import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  agents, chatActions, chatEndpoints, chatExternalPrincipals, chatIdentityLinks, companies, createDb,
  toolApplications, toolConnections, type Db,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { inboxNotifyView, inboxSlackNotifier, type InboxItemSource } from "../services/inbox-slack-notifier.js";
import { formatInboxNotification, waitingLabel, type SlackInboxTransport } from "../services/chat-channels/slack/inbox-notify.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;

const item = (key: string, overrides: Partial<InboxItemSource> = {}, title = `Task ${key}`): InboxItemSource => ({
  dedupKey: key, sourceKind: "decision", whyNow: "Cần câu trả lời", activityAt: new Date(0).toISOString(), originAgentName: "CTO",
  relatedIssue: null,
  subject: { kind: "decision", id: key, title, identifier: null } as InboxItemSource["subject"],
  ...overrides,
});

describe("inbox Slack formatting", () => {
  it("states the ask, the agent and the wait, and escapes Slack control characters", () => {
    const view = inboxNotifyView(item("a", {}, "Deploy <@U1> & go"));
    const message = formatInboxNotification(view, 3 * 60 * 60_000, "https://x.test/HOC/decisions");
    const body = JSON.stringify(message.blocks);
    expect(message.text).toContain("Cần bạn quyết định");
    expect(body).toContain("từ CTO");
    expect(body).toContain("chờ 3 giờ");
    expect(body).toContain("&lt;@U1&gt; &amp; go");
    expect(body).toContain("<https://x.test/HOC/decisions|Mở Inbox>");
  });
  it("omits the link without a base URL", () => {
    expect(JSON.stringify(formatInboxNotification(inboxNotifyView(item("a")), 0, null).blocks)).not.toContain("Mở Inbox");
    expect(waitingLabel(new Date(0).toISOString(), 30 * 60_000)).toBe("30 phút");
  });
});

describeDatabase("inbox Slack notifier", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let companyId: string;
  let endpointId: string;
  let pending: InboxItemSource[];
  let clock: number;
  let posts: Array<{ channel: string; text: string; threadTs?: string }>;
  let updates: Array<{ ts: string; text: string }>;
  let failPosts = false;
  let enabled = true;
  let listFails = false;

  const transport: SlackInboxTransport = {
    async post(args) {
      if (failPosts) throw new Error("slack down");
      posts.push({ channel: args.channel, text: args.text, threadTs: args.threadTs });
      return { channel: "D123", ts: `ts-${posts.length}` };
    },
    async update(args) { updates.push({ ts: args.ts, text: args.text }); },
  };
  const make = (extra: Partial<Parameters<typeof inboxSlackNotifier>[1]> = {}) => inboxSlackNotifier(db, {
    transport, token: async () => "xoxb-fake", baseUrl: () => "https://paperclip.test", connectorsEnabled: async () => enabled,
    listPending: async () => { if (listFails) throw new Error("feed down"); return pending; },
    now: () => clock, reminderMs: 4 * 60 * 60_000, ...extra,
  });

  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("paperclip-inbox-slack-"); db = createDb(database.connectionString); }, 90_000);
  afterAll(async () => { await database?.cleanup(); });
  beforeEach(async () => {
    // The notifier sweeps every active endpoint, so drop fixtures from earlier tests.
    await db.delete(chatActions);
    await db.delete(chatIdentityLinks);
    await db.delete(chatEndpoints);
    companyId = randomUUID();
    const agentId = randomUUID();
    posts = []; updates = []; pending = []; clock = Date.parse("2026-11-11T00:00:00Z"); failPosts = false; enabled = true; listFails = false;
    await db.insert(companies).values({ id: companyId, name: "Fixture", issuePrefix: `I${companyId.slice(0, 6).toUpperCase()}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "CEO", adapterType: "paperclip_runner" });
    const [application] = await db.insert(toolApplications).values({ companyId, name: "Fixture", type: "mcp_http" }).returning();
    const [connection] = await db.insert(toolConnections).values({ companyId, applicationId: application!.id, name: "Fixture", uid: randomUUID(), transport: "mcp_remote", authKind: "none", enabled: true, status: "active" }).returning();
    const [endpoint] = await db.insert(chatEndpoints).values({ companyId, connectionId: connection!.id, provider: "slack", publicId: randomUUID(), assignedAgentId: agentId, status: "active", providerAccountId: "T1", sponsorUserId: "board" }).returning();
    endpointId = endpoint!.id;
    const [principal] = await db.insert(chatExternalPrincipals).values({ companyId, provider: "slack", providerAccountId: "T1", externalId: "U777" }).returning();
    await db.insert(chatIdentityLinks).values({ companyId, endpointId, principalId: principal!.id, paperclipUserId: "board", status: "linked" });
  });

  const rows = () => db.select().from(chatActions).where(and(eq(chatActions.endpointId, endpointId), eq(chatActions.kind, "inbox_notify")));

  it("sends one baseline summary for existing items, then one message per new item, never twice", async () => {
    pending = [item("old1"), item("old2")];
    const notifier = make();
    await notifier.runOnce();
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ channel: "U777" });
    expect(posts[0]!.text).toContain("2 việc");
    await notifier.runOnce();
    expect(posts).toHaveLength(1);

    pending = [item("old1"), item("old2"), item("new1")];
    await notifier.runOnce();
    await notifier.runOnce();
    expect(posts).toHaveLength(2);
    expect(posts[1]!.text).toContain("Task new1");
  });

  it("edits the message once when the item leaves the pending set", async () => {
    const notifier = make();
    await notifier.runOnce(); // empty baseline
    pending = [item("n1")];
    await notifier.runOnce();
    pending = [];
    await notifier.runOnce();
    await notifier.runOnce();
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ ts: "ts-1" });
    expect(updates[0]!.text).toContain("Đã xử lý");
  });

  it("does not mark everything resolved when the feed cannot be read", async () => {
    const notifier = make();
    await notifier.runOnce();
    pending = [item("n1")];
    await notifier.runOnce();
    listFails = true;
    await notifier.runOnce();
    expect(updates).toHaveLength(0);
  });

  it("posts exactly one reminder in the thread after the delay", async () => {
    const notifier = make();
    await notifier.runOnce();
    pending = [item("n1")];
    await notifier.runOnce();
    clock += 3 * 60 * 60_000;
    await notifier.runOnce();
    expect(posts).toHaveLength(1);
    clock += 2 * 60 * 60_000;
    await notifier.runOnce();
    await notifier.runOnce();
    expect(posts).toHaveLength(2);
    expect(posts[1]).toMatchObject({ threadTs: "ts-1", channel: "D123" });
  });

  it("never replays a message whose delivery was not confirmed", async () => {
    const notifier = make();
    await notifier.runOnce();
    pending = [item("n1")];
    failPosts = true;
    await notifier.runOnce();
    failPosts = false;
    await notifier.runOnce();
    expect(posts).toHaveLength(0);
    expect((await rows()).find(row => row.providerActionId.endsWith("n1"))?.status).toBe("uncertain");
  });

  it("is a no-op when connectors are disabled, no user is linked, or no token exists", async () => {
    pending = [item("n1")];
    enabled = false;
    await make().runOnce();
    enabled = true;
    await make({ token: async () => null }).runOnce();
    await db.delete(chatIdentityLinks).where(eq(chatIdentityLinks.endpointId, endpointId));
    await make().runOnce();
    expect(posts).toHaveLength(0);
    expect(await rows()).toHaveLength(0);
  });

  it("uses the channel override instead of a DM", async () => {
    await db.delete(chatIdentityLinks).where(eq(chatIdentityLinks.endpointId, endpointId));
    pending = [item("n1")];
    await make({ channelOverride: () => "C999" }).runOnce();
    expect(posts[0]).toMatchObject({ channel: "C999" });
  });
});
