import { randomUUID } from "node:crypto";
import { parse as legacyParse } from "node:url";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { companies, createDb, webPushInboxNotices, webPushSubscriptions, type Db } from "@paperclipai/db";
import type { WebPushInboxPayload } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import {
  canonicalPushEndpoint, classifyPushStatus, isAllowedPushEndpoint, MAX_WEB_PUSH_SUBSCRIPTIONS_PER_USER, webPushSubscriptionService,
} from "../services/web-push-subscriptions.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;

const vapid = { publicKey: "pub", privateKey: "priv", keyId: "key-1", subject: "https://paperclip.test" };
const keys = { p256dh: "B".repeat(87), auth: "a".repeat(22) };
const payload: WebPushInboxPayload = { v: 1, title: "t", body: "b", url: "/X/decisions?item=a", tag: "a", companyId: randomUUID(), itemId: "a" };

describe("push endpoint allowlist", () => {
  const accepted = [
    "https://fcm.googleapis.com/fcm/send/abc",
    "https://updates.push.services.mozilla.com/wpush/v2/abc",
    "https://web.push.apple.com/abc",
    "https://eu.push.services.mozilla.com/x",
    "https://wns2-par02p.notify.windows.com/?token=abc",
  ];
  it.each(accepted)("accepts %s and the legacy parser sees the same host", endpoint => {
    expect(isAllowedPushEndpoint(endpoint)).toBe(true);
    expect(canonicalPushEndpoint(endpoint)).toBe(endpoint);
    expect(legacyParse(endpoint).hostname).toBe(new URL(endpoint).hostname);
    expect(legacyParse(endpoint).protocol).toBe("https:");
  });

  it.each([
    "https://evil.com;.googleapis.com/x",
    "https://evil.com'.googleapis.com/x",
    'https://evil.com".googleapis.com/x',
    "https://evil.com{.googleapis.com/x",
    "https://evil.com`.googleapis.com/x",
    "https://evil.com;.notify.windows.com/x",
    "https://evil.com;.push.services.mozilla.com/x",
    "https://evil.com;.web.push.apple.com/x",
    "http://fcm.googleapis.com/fcm/send/abc",
    "https://evil.example/push",
    "https://fcm.googleapis.com.evil.example/push",
    "https://evilgoogleapis.com/push",
    "https://evilnotify.windows.com.evil.example/push",
    "https://other.googleapis.com/x",
    "https://us-central.push.apple.com/x",
    "https://push.apple.com/x",
    "https://fcm.googleapis.com:8443/push",
    "https://fcm.googleapis.com:443/push",
    "https://user:pw@fcm.googleapis.com/push",
    "https://fcm.googleapis.com@evil.com/push",
    "https://fcm.googleapis.com./push",
    "https://FCM.googleapis.com/push",
    "https://fcm.googleapis.com/push#x",
    "https://127.0.0.1/push",
    "https://[::1]/push",
    "https://10.0.0.5/push",
    "https://169.254.169.254/latest",
    "https://2130706433/push",
    "not a url",
    "",
  ])("rejects %s", endpoint => expect(isAllowedPushEndpoint(endpoint)).toBe(false));

  it("documents why the check exists: the legacy parser reads the bypass host as evil.com", () => {
    expect(legacyParse("https://evil.com;.googleapis.com/x").hostname).toBe("evil.com");
  });
});

describe("push status classification", () => {
  it("maps status codes to outcomes", () => {
    expect([404, 410].map(classifyPushStatus)).toEqual(["gone", "gone"]);
    expect([400, 401, 403, 413].map(classifyPushStatus)).toEqual(["rejected", "rejected", "rejected", "rejected"]);
    expect([429, 500, 503, undefined].map(classifyPushStatus)).toEqual(["transient", "transient", "transient", "transient"]);
  });
});

describeDatabase("web push subscription service", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let sent: Array<{ endpoint: string; payload: string; options: any }>;
  let failWith: { statusCode?: number } | null;
  let vapidValue: typeof vapid | null;
  let svc: ReturnType<typeof webPushSubscriptionService>;

  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("paperclip-web-push-subs-"); db = createDb(database.connectionString); }, 90_000);
  afterAll(async () => { await database?.cleanup(); });
  beforeEach(async () => {
    await db.delete(webPushSubscriptions);
    sent = []; failWith = null; vapidValue = vapid;
    svc = webPushSubscriptionService(db, {
      getVapid: () => vapidValue,
      sendNotification: async (subscription, body, options) => {
        if (failWith) throw Object.assign(new Error("push failed"), failWith);
        sent.push({ endpoint: subscription.endpoint, payload: body, options });
        return {};
      },
    });
  });

  const endpoint = (n: number | string) => `https://fcm.googleapis.com/fcm/send/${n}`;
  const row = async (ep: string) => (await db.select().from(webPushSubscriptions).where(eq(webPushSubscriptions.endpoint, ep)))[0];

  it("upserts per endpoint for the same user and tracks whether anyone is subscribed", async () => {
    expect(svc.hasAnySubscriptions()).toBe(false);
    await svc.upsert("u1", { endpoint: endpoint(1), keys, userAgent: "Phone" }, "key-1");
    expect(svc.hasAnySubscriptions()).toBe(true);
    const summary = await svc.upsert("u1", { endpoint: endpoint(1), keys, userAgent: "Tablet" }, "key-1");
    expect(summary.userAgent).toBe("Tablet");
    expect(await svc.listForUser("u1")).toHaveLength(1);
  });

  it("refuses with 409 to take over an endpoint owned by another user and leaves the row untouched", async () => {
    await svc.upsert("u1", { endpoint: endpoint(1), keys, userAgent: "Phone" }, "key-1");
    await expect(svc.upsert("u2", { endpoint: endpoint(1), keys: { ...keys, auth: "b".repeat(22) }, userAgent: "Tablet" }, "key-1"))
      .rejects.toMatchObject({ status: 409 });
    expect(await row(endpoint(1))).toMatchObject({ userId: "u1", userAgent: "Phone", auth: keys.auth });
  });

  it("rejects a disallowed endpoint at the service and stores only the canonical value", async () => {
    await expect(svc.upsert("u1", { endpoint: "https://evil.com;.googleapis.com/x", keys }, "key-1")).rejects.toMatchObject({ status: 422 });
    await svc.upsert("u1", { endpoint: endpoint(1), keys }, "key-1");
    expect((await db.select().from(webPushSubscriptions)).map(r => r.endpoint)).toEqual([endpoint(1)]);
  });

  it("evicts the oldest subscription beyond the per-user cap", async () => {
    for (let n = 0; n < MAX_WEB_PUSH_SUBSCRIPTIONS_PER_USER + 2; n += 1) {
      await svc.upsert("u1", { endpoint: endpoint(n), keys }, "key-1");
      await db.update(webPushSubscriptions).set({ createdAt: new Date(Date.now() - (100 - n) * 1000) }).where(eq(webPushSubscriptions.endpoint, endpoint(n)));
    }
    const remaining = await db.select().from(webPushSubscriptions);
    expect(remaining).toHaveLength(MAX_WEB_PUSH_SUBSCRIPTIONS_PER_USER);
    expect(await row(endpoint(0))).toBeUndefined();
    expect(await row(endpoint(MAX_WEB_PUSH_SUBSCRIPTIONS_PER_USER + 1))).toBeDefined();
  });

  it("removes only the caller's own endpoint", async () => {
    await svc.upsert("u1", { endpoint: endpoint(1), keys }, "key-1");
    expect(await svc.remove("u2", endpoint(1))).toBe(false);
    expect(await row(endpoint(1))).toBeDefined();
    expect(await svc.remove("u1", endpoint(1))).toBe(true);
    expect(await row(endpoint(1))).toBeUndefined();
    expect(svc.hasAnySubscriptions()).toBe(false);
  });

  it("deletes rows signed with another VAPID key before listing users", async () => {
    await svc.upsert("u1", { endpoint: endpoint(1), keys }, "old-key");
    await svc.upsert("u2", { endpoint: endpoint(2), keys }, "key-1");
    expect(await svc.listActiveUserIds("key-1")).toEqual(["u2"]);
    expect(await row(endpoint(1))).toBeUndefined();
    await svc.upsert("u2", { endpoint: endpoint(3), keys }, "old-key");
    expect((await svc.listSendableForUser("u2", "key-1")).map(r => r.endpoint)).toEqual([endpoint(2)]);
  });

  it("sends the encrypted JSON payload with TTL, urgency and the VAPID details", async () => {
    await svc.upsert("u1", { endpoint: endpoint(1), keys }, "key-1");
    const [sub] = await svc.listSendableForUser("u1", "key-1");
    expect(await svc.send(sub!, payload)).toBe("ok");
    expect(JSON.parse(sent[0]!.payload)).toEqual(payload);
    expect(sent[0]!.options).toMatchObject({ TTL: 86400, urgency: "high", timeout: 10000, vapidDetails: { subject: vapid.subject, publicKey: "pub", privateKey: "priv" } });
    expect((await row(endpoint(1)))!.lastSuccessAt).not.toBeNull();
  });

  it.each([404, 410])("deletes the subscription on %i", async statusCode => {
    await svc.upsert("u1", { endpoint: endpoint(1), keys }, "key-1");
    const [sub] = await svc.listSendableForUser("u1", "key-1");
    failWith = { statusCode };
    expect(await svc.send(sub!, payload)).toBe("gone");
    expect(await row(endpoint(1))).toBeUndefined();
    expect(svc.hasAnySubscriptions()).toBe(false);
  });

  it("keeps the row and counts failures on 503 and resets them on success", async () => {
    await svc.upsert("u1", { endpoint: endpoint(1), keys }, "key-1");
    const [sub] = await svc.listSendableForUser("u1", "key-1");
    failWith = { statusCode: 503 };
    expect(await svc.send(sub!, payload)).toBe("transient");
    expect(await svc.send(sub!, payload)).toBe("transient");
    expect(await row(endpoint(1))).toMatchObject({ failureCount: 2, lastFailureCode: "503" });
    failWith = null;
    await svc.send(sub!, payload);
    expect(await row(endpoint(1))).toMatchObject({ failureCount: 0, lastFailureCode: null });
  });

  it.each([400, 401, 403, 413])("deletes the subscription when the push service rejects it with %i", async statusCode => {
    await svc.upsert("u1", { endpoint: endpoint(1), keys }, "key-1");
    const [sub] = await svc.listSendableForUser("u1", "key-1");
    failWith = { statusCode };
    expect(await svc.send(sub!, payload)).toBe("rejected");
    expect(await row(endpoint(1))).toBeUndefined();
    expect(svc.hasAnySubscriptions()).toBe(false);
  });

  it("deletes a subscription after 10 consecutive transient failures", async () => {
    await svc.upsert("u1", { endpoint: endpoint(1), keys }, "key-1");
    const [sub] = await svc.listSendableForUser("u1", "key-1");
    failWith = { statusCode: 503 };
    for (let n = 0; n < 9; n += 1) await svc.send(sub!, payload);
    expect(await row(endpoint(1))).toMatchObject({ failureCount: 9 });
    await svc.send(sub!, payload);
    expect(await row(endpoint(1))).toBeUndefined();
  });

  it("deletes a subscription that failed transiently after seven days without a success", async () => {
    await svc.upsert("u1", { endpoint: endpoint(1), keys }, "key-1");
    await db.update(webPushSubscriptions).set({ createdAt: new Date(Date.now() - 8 * 86_400_000) });
    const [sub] = await svc.listSendableForUser("u1", "key-1");
    failWith = { statusCode: 503 };
    await svc.send(sub!, payload);
    expect(await row(endpoint(1))).toBeUndefined();
    await svc.upsert("u1", { endpoint: endpoint(2), keys }, "key-1");
    const [fresh] = await svc.listSendableForUser("u1", "key-1");
    await svc.send(fresh!, payload);
    expect(await row(endpoint(2))).toBeDefined();
  });

  it("deletes a subscription whose stored keys are malformed without calling out", async () => {
    await db.insert(webPushSubscriptions).values({ userId: "u1", endpoint: endpoint(1), p256dh: "p".repeat(87), auth: keys.auth, vapidKeyId: "key-1" });
    const [sub] = await svc.listSendableForUser("u1", "key-1");
    expect(await svc.send(sub!, payload)).toBe("rejected");
    expect(sent).toHaveLength(0);
    expect(await row(endpoint(1))).toBeUndefined();
  });

  it("does not let a hung send stall the caller and counts it as a transient failure", async () => {
    const hung = webPushSubscriptionService(db, { getVapid: () => vapid, sendNotification: () => new Promise(() => {}), overallTimeoutMs: 20 });
    await hung.upsert("u1", { endpoint: endpoint(1), keys }, "key-1");
    const [sub] = await hung.listSendableForUser("u1", "key-1");
    expect(await hung.send(sub!, payload)).toBe("transient");
    expect(await row(endpoint(1))).toMatchObject({ failureCount: 1, lastFailureCode: "network" });
  });

  it("deletes the user's inbox notices, baseline included, when their last subscription goes", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Notice fixture", issuePrefix: `N${companyId.slice(0, 6).toUpperCase()}` });
    const seed = async () => {
      await db.delete(webPushInboxNotices);
      await db.insert(webPushInboxNotices).values(["__baseline__", "decision:a"].map(itemKey => ({ userId: "u1", companyId, itemKey })));
      await db.insert(webPushInboxNotices).values({ userId: "u2", companyId, itemKey: "__baseline__" });
    };
    const noticeCount = async (userId: string) => (await db.select().from(webPushInboxNotices).where(eq(webPushInboxNotices.userId, userId))).length;

    await svc.upsert("u1", { endpoint: endpoint(1), keys }, "key-1");
    await svc.upsert("u1", { endpoint: endpoint(2), keys }, "key-1");
    await svc.upsert("u2", { endpoint: endpoint(3), keys }, "key-1");
    await seed();
    await svc.remove("u1", endpoint(1));
    expect(await noticeCount("u1")).toBe(2); // another device remains
    await svc.remove("u1", endpoint(2));
    expect(await noticeCount("u1")).toBe(0);
    expect(await noticeCount("u2")).toBe(1);

    // 410 cleanup and stale-key eviction behave the same way.
    await seed();
    failWith = { statusCode: 410 };
    const [sub] = await svc.listSendableForUser("u2", "key-1");
    await svc.send(sub!, payload);
    expect(await noticeCount("u2")).toBe(0);
    await seed();
    await svc.upsert("u1", { endpoint: endpoint(4), keys }, "old-key");
    await svc.listActiveUserIds("key-1");
    expect(await noticeCount("u1")).toBe(0);
    await db.delete(webPushInboxNotices);
    await db.delete(companies).where(eq(companies.id, companyId));
  });

  it("treats a network error as transient", async () => {
    await svc.upsert("u1", { endpoint: endpoint(1), keys }, "key-1");
    const [sub] = await svc.listSendableForUser("u1", "key-1");
    failWith = {};
    expect(await svc.send(sub!, payload)).toBe("transient");
    expect((await row(endpoint(1)))!.lastFailureCode).toBe("network");
  });

  it("re-checks the allowlist before sending and removes a disallowed endpoint without calling out", async () => {
    // Inserted directly: a row written before the allowlist existed, or by other means.
    await db.insert(webPushSubscriptions).values({ userId: "u1", endpoint: "https://evil.example/push", p256dh: keys.p256dh, auth: keys.auth, vapidKeyId: "key-1" });
    const [sub] = await svc.listSendableForUser("u1", "key-1");
    expect(await svc.send(sub!, payload)).toBe("gone");
    expect(sent).toHaveLength(0);
    expect(await row("https://evil.example/push")).toBeUndefined();
  });

  it("does not send when push has no VAPID key", async () => {
    await svc.upsert("u1", { endpoint: endpoint(1), keys }, "key-1");
    const [sub] = await svc.listSendableForUser("u1", "key-1");
    vapidValue = null;
    expect(await svc.send(sub!, payload)).toBe("rejected");
    expect(sent).toHaveLength(0);
  });
});
