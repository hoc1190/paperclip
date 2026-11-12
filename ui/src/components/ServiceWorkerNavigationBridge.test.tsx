// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServiceWorkerNavigationBridge } from "./ServiceWorkerNavigationBridge";

const navigate = vi.hoisted(() => vi.fn());
vi.mock("@/lib/router", () => ({ useNavigate: () => navigate }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let sw: EventTarget;

function post(data: unknown) {
  sw.dispatchEvent(new MessageEvent("message", { data }));
}

beforeEach(() => {
  sw = new EventTarget();
  Object.defineProperty(window.navigator, "serviceWorker", { value: sw, configurable: true });
  container = document.createElement("div");
  root = createRoot(container);
  flushSync(() => root.render(<ServiceWorkerNavigationBridge />));
});

afterEach(() => {
  flushSync(() => root.unmount());
  vi.clearAllMocks();
});

describe("ServiceWorkerNavigationBridge", () => {
  it("navigates on a paperclip:navigate message", () => {
    post({ type: "paperclip:navigate", url: "/PAP/decisions?item=a%3Ab" });
    expect(navigate).toHaveBeenCalledWith("/PAP/decisions?item=a%3Ab");
  });

  it("ignores other messages and non-relative urls", () => {
    post({ type: "other", url: "/x" });
    post({ type: "paperclip:navigate", url: "https://evil.example/" });
    post({ type: "paperclip:navigate", url: "//evil.example/" });
    post({ type: "paperclip:navigate" });
    post(null);
    expect(navigate).not.toHaveBeenCalled();
  });
});
