import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AttentionItem } from "@paperclipai/shared";
import { DecisionBundleHeader, decisionHistoryCount, decisionHistoryQueryEnabled, findDeepLinkTarget, resolveDeepLink } from "./WhatNeedsMe";

describe("WhatNeedsMe decision history", () => {
  it("defers terminal-history queries until their curtain opens", () => {
    expect(decisionHistoryQueryEnabled("company-1", false)).toBe(false);
    expect(decisionHistoryQueryEnabled("company-1", true)).toBe(true);
    expect(decisionHistoryQueryEnabled(null, true)).toBe(false);
  });

  it("discloses when terminal history exceeds the visible window", () => {
    expect(decisionHistoryCount(undefined)).toBeUndefined();
    expect(decisionHistoryCount(49)).toBe(49);
    expect(decisionHistoryCount(50)).toBe(50);
    expect(decisionHistoryCount(51)).toBe("50+");
  });

  it("labels general bundles as decisions instead of cleanups", () => {
    const single = renderToStaticMarkup(
      <DecisionBundleHeader agentName="Planner" title="Choose a route" originIssue={null} count={1} />,
    );
    const multiple = renderToStaticMarkup(
      <DecisionBundleHeader agentName="Planner" title="Choose routes" originIssue={null} count={2} />,
    );

    expect(single).toContain("Planner proposed 1 decision");
    expect(multiple).toContain("Planner proposed 2 decisions");
    expect(single).not.toContain("cleanup");
    expect(multiple).not.toContain("cleanup");
  });
});

describe("WhatNeedsMe deep link target", () => {
  const items = [
    { id: "attn:a", sourceKind: "approval", subject: { id: "s1" } },
    { id: "attn:b", sourceKind: "decision", subject: { id: "d1" } },
  ] as unknown as AttentionItem[];

  it("matches ?item= by attention item id", () => {
    expect(findDeepLinkTarget(items, "attn:a", null)?.id).toBe("attn:a");
  });

  it("returns undefined for an unknown ?item=", () => {
    expect(findDeepLinkTarget(items, "attn:gone", null)).toBeUndefined();
  });

  it("keeps ?decisionId= matching decision subjects", () => {
    expect(findDeepLinkTarget(items, null, "d1")?.id).toBe("attn:b");
    expect(findDeepLinkTarget(items, null, "s1")).toBeUndefined();
  });
});

describe("WhatNeedsMe resolveDeepLink", () => {
  const base = {
    hasFeed: true,
    target: undefined,
    isFetching: false,
    dataUpdatedAt: 2000,
    linkedAt: 1000,
    routeCompanyPrefix: "PAP",
    selectedCompanyPrefix: "PAP",
  };
  const hit = { id: "attn:a" } as AttentionItem;

  it("opens a hit from cached data while a refetch is in flight", () => {
    expect(resolveDeepLink({ ...base, target: hit, isFetching: true, dataUpdatedAt: 500 })).toBe("open");
  });

  it("waits on a miss while fetching or when data predates the link", () => {
    expect(resolveDeepLink({ ...base, isFetching: true })).toBe("wait");
    expect(resolveDeepLink({ ...base, dataUpdatedAt: 500 })).toBe("wait");
    expect(resolveDeepLink({ ...base, hasFeed: false })).toBe("wait");
  });

  it("reports missing only after a fresh completed fetch", () => {
    expect(resolveDeepLink(base)).toBe("missing");
  });

  it("waits while the selected company is not the route company", () => {
    expect(resolveDeepLink({ ...base, selectedCompanyPrefix: "OLD" })).toBe("wait");
    expect(resolveDeepLink({ ...base, target: hit, selectedCompanyPrefix: "OLD" })).toBe("wait");
    expect(resolveDeepLink({ ...base, routeCompanyPrefix: "pap" })).toBe("missing");
  });
});
