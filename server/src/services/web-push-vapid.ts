import { createECDH, createHash } from "node:crypto";
import { deriveLocalEncryptedInstanceSecret } from "../secrets/local-encrypted-provider.js";
import { logger } from "../middleware/logger.js";

export type WebPushVapid = { publicKey: string; privateKey: string; keyId: string; subject: string };
type WebPushEnv = Record<string, string | undefined>;

export const DEFAULT_WEB_PUSH_SUBJECT = "https://paperclip.vibehonban.jp";
const MAX_DERIVE_ATTEMPTS = 8;

const cache = new WeakMap<object, WebPushVapid | null>();

export function webPushKeyId(publicKey: string): string {
  return createHash("sha256").update(publicKey).digest("hex").slice(0, 16);
}

function deriveKeyPair(env: WebPushEnv): { publicKey: string; privateKey: string } {
  for (let attempt = 0; attempt < MAX_DERIVE_ATTEMPTS; attempt += 1) {
    const purpose = attempt === 0 ? "web-push-vapid:v1" : `web-push-vapid:v1:${attempt}`;
    const privateKey = deriveLocalEncryptedInstanceSecret(purpose, env);
    const ecdh = createECDH("prime256v1");
    try {
      ecdh.setPrivateKey(Buffer.from(privateKey, "base64url"));
    } catch {
      // Scalar outside the curve order (about 2^-32 odds): derive again deterministically.
      continue;
    }
    return { privateKey, publicKey: ecdh.getPublicKey().toString("base64url") };
  }
  throw new Error("Could not derive a valid VAPID key");
}

function resolveUncached(env: WebPushEnv): WebPushVapid | null {
  const subject = env.PAPERCLIP_WEB_PUSH_SUBJECT?.trim() || DEFAULT_WEB_PUSH_SUBJECT;
  // Apple rejects a missing or malformed subject (403 BadJwtToken).
  if (!/^(https:\/\/[^\s/]+|mailto:[^\s@]+@[^\s@]+)/.test(subject)) {
    logger.warn({ subject }, "Web push disabled: PAPERCLIP_WEB_PUSH_SUBJECT must be an https URL or mailto: address");
    return null;
  }
  const envPublic = env.PAPERCLIP_WEB_PUSH_VAPID_PUBLIC_KEY?.trim();
  const envPrivate = env.PAPERCLIP_WEB_PUSH_VAPID_PRIVATE_KEY?.trim();
  if (envPublic && envPrivate) return { publicKey: envPublic, privateKey: envPrivate, keyId: webPushKeyId(envPublic), subject };
  try {
    const pair = deriveKeyPair(env);
    return { ...pair, keyId: webPushKeyId(pair.publicKey), subject };
  } catch (error) {
    logger.warn({ error: String(error) }, "Web push disabled: the instance master key could not be loaded");
    return null;
  }
}

/** Resolved once per env object (process lifetime for `process.env`). Null means push is disabled. */
export function resolveWebPushVapid(env: WebPushEnv = process.env): WebPushVapid | null {
  if (cache.has(env)) return cache.get(env) ?? null;
  const result = resolveUncached(env);
  cache.set(env, result);
  return result;
}
