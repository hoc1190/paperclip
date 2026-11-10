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

export function formatInboxNotification(view: InboxNotifyView, now: number, inboxUrl: string | null) {
  const { plain, head, meta } = describe(view, now);
  const blocks: unknown[] = [section(head)];
  const detail = view.detail ? escapeMrkdwn(clip(view.detail, 400)) : null;
  if (detail) blocks.push(section(detail));
  blocks.push(context([meta, inboxLink(inboxUrl)].filter(Boolean).join(" · ")));
  return { text: plain, blocks };
}

export function formatInboxResolved(title: string) {
  const text = `✅ Đã xử lý: ${clip(title, 200)}`;
  return { text, blocks: [section(`✅ ~${escapeMrkdwn(clip(title, 200))}~ — đã xử lý`)] };
}

export function formatInboxReminder(view: InboxNotifyView, now: number, inboxUrl: string | null) {
  const text = `Nhắc lại: vẫn đang chờ bạn (${waitingLabel(view.since, now)}) — ${clip(view.title, 200)}`;
  return { text, blocks: [section(`⏰ Vẫn đang chờ bạn ${waitingLabel(view.since, now)}. ${inboxLink(inboxUrl) ?? ""}`.trim())] };
}

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
