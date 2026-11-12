// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PushPermissionPrompt } from "./PushPermissionPrompt";

const mockApi = vi.hoisted(() => ({ getConfig: vi.fn() }));
const mockLib = vi.hoisted(() => ({
  getPushSupport: vi.fn(),
  isStandalone: vi.fn(),
  enablePush: vi.fn(),
  getCurrentEndpoint: vi.fn(),
}));
const pushToast = vi.hoisted(() => vi.fn());

vi.mock("@/api/webPush", () => ({ webPushApi: mockApi }));
vi.mock("@/lib/web-push", () => mockLib);
vi.mock("@/context/ToastContext", () => ({ useToastActions: () => ({ pushToast }) }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function wait(ms: number) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = new Promise<void>((resolve) => setTimeout(resolve, ms));
  });
  await result;
}

async function settle() {
  for (let i = 0; i < 5; i += 1) await wait(0);
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function render() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  flushSync(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/ACME/inbox"]}>
          <PushPermissionPrompt />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

function buttonByText(text: string) {
  return Array.from(document.body.querySelectorAll("button")).find((b) => b.textContent?.includes(text));
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.stubGlobal("Notification", { permission: "default" });
  mockLib.getPushSupport.mockReturnValue("available");
  mockLib.isStandalone.mockReturnValue(true);
  mockLib.getCurrentEndpoint.mockResolvedValue(null);
  mockApi.getConfig.mockResolvedValue({ enabled: true, publicKey: "KEY" });
  mockLib.enablePush.mockResolvedValue(undefined);
});

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
  window.localStorage.clear();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("PushPermissionPrompt", () => {
  it("opens after the delay and calls enablePush synchronously from the click", async () => {
    render();
    await settle();
    expect(buttonByText("Bật thông báo")).toBeUndefined();
    await wait(2100);
    await settle();
    expect(document.body.textContent).toContain("Bật thông báo Inbox");

    const button = buttonByText("Bật thông báo");
    expect(button).toBeDefined();
    button!.click();
    expect(mockLib.enablePush).toHaveBeenCalledTimes(1);
    expect(mockLib.enablePush).toHaveBeenCalledWith({ enabled: true, publicKey: "KEY" });

    await settle();
    expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({ tone: "success" }));
    expect(buttonByText("Để sau")).toBeUndefined();
  });

  it("snoozes on Để sau", async () => {
    render();
    await wait(2100);
    await settle();
    buttonByText("Để sau")!.click();
    await settle();
    expect(window.localStorage.getItem("paperclip:push-prompt-snoozed-until")).not.toBeNull();
    expect(mockLib.enablePush).not.toHaveBeenCalled();
  });

  it("shows blocked guidance on PERMISSION_DENIED", async () => {
    mockLib.enablePush.mockRejectedValue(new Error("PERMISSION_DENIED"));
    render();
    await wait(2100);
    await settle();
    buttonByText("Bật thông báo")!.click();
    await settle();
    expect(document.body.textContent).toContain("Cài đặt > Thông báo > Paperclip");
  });

  it("does not open when not installed", async () => {
    mockLib.isStandalone.mockReturnValue(false);
    render();
    await wait(2100);
    await settle();
    expect(document.body.textContent).not.toContain("Bật thông báo Inbox");
  });
});
