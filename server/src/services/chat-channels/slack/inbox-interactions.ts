import { eq } from "drizzle-orm";
import { chatEndpoints, type Db } from "@paperclipai/db";
import type { EndpointRow, InternalSetupState } from "../runtime-types.js";
import type { createChatCredentials } from "../credentials.js";
import { slackRequestSignatureIsValid } from "./callback-verification.js";
import { INBOX_ACTION_PREFIX, parseSlackBlockActions, type SlackBlockActionsPayload } from "./inbox-notify.js";

export type InboxClickHandler = (endpoint: EndpointRow, click: SlackBlockActionsPayload) => Promise<void>;

/**
 * Intercepts Slack interactivity callbacks for Inbox buttons (`inbox:` action ids) before the Chat SDK
 * sees them. Everything else returns null and flows through the normal pipeline untouched.
 */
export function createSlackInboxInteractions(db: Db, options: {
  resolveCredentials: ReturnType<typeof createChatCredentials>["resolveCredentials"];
  handler: () => InboxClickHandler | null;
  log?: { warn: (obj: object, msg: string) => void };
}) {
  async function markInteractivityObserved(endpoint: EndpointRow, url: string) {
    const [current] = await db.select({ setup: chatEndpoints.setup }).from(chatEndpoints).where(eq(chatEndpoints.id, endpoint.id));
    if (!current) return;
    const setup = current.setup as InternalSetupState;
    await db.update(chatEndpoints).set({
      setup: { ...setup, slackCallbackSurfaces: { ...setup.slackCallbackSurfaces, interactivity: { url, observedAt: new Date().toISOString() } } } as InternalSetupState,
      updatedAt: new Date(),
    }).where(eq(chatEndpoints.id, endpoint.id));
  }

  return async function handleSlackInboxCallback(endpoint: EndpointRow, request: Request): Promise<Response | null> {
    const handler = options.handler();
    if (!handler || request.method !== "POST" || !endpoint.providerAccountId) return null;
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.includes("application/x-www-form-urlencoded")) return null;
    const body = await request.clone().text();
    if (!body.includes("block_actions")) return null;
    const click = parseSlackBlockActions(body, contentType);
    if (!click || !click.actions.some(action => action.actionId.startsWith(INBOX_ACTION_PREFIX))) return null;
    const { signingSecret } = await options.resolveCredentials(endpoint, db, ["signingSecret"]);
    if (!slackRequestSignatureIsValid(request, body, signingSecret)) return new Response("invalid signature", { status: 401 });
    // A correctly signed callback from another workspace is acknowledged and ignored.
    if (click.teamId !== endpoint.providerAccountId) return new Response("", { status: 200 });
    try {
      await markInteractivityObserved(endpoint, request.url);
      await handler(endpoint, click);
    } catch (error) {
      options.log?.warn({ endpointId: endpoint.id, error: String(error) }, "Inbox Slack click could not be processed");
    }
    // Slack needs a 200 within 3 seconds; feedback is posted via response_url / chat.update.
    return new Response("", { status: 200 });
  };
}
