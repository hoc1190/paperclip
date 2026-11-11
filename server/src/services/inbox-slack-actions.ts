import { randomBytes } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { chatActions, chatEndpoints, chatExternalPrincipals, chatIdentityLinks, type Db } from "@paperclipai/db";
import type { AskUserQuestionsInteraction, IssueThreadInteraction } from "@paperclipai/shared";
import {
  INBOX_ACTION_PREFIX, INBOX_LINK_ACTION_PREFIX, formatInboxResolved, formatInboxStillPending, inboxActionBlocks, inboxThreadNotice, postSlackEphemeral, type InboxButton, type SlackBlockActionsPayload, type SlackInboxTransport,
} from "./chat-channels/slack/inbox-notify.js";
import { matchInboxReply, type ReplyOption, type SlackThreadReply } from "./chat-channels/slack/inbox-reply.js";
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
    case "recovery_action":
      // Closing or cancelling the source task does not close the recovery action (it needs an
      // operator attestation in the Inbox), so offering those buttons would be misleading.
      return [];
    case "blocker_attention":
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
  for (const [position, spec] of input.specs.entries()) {
    const token = randomBytes(12).toString("base64url");
    const actionId = `${INBOX_ACTION_PREFIX}${token}`;
    await db.insert(chatActions).values({
      companyId: input.companyId, endpointId: input.endpointId, kind: INBOX_ACTION_KIND, providerActionId: actionId, status: "ready",
      payload: { groupId: input.groupId, userId: input.userId, dedupKey: input.dedupKey, title: input.title, label: spec.label, choice: spec.choice, request: spec.request,
        // Kept so a thread reply can be matched to this button and re-offered with the same dialog.
        index: position + 1, style: spec.style ?? null, confirm: spec.confirm ?? null },
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

type ButtonPayload = {
  groupId: string; userId: string; dedupKey: string; title: string; label: string; choice: string; request: InboxRequest;
  index?: number; style?: "primary" | "danger" | null; confirm?: InboxButton["confirm"] | null;
};

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
  if (!(await senderIsLinked(db, endpoint, payload.userId, click.userId))) {
    await tell("Tài khoản Slack này chưa được liên kết với người nhận tin này nên không thể xử lý từ Slack."); return true;
  }
  await executeInboxButton(db, deps, endpoint, row, payload, { slackUserId: click.userId, actionId: action.actionId, tell });
  return true;
}

/** True when the Slack account is linked to the Paperclip board user an Inbox message was sent to. */
async function senderIsLinked(db: Db, endpoint: typeof chatEndpoints.$inferSelect, paperclipUserId: string, slackUserId: string): Promise<boolean> {
  if (!endpoint.providerAccountId) return false;
  const links = await db.select({ id: chatIdentityLinks.id }).from(chatIdentityLinks)
    .innerJoin(chatExternalPrincipals, and(eq(chatExternalPrincipals.id, chatIdentityLinks.principalId), eq(chatExternalPrincipals.companyId, chatIdentityLinks.companyId)))
    .where(and(
      eq(chatIdentityLinks.companyId, endpoint.companyId), eq(chatIdentityLinks.endpointId, endpoint.id), eq(chatIdentityLinks.status, "linked"),
      eq(chatIdentityLinks.paperclipUserId, paperclipUserId), eq(chatExternalPrincipals.provider, "slack"),
      eq(chatExternalPrincipals.providerAccountId, endpoint.providerAccountId), eq(chatExternalPrincipals.externalId, slackUserId),
    ));
  return links.length > 0;
}

type ExecuteContext = { slackUserId: string; actionId: string; tell: (text: string) => Promise<void> };

/**
 * Runs one authorized button: stale check, single-winner claim, the same API request the Inbox
 * uses, and the final message edit. Shared by clicks and by thread replies matched to a button.
 */
async function executeInboxButton(
  db: Db, deps: InboxClickDeps, endpoint: typeof chatEndpoints.$inferSelect,
  row: typeof chatActions.$inferSelect, payload: ButtonPayload, ctx: ExecuteContext,
): Promise<boolean> {
  const { tell } = ctx;
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

  if (groupResult?.state === "resolved") { await tell("Việc này đã được xử lý rồi."); return false; }
  // Still pending? The web UI or another click may have resolved it first.
  let stillPending: boolean;
  try { stillPending = (await deps.listPending(endpoint.companyId, payload.userId)).some(item => item.dedupKey === payload.dedupKey); }
  catch { await tell("Không kiểm tra được trạng thái hiện tại. Thử lại sau hoặc mở Inbox."); return false; }
  if (!stillPending) { await settle("đã xử lý ở nơi khác", "resolved"); await tell("Việc này đã được xử lý rồi."); return false; }
  if (!deps.api) { await tell("Chưa hỗ trợ xử lý từ Slack ở chế độ triển khai này. Hãy mở Inbox."); return false; }

  // One click wins; sibling buttons and double clicks are rejected by this unique claim.
  const claimKey = `${CLAIM_KIND}:${payload.groupId}`;
  const [claim] = await db.insert(chatActions).values({
    companyId: endpoint.companyId, endpointId: endpoint.id, kind: CLAIM_KIND, providerActionId: claimKey, status: "processing",
    payload: { actionId: ctx.actionId, slackUserId: ctx.slackUserId },
  }).onConflictDoNothing().returning();
  if (!claim) { await tell("Việc này đang/đã được xử lý rồi."); return false; }

  const result = await deps.api.request(payload.request);
  if (!result.ok) {
    // Release the claim so the user can retry or use the Inbox; nothing was applied.
    await db.delete(chatActions).where(eq(chatActions.id, claim.id));
    await tell(`Không xử lý được (${result.message ?? result.status}). Hãy mở Inbox để xử lý.`);
    return false;
  }
  await db.update(chatActions).set({ status: "processed", result: { status: result.status }, updatedAt: new Date() }).where(eq(chatActions.id, claim.id));
  await db.update(chatActions).set({ status: "processed", updatedAt: new Date() }).where(eq(chatActions.id, row.id));
  // The request succeeded, but only claim "resolved" if the item really left the Inbox.
  let remains = false;
  try { remains = (await deps.listPending(endpoint.companyId, payload.userId)).some(item => item.dedupKey === payload.dedupKey); }
  catch { /* unknown: fall through as resolved, the sweep corrects it */ }
  if (remains) {
    if (token && groupResult?.channel && groupResult.ts) {
      try { await deps.transport.update({ token, channel: groupResult.channel, ts: groupResult.ts, ...formatInboxStillPending(payload.title, payload.choice) }); }
      catch (error) { deps.log?.warn({ endpointId: endpoint.id, error: String(error) }, "Inbox Slack message could not be updated after a click"); }
    }
    await tell("Đã thực hiện, nhưng việc này vẫn đang chờ trong Inbox. Hãy mở Inbox để hoàn tất.");
    return false;
  }
  await settle(payload.choice, "resolved");
  return true;
}

const REPLY_CLAIM_KIND = "inbox_reply_claim";

const isDestructive = (payload: ButtonPayload) =>
  Boolean(payload.confirm) || payload.request.path.endsWith("/reject") || payload.request.body?.status === "cancelled";

const hintOf = (payload: ButtonPayload): ReplyOption["hint"] =>
  payload.request.path.endsWith("/accept") ? "accept" : payload.request.path.endsWith("/reject") ? "reject" : null;

/** Re-offers a stored button; destructive ones that predate stored dialogs get a generic confirmation. */
const reofferButton = (row: typeof chatActions.$inferSelect, payload: ButtonPayload): InboxButton => ({
  actionId: row.providerActionId, text: payload.label, style: payload.style ?? undefined,
  confirm: payload.confirm ?? (isDestructive(payload) ? { title: payload.label, text: "Hành động này không hoàn tác được.", confirm: "Xác nhận", deny: "Huỷ" } : undefined),
});

/**
 * Handles a user's thread reply under an Inbox notification. Returns true when the reply belonged to
 * an open Inbox message that has answer buttons (the caller must then NOT forward it to the agent);
 * false leaves the message to the normal chat pipeline. The caller has verified signature and workspace.
 *
 * A reply resolves the item only when it maps to exactly one non-destructive button; the work is then
 * done by the same executor the button click uses, so stale checks, the single-winner claim and the
 * API request are identical. Ambiguous text never resolves anything.
 */
export async function handleInboxThreadReply(db: Db, deps: InboxClickDeps, endpoint: typeof chatEndpoints.$inferSelect, reply: SlackThreadReply): Promise<boolean> {
  const [group] = await db.select().from(chatActions).where(and(
    eq(chatActions.endpointId, endpoint.id), eq(chatActions.companyId, endpoint.companyId), eq(chatActions.kind, "inbox_notify"), eq(chatActions.status, "processed"),
    sql`${chatActions.result}->>'ts' = ${reply.threadTs}`, sql`${chatActions.result}->>'channel' = ${reply.channel}`, sql`${chatActions.result}->>'state' = 'open'`,
  ));
  if (!group) return false;
  const rows = await db.select().from(chatActions).where(and(
    eq(chatActions.endpointId, endpoint.id), eq(chatActions.kind, INBOX_ACTION_KIND), sql`${chatActions.payload}->>'groupId' = ${group.id}`,
  )).orderBy(asc(chatActions.createdAt));
  if (rows.length === 0) return false; // link-only message: nothing to answer, leave it to the agent

  // Slack redelivers events; one reply is processed at most once.
  const [claim] = await db.insert(chatActions).values({
    companyId: endpoint.companyId, endpointId: endpoint.id, kind: REPLY_CLAIM_KIND, providerActionId: `${REPLY_CLAIM_KIND}:${reply.channel}:${reply.ts}`,
    status: "processing", payload: { groupId: group.id, slackUserId: reply.userId },
  }).onConflictDoNothing().returning();
  if (!claim) return true;

  const token = await deps.token(endpoint.id);
  if (!token) return true;
  const say = async (text: string, blocks?: unknown[]) => {
    try { await deps.transport.post({ token, channel: reply.channel, threadTs: reply.threadTs, ...inboxThreadNotice(text, blocks) }); }
    catch (error) { deps.log?.warn({ endpointId: endpoint.id, error: String(error) }, "Inbox Slack thread reply could not be posted"); }
  };

  const buttons = rows.map(row => ({ row, payload: row.payload as unknown as ButtonPayload }))
    .sort((a, b) => (a.payload.index ?? 0) - (b.payload.index ?? 0));
  const owner = buttons[0]!.payload.userId;
  if (!(await senderIsLinked(db, endpoint, owner, reply.userId))) {
    const hint = "Tài khoản Slack này chưa được liên kết với người nhận tin này nên không thể xử lý từ Slack.";
    if (deps.transport.ephemeral) { try { await deps.transport.ephemeral({ token, channel: reply.channel, user: reply.userId, text: hint, threadTs: reply.threadTs }); } catch { /* best effort */ } }
    else await say(hint);
    return true;
  }

  const options: ReplyOption[] = buttons.map(({ payload }, position) => ({ index: payload.index ?? position + 1, label: payload.label, hint: hintOf(payload) }));
  const match = matchInboxReply(reply.text, options);
  if (match.kind === "none") {
    await say(
      "Mình chưa chắc bạn chọn đáp án nào nên chưa ghi gì. Chọn một nút bên dưới hoặc mở Inbox. Tin nhắn này chưa được lưu làm câu trả lời; muốn bình luận cho agent, hãy ghi trên task trong Paperclip.",
      inboxActionBlocks(buttons.map(({ row, payload }) => reofferButton(row, payload))),
    );
    return true;
  }
  const chosen = buttons.find(({ payload }, position) => (payload.index ?? position + 1) === match.option.index)!;
  if (isDestructive(chosen.payload)) {
    await say(`"${chosen.payload.label}" không hoàn tác được nên mình không làm từ tin nhắn chữ. Hãy bấm nút "${chosen.payload.label}" ở tin gốc để xác nhận.`);
    return true;
  }
  const done = await executeInboxButton(db, deps, endpoint, chosen.row, chosen.payload, { slackUserId: reply.userId, actionId: chosen.row.providerActionId, tell: say });
  if (done) await say(`Đã ghi: ${chosen.payload.choice}`);
  return true;
}
