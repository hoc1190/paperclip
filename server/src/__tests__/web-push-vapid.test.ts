import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveWebPushVapid, DEFAULT_WEB_PUSH_SUBJECT, webPushKeyId } from "../services/web-push-vapid.js";

const masterKey = (byte: number) => Buffer.alloc(32, byte).toString("base64");

describe("web push VAPID resolution", () => {
  it("derives a deterministic P-256 key from the master key", () => {
    const a = resolveWebPushVapid({ PAPERCLIP_SECRETS_MASTER_KEY: masterKey(7) });
    const b = resolveWebPushVapid({ PAPERCLIP_SECRETS_MASTER_KEY: masterKey(7) });
    const other = resolveWebPushVapid({ PAPERCLIP_SECRETS_MASTER_KEY: masterKey(8) });
    expect(a).not.toBeNull();
    expect(b).toEqual(a);
    expect(other!.publicKey).not.toBe(a!.publicKey);
    const point = Buffer.from(a!.publicKey, "base64url");
    expect(point.length).toBe(65);
    expect(point[0]).toBe(0x04);
    expect(Buffer.from(a!.privateKey, "base64url").length).toBe(32);
    expect(a!.keyId).toBe(webPushKeyId(a!.publicKey));
    expect(a!.keyId).toHaveLength(16);
  });

  it("uses the configured environment keys when both are set", () => {
    const result = resolveWebPushVapid({
      PAPERCLIP_SECRETS_MASTER_KEY: masterKey(7),
      PAPERCLIP_WEB_PUSH_VAPID_PUBLIC_KEY: "BPublic",
      PAPERCLIP_WEB_PUSH_VAPID_PRIVATE_KEY: "Private",
    });
    expect(result).toMatchObject({ publicKey: "BPublic", privateKey: "Private", keyId: webPushKeyId("BPublic") });
  });

  it("defaults the subject and lets the environment override it", () => {
    expect(resolveWebPushVapid({ PAPERCLIP_SECRETS_MASTER_KEY: masterKey(7) })!.subject).toBe(DEFAULT_WEB_PUSH_SUBJECT);
    expect(resolveWebPushVapid({ PAPERCLIP_SECRETS_MASTER_KEY: masterKey(7), PAPERCLIP_WEB_PUSH_SUBJECT: "mailto:ops@example.com" })!.subject)
      .toBe("mailto:ops@example.com");
  });

  it("is disabled for a subject Apple would reject, and when the master key cannot be loaded", () => {
    expect(resolveWebPushVapid({ PAPERCLIP_SECRETS_MASTER_KEY: masterKey(7), PAPERCLIP_WEB_PUSH_SUBJECT: "http://insecure.example" })).toBeNull();
    expect(resolveWebPushVapid({ PAPERCLIP_SECRETS_MASTER_KEY: "not-a-valid-key" })).toBeNull();
  });

  describe("without a master key", () => {
    afterEach(() => vi.useRealTimers());
    const missingKeyEnv = () => ({ PAPERCLIP_SECRETS_MASTER_KEY_FILE: path.join(mkdtempSync(path.join(tmpdir(), "vapid-")), "master.key") });

    it("never creates a master key file and is disabled", () => {
      const env = missingKeyEnv();
      expect(resolveWebPushVapid(env)).toBeNull();
      expect(existsSync(env.PAPERCLIP_SECRETS_MASTER_KEY_FILE)).toBe(false);
    });

    it("does not cache the missing key forever", () => {
      vi.useFakeTimers();
      const env = missingKeyEnv();
      expect(resolveWebPushVapid(env)).toBeNull();
      writeFileSync(env.PAPERCLIP_SECRETS_MASTER_KEY_FILE, masterKey(9), { mode: 0o600 });
      expect(resolveWebPushVapid(env)).toBeNull(); // still inside the retry interval
      vi.advanceTimersByTime(31_000);
      expect(resolveWebPushVapid(env)).not.toBeNull();
    });
  });
});
