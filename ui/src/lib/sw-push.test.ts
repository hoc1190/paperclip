import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const uiRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const ORIGIN = "https://app.example.com";

type Listener = (event: Record<string, unknown>) => void;

function loadWorker(windows: Array<Record<string, unknown>> = []) {
  const listeners = new Map<string, Listener>();
  const showNotification = vi.fn(async (_title: string, _options: unknown) => {});
  const openWindow = vi.fn(async (_url: string) => null);
  const swSelf = {
    addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
    skipWaiting: vi.fn(),
    location: { origin: ORIGIN },
    registration: { showNotification },
    clients: { claim: vi.fn(), matchAll: vi.fn(async () => windows), openWindow },
  };
  const caches = { keys: vi.fn(async () => []), delete: vi.fn(), open: vi.fn(), match: vi.fn() };
  const code = readFileSync(resolve(uiRoot, "public/sw.js"), "utf8");
  new Function("self", "caches", "fetch", "Response", "URL", code)(swSelf, caches, vi.fn(), Response, URL);
  return { listeners, showNotification, openWindow };
}

async function dispatch(listener: Listener | undefined, event: Record<string, unknown>) {
  if (!listener) throw new Error("listener missing");
  const waits: Promise<unknown>[] = [];
  listener({ ...event, waitUntil: (p: Promise<unknown>) => waits.push(p) });
  await Promise.all(waits);
}

const payload = {
  v: 1,
  title: "A very long inbox item title that must never be clipped by the worker at all",
  body: "Needs your decision",
  url: "/PAP/decisions?item=abc%2F1",
  tag: "inbox:abc/1",
  companyId: "c1",
  itemId: "abc/1",
};

describe("sw.js web push", () => {
  it("shows the full title and data on push", async () => {
    const { listeners, showNotification } = loadWorker();
    await dispatch(listeners.get("push"), { data: { json: () => payload } });
    expect(showNotification).toHaveBeenCalledWith(payload.title, {
      body: payload.body,
      tag: payload.tag,
      renotify: false,
      icon: "/android-chrome-192x192.png",
      badge: "/android-chrome-192x192.png",
      data: { url: payload.url, companyId: "c1", itemId: "abc/1" },
    });
  });

  it("still shows a notification for a malformed payload", async () => {
    const { listeners, showNotification } = loadWorker();
    await dispatch(listeners.get("push"), {
      data: { json: () => { throw new SyntaxError("bad"); } },
    });
    expect(showNotification).toHaveBeenCalledTimes(1);
    const [title, options] = showNotification.mock.calls[0] as unknown as [string, { body: string; data: { url: string } }];
    expect(title).toBe("Paperclip");
    expect(options.body).toBe("New Inbox item");
    expect(options.data.url).toBe("/");
  });

  it("still shows a notification when the push has no data", async () => {
    const { listeners, showNotification } = loadWorker();
    await dispatch(listeners.get("push"), { data: null });
    expect(showNotification).toHaveBeenCalledTimes(1);
  });

  it("focuses an open window and posts a navigate message on click", async () => {
    const client = { focused: false, focus: vi.fn(async () => {}), postMessage: vi.fn() };
    const { listeners, openWindow } = loadWorker([client]);
    const close = vi.fn();
    await dispatch(listeners.get("notificationclick"), {
      notification: { close, data: { url: payload.url } },
    });
    expect(close).toHaveBeenCalled();
    expect(client.focus).toHaveBeenCalled();
    expect(client.postMessage).toHaveBeenCalledWith({
      type: "paperclip:navigate",
      url: "/PAP/decisions?item=abc%2F1",
    });
    expect(openWindow).not.toHaveBeenCalled();
  });

  it("opens a new window with the same-origin URL when no client is open", async () => {
    const { listeners, openWindow } = loadWorker([]);
    await dispatch(listeners.get("notificationclick"), {
      notification: { close: vi.fn(), data: { url: payload.url } },
    });
    expect(openWindow).toHaveBeenCalledWith(`${ORIGIN}/PAP/decisions?item=abc%2F1`);
  });

  it("rejects a cross-origin url and falls back to /", async () => {
    const { listeners, openWindow } = loadWorker([]);
    await dispatch(listeners.get("notificationclick"), {
      notification: { close: vi.fn(), data: { url: "https://evil.example.net/x?y=1" } },
    });
    expect(openWindow).toHaveBeenCalledWith(`${ORIGIN}/`);
  });
});
