import { and, asc, eq, inArray, ne, sql, type SQL } from "drizzle-orm";
import webpush from "web-push";
import { webPushInboxNotices, webPushSubscriptions, type Db } from "@paperclipai/db";
import {
  canonicalWebPushEndpoint, isValidWebPushAuth, isValidWebPushP256dh,
  type WebPushInboxPayload, type WebPushSubscribe, type WebPushSubscriptionSummary,
} from "@paperclipai/shared";
import { conflict, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { resolveWebPushVapid, type WebPushVapid } from "./web-push-vapid.js";

export const MAX_WEB_PUSH_SUBSCRIPTIONS_PER_USER = 20;

const ALLOWED_EXACT_HOSTS = new Set([
  "fcm.googleapis.com",
  "web.push.apple.com",
  "updates.push.services.mozilla.com",
]);
const ALLOWED_HOST_SUFFIXES = [".push.services.mozilla.com", ".notify.windows.com"];

const SEND_TIMEOUT_MS = 10_000;
const SEND_OVERALL_TIMEOUT_MS = 15_000;
const MAX_CONSECUTIVE_FAILURES = 10;
const MAX_WITHOUT_SUCCESS_MS = 7 * 24 * 60 * 60_000;

/**
 * Canonical https URL (see `canonicalWebPushEndpoint`: the legacy `url.parse()` used by web-push must see the
 * same host) on an exact push-service host. Returns the value to store and send, or null.
 */
export function canonicalPushEndpoint(endpoint: string): string | null {
  const canonical = canonicalWebPushEndpoint(endpoint);
  if (!canonical) return null;
  const host = new URL(canonical).hostname;
  return ALLOWED_EXACT_HOSTS.has(host) || ALLOWED_HOST_SUFFIXES.some(suffix => host.endsWith(suffix)) ? canonical : null;
}

export function isAllowedPushEndpoint(endpoint: string): boolean {
  return canonicalPushEndpoint(endpoint) !== null;
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
  overallTimeoutMs?: number;
  now?: () => number;
} = {}) {
  const overallTimeoutMs = options.overallTimeoutMs ?? SEND_OVERALL_TIMEOUT_MS;
  const now = () => options.now?.() ?? Date.now();
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

  /**
   * Deletes matching rows. A user whose last subscription is gone loses their inbox notice rows (baseline
   * included), so re-enabling re-baselines instead of pushing what arrived while disabled.
   */
  async function deleteWhere(where: SQL | undefined) {
    const removed = await db.delete(webPushSubscriptions).where(where)
      .returning({ id: webPushSubscriptions.id, userId: webPushSubscriptions.userId });
    if (removed.length === 0) return removed;
    const userIds = [...new Set(removed.map(row => row.userId))];
    const remaining = await db.selectDistinct({ userId: webPushSubscriptions.userId }).from(webPushSubscriptions)
      .where(inArray(webPushSubscriptions.userId, userIds));
    const kept = new Set(remaining.map(row => row.userId));
    const orphaned = userIds.filter(userId => !kept.has(userId));
    if (orphaned.length > 0) await db.delete(webPushInboxNotices).where(inArray(webPushInboxNotices.userId, orphaned));
    await refreshHasAny();
    return removed;
  }

  async function deleteByEndpoint(endpoint: string) {
    await deleteWhere(eq(webPushSubscriptions.endpoint, endpoint));
  }

  async function recordResult(id: string, result: "ok" | { code: string }) {
    const at = new Date(now());
    const [row] = await db.update(webPushSubscriptions).set(result === "ok"
      ? { lastSuccessAt: at, failureCount: 0, lastFailureCode: null, updatedAt: at }
      : { lastFailureAt: at, lastFailureCode: result.code, failureCount: sql`${webPushSubscriptions.failureCount} + 1`, updatedAt: at },
    ).where(eq(webPushSubscriptions.id, id)).returning();
    return row;
  }

  return {
    refreshHasAny,
    hasAnySubscriptions: () => anySubscriptions,
    deleteByEndpoint,
    recordResult,

    async upsert(userId: string, input: Pick<WebPushSubscribe, "endpoint" | "keys" | "userAgent">, keyId: string) {
      const at = new Date();
      const canonical = canonicalPushEndpoint(input.endpoint);
      if (!canonical) throw unprocessable("Push endpoint host is not allowed");
      const [row] = await db.insert(webPushSubscriptions).values({
        userId, endpoint: canonical, p256dh: input.keys.p256dh, auth: input.keys.auth,
        vapidKeyId: keyId, userAgent: input.userAgent ?? null,
      }).onConflictDoUpdate({
        target: webPushSubscriptions.endpoint,
        // Another user's registration of the same endpoint is never taken over.
        setWhere: eq(webPushSubscriptions.userId, userId),
        set: {
          p256dh: input.keys.p256dh, auth: input.keys.auth, vapidKeyId: keyId,
          userAgent: input.userAgent ?? null, failureCount: 0, lastFailureAt: null, lastFailureCode: null, updatedAt: at,
        },
      }).returning();
      if (!row) throw conflict("Push endpoint is registered by another user");
      // Keep the newest MAX subscriptions; evict the oldest.
      const owned = await db.select({ id: webPushSubscriptions.id }).from(webPushSubscriptions)
        .where(eq(webPushSubscriptions.userId, userId)).orderBy(asc(webPushSubscriptions.createdAt), asc(webPushSubscriptions.id));
      if (owned.length > MAX_WEB_PUSH_SUBSCRIPTIONS_PER_USER) {
        const evict = owned.slice(0, owned.length - MAX_WEB_PUSH_SUBSCRIPTIONS_PER_USER).map(r => r.id).filter(id => id !== row.id);
        if (evict.length) await deleteWhere(inArray(webPushSubscriptions.id, evict));
      }
      anySubscriptions = true;
      return toSummary(row);
    },

    /** Only the caller's own row; returns whether a row was removed. */
    async remove(userId: string, endpoint: string) {
      const removed = await deleteWhere(and(eq(webPushSubscriptions.userId, userId), eq(webPushSubscriptions.endpoint, endpoint)));
      return removed.length > 0;
    },

    async listForUser(userId: string): Promise<WebPushSubscriptionSummary[]> {
      const rows = await db.select().from(webPushSubscriptions)
        .where(eq(webPushSubscriptions.userId, userId)).orderBy(asc(webPushSubscriptions.createdAt));
      return rows.map(toSummary);
    },

    /** Full rows for sending. Rows signed with a different VAPID key can never be delivered, so they are deleted. */
    async listSendableForUser(userId: string, keyId: string): Promise<WebPushSubscriptionRow[]> {
      await deleteWhere(and(eq(webPushSubscriptions.userId, userId), ne(webPushSubscriptions.vapidKeyId, keyId)));
      return db.select().from(webPushSubscriptions).where(eq(webPushSubscriptions.userId, userId));
    },

    /** Distinct users with at least one subscription for the current key (stale-key rows are removed first). */
    async listActiveUserIds(keyId: string): Promise<string[]> {
      await deleteWhere(ne(webPushSubscriptions.vapidKeyId, keyId));
      const rows = await db.selectDistinct({ userId: webPushSubscriptions.userId }).from(webPushSubscriptions);
      return rows.map(r => r.userId);
    },

    /**
     * Re-checks the allowlist and key shape, sends, then applies the outcome: delete on 404/410, on a rejection
     * (400/401/403/413 or unusable keys) and once a subscription keeps failing; record otherwise.
     */
    async send(sub: WebPushSubscriptionRow, payload: WebPushInboxPayload): Promise<WebPushSendOutcome> {
      const vapid = getVapid();
      if (!vapid) return "rejected";
      const endpoint = canonicalPushEndpoint(sub.endpoint);
      if (!endpoint) {
        logger.warn({ subscriptionId: sub.id }, "Web push endpoint is not allowed; removing subscription");
        await deleteByEndpoint(sub.endpoint);
        return "gone";
      }
      if (!isValidWebPushP256dh(sub.p256dh) || !isValidWebPushAuth(sub.auth)) {
        logger.warn({ subscriptionId: sub.id }, "Web push keys are invalid; removing subscription");
        await deleteByEndpoint(sub.endpoint);
        return "rejected";
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // The overall timer keeps a hung connection from stalling the single delivery worker.
        await Promise.race([
          sendNotification({ endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify(payload), {
            TTL: 86400, urgency: "high", timeout: SEND_TIMEOUT_MS,
            vapidDetails: { subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
          }),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Web push send timed out")), overallTimeoutMs); }),
        ]);
        await recordResult(sub.id, "ok");
        return "ok";
      } catch (error) {
        const statusCode = (error as { statusCode?: number }).statusCode;
        const outcome = classifyPushStatus(statusCode);
        if (outcome === "gone") {
          await deleteByEndpoint(sub.endpoint);
          return outcome;
        }
        if (outcome === "rejected") {
          logger.warn({ subscriptionId: sub.id, statusCode }, "Web push rejected by push service; removing subscription");
          await deleteByEndpoint(sub.endpoint);
          return outcome;
        }
        const updated = await recordResult(sub.id, { code: String(statusCode ?? "network") });
        const lastGoodAt = (updated?.lastSuccessAt ?? sub.createdAt).getTime();
        if (updated && (updated.failureCount >= MAX_CONSECUTIVE_FAILURES || now() - lastGoodAt > MAX_WITHOUT_SUCCESS_MS)) {
          logger.warn({ subscriptionId: sub.id }, "Web push subscription keeps failing; removing it");
          await deleteByEndpoint(sub.endpoint);
        }
        return outcome;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export type WebPushSubscriptionService = ReturnType<typeof webPushSubscriptionService>;
