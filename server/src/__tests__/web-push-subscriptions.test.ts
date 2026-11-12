import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, webPushSubscriptions, type Db } from "@paperclipai/db";
import type { WebPushInboxPayload } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import {
  classifyPushStatus, isAllowedPushEndpoint, MAX_WEB_PUSH_SUBSCRIPTIONS_PER_USER, webPushSubscriptionService,
} from "../services/web-push-subscriptions.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;

const vapid = { publicKey: "pub", privateKey: "priv", keyId: "key-1", subject: "https://paperclip.test" };
const keys = { p256dh: "p".repeat(87), auth: "a".repeat(22) };
const payload: WebPushInboxPayload = { v: 1, title: "t", body: "b", url: "/X/decisions?item=a", tag: "a", companyId: randomUUID(), itemId: "a" };

describe("push endpoint allowlist", () => {
  it.each([
    "https://fcm.googleapis.com/fcm/send/abc",
    "https://updates.push.services.mozilla.com/wpush/v2/abc",
    "https://web.push.apple.com/abc",
    "https://eu.push.services.mozilla.com/x",
    "https://wns2-par02p.notify.windows.com/?token=abc",
    "https://us-central.push.apple.com/x",
  ])("accepts %s", endpoint => expect(isAllowedPushEndpoint(endpoint)).toBe(true));

  it.each([
    "http://fcm.googleapis.com/fcm/send/abc",
    "https://evil.example/push",
    "https://fcm.googleapis.com.evil.example/push",
    "https://evilgoogleapis.com/push",
    "https://fcm.googleapis.com:8443/push",
    "https://user:pw@fcm.googleapis.com/push",
    "https://127.0.0.1/push",
    "https://[::1]/push",
    "https://10.0.0.5/push",
    "https://169.254.169.254/latest",
    "not a url",
    "",
  ])("rejects %s", endpoint => expect(isAllowedPushEndpoint(endpoint)).toBe(false));
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

  it("upserts per endpoint, moves ownership, and tracks whether anyone is subscribed", async () => {
    expect(svc.hasAnySubscriptions()).toBe(false);
    await svc.upsert("u1", { endpoint: endpoint(1), keys, userAgent: "Phone" }, "key-1");
    expect(svc.hasAnySubscriptions()).toBe(true);
    const summary = await svc.upsert("u2", { endpoint: endpoint(1), keys, userAgent: "Tablet" }, "key-1");
    expect(summary.userAgent).toBe("Tablet");
    expect(await svc.listForUser("u1")).toEqual([]);
    expect(await svc.listForUser("u2")).toHaveLength(1);
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
    expect(sent[0]!.options).toMatchObject({ TTL: 86400, urgency: "high", vapidDetails: { subject: vapid.subject, publicKey: "pub", privateKey: "priv" } });
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

  it("keeps the row and counts failures on 503, and keeps it with the code on 403", async () => {
    await svc.upsert("u1", { endpoint: endpoint(1), keys }, "key-1");
    const [sub] = await svc.listSendableForUser("u1", "key-1");
    failWith = { statusCode: 503 };
    expect(await svc.send(sub!, payload)).toBe("transient");
    expect(await svc.send(sub!, payload)).toBe("transient");
    expect(await row(endpoint(1))).toMatchObject({ failureCount: 2, lastFailureCode: "503" });
    failWith = { statusCode: 403 };
    expect(await svc.send(sub!, payload)).toBe("rejected");
    expect(await row(endpoint(1))).toMatchObject({ failureCount: 3, lastFailureCode: "403" });
    failWith = null;
    await svc.send(sub!, payload);
    expect(await row(endpoint(1))).toMatchObject({ failureCount: 0, lastFailureCode: null });
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
