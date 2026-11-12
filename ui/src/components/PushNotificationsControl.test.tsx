// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PushNotificationsControl } from "./PushNotificationsControl";

const mockApi = vi.hoisted(() => ({ getConfig: vi.fn(), listMine: vi.fn() }));
const mockLib = vi.hoisted(() => ({
  getPushSupport: vi.fn(),
  enablePush: vi.fn(),
  disablePush: vi.fn(),
  getCurrentEndpoint: vi.fn(),
}));

vi.mock("@/api/webPush", () => ({ webPushApi: mockApi }));
vi.mock("@/lib/web-push", () => mockLib);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
  await result;
}

async function settle() {
  for (let i = 0; i < 5; i += 1) await flush();
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let permission: NotificationPermission;

function render() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  flushSync(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <PushNotificationsControl />
      </QueryClientProvider>,
    );
  });
}

function buttonByText(text: string) {
  return Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes(text));
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  permission = "default";
  vi.stubGlobal("Notification", {
    get permission() {
      return permission;
    },
  });
  mockLib.getPushSupport.mockReturnValue("available");
  mockLib.getCurrentEndpoint.mockResolvedValue(null);
  mockApi.getConfig.mockResolvedValue({ enabled: true, publicKey: "KEY" });
  mockApi.listMine.mockResolvedValue([]);
});

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("PushNotificationsControl", () => {
  it("explains an unsupported browser", async () => {
    mockLib.getPushSupport.mockReturnValue("unsupported");
    render();
    await settle();
    expect(container.textContent).toContain("does not support push notifications");
  });

  it("explains how to add to the Home Screen on iOS", async () => {
    mockLib.getPushSupport.mockReturnValue("ios-needs-install");
    render();
    await settle();
    expect(container.textContent).toContain("Add to Home");
    expect(buttonByText("Turn on")).toBeUndefined();
  });

  it("explains how to re-allow when denied", async () => {
    mockLib.getPushSupport.mockReturnValue("denied");
    render();
    await settle();
    expect(container.textContent).toContain("blocked");
    expect(buttonByText("Turn on")).toBeUndefined();
  });

  it("explains a server with push disabled", async () => {
    mockApi.getConfig.mockResolvedValue({ enabled: false, publicKey: null });
    render();
    await settle();
    expect(container.textContent).toContain("turned off on this server");
    expect(buttonByText("Turn on")).toBeUndefined();
  });

  it("offers the enable button when off and calls enablePush from the tap", async () => {
    mockLib.enablePush.mockImplementation(() => new Promise(() => {}));
    render();
    await settle();
    const button = buttonByText("Turn on notifications on this device");
    expect(button).toBeDefined();
    flushSync(() => button!.click());
    // enablePush is invoked synchronously within the click, with the preloaded config.
    expect(mockLib.enablePush).toHaveBeenCalledTimes(1);
    expect(mockLib.enablePush).toHaveBeenCalledWith({ enabled: true, publicKey: "KEY" });
    expect(container.textContent).toContain("Turning on");
  });

  it("shows an error with retry when enabling fails", async () => {
    mockLib.enablePush.mockRejectedValueOnce(new Error("PERMISSION_DISMISSED"));
    render();
    await settle();
    flushSync(() => buttonByText("Turn on notifications")!.click());
    await settle();
    expect(container.querySelector("[role=alert]")?.textContent).toContain("not granted");
    expect(buttonByText("Retry")).toBeDefined();
  });

  it("shows the on state with devices and turns off", async () => {
    permission = "granted";
    mockLib.getCurrentEndpoint.mockResolvedValue("https://fcm.googleapis.com/send/x");
    mockLib.disablePush.mockResolvedValue(undefined);
    mockApi.listMine.mockResolvedValue([
      { id: "1", userAgent: "Pixel Chrome", createdAt: "2026-01-01", lastSuccessAt: null },
    ]);
    render();
    await settle();
    expect(container.textContent).toContain("On for this device");
    expect(container.textContent).toContain("Pixel Chrome");
    flushSync(() => buttonByText("Turn off")!.click());
    await settle();
    expect(mockLib.disablePush).toHaveBeenCalledTimes(1);
  });

  it("shows a retry when the config cannot be loaded", async () => {
    mockApi.getConfig.mockRejectedValue(new Error("boom"));
    render();
    await settle();
    expect(container.querySelector("[role=alert]")).not.toBeNull();
    expect(buttonByText("Retry")).toBeDefined();
  });
});
