// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockApi = vi.hoisted(() => ({
  getConfig: vi.fn(),
  listMine: vi.fn(),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
}));
vi.mock("@/api/webPush", () => ({ webPushApi: mockApi }));

import { disablePush, enablePush, getPushSupport, syncPushSubscription } from "./web-push";

const P256DH = "B".repeat(87);
const AUTH = "a".repeat(22);
const PUBLIC_KEY = "BPublicKey_-AAAA";

const calls: string[] = [];
let permission: NotificationPermission;
let subscription: ReturnType<typeof makeSubscription> | null;
const pushManager = {
  getSubscription: vi.fn(async () => subscription),
  subscribe: vi.fn(async () => {
    calls.push("subscribe");
    subscription = makeSubscription("https://fcm.googleapis.com/send/new");
    return subscription;
  }),
};

function makeSubscription(endpoint: string, key?: ArrayBuffer) {
  return {
    endpoint,
    options: { applicationServerKey: key ?? null },
    toJSON: () => ({ endpoint, keys: { p256dh: P256DH, auth: AUTH } }),
    unsubscribe: vi.fn(async () => true),
  };
}

function setNavigator(values: Record<string, unknown>) {
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(window.navigator, key, { value, configurable: true });
  }
}

function setup(options: { ios?: boolean; standalone?: boolean; push?: boolean; permission?: NotificationPermission } = {}) {
  permission = options.permission ?? "default";
  const NotificationMock = {
    get permission() {
      return permission;
    },
    requestPermission: vi.fn(async () => {
      calls.push("requestPermission");
      permission = "granted";
      return permission as NotificationPermission;
    }),
  };
  vi.stubGlobal("Notification", NotificationMock);
  if (options.push === false) {
    delete (window as unknown as Record<string, unknown>).PushManager;
  } else {
    (window as unknown as Record<string, unknown>).PushManager = class {};
  }
  setNavigator({
    userAgent: options.ios ? "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" : "Mozilla/5.0 (X11; Linux)",
    standalone: options.standalone ?? false,
    maxTouchPoints: 0,
    serviceWorker: {
      ready: Promise.resolve({ pushManager }),
    },
  });
  window.matchMedia = vi.fn(() => ({ matches: false })) as unknown as typeof window.matchMedia;
  return NotificationMock;
}

beforeEach(() => {
  calls.length = 0;
  subscription = null;
  vi.clearAllMocks();
  mockApi.subscribe.mockResolvedValue({});
  mockApi.unsubscribe.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getPushSupport", () => {
  it("reports available, denied, unsupported and iOS-needs-install", () => {
    setup();
    expect(getPushSupport()).toBe("available");
    setup({ permission: "denied" });
    expect(getPushSupport()).toBe("denied");
    setup({ push: false });
    expect(getPushSupport()).toBe("unsupported");
    setup({ ios: true, push: false });
    expect(getPushSupport()).toBe("ios-needs-install");
    setup({ ios: true, standalone: true });
    expect(getPushSupport()).toBe("available");
  });
});

describe("enablePush", () => {
  it("calls requestPermission first and registers the subscription", async () => {
    const notification = setup();
    const promise = enablePush({ enabled: true, publicKey: PUBLIC_KEY });
    // Synchronously after the call, only the permission prompt has been raised.
    expect(notification.requestPermission).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["requestPermission"]);
    await promise;
    expect(calls).toEqual(["requestPermission", "subscribe"]);
    expect(pushManager.subscribe).toHaveBeenCalledWith(
      expect.objectContaining({ userVisibleOnly: true }),
    );
    expect(mockApi.subscribe).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: "https://fcm.googleapis.com/send/new",
        keys: { p256dh: P256DH, auth: AUTH },
      }),
    );
  });

  it("does not subscribe when permission is denied", async () => {
    const notification = setup();
    notification.requestPermission.mockResolvedValueOnce("denied");
    await expect(enablePush({ enabled: true, publicKey: PUBLIC_KEY })).rejects.toThrow("PERMISSION_DENIED");
    expect(pushManager.subscribe).not.toHaveBeenCalled();
    expect(mockApi.subscribe).not.toHaveBeenCalled();
  });
});

describe("disablePush", () => {
  it("unregisters on the server and unsubscribes locally", async () => {
    setup({ permission: "granted" });
    subscription = makeSubscription("https://fcm.googleapis.com/send/old");
    const existing = subscription;
    await disablePush();
    expect(mockApi.unsubscribe).toHaveBeenCalledWith("https://fcm.googleapis.com/send/old");
    expect(existing.unsubscribe).toHaveBeenCalled();
  });
});

describe("syncPushSubscription", () => {
  it("never prompts and does nothing unless permission is granted", async () => {
    const notification = setup({ permission: "default" });
    await syncPushSubscription();
    expect(notification.requestPermission).not.toHaveBeenCalled();
    expect(mockApi.getConfig).not.toHaveBeenCalled();
  });

  it("re-registers an existing subscription with the server", async () => {
    const notification = setup({ permission: "granted" });
    mockApi.getConfig.mockResolvedValue({ enabled: true, publicKey: PUBLIC_KEY });
    subscription = makeSubscription("https://fcm.googleapis.com/send/old");
    await syncPushSubscription();
    expect(mockApi.subscribe).toHaveBeenCalledTimes(1);
    expect(pushManager.subscribe).not.toHaveBeenCalled();
    expect(notification.requestPermission).not.toHaveBeenCalled();
  });

  it("re-subscribes when the server key differs", async () => {
    setup({ permission: "granted" });
    mockApi.getConfig.mockResolvedValue({ enabled: true, publicKey: PUBLIC_KEY });
    const oldKey = new Uint8Array([1, 2, 3, 4]).buffer;
    subscription = makeSubscription("https://fcm.googleapis.com/send/old", oldKey);
    const old = subscription;
    await syncPushSubscription();
    expect(old.unsubscribe).toHaveBeenCalled();
    expect(pushManager.subscribe).toHaveBeenCalledTimes(1);
    expect(mockApi.subscribe).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: "https://fcm.googleapis.com/send/new" }),
    );
  });

  it("skips when the server has push disabled", async () => {
    setup({ permission: "granted" });
    mockApi.getConfig.mockResolvedValue({ enabled: false, publicKey: null });
    subscription = makeSubscription("https://fcm.googleapis.com/send/old");
    await syncPushSubscription();
    expect(mockApi.subscribe).not.toHaveBeenCalled();
  });
});
