import { describe, expect, it } from "vitest";
import {
  INBOX_ITEM_DEEP_LINK_PARAM,
  inboxItemDeepLink,
  webPushSubscribeSchema,
  webPushUnsubscribeSchema,
} from "./index.js";

const validKeys = { p256dh: "B".repeat(87), auth: "a".repeat(22) };

describe("inboxItemDeepLink", () => {
  it("builds a same-origin decisions URL with an encoded item id", () => {
    expect(INBOX_ITEM_DEEP_LINK_PARAM).toBe("item");
    expect(inboxItemDeepLink("PAP", "decision:abc/1 x")).toBe(
      "/PAP/decisions?item=decision%3Aabc%2F1%20x",
    );
  });

  it("round-trips through URLSearchParams", () => {
    const id = "issue_thread_interaction:a&b=c";
    const url = new URL(inboxItemDeepLink("PAP", id), "https://example.test");
    expect(url.searchParams.get(INBOX_ITEM_DEEP_LINK_PARAM)).toBe(id);
  });
});

describe("web push validators", () => {
  it("accepts a valid subscription", () => {
    const parsed = webPushSubscribeSchema.parse({
      endpoint: "https://fcm.googleapis.com/fcm/send/abc",
      keys: validKeys,
      userAgent: "UA",
    });
    expect(parsed.keys).toEqual(validKeys);
  });

  it("rejects http, oversized endpoints and non-URLs", () => {
    const base = { keys: validKeys };
    expect(webPushSubscribeSchema.safeParse({ ...base, endpoint: "http://fcm.googleapis.com/x" }).success).toBe(false);
    expect(webPushSubscribeSchema.safeParse({ ...base, endpoint: "nope" }).success).toBe(false);
    expect(
      webPushSubscribeSchema.safeParse({ ...base, endpoint: `https://fcm.googleapis.com/${"a".repeat(2048)}` }).success,
    ).toBe(false);
  });

  it("rejects bad keys and long user agents", () => {
    const endpoint = "https://fcm.googleapis.com/x";
    expect(webPushSubscribeSchema.safeParse({ endpoint, keys: { ...validKeys, auth: "bad+key/==" } }).success).toBe(false);
    expect(webPushSubscribeSchema.safeParse({ endpoint, keys: { ...validKeys, p256dh: "short" } }).success).toBe(false);
    expect(webPushSubscribeSchema.safeParse({ endpoint, keys: validKeys, userAgent: "x".repeat(301) }).success).toBe(false);
  });

  it("validates unsubscribe payloads", () => {
    expect(webPushUnsubscribeSchema.safeParse({ endpoint: "https://web.push.apple.com/x" }).success).toBe(true);
    expect(webPushUnsubscribeSchema.safeParse({}).success).toBe(false);
  });
});
