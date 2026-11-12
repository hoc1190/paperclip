import { and, eq, inArray, lt, ne, notInArray } from "drizzle-orm";
import { companies, companyMemberships, webPushInboxNotices, type Db } from "@paperclipai/db";
import { inboxItemDeepLink, type WebPushInboxPayload } from "@paperclipai/shared";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { inboxNotifyView, type InboxItemSource } from "./inbox-slack-notifier.js";
import { subscribeAllCompanyLiveEvents } from "./live-events.js";
import type { WebPushSubscriptionService } from "./web-push-subscriptions.js";

/**
 * Pushes new board Inbox items to the user's registered devices. Event driven
 * only: a company live event marks the company dirty and a coalesced flush
 * diffs the pending feed against durable notice rows (written BEFORE sending,
 * so a crash never sends twice). No subscriptions means no SQL and no timers.
 * `inboxNotifyView` is imported from the Slack notifier: it is one pure function
 * and moving it would touch Slack code that this change must leave alone.
 */
const BASELINE_KEY = "__baseline__";
const NOTICE_RETENTION_MS = 7 * 24 * 60 * 60_000;
const MAX_PAYLOAD_BYTES = 3000;
const COMPANY_RETRY_MS = 5000;
const MAX_COMPANY_RETRIES = 5;
const TRIGGER_EVENTS = new Set(["activity.logged", "heartbeat.run.status", "agent.status"]);

type Logger = { warn: (obj: object, msg: string) => void; info?: (obj: object, msg: string) => void };
export type InboxPushItem = InboxItemSource & { id: string };

export type InboxWebPushNotifierDeps = {
  listPending: (companyId: string, userId: string) => Promise<InboxPushItem[]>;
  vapid: { keyId: string };
  subscriptions: Pick<WebPushSubscriptionService, "hasAnySubscriptions" | "refreshHasAny" | "listActiveUserIds" | "listSendableForUser" | "send">;
  isWarmStandby?: () => boolean;
  log?: Logger;
  now?: () => number;
  coalesceMs?: number;
  maxPerRun?: number;
};

const byteLength = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const clip = (value: string, max: number) => (value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`);

/** Shortens `body` first, then `title`, only when the serialized payload would not fit a push message. */
export function fitWebPushPayload(payload: WebPushInboxPayload): WebPushInboxPayload {
  if (byteLength(payload) <= MAX_PAYLOAD_BYTES) return payload;
  let next = { ...payload };
  for (const field of ["body", "title"] as const) {
    let max = next[field].length;
    while (byteLength(next) > MAX_PAYLOAD_BYTES && max > 1) {
      max = Math.floor(max * 0.8);
      next = { ...next, [field]: clip(payload[field], max) };
    }
    if (byteLength(next) <= MAX_PAYLOAD_BYTES) break;
  }
  return next;
}

export function inboxWebPushNotifier(db: Db, deliveryWork: ReturnType<typeof createDeliveryWorkCoordinator>, deps: InboxWebPushNotifierDeps) {
  const now = () => deps.now?.() ?? Date.now();
  const coalesceMs = deps.coalesceMs ?? 3000;
  const maxPerRun = deps.maxPerRun ?? 5;
  const dirty = new Set<string>();
  const companyRetries = new Map<string, number>();
  let dirtyAll = false;
  let flushAt: number | null = null;
  let stopped = false;

  const warm = () => deps.isWarmStandby?.() === true;

  function scheduleFlush(at: number) {
    flushAt = flushAt === null ? at : Math.min(flushAt, at);
    worker.wake();
  }

  function payloadFor(item: InboxPushItem, companyId: string, prefix: string): WebPushInboxPayload {
    const view = inboxNotifyView(item);
    return fitWebPushPayload({
      v: 1,
      title: view.title || "Paperclip",
      body: [view.ask, view.issue, view.agent].filter(Boolean).join(" · "),
      url: inboxItemDeepLink(prefix, item.id),
      tag: item.id,
      companyId,
      itemId: item.id,
    });
  }

  async function runCompany(userId: string, company: { id: string; prefix: string }) {
    // A failed read throws here, so it can never look like "everything resolved".
    const pending = (await deps.listPending(company.id, userId)).filter(item => item.sourceKind !== "recovery_action");
    const rows = await db.select({ itemKey: webPushInboxNotices.itemKey }).from(webPushInboxNotices)
      .where(and(eq(webPushInboxNotices.userId, userId), eq(webPushInboxNotices.companyId, company.id)));
    const known = new Set(rows.map(row => row.itemKey));
    const insert = (keys: string[]) => keys.length === 0 ? Promise.resolve([]) : db.insert(webPushInboxNotices)
      .values(keys.map(itemKey => ({ userId, companyId: company.id, itemKey }))).onConflictDoNothing().returning({ itemKey: webPushInboxNotices.itemKey });

    if (!known.has(BASELINE_KEY)) {
      // First enable: everything already pending is silent history.
      await insert([BASELINE_KEY, ...pending.map(item => item.id)]);
      return;
    }

    const fresh = pending.filter(item => !known.has(item.id))
      .sort((a, b) => Date.parse(a.activityAt) - Date.parse(b.activityAt));
    if (fresh.length > 0) {
      const claimed = new Set((await insert(fresh.map(item => item.id))).map(row => row.itemKey));
      const mine = fresh.filter(item => claimed.has(item.id));
      const subs = mine.length > 0 ? await deps.subscriptions.listSendableForUser(userId, deps.vapid.keyId) : [];
      const fanOut = async (payload: WebPushInboxPayload) => {
        await Promise.allSettled(subs.map(sub => deps.subscriptions.send(sub, payload)));
      };
      if (subs.length > 0) {
        for (const item of mine.slice(0, maxPerRun)) await fanOut(payloadFor(item, company.id, company.prefix));
        const extra = mine.length - maxPerRun;
        if (extra > 0) {
          await fanOut(fitWebPushPayload({
            v: 1, title: `+${extra} mục mới trong Inbox`, body: "", url: `/${company.prefix}/decisions`,
            tag: `inbox-summary:${company.id}`, companyId: company.id, itemId: `summary:${company.id}`, renotify: true,
          }));
        }
      }
    }

    // Bound the table; keep recently resolved keys so a flapping item is not re-pushed within a week.
    const stillPending = pending.map(item => item.id);
    await db.delete(webPushInboxNotices).where(and(
      eq(webPushInboxNotices.userId, userId), eq(webPushInboxNotices.companyId, company.id),
      ne(webPushInboxNotices.itemKey, BASELINE_KEY),
      lt(webPushInboxNotices.notifiedAt, new Date(now() - NOTICE_RETENTION_MS)),
      ...(stillPending.length > 0 ? [notInArray(webPushInboxNotices.itemKey, stillPending)] : []),
    ));
  }

  async function run() {
    if (stopped || warm()) return;
    if (flushAt === null || now() < flushAt) return;
    // Remove before awaiting: an event arriving during the work belongs to the next batch.
    const snapshot = new Set(dirty);
    const all = dirtyAll;
    dirty.clear(); dirtyAll = false; flushAt = null;
    try {
      const userIds = await deps.subscriptions.listActiveUserIds(deps.vapid.keyId);
      if (userIds.length === 0) return;
      const memberships = await db.select({ userId: companyMemberships.principalId, id: companies.id, prefix: companies.issuePrefix })
        .from(companyMemberships).innerJoin(companies, eq(companies.id, companyMemberships.companyId))
        .where(and(
          eq(companyMemberships.principalType, "user"), eq(companyMemberships.status, "active"),
          inArray(companyMemberships.principalId, userIds),
        ));
      for (const membership of memberships) {
        if (!all && !snapshot.has(membership.id)) continue;
        try {
          await runCompany(membership.userId, membership);
          companyRetries.delete(membership.id);
        } catch (error) {
          deps.log?.warn({ companyId: membership.id, error: String(error) }, "Inbox web push failed for company");
          // Retry shortly instead of waiting for the next live event, but not forever.
          const attempts = (companyRetries.get(membership.id) ?? 0) + 1;
          if (attempts <= MAX_COMPANY_RETRIES) {
            companyRetries.set(membership.id, attempts);
            dirty.add(membership.id);
            scheduleFlush(now() + COMPANY_RETRY_MS);
          } else {
            companyRetries.delete(membership.id);
          }
        }
      }
    } catch (error) {
      for (const id of snapshot) dirty.add(id);
      dirtyAll ||= all;
      flushAt ??= now() + 5000;
      throw error;
    }
  }

  const worker = deliveryWork.register(DELIVERY_QUEUES.webPushInbox, {
    retryMs: 5000,
    run,
    hasPending: async () => false,
    nextRunAt: () => flushAt,
  });

  const stopEvents = subscribeAllCompanyLiveEvents(event => {
    if (stopped || warm() || !TRIGGER_EVENTS.has(event.type)) return;
    if (!deps.subscriptions.hasAnySubscriptions()) return;
    if (!/^[a-f0-9-]{36}$/i.test(event.companyId)) return;
    dirty.add(event.companyId);
    scheduleFlush(now() + coalesceMs);
  });

  return {
    /** Catches items created while the server was down. Does nothing (no SQL after the first probe) with no subscriptions. */
    async start() {
      if (await deps.subscriptions.refreshHasAny()) { dirtyAll = true; scheduleFlush(now()); }
      return this;
    },
    /** Marks one user's companies dirty and flushes right away, so a fresh subscription gets its baseline. */
    async requestReconcile(input: { userId: string }) {
      if (stopped || warm()) return;
      const rows = await db.select({ id: companyMemberships.companyId }).from(companyMemberships)
        .where(and(eq(companyMemberships.principalType, "user"), eq(companyMemberships.principalId, input.userId), eq(companyMemberships.status, "active")));
      for (const row of rows) dirty.add(row.id);
      if (rows.length > 0) scheduleFlush(now());
    },
    async stop() {
      stopped = true;
      stopEvents();
      await worker.stop();
    },
  };
}

export type InboxWebPushNotifier = ReturnType<typeof inboxWebPushNotifier>;
