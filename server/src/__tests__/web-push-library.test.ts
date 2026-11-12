import { createECDH, randomBytes } from "node:crypto";
import { parse as legacyParse } from "node:url";
import webpush from "web-push";
import { describe, expect, it } from "vitest";
import type { WebPushInboxPayload } from "@paperclipai/shared";
import { isValidWebPushAuth, isValidWebPushP256dh } from "@paperclipai/shared";
import { fitWebPushPayload } from "../services/inbox-web-push-notifier.js";
import { canonicalPushEndpoint } from "../services/web-push-subscriptions.js";

// Exercises the real web-push encryption (aes128gcm) and VAPID signing; nothing leaves the process.
describe("web-push library with a real P-256 subscription", () => {
  it("encrypts a 3000 byte payload and signs it with VAPID", () => {
    const device = createECDH("prime256v1");
    device.generateKeys();
    const p256dh = device.getPublicKey().toString("base64url");
    const auth = randomBytes(16).toString("base64url");
    expect(isValidWebPushP256dh(p256dh)).toBe(true);
    expect(isValidWebPushAuth(auth)).toBe(true);

    const endpoint = canonicalPushEndpoint("https://fcm.googleapis.com/fcm/send/abc")!;
    const vapid = webpush.generateVAPIDKeys();
    const payload = fitWebPushPayload({
      v: 1, title: "t".repeat(5000), body: "b".repeat(5000), url: "/X/decisions?item=a", tag: "a", companyId: "c", itemId: "a",
    } satisfies WebPushInboxPayload);
    const json = JSON.stringify(payload);
    expect(Buffer.byteLength(json)).toBeLessThanOrEqual(3000);

    const details = webpush.generateRequestDetails({ endpoint, keys: { p256dh, auth } }, json, {
      TTL: 86400, urgency: "high", timeout: 10000,
      vapidDetails: { subject: "https://paperclip.test", publicKey: vapid.publicKey, privateKey: vapid.privateKey },
    });

    expect(details.method).toBe("POST");
    expect(details.endpoint).toBe(endpoint);
    expect(legacyParse(details.endpoint).hostname).toBe("fcm.googleapis.com");
    expect(details.headers["Content-Encoding"]).toBe("aes128gcm");
    expect(details.headers.TTL).toBe(86400);
    expect(details.headers.Urgency).toBe("high");
    expect(details.headers.Authorization).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/);
    // RFC 8188: 86 byte header (salt, record size, key id) + payload + 1 byte delimiter + 16 byte tag.
    expect(Buffer.isBuffer(details.body)).toBe(true);
    expect((details.body as Buffer).length).toBe(86 + Buffer.byteLength(json) + 1 + 16);
    expect((details.body as Buffer).length).toBeLessThanOrEqual(4096);
  });

  it("rejects a subscription whose p256dh is not a 65 byte point", () => {
    expect(() => webpush.generateRequestDetails(
      { endpoint: "https://fcm.googleapis.com/x", keys: { p256dh: "B".repeat(86), auth: randomBytes(16).toString("base64url") } }, "x",
    )).toThrow(/65 bytes/);
  });
});
