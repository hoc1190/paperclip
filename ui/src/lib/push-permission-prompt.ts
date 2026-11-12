import type { WebPushConfig } from "@paperclipai/shared";
import type { PushSupport } from "@/lib/web-push";

export const PUSH_PROMPT_SNOOZE_KEY = "paperclip:push-prompt-snoozed-until";
export const PUSH_PROMPT_SNOOZE_MS = 3 * 24 * 60 * 60 * 1000;

const NON_SHELL_SEGMENTS = new Set([
  "auth",
  "onboarding",
  "oauth-handoff",
  "board-claim",
  "mcp-connect",
  "dot-connect",
  "mcp-device",
  "cli-auth",
  "invite",
]);

/** True when the pathname is a company-prefixed app shell route, not login/onboarding/pairing pages. */
export function isAppShellPath(pathname: string): boolean {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length < 2) return false;
  return !segments.some((segment) => NON_SHELL_SEGMENTS.has(segment));
}

export function readSnoozedUntil(): number | null {
  try {
    const raw = window.localStorage.getItem(PUSH_PROMPT_SNOOZE_KEY);
    if (!raw) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

export function snoozePushPrompt(now: number = Date.now()): void {
  try {
    window.localStorage.setItem(PUSH_PROMPT_SNOOZE_KEY, String(now + PUSH_PROMPT_SNOOZE_MS));
  } catch {
    // Storage unavailable: the prompt simply closes for this session.
  }
}

export function isSnoozed(snoozedUntil: number | null, now: number = Date.now()): boolean {
  return snoozedUntil !== null && snoozedUntil > now;
}

export interface PushPromptInputs {
  standalone: boolean;
  support: PushSupport;
  permission: NotificationPermission | undefined;
  config: Pick<WebPushConfig, "enabled" | "publicKey"> | undefined;
  /** undefined while the local subscription lookup is still pending. */
  hasSubscription: boolean | undefined;
  snoozedUntil: number | null;
  now: number;
  pathname: string;
}

export function shouldShowPushPrompt(input: PushPromptInputs): boolean {
  return (
    input.standalone &&
    input.support === "available" &&
    input.permission === "default" &&
    !!input.config?.enabled &&
    !!input.config.publicKey &&
    input.hasSubscription === false &&
    !isSnoozed(input.snoozedUntil, input.now) &&
    isAppShellPath(input.pathname)
  );
}
