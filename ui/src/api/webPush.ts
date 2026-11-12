import type { WebPushConfig, WebPushSubscribe, WebPushSubscriptionSummary } from "@paperclipai/shared";
import { api } from "./client";

export const webPushApi = {
  getConfig: () => api.get<WebPushConfig>("/web-push/config"),
  listMine: () => api.get<WebPushSubscriptionSummary[]>("/web-push/subscriptions/me"),
  subscribe: (data: WebPushSubscribe) =>
    api.put<WebPushSubscriptionSummary>("/web-push/subscriptions/me", data),
  unsubscribe: (endpoint: string) =>
    api.post<void>("/web-push/subscriptions/me/unsubscribe", { endpoint }),
};
