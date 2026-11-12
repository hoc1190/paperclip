import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import webpush from "web-push";
import { webPushSubscriptions, type Db } from "@paperclipai/db";
import type { WebPushInboxPayload, WebPushSubscribe, WebPushSubscriptionSummary } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { resolveWebPushVapid, type WebPushVapid } from "./web-push-vapid.js";

export const MAX_WEB_PUSH_SUBSCRIPTIONS_PER_USER = 20;

const ALLOWED_HOST_SUFFIXES = [
  "googleapis.com",
  "push.apple.com",
  "push.services.mozilla.com",
  "notify.windows.com",
];

/** https only, default port, no credentials, and a host owned by a known push service. Blocks SSRF and IP literals. */
export function isAllowedPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try { url = new URL(endpoint); } catch { return false; }
  if (url.protocol !== "https:" || url.port !== "" || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  return ALLOWED_HOST_SUFFIXES.some(suffix => host === suffix || host.endsWith(`.${suffix}`));
}

export type WebPushSendOutcome = "ok" | "gone" | "rejected" | "transient";
export type WebPushSubscriptionRow = typeof webPushSubscriptions.$inferSelect;
type SendNotification = (
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
  payload: string,
  options: webpush.RequestOptions,
) => Promise<unknown>;

export function classifyPushStatus(statusCode: number | undefined): Exclude<WebPushSendOutcome, "ok"> {
  if (statusCode === 404 || statusCode === 410) return "gone";
  if (statusCode === 400 || statusCode === 401 || statusCode === 403 || statusCode === 413) return "rejected";
  return "transient";
}

const toSummary = (row: WebPushSubscriptionRow): WebPushSubscriptionSummary => ({
  id: row.id,
  userAgent: row.userAgent,
  createdAt: row.createdAt.toISOString(),
  lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
});

export function webPushSubscriptionService(db: Db, options: {
  getVapid?: () => WebPushVapid | null;
  sendNotification?: SendNotification;
} = {}) {
  const getVapid = options.getVapid ?? (() => resolveWebPushVapid());
  const sendNotification: SendNotification = options.sendNotification
    ?? ((subscription, payload, requestOptions) => webpush.sendNotification(subscription, payload, requestOptions));
  // Lets the notifier stay completely quiet (no SQL) when nobody subscribed.
  let anySubscriptions = false;

  async function refreshHasAny() {
    const [row] = await db.select({ id: webPushSubscriptions.id }).from(webPushSubscriptions).limit(1);
    anySubscriptions = Boolean(row);
    return anySubscriptions;
  }

  async function deleteByEndpoint(endpoint: string) {
    await db.delete(webPushSubscriptions).where(eq(webPushSubscriptions.endpoint, endpoint));
    await refreshHasAny();
  }

  async function recordResult(id: string, result: "ok" | { code: string }) {
    const now = new Date();
    await db.update(webPushSubscriptions).set(result === "ok"
      ? { lastSuccessAt: now, failureCount: 0, lastFailureCode: null, updatedAt: now }
      : { lastFailureAt: now, lastFailureCode: result.code, failureCount: sql`${webPushSubscriptions.failureCount} + 1`, updatedAt: now },
    ).where(eq(webPushSubscriptions.id, id));
  }

  return {
    refreshHasAny,
    hasAnySubscriptions: () => anySubscriptions,
    deleteByEndpoint,
    recordResult,

    async upsert(userId: string, input: Pick<WebPushSubscribe, "endpoint" | "keys" | "userAgent">, keyId: string) {
      const now = new Date();
      const [row] = await db.insert(webPushSubscriptions).values({
        userId, endpoint: input.endpoint, p256dh: input.keys.p256dh, auth: input.keys.auth,
        vapidKeyId: keyId, userAgent: input.userAgent ?? null,
      }).onConflictDoUpdate({
        target: webPushSubscriptions.endpoint,
        set: {
          userId, p256dh: input.keys.p256dh, auth: input.keys.auth, vapidKeyId: keyId,
          userAgent: input.userAgent ?? null, failureCount: 0, lastFailureAt: null, lastFailureCode: null, updatedAt: now,
        },
      }).returning();
      // Keep the newest MAX subscriptions; evict the oldest.
      const owned = await db.select({ id: webPushSubscriptions.id }).from(webPushSubscriptions)
        .where(eq(webPushSubscriptions.userId, userId)).orderBy(asc(webPushSubscriptions.createdAt), asc(webPushSubscriptions.id));
      if (owned.length > MAX_WEB_PUSH_SUBSCRIPTIONS_PER_USER) {
        const evict = owned.slice(0, owned.length - MAX_WEB_PUSH_SUBSCRIPTIONS_PER_USER).map(r => r.id).filter(id => id !== row!.id);
        if (evict.length) await db.delete(webPushSubscriptions).where(inArray(webPushSubscriptions.id, evict));
      }
      anySubscriptions = true;
      return toSummary(row!);
    },

    /** Only the caller's own row; returns whether a row was removed. */
    async remove(userId: string, endpoint: string) {
      const removed = await db.delete(webPushSubscriptions)
        .where(and(eq(webPushSubscriptions.userId, userId), eq(webPushSubscriptions.endpoint, endpoint)))
        .returning({ id: webPushSubscriptions.id });
      await refreshHasAny();
      return removed.length > 0;
    },

    async listForUser(userId: string): Promise<WebPushSubscriptionSummary[]> {
      const rows = await db.select().from(webPushSubscriptions)
        .where(eq(webPushSubscriptions.userId, userId)).orderBy(asc(webPushSubscriptions.createdAt));
      return rows.map(toSummary);
    },

    /** Full rows for sending. Rows signed with a different VAPID key can never be delivered, so they are deleted. */
    async listSendableForUser(userId: string, keyId: string): Promise<WebPushSubscriptionRow[]> {
      const stale = await db.delete(webPushSubscriptions)
        .where(and(eq(webPushSubscriptions.userId, userId), ne(webPushSubscriptions.vapidKeyId, keyId)))
        .returning({ id: webPushSubscriptions.id });
      if (stale.length) await refreshHasAny();
      return db.select().from(webPushSubscriptions).where(eq(webPushSubscriptions.userId, userId));
    },

    /** Distinct users with at least one subscription for the current key (stale-key rows are removed first). */
    async listActiveUserIds(keyId: string): Promise<string[]> {
      const stale = await db.delete(webPushSubscriptions).where(ne(webPushSubscriptions.vapidKeyId, keyId))
        .returning({ id: webPushSubscriptions.id });
      if (stale.length) await refreshHasAny();
      const rows = await db.selectDistinct({ userId: webPushSubscriptions.userId }).from(webPushSubscriptions);
      return rows.map(r => r.userId);
    },

    /** Re-checks the allowlist, sends, then applies the outcome (delete on 404/410, record otherwise). */
    async send(sub: WebPushSubscriptionRow, payload: WebPushInboxPayload): Promise<WebPushSendOutcome> {
      const vapid = getVapid();
      if (!vapid) return "rejected";
      if (!isAllowedPushEndpoint(sub.endpoint)) {
        logger.warn({ subscriptionId: sub.id }, "Web push endpoint is not allowed; removing subscription");
        await deleteByEndpoint(sub.endpoint);
        return "gone";
      }
      try {
        await sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify(payload), {
          TTL: 86400, urgency: "high",
          vapidDetails: { subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
        });
        await recordResult(sub.id, "ok");
        return "ok";
      } catch (error) {
        const statusCode = (error as { statusCode?: number }).statusCode;
        const outcome = classifyPushStatus(statusCode);
        if (outcome === "gone") {
          await deleteByEndpoint(sub.endpoint);
          return outcome;
        }
        if (outcome === "rejected") logger.warn({ subscriptionId: sub.id, statusCode }, "Web push rejected by push service");
        await recordResult(sub.id, { code: String(statusCode ?? "network") });
        return outcome;
      }
    },
  };
}

export type WebPushSubscriptionService = ReturnType<typeof webPushSubscriptionService>;
