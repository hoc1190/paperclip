export interface WebPushConfig {
  enabled: boolean;
  publicKey: string | null;
}

export interface WebPushSubscriptionSummary {
  id: string;
  userAgent: string | null;
  createdAt: string;
  lastSuccessAt: string | null;
}

export interface WebPushInboxPayload {
  v: 1;
  title: string;
  body: string;
  url: string;
  tag: string;
  companyId: string;
  itemId: string;
}

export const INBOX_ITEM_DEEP_LINK_PARAM = "item";

export function inboxItemDeepLink(issuePrefix: string, itemId: string): string {
  return `/${issuePrefix}/decisions?${INBOX_ITEM_DEEP_LINK_PARAM}=${encodeURIComponent(itemId)}`;
}
