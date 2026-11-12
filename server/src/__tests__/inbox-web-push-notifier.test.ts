import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { companies, companyMemberships, createDb, webPushInboxNotices, webPushSubscriptions, type Db } from "@paperclipai/db";
import type { WebPushInboxPayload } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";
import { fitWebPushPayload, inboxWebPushNotifier, type InboxPushItem } from "../services/inbox-web-push-notifier.js";
import { publishLiveEvent } from "../services/live-events.js";
import { webPushSubscriptionService } from "../services/web-push-subscriptions.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;

const keys = { p256dh: "B".repeat(87), auth: "a".repeat(22) };
const vapid = { publicKey: "pub", privateKey: "priv", keyId: "key-1", subject: "https://paperclip.test" };

describe("web push payload sizing", () => {
  const base: WebPushInboxPayload = { v: 1, title: "Short title", body: "ask", url: "/X/decisions?item=a", tag: "a", companyId: "c", itemId: "a" };
  it("keeps a normal payload, including a long title, untouched", () => {
    expect(fitWebPushPayload(base)).toBe(base);
    const long = { ...base, title: "Tiêu đề dài ".repeat(40) };
    expect(fitWebPushPayload(long).title).toBe(long.title);
  });
  it("shortens the body first, then the title, to stay under the limit", () => {
    const hugeBody = fitWebPushPayload({ ...base, body: "b".repeat(10_000) });
    expect(hugeBody.title).toBe(base.title);
    expect(Buffer.byteLength(JSON.stringify(hugeBody))).toBeLessThanOrEqual(3000);
    expect(hugeBody.body.endsWith("…")).toBe(true);
    const hugeTitle = fitWebPushPayload({ ...base, title: "t".repeat(10_000), body: "b".repeat(10_000) });
    expect(Buffer.byteLength(JSON.stringify(hugeTitle))).toBeLessThanOrEqual(3000);
    expect(hugeTitle.title.endsWith("…")).toBe(true);
  });
});

describeDatabase("inbox web push notifier", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let companyId: string;
  let prefix: string;
  let clock: number;
  let pending: InboxPushItem[];
  let listCalls: number;
  let listFails: boolean;
  let pushes: Array<{ endpoint: string; payload: WebPushInboxPayload }>;
  let failByEndpoint: Record<string, number>;
  let tasks: Array<{ queue: string; run: (signal: AbortSignal) => Promise<unknown>; nextRunAt?: () => number | null; hasPending: () => Promise<boolean> }>;
  let wake: ReturnType<typeof vi.fn>;
  let stoppers: Array<() => Promise<void>>;
  let subs: ReturnType<typeof webPushSubscriptionService>;

  const item = (key: string, overrides: Partial<InboxPushItem> = {}, title = `Task ${key}`): InboxPushItem => ({
    id: `decision:${key}`, dedupKey: key, sourceKind: "decision", whyNow: "Cần câu trả lời",
    activityAt: new Date(clock).toISOString(), originAgentName: "CTO",
    relatedIssue: { identifier: "HOC-1", title: "Issue title" } as InboxPushItem["relatedIssue"],
    subject: { kind: "decision", id: key, title, identifier: null } as unknown as InboxPushItem["subject"],
    ...overrides,
  });

  const fakeCoordinator = () => ({
    register: (queue: string, task: (typeof tasks)[number]) => {
      tasks.push({ ...task, queue });
      return { wake, stop: async () => {} };
    },
  }) as never;

  const make = async (extra: Partial<Parameters<typeof inboxWebPushNotifier>[2]> = {}) => {
    const notifier = inboxWebPushNotifier(db, fakeCoordinator(), {
      listPending: async () => { listCalls += 1; if (listFails) throw new Error("feed down"); return pending; },
      vapid, subscriptions: subs, now: () => clock, coalesceMs: 3000, ...extra,
    });
    stoppers.push(notifier.stop);
    return notifier;
  };
  const task = () => tasks.find(t => t.queue === DELIVERY_QUEUES.webPushInbox)!;
  const flush = async () => { clock += 10_000; await task().run(new AbortController().signal); };
  const subscribe = (n: number, userId = "local-board", keyId = "key-1") =>
    subs.upsert(userId, { endpoint: `https://fcm.googleapis.com/fcm/send/${n}`, keys, userAgent: `Device ${n}` }, keyId);
  const emit = () => publishLiveEvent({ companyId, type: "activity.logged" });
  const notices = () => db.select().from(webPushInboxNotices).where(eq(webPushInboxNotices.companyId, companyId));

  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("paperclip-web-push-notifier-"); db = createDb(database.connectionString); }, 90_000);
  afterAll(async () => { await database?.cleanup(); });
  beforeEach(async () => {
    await Promise.all(stoppers?.map(stop => stop()) ?? []);
    await db.delete(webPushSubscriptions);
    await db.delete(webPushInboxNotices);
    // Startup and reconcile passes cover every company of the user, so drop earlier fixtures.
    await db.delete(companyMemberships);
    await db.delete(companies);
    companyId = randomUUID();
    prefix = `W${companyId.slice(0, 6).toUpperCase()}`;
    clock = Date.parse("2026-11-12T00:00:00Z");
    pending = []; listCalls = 0; listFails = false; pushes = []; failByEndpoint = {}; tasks = []; stoppers = []; wake = vi.fn();
    await db.insert(companies).values({ id: companyId, name: "Fixture", issuePrefix: prefix });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "local-board", status: "active" });
    subs = webPushSubscriptionService(db, {
      getVapid: () => vapid,
      sendNotification: async (subscription, body) => {
        const status = failByEndpoint[subscription.endpoint];
        if (status) throw Object.assign(new Error("push failed"), { statusCode: status });
        pushes.push({ endpoint: subscription.endpoint, payload: JSON.parse(body) });
        return {};
      },
    });
  });

  it("writes a silent baseline on first enable, then pushes a new item exactly once with the full title and deep link", async () => {
    await subscribe(1);
    pending = [item("old")];
    const notifier = await make();
    await notifier.requestReconcile({ userId: "local-board" });
    await flush();
    expect(pushes).toHaveLength(0);
    expect((await notices()).map(n => n.itemKey).sort()).toEqual(["__baseline__", "decision:old"]);

    const fullTitle = "A very long title that must never be clipped in the notification ".repeat(3).trim();
    pending = [item("old"), item("new", {}, fullTitle)];
    emit();
    await flush();
    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.payload).toEqual({
      v: 1, title: fullTitle, body: "Cần bạn quyết định · HOC-1 · CTO",
      url: `/${prefix}/decisions?item=${encodeURIComponent("decision:new")}`,
      tag: "decision:new", companyId, itemId: "decision:new",
    });

    // Another flush, then a simulated restart with a fresh notifier: no repeat.
    emit(); await flush();
    tasks = [];
    const restarted = await make();
    await restarted.start();
    await flush();
    expect(pushes).toHaveLength(1);
  });

  it("never pushes recovery_action items", async () => {
    await subscribe(1);
    const notifier = await make();
    await notifier.requestReconcile({ userId: "local-board" });
    await flush();
    pending = [item("r", { id: "recovery_action:r", sourceKind: "recovery_action" })];
    emit(); await flush();
    expect(pushes).toHaveLength(0);
  });

  it("fans out to every device and cleans up 404/410 but keeps a 503 device with a failure count", async () => {
    await subscribe(1); await subscribe(2); await subscribe(3); await subscribe(4);
    const notifier = await make();
    await notifier.requestReconcile({ userId: "local-board" });
    await flush();
    failByEndpoint = {
      "https://fcm.googleapis.com/fcm/send/2": 410,
      "https://fcm.googleapis.com/fcm/send/3": 404,
      "https://fcm.googleapis.com/fcm/send/4": 503,
    };
    pending = [item("a")];
    emit(); await flush();
    expect(pushes.map(p => p.endpoint)).toEqual(["https://fcm.googleapis.com/fcm/send/1"]);
    const remaining = await db.select().from(webPushSubscriptions);
    expect(remaining.map(r => r.endpoint).sort()).toEqual(["https://fcm.googleapis.com/fcm/send/1", "https://fcm.googleapis.com/fcm/send/4"]);
    expect(remaining.find(r => r.endpoint.endsWith("/4"))).toMatchObject({ failureCount: 1, lastFailureCode: "503" });

    // A failed send is not retried: the item stays claimed.
    emit(); await flush();
    expect(pushes).toHaveLength(1);
  });

  it("pushes at most maxPerRun items oldest first, then one summary, and marks all of them notified", async () => {
    await subscribe(1);
    const notifier = await make({ maxPerRun: 5 });
    await notifier.requestReconcile({ userId: "local-board" });
    await flush();
    pending = Array.from({ length: 8 }, (_, n) => item(`n${n}`, { activityAt: new Date(clock + (7 - n) * 1000).toISOString() }));
    emit(); await flush();
    expect(pushes).toHaveLength(6);
    // Oldest activityAt first: n7 is the oldest.
    expect(pushes.slice(0, 5).map(p => p.payload.itemId)).toEqual(["decision:n7", "decision:n6", "decision:n5", "decision:n4", "decision:n3"]);
    expect(pushes[5]!.payload).toMatchObject({ title: "+3 mục mới trong Inbox", url: `/${prefix}/decisions`, companyId, renotify: true });
    expect(pushes[5]!.payload.tag.startsWith("inbox-summary:")).toBe(true);
    expect(pushes[0]!.payload.renotify).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(pushes[5]!.payload))).toBeLessThanOrEqual(3000);
    expect((await notices()).length).toBe(1 + 8);
    emit(); await flush();
    expect(pushes).toHaveLength(6);
  });

  it("does not re-push an item that resolves and returns within seven days, and prunes old resolved keys", async () => {
    await subscribe(1);
    const notifier = await make();
    await notifier.requestReconcile({ userId: "local-board" });
    await flush();
    pending = [item("flap")];
    emit(); await flush();
    expect(pushes).toHaveLength(1);
    pending = [];
    emit(); await flush();
    pending = [item("flap")];
    emit(); await flush();
    expect(pushes).toHaveLength(1);

    pending = [];
    clock += 8 * 24 * 60 * 60_000;
    emit(); await flush();
    expect((await notices()).map(n => n.itemKey)).toEqual(["__baseline__"]);
  });

  it("coalesces a burst of events into one scheduled flush and ignores noisy event types", async () => {
    await subscribe(1);
    await make();
    for (let n = 0; n < 20; n += 1) emit();
    publishLiveEvent({ companyId, type: "heartbeat.run.log" as never });
    publishLiveEvent({ companyId, type: "heartbeat.run.event" as never });
    expect(task().nextRunAt!()).toBe(clock + 3000);
    // Not due yet: running does nothing and costs no feed read.
    await task().run(new AbortController().signal);
    expect(listCalls).toBe(0);
    await flush();
    expect(listCalls).toBe(1);
    expect(task().nextRunAt!()).toBeNull();
  });

  it("stays completely quiet when nobody is subscribed", async () => {
    const notifier = await make();
    await notifier.start();
    emit(); emit();
    expect(task().nextRunAt!()).toBeNull();
    expect(wake).not.toHaveBeenCalled();
    await flush();
    expect(listCalls).toBe(0);
    expect(await task().hasPending()).toBe(false);
  });

  it("makes one startup pass for existing subscribers to catch items created while down", async () => {
    await subscribe(1);
    // Baseline already exists from an earlier run of the server.
    await db.insert(webPushInboxNotices).values({ userId: "local-board", companyId, itemKey: "__baseline__" });
    pending = [item("while-down")];
    const notifier = await make();
    await notifier.start();
    expect(task().nextRunAt!()).not.toBeNull();
    await flush();
    expect(pushes.map(p => p.payload.itemId)).toEqual(["decision:while-down"]);
    await flush();
    expect(listCalls).toBe(1);
  });

  it("does nothing on a warm standby and after stop", async () => {
    await subscribe(1);
    await make({ isWarmStandby: () => true });
    emit();
    expect(task().nextRunAt!()).toBeNull();
    const notifier = await make();
    await notifier.stop();
    emit();
    expect(task().nextRunAt!()).toBeNull();
  });

  it("drops subscriptions signed with another VAPID key instead of sending", async () => {
    await subscribe(1, "local-board", "old-key");
    const notifier = await make();
    await notifier.requestReconcile({ userId: "local-board" });
    await flush();
    expect(await db.select().from(webPushSubscriptions)).toHaveLength(0);
    expect(listCalls).toBe(0);
  });

  it("only notifies companies the user is an active member of and that had events", async () => {
    await subscribe(1);
    const otherCompany = randomUUID();
    await db.insert(companies).values({ id: otherCompany, name: "Other", issuePrefix: `O${otherCompany.slice(0, 6).toUpperCase()}` });
    await db.insert(companyMemberships).values({ companyId: otherCompany, principalType: "user", principalId: "someone-else", status: "active" });
    const notifier = await make();
    await notifier.requestReconcile({ userId: "local-board" });
    await flush();
    expect(listCalls).toBe(1);
    publishLiveEvent({ companyId: otherCompany, type: "agent.status" });
    await flush();
    expect(listCalls).toBe(1);
    const noticeRows = await db.select().from(webPushInboxNotices).where(and(eq(webPushInboxNotices.companyId, otherCompany)));
    expect(noticeRows).toHaveLength(0);
  });

  it("keeps going and does not claim items when the feed read fails, and retries on the next event", async () => {
    await subscribe(1);
    const notifier = await make();
    await notifier.requestReconcile({ userId: "local-board" });
    await flush();
    pending = [item("a")];
    listFails = true;
    emit(); await flush();
    expect(pushes).toHaveLength(0);
    expect((await notices()).map(n => n.itemKey)).toEqual(["__baseline__"]);
    listFails = false;
    emit(); await flush();
    expect(pushes).toHaveLength(1);
  });

  it("retries a failed company flush after about five seconds without a new event, with bounded attempts", async () => {
    await subscribe(1);
    const notifier = await make();
    await notifier.requestReconcile({ userId: "local-board" });
    await flush();
    pending = [item("a")];
    listFails = true;
    emit(); await flush();
    expect(pushes).toHaveLength(0);
    const at = task().nextRunAt!();
    expect(at).toBe(clock + 5000);
    listFails = false;
    clock = at!;
    await task().run(new AbortController().signal);
    expect(pushes).toHaveLength(1);

    // Bounded: a permanently failing feed stops rescheduling after the retry budget.
    pending = [item("b")];
    listFails = true;
    emit(); await flush();
    for (let n = 0; n < 5; n += 1) {
      expect(task().nextRunAt!()).not.toBeNull();
      clock = task().nextRunAt!();
      await task().run(new AbortController().signal);
    }
    expect(task().nextRunAt!()).toBeNull();
  });

  it("re-baselines when the last subscription is removed, so items from while disabled are not pushed on re-enable", async () => {
    await subscribe(1);
    pending = [item("old")];
    const notifier = await make();
    await notifier.requestReconcile({ userId: "local-board" });
    await flush();
    expect((await notices()).length).toBe(2);

    expect(await subs.remove("local-board", "https://fcm.googleapis.com/fcm/send/1")).toBe(true);
    expect(await notices()).toHaveLength(0);

    pending = [item("old"), item("while-disabled")];
    await subscribe(2);
    await notifier.requestReconcile({ userId: "local-board" });
    await flush();
    expect(pushes).toHaveLength(0);
    expect((await notices()).map(n => n.itemKey).sort()).toEqual(["__baseline__", "decision:old", "decision:while-disabled"]);
  });

  it("keeps the notices while the user still has another device", async () => {
    await subscribe(1); await subscribe(2);
    const notifier = await make();
    await notifier.requestReconcile({ userId: "local-board" });
    await flush();
    await subs.remove("local-board", "https://fcm.googleapis.com/fcm/send/1");
    expect((await notices()).map(n => n.itemKey)).toEqual(["__baseline__"]);
  });
});
