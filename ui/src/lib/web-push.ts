import { webPushSubscribeSchema, type WebPushConfig } from "@paperclipai/shared";
import { webPushApi } from "@/api/webPush";

export type PushSupport = "unsupported" | "ios-needs-install" | "denied" | "available";

function isIos(): boolean {
  const ua = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  // iPadOS reports as Mac with touch support.
  return /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
}

export function isStandalone(): boolean {
  if ((navigator as Navigator & { standalone?: boolean }).standalone === true) return true;
  return typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)").matches;
}

export function getPushSupport(): PushSupport {
  // iOS Safari tabs expose no PushManager, so check the install requirement first.
  if (isIos() && !isStandalone()) return "ios-needs-install";
  const hasApis = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  if (!hasApis) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  return "available";
}

export function urlBase64ToUint8Array(value: string): Uint8Array<ArrayBuffer> {
  const padded = value + "=".repeat((4 - (value.length % 4)) % 4);
  const raw = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

function bufferToBase64Url(buffer: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function sameKey(subscription: PushSubscription, publicKey: string): boolean {
  const current = subscription.options?.applicationServerKey;
  // Unknown key: treat as matching and let the server's key-id check repair it.
  if (!current) return true;
  return bufferToBase64Url(current) === publicKey;
}

async function registerWithServer(subscription: PushSubscription): Promise<void> {
  const json = subscription.toJSON();
  const body = webPushSubscribeSchema.parse({
    endpoint: json.endpoint,
    keys: json.keys,
    userAgent: navigator.userAgent.slice(0, 300),
  });
  await webPushApi.subscribe(body);
}

/**
 * Must be called straight from the click handler: `Notification.requestPermission()`
 * is the first statement, with nothing awaited before it, so iOS keeps it inside
 * the user gesture. `config.publicKey` is fetched ahead of time for that reason.
 */
export async function enablePush(config: WebPushConfig): Promise<void> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error(permission === "denied" ? "PERMISSION_DENIED" : "PERMISSION_DISMISSED");
  }
  if (!config.publicKey) throw new Error("PUSH_NOT_CONFIGURED");
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(config.publicKey),
  });
  await registerWithServer(subscription);
}

export async function disablePush(): Promise<void> {
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return;
  const { endpoint } = subscription;
  await webPushApi.unsubscribe(endpoint);
  await subscription.unsubscribe();
}

export async function getCurrentEndpoint(): Promise<string | null> {
  const registration = await navigator.serviceWorker.ready;
  return (await registration.pushManager.getSubscription())?.endpoint ?? null;
}

/**
 * Startup repair: re-registers this device's subscription with the server. Only
 * runs when permission is already granted and never prompts.
 */
export async function syncPushSubscription(): Promise<void> {
  try {
    if (getPushSupport() !== "available" || Notification.permission !== "granted") return;
    const config = await webPushApi.getConfig();
    if (!config.enabled || !config.publicKey) return;
    const registration = await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) return;
    if (!sameKey(subscription, config.publicKey)) {
      await subscription.unsubscribe();
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(config.publicKey),
      });
    }
    await registerWithServer(subscription);
  } catch {
    // Best effort; the next app start tries again.
  }
}
