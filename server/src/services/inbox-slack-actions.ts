import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { chatActions, chatEndpoints, chatExternalPrincipals, chatIdentityLinks, type Db } from "@paperclipai/db";
import type { AskUserQuestionsInteraction, IssueThreadInteraction } from "@paperclipai/shared";
import {
  INBOX_ACTION_PREFIX, INBOX_LINK_ACTION_PREFIX, formatInboxResolved, postSlackEphemeral, type InboxButton, type SlackBlockActionsPayload, type SlackInboxTransport,
} from "./chat-channels/slack/inbox-notify.js";
import type { InboxItemSource } from "./inbox-slack-notifier.js";
import { nativeChatConfirmation, nativeChatCustomQuestion, nativeChatQuestion } from "./chat-interaction-publications.js";

/**
 * Click-to-resolve buttons for Inbox Slack messages. Every click is executed through
 * the SAME HTTP routes the Inbox web UI uses (so authorization, activity logging,
 * wakeups and validation are identical); this module only decides which buttons to
 * offer and maps a signed click back to one of them.
 */
export const INBOX_ACTION_KIND = "inbox_action";
const CLAIM_KIND = "inbox_action_claim";
const MAX_OPTION_BUTTONS = 8;

export type InboxRequest = { method: "POST" | "PATCH"; path: string; body: Record<string, unknown> };
export type InboxApiResult = { ok: boolean; status: number; message?: string };

/** Read/write access to the server's own API as the board user. */
export type InboxActionApi = {
  interactions(issueId: string): Promise<IssueThreadInteraction[] | null>;
  decision(decisionId: string): Promise<{ status?: string; options?: Array<{ id: string; label: string; style?: string }>; inputs?: unknown[] } | null>;
  request(request: InboxRequest): Promise<InboxApiResult>;
};

export type ButtonSpec = {
  label: string;
  /** What the message shows after a successful click, e.g. the chosen answer. */
  choice: string;
  request: InboxRequest;
  style?: "primary" | "danger";
  confirm?: InboxButton["confirm"];
};

const issueIdOf = (item: InboxItemSource): string | null => {
  const metaIssue = (item.subject.metadata as { issueId?: unknown } | undefined)?.issueId;
  return item.relatedIssue?.id ?? (typeof metaIssue === "string" ? metaIssue : null) ?? (item.subject.kind === "issue" ? item.subject.id : null);
};

/** Decides which action buttons an item gets. Returns [] when it can only be handled in the Inbox. */
export async function buildInboxActionSpecs(item: InboxItemSource, api: InboxActionApi): Promise<ButtonSpec[]> {
  const issueId = issueIdOf(item);
  switch (item.sourceKind) {
    case "issue_thread_interaction": {
      if (!issueId) return [];
      const interaction = (await api.interactions(issueId))?.find(candidate => candidate.id === item.subject.id && candidate.status === "pending");
      if (!interaction) return [];
      const base = `/issues/${issueId}/interactions/${interaction.id}`;
      if (interaction.kind === "ask_user_questions") {
        const typed = interaction as AskUserQuestionsInteraction;
        const question = nativeChatQuestion(typed, MAX_OPTION_BUTTONS) ?? nativeChatCustomQuestion(typed);
        if (!question) return [];
        return question.options.filter(option => option.freeText !== true).slice(0, MAX_OPTION_BUTTONS).map((option, index) => ({
          label: option.label, choice: option.label, style: index === 0 ? "primary" as const : undefined,
          request: { method: "POST", path: `${base}/respond`, body: { answers: [{ questionId: question.id, optionIds: [option.id] }] } },
        }));
      }
      if (interaction.kind === "request_confirmation" && nativeChatConfirmation(interaction)) {
        const payload = interaction.payload;
        return [
          { label: payload.acceptLabel?.trim() || "Duyệt", choice: payload.acceptLabel?.trim() || "Đã duyệt", style: "primary", request: { method: "POST", path: `${base}/accept`, body: {} } },
          { label: payload.rejectLabel?.trim() || "Từ chối", choice: payload.rejectLabel?.trim() || "Đã từ chối", request: { method: "POST", path: `${base}/reject`, body: {} },
            confirm: { title: "Từ chối?", text: "Agent sẽ nhận được kết quả từ chối này.", confirm: "Từ chối", deny: "Huỷ" } },
        ];
      }
      return [];
    }
    case "decision": {
      const decision = await api.decision(item.subject.id);
      if (!decision || (decision.status && decision.status !== "pending") || decision.inputs?.length || !decision.options?.length) return [];
      return decision.options.slice(0, MAX_OPTION_BUTTONS).map((option, index) => ({
        label: option.label, choice: option.label,
        style: option.style === "destructive" ? "danger" as const : index === 0 || option.style === "primary" ? "primary" as const : undefined,
        request: { method: "POST", path: `/decisions/${item.subject.id}/decide`, body: { optionId: option.id } },
        ...(option.style === "destructive" ? { confirm: { title: option.label, text: "Hành động này không hoàn tác được.", confirm: "Xác nhận", deny: "Huỷ" } } : {}),
      }));
    }
    case "blocker_attention":
    case "recovery_action":
    case "review": {
      if (!issueId) return [];
      return [
        { label: "Đánh dấu xong", choice: "Đã đánh dấu xong", style: "primary", request: { method: "PATCH", path: `/issues/${issueId}`, body: { status: "done", comment: "Đánh dấu xong từ Slack bởi board." } },
          confirm: { title: "Đánh dấu task xong?", text: "Task sẽ chuyển sang trạng thái done.", confirm: "Đánh dấu xong", deny: "Huỷ" } },
        { label: "Huỷ task", choice: "Đã huỷ task", style: "danger", request: { method: "PATCH", path: `/issues/${issueId}`, body: { status: "cancelled", comment: "Huỷ từ Slack bởi board." } },
          confirm: { title: "Huỷ task này?", text: "Task sẽ chuyển sang cancelled và agent ngừng làm.", confirm: "Huỷ task", deny: "Giữ lại" } },
      ];
    }
    default:
      return [];
  }
}

/** Server-to-self calls as the board user. Only valid where every local request is the board (local_trusted). */
export function createLoopbackInboxApi(origin: string, fetchImpl: typeof fetch = fetch): InboxActionApi {
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetchImpl(`${origin}/api${path}`, {
      method, headers: { "content-type": "application/json", origin, accept: "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000),
    });
    const text = await response.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }
    return { response, json };
  };
  return {
    async interactions(issueId) {
      try { const { response, json } = await call("GET", `/issues/${issueId}/interactions`); return response.ok && Array.isArray(json) ? json : null; } catch { return null; }
    },
    async decision(decisionId) {
      try { const { response, json } = await call("GET", `/decisions/${decisionId}`); return response.ok && json ? json : null; } catch { return null; }
    },
    async request({ method, path, body }) {
      try {
        const { response, json } = await call(method, path, body);
        return { ok: response.ok, status: response.status, message: response.ok ? undefined : String(json?.error ?? json?.message ?? `HTTP ${response.status}`) };
      } catch (error) { return { ok: false, status: 0, message: String(error) }; }
    },
  };
}

/** Persists one chat_actions row per button (before posting) and returns the Slack buttons. */
export async function persistInboxButtons(db: Db, input: {
  companyId: string; endpointId: string; groupId: string; userId: string; dedupKey: string; title: string; specs: ButtonSpec[];
}): Promise<InboxButton[]> {
  const buttons: InboxButton[] = [];
  for (const spec of input.specs) {
    const token = randomBytes(12).toString("base64url");
    const actionId = `${INBOX_ACTION_PREFIX}${token}`;
    await db.insert(chatActions).values({
      companyId: input.companyId, endpointId: input.endpointId, kind: INBOX_ACTION_KIND, providerActionId: actionId, status: "ready",
      payload: { groupId: input.groupId, userId: input.userId, dedupKey: input.dedupKey, title: input.title, label: spec.label, choice: spec.choice, request: spec.request },
    });
    buttons.push({ actionId, text: spec.label, style: spec.style, confirm: spec.confirm });
  }
  return buttons;
}

export type InboxClickDeps = {
  transport: SlackInboxTransport;
  token: (endpointId: string) => Promise<string | null>;
  api: InboxActionApi | null;
  listPending: (companyId: string, userId: string) => Promise<Array<Pick<InboxItemSource, "dedupKey">>>;
  fetch?: typeof fetch;
  log?: { warn: (obj: object, msg: string) => void };
};

type ButtonPayload = { groupId: string; userId: string; dedupKey: string; title: string; label: string; choice: string; request: InboxRequest };

/**
 * Handles one verified Slack block_actions callback for `inbox:` buttons. The caller has already
 * verified the Slack signature and workspace. Returns true when the click was for an Inbox button.
 */
export async function handleInboxClick(db: Db, deps: InboxClickDeps, endpoint: typeof chatEndpoints.$inferSelect, click: SlackBlockActionsPayload): Promise<boolean> {
  const action = click.actions.find(candidate => candidate.actionId.startsWith(INBOX_ACTION_PREFIX));
  if (!action) return false;
  if (action.actionId.startsWith(INBOX_LINK_ACTION_PREFIX)) return true; // opening a link needs no server work
  const tell = (text: string) => postSlackEphemeral(click.responseUrl, text, deps.fetch);

  const [row] = await db.select().from(chatActions).where(and(
    eq(chatActions.endpointId, endpoint.id), eq(chatActions.companyId, endpoint.companyId),
    eq(chatActions.kind, INBOX_ACTION_KIND), eq(chatActions.providerActionId, action.actionId),
  ));
  if (!row) { await tell("Nút này không còn hiệu lực. Hãy mở Inbox để xử lý."); return true; }
  const payload = row.payload as unknown as ButtonPayload;

  // The clicking Slack account must be linked to the Paperclip user the message was sent to.
  const links = endpoint.providerAccountId ? await db.select({ id: chatIdentityLinks.id }).from(chatIdentityLinks)
    .innerJoin(chatExternalPrincipals, and(eq(chatExternalPrincipals.id, chatIdentityLinks.principalId), eq(chatExternalPrincipals.companyId, chatIdentityLinks.companyId)))
    .where(and(
      eq(chatIdentityLinks.companyId, endpoint.companyId), eq(chatIdentityLinks.endpointId, endpoint.id), eq(chatIdentityLinks.status, "linked"),
      eq(chatIdentityLinks.paperclipUserId, payload.userId), eq(chatExternalPrincipals.provider, "slack"),
      eq(chatExternalPrincipals.providerAccountId, endpoint.providerAccountId), eq(chatExternalPrincipals.externalId, click.userId),
    )) : [];
  if (links.length === 0) { await tell("Tài khoản Slack này chưa được liên kết với người nhận tin này nên không thể xử lý từ Slack."); return true; }

  const [group] = await db.select().from(chatActions).where(and(eq(chatActions.id, payload.groupId), eq(chatActions.endpointId, endpoint.id)));
  const groupResult = group?.result as { channel?: string; ts?: string; state?: string } | null | undefined;
  const token = await deps.token(endpoint.id);
  const settle = async (text: string, state: "resolved" | null) => {
    if (state && group) await db.update(chatActions).set({ result: { ...(groupResult ?? {}), state }, updatedAt: new Date() }).where(eq(chatActions.id, group.id));
    if (token && groupResult?.channel && groupResult.ts) {
      try { await deps.transport.update({ token, channel: groupResult.channel, ts: groupResult.ts, ...formatInboxResolved(payload.title, text) }); }
      catch (error) { deps.log?.warn({ endpointId: endpoint.id, error: String(error) }, "Inbox Slack message could not be updated after a click"); }
    }
  };

  if (groupResult?.state === "resolved") { await tell("Việc này đã được xử lý rồi."); return true; }
  // Still pending? The web UI or another click may have resolved it first.
  let stillPending: boolean;
  try { stillPending = (await deps.listPending(endpoint.companyId, payload.userId)).some(item => item.dedupKey === payload.dedupKey); }
  catch { await tell("Không kiểm tra được trạng thái hiện tại. Thử lại sau hoặc mở Inbox."); return true; }
  if (!stillPending) { await settle("đã xử lý ở nơi khác", "resolved"); await tell("Việc này đã được xử lý rồi."); return true; }
  if (!deps.api) { await tell("Chưa hỗ trợ xử lý từ Slack ở chế độ triển khai này. Hãy mở Inbox."); return true; }

  // One click wins; sibling buttons and double clicks are rejected by this unique claim.
  const claimKey = `${CLAIM_KIND}:${payload.groupId}`;
  const [claim] = await db.insert(chatActions).values({
    companyId: endpoint.companyId, endpointId: endpoint.id, kind: CLAIM_KIND, providerActionId: claimKey, status: "processing",
    payload: { actionId: action.actionId, slackUserId: click.userId },
  }).onConflictDoNothing().returning();
  if (!claim) { await tell("Việc này đang/đã được xử lý rồi."); return true; }

  const result = await deps.api.request(payload.request);
  if (!result.ok) {
    // Release the claim so the user can retry or use the Inbox; nothing was applied.
    await db.delete(chatActions).where(eq(chatActions.id, claim.id));
    await tell(`Không xử lý được (${result.message ?? result.status}). Hãy mở Inbox để xử lý.`);
    return true;
  }
  await db.update(chatActions).set({ status: "processed", result: { status: result.status }, updatedAt: new Date() }).where(eq(chatActions.id, claim.id));
  await db.update(chatActions).set({ status: "processed", updatedAt: new Date() }).where(eq(chatActions.id, row.id));
  await settle(payload.choice, "resolved");
  return true;
}
