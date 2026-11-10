import { and, eq } from "drizzle-orm";
import { chatActions, chatEndpoints, chatExternalPrincipals, chatIdentityLinks, companies, type Db } from "@paperclipai/db";
import type { AttentionItem, AttentionSourceKind } from "@paperclipai/shared";
import {
  formatInboxIntro, formatInboxNotification, formatInboxReminder, formatInboxResolved,
  type InboxButton, type InboxNotifyView, type SlackInboxTransport,
} from "./chat-channels/slack/inbox-notify.js";
import { buildInboxActionSpecs, persistInboxButtons, type InboxActionApi } from "./inbox-slack-actions.js";

/**
 * Mirrors the board Inbox to Slack: one message per pending item, edited when
 * the item is resolved, plus at most one reminder. State lives in chat_actions
 * (kind `inbox_notify`) and is written BEFORE any dispatch, so a crash or an
 * ambiguous provider response can never replay a message.
 */
export const INBOX_NOTIFY_KIND = "inbox_notify";
const BASELINE_KEY = "__baseline__";
const MAX_SENDS_PER_RUN = 10;
export const DEFAULT_REMINDER_MS = 4 * 60 * 60_000;

type Logger = { warn: (obj: object, msg: string) => void; info?: (obj: object, msg: string) => void };

export type InboxSlackNotifierDeps = {
  transport: SlackInboxTransport;
  /** Bot token for an endpoint; null/throw when the connection is not usable. */
  token: (endpointId: string) => Promise<string | null>;
  /** Public origin for the Inbox link; null omits the link. */
  baseUrl: () => string | null | undefined;
  /** Pending Inbox items for the board user (the same feed the Inbox page shows). */
  listPending: (companyId: string, userId: string) => Promise<InboxItemSource[]>;
  connectorsEnabled: () => Promise<boolean>;
  /** Optional Slack channel/DM id that replaces the linked-user DM. */
  channelOverride?: () => string | null | undefined;
  /** Server's own API as the board user; null disables action buttons (link buttons only). */
  api?: InboxActionApi | null;
  /** 0 disables reminders. */
  reminderMs?: number;
  now?: () => number;
  log?: Logger;
};

export type InboxItemSource = Pick<AttentionItem, "dedupKey" | "sourceKind" | "subject" | "whyNow" | "activityAt" | "originAgentName" | "relatedIssue">;

const ASK: Record<AttentionSourceKind, string> = {
  issue_thread_interaction: "Cần bạn trả lời / xác nhận",
  decision: "Cần bạn quyết định",
  approval: "Cần bạn duyệt",
  join_request: "Cần bạn duyệt thành viên",
  recovery_action: "Task bị kẹt — cần bạn xử lý",
  blocker_attention: "Task bị kẹt — cần bạn xử lý",
  failed_run: "Agent chạy lỗi — cần bạn xem",
  agent_error_alert: "Agent lỗi — cần bạn xem",
  review: "Cần bạn xem lại",
  budget_alert: "Cần bạn xem ngân sách",
  productivity_review: "Cần bạn xem lại",
};

export function inboxNotifyView(item: InboxItemSource): InboxNotifyView {
  return {
    ask: ASK[item.sourceKind] ?? "Cần bạn xử lý",
    title: item.subject.title ?? item.relatedIssue?.title ?? item.whyNow,
    detail: item.whyNow && item.whyNow !== item.subject.title ? item.whyNow : null,
    agent: item.originAgentName ?? null,
    issue: item.relatedIssue?.identifier ?? item.subject.identifier ?? null,
    since: item.activityAt,
  };
}

type Recipient = { channel: string; userId: string };

export function inboxSlackNotifier(db: Db, deps: InboxSlackNotifierDeps) {
  const now = () => deps.now?.() ?? Date.now();
  const reminderMs = deps.reminderMs ?? DEFAULT_REMINDER_MS;

  async function resolveRecipient(endpoint: typeof chatEndpoints.$inferSelect): Promise<Recipient | null> {
    const override = deps.channelOverride?.()?.trim();
    const sponsor = endpoint.sponsorUserId;
    if (override) return sponsor ? { channel: override, userId: sponsor } : null;
    if (!endpoint.providerAccountId) return null;
    const links = await db.select({ userId: chatIdentityLinks.paperclipUserId, slackUserId: chatExternalPrincipals.externalId })
      .from(chatIdentityLinks)
      .innerJoin(chatExternalPrincipals, and(eq(chatExternalPrincipals.id, chatIdentityLinks.principalId), eq(chatExternalPrincipals.companyId, chatIdentityLinks.companyId)))
      .where(and(
        eq(chatIdentityLinks.companyId, endpoint.companyId), eq(chatIdentityLinks.endpointId, endpoint.id), eq(chatIdentityLinks.status, "linked"),
        eq(chatExternalPrincipals.provider, "slack"), eq(chatExternalPrincipals.providerAccountId, endpoint.providerAccountId), eq(chatExternalPrincipals.isBot, false),
      ));
    // The sponsor's own link wins; otherwise only an unambiguous single linked person is used.
    const own = links.filter(link => link.userId === sponsor);
    const pick = own.length === 1 ? own[0] : links.length === 1 ? links[0] : null;
    return pick?.userId ? { channel: pick.slackUserId, userId: pick.userId } : null;
  }

  /** Action buttons (when the server can execute them) plus always-available link buttons. */
  async function actionButtons(endpoint: typeof chatEndpoints.$inferSelect, userId: string, groupId: string, item: InboxItemSource, title: string, inboxUrl: string | null): Promise<InboxButton[]> {
    const buttons: InboxButton[] = [];
    if (deps.api) {
      try {
        const specs = await buildInboxActionSpecs(item, deps.api);
        buttons.push(...await persistInboxButtons(db, { companyId: endpoint.companyId, endpointId: endpoint.id, groupId, userId, dedupKey: item.dedupKey, title, specs }));
      } catch (error) { deps.log?.warn({ endpointId: endpoint.id, error: String(error) }, "Inbox Slack action buttons unavailable; sending links only"); }
    }
    const identifier = item.relatedIssue?.identifier ?? item.subject.identifier;
    if (inboxUrl && identifier) buttons.push({ actionId: "inbox:link:task", text: `Mở ${identifier}`, url: inboxUrl.replace(/decisions$/, `issues/${identifier}`) });
    if (inboxUrl) buttons.push({ actionId: "inbox:link:inbox", text: "Mở Inbox", url: inboxUrl });
    return buttons;
  }

  async function runEndpoint(endpoint: typeof chatEndpoints.$inferSelect, budget: { left: number }) {
    const recipient = await resolveRecipient(endpoint);
    if (!recipient) return;
    const token = await deps.token(endpoint.id);
    if (!token) return;
    // A failed read must never look like "everything was resolved".
    const pending = await deps.listPending(endpoint.companyId, recipient.userId);
    const [company] = await db.select({ prefix: companies.issuePrefix }).from(companies).where(eq(companies.id, endpoint.companyId));
    const base = deps.baseUrl()?.replace(/\/+$/, "");
    const inboxUrl = base && company ? `${base}/${company.prefix}/decisions` : null;

    const rows = await db.select().from(chatActions).where(and(eq(chatActions.endpointId, endpoint.id), eq(chatActions.kind, INBOX_NOTIFY_KIND)));
    const byKey = new Map(rows.map(row => [row.providerActionId, row]));
    const pendingByKey = new Map(pending.map(item => [`${INBOX_NOTIFY_KIND}:${item.dedupKey}`, item]));
    const at = now();

    async function claim(key: string, payload: Record<string, unknown>) {
      const [row] = await db.insert(chatActions).values({
        companyId: endpoint.companyId, endpointId: endpoint.id, kind: INBOX_NOTIFY_KIND, providerActionId: key, status: "processing", payload,
      }).onConflictDoNothing().returning();
      return row ?? null;
    }
    const finish = (id: string, status: string, result: Record<string, unknown>) =>
      db.update(chatActions).set({ status, result, updatedAt: new Date() }).where(eq(chatActions.id, id));

    // First run for this endpoint: a one-line intro, then every pending item gets its own message
    // through the normal path below (paced by the per-sweep send budget, oldest-waiting first).
    const baselineKey = `${INBOX_NOTIFY_KIND}:${BASELINE_KEY}`;
    if (!byKey.has(baselineKey)) {
      const baseline = await claim(baselineKey, { items: pending.length });
      if (!baseline) return;
      if (pending.length === 0) { await finish(baseline.id, "processed", { skipped: "empty" }); return; }
      try {
        const sent = await deps.transport.post({ token, channel: recipient.channel, ...formatInboxIntro(pending.length) });
        await finish(baseline.id, "processed", { ...sent, sentAt: new Date(at).toISOString() });
      } catch { await finish(baseline.id, "uncertain", { code: "slack_baseline_unconfirmed" }); return; }
    }

    // 1) New pending items → one message each.
    const ordered = [...pendingByKey].sort(([, a], [, b]) => Date.parse(a.activityAt) - Date.parse(b.activityAt));
    for (const [key, item] of ordered) {
      if (byKey.has(key) || budget.left <= 0) continue;
      const view = inboxNotifyView(item);
      const row = await claim(key, { title: view.title, ask: view.ask });
      if (!row) continue;
      budget.left -= 1;
      try {
        const buttons = await actionButtons(endpoint, recipient.userId, row.id, item, view.title, inboxUrl);
        const sent = await deps.transport.post({ token, channel: recipient.channel, ...formatInboxNotification(view, at, inboxUrl, buttons) });
        await finish(row.id, "processed", { ...sent, sentAt: new Date(at).toISOString(), state: "open" });
      } catch { await finish(row.id, "uncertain", { code: "slack_inbox_notify_unconfirmed" }); }
    }

    for (const row of rows) {
      if (row.status !== "processed" || row.providerActionId.endsWith(`:${BASELINE_KEY}`)) continue;
      const result = row.result as { channel?: string; ts?: string; sentAt?: string; state?: string; remindedAt?: string } | null;
      if (!result?.channel || !result.ts || result.state === "resolved") continue;
      const item = pendingByKey.get(row.providerActionId);
      const title = String((row.payload as { title?: unknown }).title ?? "");
      if (!item) {
        // 2) Left the pending set → edit the original message.
        await finish(row.id, "processed", { ...result, state: "resolved", resolvedAt: new Date(at).toISOString() });
        try { await deps.transport.update({ token, channel: result.channel, ts: result.ts, ...formatInboxResolved(title) }); }
        catch (error) { deps.log?.warn({ endpointId: endpoint.id, error: String(error) }, "Inbox Slack message could not be marked resolved"); }
        continue;
      }
      // 3) Still pending past the delay → exactly one thread reminder.
      if (reminderMs > 0 && !result.remindedAt && budget.left > 0 && result.sentAt && at - Date.parse(result.sentAt) >= reminderMs) {
        await finish(row.id, "processed", { ...result, remindedAt: new Date(at).toISOString() });
        budget.left -= 1;
        try { await deps.transport.post({ token, channel: result.channel, threadTs: result.ts, ...formatInboxReminder(inboxNotifyView(item), at, inboxUrl) }); }
        catch (error) { deps.log?.warn({ endpointId: endpoint.id, error: String(error) }, "Inbox Slack reminder was not delivered"); }
      }
    }
  }

  /** One sweep; never throws. */
  async function runOnce(): Promise<void> {
    try {
      if (!(await deps.connectorsEnabled())) return;
      const endpoints = await db.select().from(chatEndpoints).where(and(eq(chatEndpoints.provider, "slack"), eq(chatEndpoints.status, "active")));
      const budget = { left: MAX_SENDS_PER_RUN };
      for (const endpoint of endpoints) {
        try { await runEndpoint(endpoint, budget); }
        catch (error) { deps.log?.warn({ endpointId: endpoint.id, error: String(error) }, "Inbox Slack notification sweep failed"); }
      }
    } catch (error) { deps.log?.warn({ error: String(error) }, "Inbox Slack notification sweep failed"); }
  }

  function start(intervalMs = 60_000) {
    let running = false;
    const timer = setInterval(() => {
      if (running) return;
      running = true;
      void runOnce().finally(() => { running = false; });
    }, intervalMs);
    timer.unref?.();
    return { stop: () => clearInterval(timer) };
  }

  return { runOnce, start };
}
