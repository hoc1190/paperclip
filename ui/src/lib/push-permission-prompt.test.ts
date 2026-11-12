// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PUSH_PROMPT_SNOOZE_KEY,
  PUSH_PROMPT_SNOOZE_MS,
  isAppShellPath,
  isSnoozed,
  readSnoozedUntil,
  shouldShowPushPrompt,
  snoozePushPrompt,
  type PushPromptInputs,
} from "./push-permission-prompt";

const base: PushPromptInputs = {
  standalone: true,
  support: "available",
  permission: "default",
  config: { enabled: true, publicKey: "KEY" },
  hasSubscription: false,
  snoozedUntil: null,
  now: 1_000,
  pathname: "/ACME/inbox",
};

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("shouldShowPushPrompt", () => {
  it("shows when every condition holds", () => {
    expect(shouldShowPushPrompt(base)).toBe(true);
  });

  it.each<[string, Partial<PushPromptInputs>]>([
    ["not standalone", { standalone: false }],
    ["unsupported", { support: "unsupported" }],
    ["needs install", { support: "ios-needs-install" }],
    ["denied support", { support: "denied" }],
    ["permission granted", { permission: "granted" }],
    ["permission denied", { permission: "denied" }],
    ["no Notification", { permission: undefined }],
    ["config pending", { config: undefined }],
    ["server disabled", { config: { enabled: false, publicKey: "KEY" } }],
    ["no public key", { config: { enabled: true, publicKey: null } }],
    ["existing subscription", { hasSubscription: true }],
    ["subscription lookup pending", { hasSubscription: undefined }],
    ["snoozed", { snoozedUntil: 5_000 }],
    ["login page", { pathname: "/auth" }],
    ["onboarding", { pathname: "/onboarding" }],
    ["company onboarding", { pathname: "/ACME/onboarding" }],
    ["root", { pathname: "/" }],
  ])("hides when %s", (_name, override) => {
    expect(shouldShowPushPrompt({ ...base, ...override })).toBe(false);
  });

  it("shows again once the snooze expired", () => {
    expect(shouldShowPushPrompt({ ...base, snoozedUntil: 999 })).toBe(true);
  });
});

describe("isAppShellPath", () => {
  it("accepts company routes and rejects auth-like pages", () => {
    expect(isAppShellPath("/ACME/issues/1")).toBe(true);
    expect(isAppShellPath("/invite/abc")).toBe(false);
    expect(isAppShellPath("/cli-auth/1")).toBe(false);
  });
});

describe("snooze helpers", () => {
  it("snoozes for three days and reads it back", () => {
    snoozePushPrompt(10);
    expect(window.localStorage.getItem(PUSH_PROMPT_SNOOZE_KEY)).toBe(String(10 + PUSH_PROMPT_SNOOZE_MS));
    expect(readSnoozedUntil()).toBe(10 + PUSH_PROMPT_SNOOZE_MS);
  });

  it("expires at the boundary", () => {
    expect(isSnoozed(100, 99)).toBe(true);
    expect(isSnoozed(100, 100)).toBe(false);
    expect(isSnoozed(null, 0)).toBe(false);
  });

  it("ignores garbage values", () => {
    window.localStorage.setItem(PUSH_PROMPT_SNOOZE_KEY, "abc");
    expect(readSnoozedUntil()).toBeNull();
  });

  it("survives storage throwing", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readSnoozedUntil()).toBeNull();
    expect(() => snoozePushPrompt()).not.toThrow();
  });
});
