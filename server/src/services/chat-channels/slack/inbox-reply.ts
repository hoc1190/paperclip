/**
 * Slack-specific parsing and deterministic matching for replies typed in the thread of an
 * Inbox notification message. Nothing here touches the database or the Paperclip API; the
 * shared workflow in services/inbox-slack-actions.ts decides what to do with a match.
 */

export type SlackThreadReply = {
  teamId: string | null;
  userId: string;
  channel: string;
  /** Timestamp of the reply itself. */
  ts: string;
  /** Timestamp of the message the reply hangs under. */
  threadTs: string;
  text: string;
  eventId: string | null;
};

/** A plain user message posted inside a thread. Bot messages, edits and top-level messages are not replies. */
export function parseSlackThreadReply(body: string, contentType: string): SlackThreadReply | null {
  if (!contentType.includes("application/json") || !body.includes("thread_ts")) return null;
  let payload: Record<string, any>;
  try { payload = JSON.parse(body); } catch { return null; }
  const event = payload?.event;
  if (payload?.type !== "event_callback" || event?.type !== "message") return null;
  if (event.subtype || event.bot_id || event.hidden) return null;
  if (typeof event.user !== "string" || typeof event.channel !== "string" || typeof event.ts !== "string" || typeof event.thread_ts !== "string") return null;
  if (event.thread_ts === event.ts || typeof event.text !== "string") return null;
  return {
    teamId: typeof payload.team_id === "string" ? payload.team_id : null,
    userId: event.user, channel: event.channel, ts: event.ts, threadTs: event.thread_ts, text: event.text,
    eventId: typeof payload.event_id === "string" ? payload.event_id : null,
  };
}

export type ReplyOption = {
  /** 1-based position in the original message. */
  index: number;
  label: string;
  /** "accept"/"reject" for confirmation buttons, null for plain answers. */
  hint: "accept" | "reject" | null;
};

export type ReplyMatch = { kind: "match"; option: ReplyOption } | { kind: "none" };

const MAX_REPLY_TOKENS = 8;
const MAX_REPLY_LENGTH = 80;

const AFFIRM = ["co", "yes", "y", "ok", "oke", "okay", "dong y", "duyet", "approve", "accept", "gui lai", "chay tiep", "chay lai", "tiep tuc", "agree"];
const NEGATE = ["khong", "no", "n", "tu choi", "huy", "giu dung", "dung", "reject", "cancel", "stop", "hold", "decline"];

/** Lowercase, strip Vietnamese diacritics and punctuation, collapse whitespace. */
export function normalizeReply(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toLowerCase()
    .replace(/<[^>]*>/g, " ") // Slack mentions/links
    .replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

const hasPhrase = (haystack: string, phrase: string) => ` ${haystack} `.includes(` ${phrase} `);
const hasAny = (haystack: string, phrases: string[]) => phrases.some(phrase => hasPhrase(haystack, phrase));

function classify(option: ReplyOption): "affirm" | "negate" | null {
  if (option.hint === "accept") return "affirm";
  if (option.hint === "reject") return "negate";
  const label = normalizeReply(option.label);
  const yes = hasAny(label, AFFIRM);
  const no = hasAny(label, NEGATE);
  return yes === no ? null : yes ? "affirm" : "negate";
}

/**
 * Maps a free-text reply to exactly one offered option, or reports no match.
 * Order: option number, label phrase, then yes/no synonyms. Anything long, a question,
 * or matching more than one option is "none" — the caller must never guess.
 */
export function matchInboxReply(text: string, options: ReplyOption[]): ReplyMatch {
  const none: ReplyMatch = { kind: "none" };
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > MAX_REPLY_LENGTH || trimmed.includes("?")) return none;
  const reply = normalizeReply(trimmed);
  if (!reply || reply.split(" ").length > MAX_REPLY_TOKENS) return none;

  const number = /^(\d{1,2})$/.exec(reply);
  if (number) {
    const picked = options.find(option => option.index === Number(number[1]));
    return picked ? { kind: "match", option: picked } : none;
  }

  const exact = options.filter(option => normalizeReply(option.label) === reply);
  if (exact.length === 1) return { kind: "match", option: exact[0]! };
  // Mixed signals ("ok nhưng không") must never resolve anything.
  if (hasAny(reply, AFFIRM) && hasAny(reply, NEGATE)) return none;

  const byLabel = options.filter(option => {
    const label = normalizeReply(option.label);
    return label.length > 0 && (label === reply || hasPhrase(reply, label) || hasPhrase(label, reply) && reply.split(" ").length > 1);
  });
  if (byLabel.length === 1) return { kind: "match", option: byLabel[0]! };
  if (byLabel.length > 1) return none;

  const affirm = hasAny(reply, AFFIRM);
  const negate = hasAny(reply, NEGATE);
  if (affirm === negate) return none;
  const wanted = affirm ? "affirm" : "negate";
  const candidates = options.filter(option => classify(option) === wanted);
  return candidates.length === 1 ? { kind: "match", option: candidates[0]! } : none;
}
