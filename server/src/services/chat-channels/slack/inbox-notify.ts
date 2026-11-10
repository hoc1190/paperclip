import { createSlackSetupClient } from "../../connectors/slack/setup/provider-client.js";

/** Normalized view of one Inbox item; the shared notifier owns how it is derived. */
export type InboxNotifyView = {
  /** Plain-language "what you must do", e.g. "Cần bạn quyết định". */
  ask: string;
  title: string;
  /** Short explanation (already plain text). */
  detail: string | null;
  agent: string | null;
  issue: string | null;
  since: string;
};

export type SlackPostArgs = { token: string; channel: string; text: string; blocks: unknown[]; threadTs?: string };
export type SlackUpdateArgs = { token: string; channel: string; ts: string; text: string; blocks: unknown[] };
export type SlackInboxTransport = {
  post(args: SlackPostArgs): Promise<{ channel: string; ts: string }>;
  update(args: SlackUpdateArgs): Promise<void>;
};

const clip = (value: string, max: number) => (value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`);
// Slack mrkdwn treats these characters as control syntax in user-provided text.
const escapeMrkdwn = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function waitingLabel(sinceIso: string, now: number): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(sinceIso)) / 60_000));
  if (!Number.isFinite(minutes) || minutes < 1) return "vừa xong";
  if (minutes < 60) return `${minutes} phút`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} giờ`;
  return `${Math.floor(hours / 24)} ngày`;
}

const section = (text: string) => ({ type: "section", text: { type: "mrkdwn", text } });
const context = (text: string) => ({ type: "context", elements: [{ type: "mrkdwn", text }] });
const inboxLink = (url: string | null) => (url ? `<${url}|Mở Inbox>` : null);

function describe(view: InboxNotifyView, now: number) {
  const from = view.agent ? `từ ${escapeMrkdwn(view.agent)}` : null;
  const subject = `${view.issue ? `${escapeMrkdwn(view.issue)} · ` : ""}${escapeMrkdwn(clip(view.title, 200))}`;
  return {
    plain: `${view.ask}: ${clip(view.title, 200)}`,
    head: `*${escapeMrkdwn(view.ask)}:* ${subject}`,
    meta: [from, `chờ ${waitingLabel(view.since, now)}`].filter(Boolean).join(" · "),
  };
}

/** One clickable button. `url` makes a link button; otherwise the click is routed by `actionId`. */
export type InboxButton = {
  actionId: string;
  text: string;
  style?: "primary" | "danger";
  url?: string;
  /** Slack confirmation dialog, shown before a destructive click is sent. */
  confirm?: { title: string; text: string; confirm: string; deny: string };
};

const SLACK_BUTTONS_PER_BLOCK = 5;

function buttonElement(button: InboxButton) {
  return {
    type: "button", action_id: button.actionId, text: { type: "plain_text", text: clip(button.text, 70) },
    ...(button.url ? { url: button.url } : { value: button.actionId }),
    ...(button.style ? { style: button.style } : {}),
    ...(button.confirm ? { confirm: {
      title: { type: "plain_text", text: clip(button.confirm.title, 100) }, text: { type: "plain_text", text: clip(button.confirm.text, 300) },
      confirm: { type: "plain_text", text: clip(button.confirm.confirm, 30) }, deny: { type: "plain_text", text: clip(button.confirm.deny, 30) },
    } } : {}),
  };
}

export function inboxActionBlocks(buttons: InboxButton[]): unknown[] {
  const blocks: unknown[] = [];
  for (let index = 0; index < buttons.length; index += SLACK_BUTTONS_PER_BLOCK)
    blocks.push({ type: "actions", elements: buttons.slice(index, index + SLACK_BUTTONS_PER_BLOCK).map(buttonElement) });
  return blocks;
}

export function formatInboxNotification(view: InboxNotifyView, now: number, inboxUrl: string | null, buttons: InboxButton[] = []) {
  const { plain, head, meta } = describe(view, now);
  const blocks: unknown[] = [section(head)];
  const detail = view.detail ? escapeMrkdwn(clip(view.detail, 400)) : null;
  if (detail) blocks.push(section(detail));
  blocks.push(context([meta, buttons.length ? null : inboxLink(inboxUrl)].filter(Boolean).join(" · ")));
  blocks.push(...inboxActionBlocks(buttons));
  return { text: plain, blocks };
}

export function formatInboxResolved(title: string, choice?: string | null) {
  const text = `✅ Đã xử lý: ${clip(title, 200)}${choice ? ` → ${clip(choice, 100)}` : ""}`;
  return { text, blocks: [section(`✅ ~${escapeMrkdwn(clip(title, 200))}~ — đã xử lý${choice ? `: *${escapeMrkdwn(clip(choice, 100))}*` : ""}`)] };
}

export function formatInboxReminder(view: InboxNotifyView, now: number, inboxUrl: string | null) {
  const text = `Nhắc lại: vẫn đang chờ bạn (${waitingLabel(view.since, now)}) — ${clip(view.title, 200)}`;
  return { text, blocks: [section(`⏰ Vẫn đang chờ bạn ${waitingLabel(view.since, now)}. ${inboxLink(inboxUrl) ?? ""}`.trim())] };
}

export function formatInboxIntro(total: number) {
  return { text: `Đã bật thông báo Inbox: ${total} việc đang chờ bạn, gửi từng tin riêng bên dưới.`,
    blocks: [section(`*Đã bật thông báo Inbox.* ${total} việc đang chờ bạn — mỗi việc một tin riêng bên dưới, bấm nút để xử lý ngay.`)] };
}

/** @deprecated kept for callers that still want one combined summary. */
export function formatInboxBaseline(views: InboxNotifyView[], total: number, now: number, inboxUrl: string | null) {
  const lines = views.slice(0, 8).map(view => `• *${escapeMrkdwn(view.ask)}:* ${escapeMrkdwn(clip(view.issue ? `${view.issue} · ${view.title}` : view.title, 120))} (chờ ${waitingLabel(view.since, now)})`);
  const more = total > lines.length ? `\n…và ${total - lines.length} việc khác.` : "";
  return {
    text: `Đã bật thông báo Inbox: hiện có ${total} việc đang chờ bạn.`,
    blocks: [section(`*Đã bật thông báo Inbox.* Hiện có ${total} việc đang chờ bạn:\n${lines.join("\n")}${more}`),
      context(["Từ giờ mỗi việc mới sẽ có một tin riêng.", inboxLink(inboxUrl)].filter(Boolean).join(" · "))],
  };
}

export function createSlackInboxTransport(fetchImpl: typeof fetch = fetch): SlackInboxTransport {
  const api = createSlackSetupClient(fetchImpl);
  return {
    async post({ token, channel, text, blocks, threadTs }) {
      const response = await api("chat.postMessage", {
        channel, text, blocks: JSON.stringify(blocks), unfurl_links: "false", unfurl_media: "false",
        ...(threadTs ? { thread_ts: threadTs } : {}),
      }, token);
      if (typeof response.channel !== "string" || typeof response.ts !== "string") throw new Error("slack_post_unconfirmed");
      return { channel: response.channel, ts: response.ts };
    },
    async update({ token, channel, ts, text, blocks }) {
      await api("chat.update", { channel, ts, text, blocks: JSON.stringify(blocks) }, token);
    },
  };
}

export type SlackBlockActionsPayload = {
  userId: string; teamId: string | null; channelId: string | null; messageTs: string | null; responseUrl: string | null;
  actions: Array<{ actionId: string; value: string | null }>;
};

/** Parses a Slack interactivity request body (form-encoded `payload=`); null when it is not a block_actions callback. */
export function parseSlackBlockActions(body: string, contentType: string): SlackBlockActionsPayload | null {
  if (!contentType.includes("application/x-www-form-urlencoded")) return null;
  const raw = new URLSearchParams(body).get("payload");
  if (!raw) return null;
  let payload: Record<string, any>;
  try { payload = JSON.parse(raw); } catch { return null; }
  if (payload?.type !== "block_actions" || typeof payload.user?.id !== "string" || !Array.isArray(payload.actions)) return null;
  return {
    userId: payload.user.id,
    teamId: typeof payload.team?.id === "string" ? payload.team.id : typeof payload.user?.team_id === "string" ? payload.user.team_id : null,
    channelId: typeof payload.channel?.id === "string" ? payload.channel.id : typeof payload.container?.channel_id === "string" ? payload.container.channel_id : null,
    messageTs: typeof payload.message?.ts === "string" ? payload.message.ts : typeof payload.container?.message_ts === "string" ? payload.container.message_ts : null,
    responseUrl: typeof payload.response_url === "string" ? payload.response_url : null,
    actions: payload.actions.filter((a: any) => typeof a?.action_id === "string").map((a: any) => ({ actionId: a.action_id, value: typeof a.value === "string" ? a.value : null })),
  };
}

/** Private reply visible only to the clicker; response_url must be a Slack host. */
export async function postSlackEphemeral(responseUrl: string | null, text: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  if (!responseUrl) return;
  try {
    const url = new URL(responseUrl);
    if (url.protocol !== "https:" || !/(^|\.)slack\.com$/.test(url.hostname)) return;
    await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ response_type: "ephemeral", replace_original: false, text }) });
  } catch { /* the click is already acknowledged; a lost hint is harmless */ }
}

export const INBOX_ACTION_PREFIX = "inbox:";
/** Link buttons also trigger a callback in Slack; these carry no server action. */
export const INBOX_LINK_ACTION_PREFIX = "inbox:link:";
