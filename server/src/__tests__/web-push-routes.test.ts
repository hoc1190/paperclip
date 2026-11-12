import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const subscriptions = vi.hoisted(() => ({
  upsert: vi.fn(),
  remove: vi.fn(),
  listForUser: vi.fn(),
}));
const reconcile = vi.hoisted(() => vi.fn());

const vapid = { publicKey: "BPublicKey", privateKey: "priv", keyId: "key-1", subject: "https://paperclip.test" };
const keys = { p256dh: "B".repeat(87), auth: "a".repeat(22) };
const goodEndpoint = "https://fcm.googleapis.com/fcm/send/abc";
const boardActor = { type: "board", userId: "local-board", source: "local_implicit", isInstanceAdmin: true };

async function createApp(actor: Record<string, unknown>, options: { vapid?: typeof vapid | null; enabled?: boolean; withReconcile?: boolean; standby?: boolean } = {}) {
  const { errorHandler } = await import("../middleware/index.js");
  const { webPushRoutes } = await import("../routes/web-push.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.actor = actor as never; next(); });
  app.use("/api", webPushRoutes({}, {
    subscriptions: subscriptions as never,
    reconcile: () => (options.withReconcile === false ? undefined : reconcile),
    getVapid: () => (options.vapid === undefined ? vapid : options.vapid),
    isEnabled: () => options.enabled ?? true,
    isWarmStandby: () => options.standby ?? false,
  }));
  app.use(errorHandler);
  return app;
}

describe("web push routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    subscriptions.upsert.mockResolvedValue({ id: "sub-1", userAgent: "Phone", createdAt: "2026-11-12T00:00:00.000Z", lastSuccessAt: null });
    subscriptions.remove.mockResolvedValue(true);
    subscriptions.listForUser.mockResolvedValue([]);
    reconcile.mockResolvedValue(undefined);
  });

  it("returns the public key as config", async () => {
    const res = await request(await createApp(boardActor)).get("/api/web-push/config");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: true, publicKey: "BPublicKey" });
  });

  it("reports disabled when the env switch is off or no key is available", async () => {
    expect((await request(await createApp(boardActor, { enabled: false })).get("/api/web-push/config")).body).toEqual({ enabled: false, publicKey: null });
    expect((await request(await createApp(boardActor, { vapid: null })).get("/api/web-push/config")).body).toEqual({ enabled: false, publicKey: null });
  });

  it("registers a subscription for the caller and asks the notifier to reconcile", async () => {
    const res = await request(await createApp(boardActor)).put("/api/web-push/subscriptions/me")
      .send({ endpoint: goodEndpoint, keys, userAgent: "Phone" });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe("sub-1");
    expect(subscriptions.upsert).toHaveBeenCalledWith("local-board", expect.objectContaining({ endpoint: goodEndpoint, keys }), "key-1");
    expect(reconcile).toHaveBeenCalledWith({ userId: "local-board" });
  });

  it("still succeeds when the notifier is not running or reconcile fails", async () => {
    expect((await request(await createApp(boardActor, { withReconcile: false })).put("/api/web-push/subscriptions/me")
      .send({ endpoint: goodEndpoint, keys })).status).toBe(200);
    reconcile.mockRejectedValue(new Error("db down"));
    expect((await request(await createApp(boardActor)).put("/api/web-push/subscriptions/me").send({ endpoint: goodEndpoint, keys })).status).toBe(200);
  });

  it.each([
    "https://evil.example/push",
    "https://127.0.0.1/push",
    "https://push.apple.com/push",
    "https://other.googleapis.com/push",
  ])("rejects a disallowed endpoint %s", async endpoint => {
    const res = await request(await createApp(boardActor)).put("/api/web-push/subscriptions/me").send({ endpoint, keys });
    expect(res.status).toBe(422);
    expect(subscriptions.upsert).not.toHaveBeenCalled();
  });

  it("rejects http endpoints and malformed bodies", async () => {
    const app = await createApp(boardActor);
    expect((await request(app).put("/api/web-push/subscriptions/me").send({ endpoint: "http://fcm.googleapis.com/x", keys })).status).toBe(400);
    expect((await request(app).put("/api/web-push/subscriptions/me").send({ endpoint: goodEndpoint, keys: { p256dh: "x", auth: "y" } })).status).toBe(400);
    expect(subscriptions.upsert).not.toHaveBeenCalled();
  });

  it.each([
    "https://evil.com;.googleapis.com/x",
    "https://evil.com'.googleapis.com/x",
    "https://fcm.googleapis.com:8443/push",
  ])("rejects a parser-confusing endpoint %s before it reaches the service", async endpoint => {
    const res = await request(await createApp(boardActor)).put("/api/web-push/subscriptions/me").send({ endpoint, keys });
    expect(res.status).toBe(400);
    expect(subscriptions.upsert).not.toHaveBeenCalled();
  });

  it("answers 409 when the endpoint belongs to another user", async () => {
    const { conflict } = await import("../errors.js");
    subscriptions.upsert.mockRejectedValue(conflict("Push endpoint is registered by another user"));
    const res = await request(await createApp(boardActor)).put("/api/web-push/subscriptions/me").send({ endpoint: goodEndpoint, keys });
    expect(res.status).toBe(409);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("answers 503 on every route on a warm standby", async () => {
    const app = await createApp(boardActor, { standby: true });
    for (const res of [
      await request(app).get("/api/web-push/config"),
      await request(app).get("/api/web-push/subscriptions/me"),
      await request(app).put("/api/web-push/subscriptions/me").send({ endpoint: goodEndpoint, keys }),
      await request(app).post("/api/web-push/subscriptions/me/unsubscribe").send({ endpoint: goodEndpoint }),
    ]) expect(res.status).toBe(503);
    expect(subscriptions.upsert).not.toHaveBeenCalled();
  });

  it("refuses to register while push is disabled", async () => {
    const res = await request(await createApp(boardActor, { enabled: false })).put("/api/web-push/subscriptions/me").send({ endpoint: goodEndpoint, keys });
    expect(res.status).toBe(503);
    expect(subscriptions.upsert).not.toHaveBeenCalled();
  });

  it("lists only the caller's subscriptions", async () => {
    subscriptions.listForUser.mockResolvedValue([{ id: "s", userAgent: null, createdAt: "x", lastSuccessAt: null }]);
    const res = await request(await createApp(boardActor)).get("/api/web-push/subscriptions/me");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(subscriptions.listForUser).toHaveBeenCalledWith("local-board");
  });

  it("unsubscribes with the caller's user id and answers 204 even if nothing matched", async () => {
    const app = await createApp({ ...boardActor, userId: "u-9" });
    expect((await request(app).post("/api/web-push/subscriptions/me/unsubscribe").send({ endpoint: goodEndpoint })).status).toBe(204);
    expect(subscriptions.remove).toHaveBeenCalledWith("u-9", goodEndpoint);
    subscriptions.remove.mockResolvedValue(false);
    expect((await request(app).post("/api/web-push/subscriptions/me/unsubscribe").send({ endpoint: goodEndpoint })).status).toBe(204);
  });

  it.each([
    ["agent", { type: "agent", agentId: "a1", companyId: "c1" }],
    ["unauthenticated", { type: "none" }],
  ])("rejects a %s actor on every route", async (_name, actor) => {
    const app = await createApp(actor);
    for (const res of [
      await request(app).get("/api/web-push/config"),
      await request(app).get("/api/web-push/subscriptions/me"),
      await request(app).put("/api/web-push/subscriptions/me").send({ endpoint: goodEndpoint, keys }),
      await request(app).post("/api/web-push/subscriptions/me/unsubscribe").send({ endpoint: goodEndpoint }),
    ]) expect([401, 403]).toContain(res.status);
    expect(subscriptions.upsert).not.toHaveBeenCalled();
    expect(subscriptions.remove).not.toHaveBeenCalled();
  });

  it("requires a board user id", async () => {
    const res = await request(await createApp({ type: "board", source: "local_implicit" })).get("/api/web-push/subscriptions/me");
    expect(res.status).toBe(403);
  });
});
