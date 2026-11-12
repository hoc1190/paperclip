import { z } from "zod";

const BASE64URL = /^[A-Za-z0-9_-]+$/;

function decodeBase64Url(value: string): string | null {
  if (!BASE64URL.test(value)) return null;
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  try {
    return atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  } catch {
    return null;
  }
}

/** p256dh: an uncompressed P-256 point (65 bytes, 0x04 prefix) as exactly 87 base64url chars. */
export function isValidWebPushP256dh(value: string): boolean {
  if (value.length !== 87) return false;
  const decoded = decodeBase64Url(value);
  return decoded !== null && decoded.length === 65 && decoded.charCodeAt(0) === 0x04;
}

/** auth: a 16 byte secret as exactly 22 base64url chars. */
export function isValidWebPushAuth(value: string): boolean {
  if (value.length !== 22) return false;
  const decoded = decodeBase64Url(value);
  return decoded !== null && decoded.length === 16;
}

/**
 * The web-push library connects with the legacy `url.parse()`, which reads a host differently from the
 * WHATWG parser (`https://evil.com;.googleapis.com/x`). Only a plain https URL whose text is already
 * canonical (lowercase `[a-z0-9.-]` host, no credentials, port, fragment or odd characters) is accepted,
 * so both parsers agree on the host. Returns the canonical endpoint, or null.
 */
export function canonicalWebPushEndpoint(endpoint: string): string | null {
  let url: URL;
  try { url = new URL(endpoint); } catch { return null; }
  if (url.protocol !== "https:" || url.port !== "" || url.username || url.password || url.hash) return null;
  if (!/^[a-z0-9.-]+$/.test(url.hostname)) return null;
  const canonical = `https://${url.hostname}${url.pathname}${url.search}`;
  return canonical === endpoint && canonical === url.href ? canonical : null;
}

export const webPushSubscribeSchema = z.object({
  endpoint: z
    .string()
    .max(2048)
    .refine((value) => canonicalWebPushEndpoint(value) !== null, "Endpoint must be a canonical https URL"),
  keys: z.object({
    p256dh: z.string().refine(isValidWebPushP256dh, "Invalid p256dh key"),
    auth: z.string().refine(isValidWebPushAuth, "Invalid auth secret"),
  }),
  userAgent: z.string().max(300).optional(),
});
export type WebPushSubscribe = z.infer<typeof webPushSubscribeSchema>;

export const webPushUnsubscribeSchema = z.object({
  endpoint: z.string().max(2048).url(),
});
export type WebPushUnsubscribe = z.infer<typeof webPushUnsubscribeSchema>;
