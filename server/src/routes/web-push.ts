import { Router, type Request, type Response } from "express";
import { webPushSubscribeSchema, webPushUnsubscribeSchema, type WebPushConfig } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { logger } from "../middleware/logger.js";
import type { WebPushSubscriptionService } from "../services/web-push-subscriptions.js";
import { isAllowedPushEndpoint } from "../services/web-push-subscriptions.js";
import { resolveWebPushVapid, type WebPushVapid } from "../services/web-push-vapid.js";
import { assertBoard } from "./authz.js";

function requireBoardUserId(req: Request, res: Response): string | null {
  assertBoard(req);
  if (!req.actor.userId) {
    res.status(403).json({ error: "Board user context required" });
    return null;
  }
  return req.actor.userId;
}

export function webPushRoutes(_db: unknown, deps: {
  subscriptions: WebPushSubscriptionService;
  /** Resolved lazily: the notifier is wired after the app is built. */
  reconcile: () => ((input: { userId: string }) => Promise<void>) | undefined;
  getVapid?: () => WebPushVapid | null;
  isEnabled?: () => boolean;
}) {
  const router = Router();
  const getVapid = deps.getVapid ?? (() => resolveWebPushVapid());
  const isEnabled = deps.isEnabled ?? (() => process.env.PAPERCLIP_WEB_PUSH !== "false");
  const activeVapid = () => (isEnabled() ? getVapid() : null);

  router.get("/web-push/config", (req, res) => {
    if (!requireBoardUserId(req, res)) return;
    const vapid = activeVapid();
    const config: WebPushConfig = { enabled: vapid !== null, publicKey: vapid?.publicKey ?? null };
    res.json(config);
  });

  router.get("/web-push/subscriptions/me", async (req, res) => {
    const userId = requireBoardUserId(req, res);
    if (!userId) return;
    res.json(await deps.subscriptions.listForUser(userId));
  });

  router.put("/web-push/subscriptions/me", validate(webPushSubscribeSchema), async (req, res) => {
    const userId = requireBoardUserId(req, res);
    if (!userId) return;
    const vapid = activeVapid();
    if (!vapid) {
      res.status(503).json({ error: "Web push is disabled" });
      return;
    }
    if (!isAllowedPushEndpoint(req.body.endpoint)) {
      res.status(422).json({ error: "Push endpoint host is not allowed" });
      return;
    }
    const summary = await deps.subscriptions.upsert(userId, req.body, vapid.keyId);
    logger.info({ userId, subscriptionId: summary.id }, "web push subscription registered");
    // Best effort: writes the baseline now so only later items push.
    void deps.reconcile()?.({ userId }).catch(error => logger.warn({ error: String(error) }, "web push reconcile failed"));
    res.json(summary);
  });

  router.post("/web-push/subscriptions/me/unsubscribe", validate(webPushUnsubscribeSchema), async (req, res) => {
    const userId = requireBoardUserId(req, res);
    if (!userId) return;
    const removed = await deps.subscriptions.remove(userId, req.body.endpoint);
    if (removed) logger.info({ userId }, "web push subscription removed");
    res.status(204).end();
  });

  return router;
}
