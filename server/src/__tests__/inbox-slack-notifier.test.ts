import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  agents, chatActions, chatEndpoints, chatExternalPrincipals, chatIdentityLinks, companies, createDb,
  toolApplications, toolConnections, type Db,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { inboxNotifyView, inboxSlackNotifier, type InboxItemSource } from "../services/inbox-slack-notifier.js";
import { matchInboxReply, parseSlackThreadReply } from "../services/chat-channels/slack/inbox-reply.js";
import { formatInboxNotification, parseSlackBlockActions, waitingLabel, type SlackInboxTransport } from "../services/chat-channels/slack/inbox-notify.js";
import { handleInboxClick, handleInboxThreadReply, type InboxActionApi, type InboxRequest } from "../services/inbox-slack-actions.js";

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
  it("always states what the reader has to do", () => {
    const view = inboxNotifyView(item("a"));
    const linkOnly = JSON.stringify(formatInboxNotification(view, 0, "https://x.test/HOC/decisions").blocks);
    expect(linkOnly).toContain("Bạn làm:* mở link");
    const withButton = JSON.stringify(formatInboxNotification(view, 0, null, [{ actionId: "inbox:a", text: "Có" }]).blocks);
    expect(withButton).toContain("Bạn làm:* bấm một nút");
  });
});

describe("Slack thread reply parsing and matching", () => {
  const event = (over: Record<string, unknown> = {}) => JSON.stringify({ type: "event_callback", team_id: "T1", event_id: "E1", event: { type: "message", user: "U1", channel: "D1", ts: "2.0", thread_ts: "1.0", text: "ok", ...over } });
  const opts = [{ index: 1, label: "Giữ dừng", hint: null }, { index: 2, label: "Chạy tiếp", hint: null }];
  it("accepts only plain user replies inside a thread", () => {
    expect(parseSlackThreadReply(event(), "application/json")).toMatchObject({ userId: "U1", threadTs: "1.0", ts: "2.0" });
    expect(parseSlackThreadReply(event({ thread_ts: "2.0" }), "application/json")).toBeNull();
    expect(parseSlackThreadReply(event({ bot_id: "B1" }), "application/json")).toBeNull();
    expect(parseSlackThreadReply(event({ subtype: "message_changed" }), "application/json")).toBeNull();
    expect(parseSlackThreadReply(event(), "application/x-www-form-urlencoded")).toBeNull();
  });
  it("matches by number, label (diacritics-insensitive) and yes/no synonyms", () => {
    expect(matchInboxReply("2", opts)).toMatchObject({ kind: "match", option: { index: 2 } });
    expect(matchInboxReply("chay tiep", opts)).toMatchObject({ kind: "match", option: { index: 2 } });
    expect(matchInboxReply("Giữ dừng nhé", opts)).toMatchObject({ kind: "match", option: { index: 1 } });
    const yesNo = [{ index: 1, label: "Duyệt", hint: "accept" as const }, { index: 2, label: "Từ chối", hint: "reject" as const }];
    expect(matchInboxReply("ok", yesNo)).toMatchObject({ kind: "match", option: { index: 1 } });
    expect(matchInboxReply("không", yesNo)).toMatchObject({ kind: "match", option: { index: 2 } });
  });
  it("never guesses: ambiguous, questions, long text and unknown numbers are no match", () => {
    expect(matchInboxReply("ok", [{ index: 1, label: "Chạy tiếp", hint: null }, { index: 2, label: "Duyệt", hint: null }])).toEqual({ kind: "none" });
    expect(matchInboxReply("ok", [{ index: 1, label: "Phương án A", hint: null }, { index: 2, label: "Phương án B", hint: null }])).toEqual({ kind: "none" });
    expect(matchInboxReply("5", opts)).toEqual({ kind: "none" });
    expect(matchInboxReply("chạy tiếp được không?", opts)).toEqual({ kind: "none" });
    expect(matchInboxReply("x ".repeat(50), opts)).toEqual({ kind: "none" });
    expect(matchInboxReply("ok nhưng không", [{ index: 1, label: "Có", hint: null }, { index: 2, label: "Không", hint: null }])).toEqual({ kind: "none" });
  });
});

describeDatabase("inbox Slack notifier", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let companyId: string;
  let endpointId: string;
  let pending: InboxItemSource[];
  let clock: number;
  let posts: Array<{ channel: string; text: string; threadTs?: string; blocks: any[] }>;
  let updates: Array<{ ts: string; text: string }>;
  let failPosts = false;
  let enabled = true;
  let listFails = false;

  const transport: SlackInboxTransport = {
    async post(args) {
      if (failPosts) throw new Error("slack down");
      posts.push({ channel: args.channel, text: args.text, threadTs: args.threadTs, blocks: args.blocks as any[] });
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

  it("sends a one-line intro, then one separate message per existing and new item, never twice", async () => {
    pending = [item("old1"), item("old2")];
    const notifier = make();
    await notifier.runOnce();
    expect(posts).toHaveLength(3);
    expect(posts[0]).toMatchObject({ channel: "U777" });
    expect(posts[0]!.text).toContain("2 việc");
    expect(posts.slice(1).map(post => post.text).join("|")).toContain("Task old1");
    expect(posts.slice(1).map(post => post.text).join("|")).toContain("Task old2");
    await notifier.runOnce();
    expect(posts).toHaveLength(3);

    pending = [item("old1"), item("old2"), item("new1")];
    await notifier.runOnce();
    await notifier.runOnce();
    expect(posts).toHaveLength(4);
    expect(posts[3]!.text).toContain("Task new1");
  });

  it("paces a backlog: at most 10 item messages per sweep, oldest-waiting first", async () => {
    pending = Array.from({ length: 12 }, (_, index) => item(`b${index}`, { activityAt: new Date(index * 1000).toISOString() }, `Task b${index}`));
    const notifier = make();
    await notifier.runOnce();
    expect(posts).toHaveLength(11);
    expect(posts[1]!.text).toContain("Task b0");
    await notifier.runOnce();
    expect(posts).toHaveLength(13);
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

  describe("action buttons", () => {
    const question = (id: string) => ({
      id, kind: "ask_user_questions", status: "pending",
      payload: { version: 1, questions: [{ id: "q1", prompt: "Chạy lại?", selectionMode: "single", options: [{ id: "o1", label: "Giữ dừng" }, { id: "o2", label: "Chạy tiếp" }] }] },
    });
    const questionItem = (key: string) => item(key, {
      sourceKind: "issue_thread_interaction", relatedIssue: { id: "issue-1", identifier: "HOC-17", title: "Sprint" } as InboxItemSource["relatedIssue"],
      subject: { kind: "issue_thread_interaction", id: key, title: "Chạy lại 52 email?" } as InboxItemSource["subject"],
    });
    let requests: InboxRequest[];
    let apiOk = true;
    const api = (interactions: any[]): InboxActionApi => ({
      interactions: async () => interactions as never,
      decision: async () => null,
      request: async request => { requests.push(request); if (apiOk && clearOnSuccess) pending = []; return apiOk ? { ok: true, status: 200 } : { ok: false, status: 409, message: "conflict" }; },
    });
    const buttonsOf = (post: { blocks: any[] }) => post.blocks.filter(block => block.type === "actions").flatMap(block => block.elements);
    const clickFor = (actionId: string, slackUserId = "U777") => ({ userId: slackUserId, teamId: "T1", channelId: "D123", messageTs: "ts-1", responseUrl: null, actions: [{ actionId, value: actionId }] });
    let clearOnSuccess = true;
    const clickDeps = (override: Partial<Parameters<typeof handleInboxClick>[1]> = {}) => ({
      transport, token: async () => "xoxb-fake", api: api([question("qa")]), listPending: async () => pending, ...override,
    });
    const endpointRow = async () => (await db.select().from(chatEndpoints).where(eq(chatEndpoints.id, endpointId)))[0]!;
    const setup = async () => {
      requests = []; apiOk = true;
      await make({ api: api([question("qa")]) }).runOnce(); // empty baseline
      pending = [questionItem("qa")];
      await make({ api: api([question("qa")]) }).runOnce();
      return buttonsOf(posts[0]!);
    };

    it("offers one button per answer plus Open links, persisting each button server-side", async () => {
      const buttons = await setup();
      expect(buttons.map((button: any) => button.text.text)).toEqual(["Giữ dừng", "Chạy tiếp", "Mở HOC-17", "Mở Inbox"]);
      expect(buttons.filter((button: any) => button.action_id.startsWith("inbox:link:")).every((button: any) => button.url)).toBe(true);
      const stored = await db.select().from(chatActions).where(eq(chatActions.kind, "inbox_action"));
      expect(stored).toHaveLength(2);
    });

    it("does not claim success when the item is still pending after the action", async () => {
      clearOnSuccess = false;
      try {
        const buttons = await setup();
        await handleInboxClick(db, clickDeps(), await endpointRow(), clickFor(buttons[0].action_id));
        expect(updates.at(-1)!.text).toContain("vẫn đang chờ");
        expect(updates.at(-1)!.text).not.toContain("✅");
      } finally { clearOnSuccess = true; }
    });

    it("click resolves through the web API route, updates the message, and blocks a second click", async () => {
      const buttons = await setup();
      const first = buttons[0].action_id;
      await handleInboxClick(db, clickDeps(), await endpointRow(), clickFor(first));
      expect(requests).toEqual([{ method: "POST", path: "/issues/issue-1/interactions/qa/respond", body: { answers: [{ questionId: "q1", optionIds: ["o1"] }] } }]);
      expect(updates.at(-1)!.text).toContain("Giữ dừng");
      await handleInboxClick(db, clickDeps(), await endpointRow(), clickFor(buttons[1].action_id));
      expect(requests).toHaveLength(1);
      // the later "left the pending set" sweep must not overwrite the recorded choice
      pending = [];
      const before = updates.length;
      await make().runOnce();
      expect(updates).toHaveLength(before);
    });

    it("rejects a click from a Slack account that is not linked to the recipient", async () => {
      const buttons = await setup();
      await handleInboxClick(db, clickDeps(), await endpointRow(), clickFor(buttons[0].action_id, "UOTHER"));
      expect(requests).toHaveLength(0);
      expect(updates).toHaveLength(0);
    });

    it("treats a click on an already-resolved item as stale and does nothing", async () => {
      const buttons = await setup();
      pending = [];
      await handleInboxClick(db, clickDeps(), await endpointRow(), clickFor(buttons[0].action_id));
      expect(requests).toHaveLength(0);
      expect(updates.at(-1)!.text).toContain("Đã xử lý");
    });

    it("releases the claim when the server rejects the action so the user can retry", async () => {
      const buttons = await setup();
      apiOk = false;
      await handleInboxClick(db, clickDeps(), await endpointRow(), clickFor(buttons[0].action_id));
      apiOk = true;
      await handleInboxClick(db, clickDeps(), await endpointRow(), clickFor(buttons[0].action_id));
      expect(requests).toHaveLength(2);
      expect(updates).toHaveLength(1);
    });

    it("ignores link-button callbacks and unknown ids without touching the server", async () => {
      const buttons = await setup();
      await handleInboxClick(db, clickDeps(), await endpointRow(), clickFor("inbox:link:inbox"));
      await handleInboxClick(db, clickDeps(), await endpointRow(), clickFor("inbox:nope"));
      expect(requests).toHaveLength(0);
      expect(buttons.length).toBeGreaterThan(0);
    });

    it("gives blocked tasks Done/Cancel buttons that ask for confirmation", async () => {
      await make({ api: api([]) }).runOnce();
      pending = [item("b1", { sourceKind: "blocker_attention", subject: { kind: "issue", id: "issue-9", title: "Kẹt", identifier: "HOC-49" } as InboxItemSource["subject"] })];
      await make({ api: api([]) }).runOnce();
      const buttons = buttonsOf(posts[0]!);
      expect(buttons.slice(0, 2).map((button: any) => button.text.text)).toEqual(["Đánh dấu xong", "Huỷ task"]);
      expect(buttons[0].confirm).toBeTruthy();
      expect(buttons[1]).toMatchObject({ style: "danger" });
      expect(buttons[1].confirm).toBeTruthy();
    });

    it("falls back to link buttons when the server cannot execute actions", async () => {
      await make({ api: null }).runOnce();
      pending = [questionItem("qa")];
      await make({ api: null }).runOnce();
      expect(buttonsOf(posts[0]!).map((button: any) => button.text.text)).toEqual(["Mở HOC-17", "Mở Inbox"]);
      expect(await db.select().from(chatActions).where(eq(chatActions.kind, "inbox_action"))).toHaveLength(0);
    });


    describe("thread replies", () => {
      const threadReply = (text: string, over: Partial<{ userId: string; ts: string; threadTs: string }> = {}) => ({
        teamId: "T1", userId: "U777", channel: "D123", ts: `r-${Math.random()}`, threadTs: "ts-1", text, eventId: null, ...over,
      });
      const send = async (text: string, over = {}, deps = clickDeps()) => handleInboxThreadReply(db, deps, await endpointRow(), threadReply(text, over));

      it("resolves the item for an exact label and records the choice", async () => {
        await setup();
        expect(await send("chạy tiếp")).toBe(true);
        expect(requests).toEqual([{ method: "POST", path: "/issues/issue-1/interactions/qa/respond", body: { answers: [{ questionId: "q1", optionIds: ["o2"] }] } }]);
        expect(posts.at(-1)!.text).toContain("Đã ghi");
        expect(updates.at(-1)!.text).toContain("Chạy tiếp");
      });
      it("resolves by option number", async () => {
        await setup();
        await send("1");
        expect(requests[0]!.body).toMatchObject({ answers: [{ optionIds: ["o1"] }] });
      });
      it("on an unclear reply writes nothing and re-offers the buttons", async () => {
        await setup();
        const before = posts.length;
        expect(await send("để mình nghĩ thêm")).toBe(true);
        expect(requests).toHaveLength(0);
        expect(posts.length).toBe(before + 1);
        expect(buttonsOf(posts.at(-1)!).length).toBeGreaterThan(0);
        expect(posts.at(-1)!.threadTs).toBe("ts-1");
      });
      it("never executes a destructive match from text; asks for the confirm button", async () => {
        await make({ api: api([]) }).runOnce();
        pending = [item("b1", { sourceKind: "blocker_attention", subject: { kind: "issue", id: "issue-9", title: "Kẹt", identifier: "HOC-49" } as InboxItemSource["subject"] })];
        await make({ api: api([]) }).runOnce();
        requests = [];
        await send("huỷ", {}, clickDeps({ api: api([]) }));
        expect(requests).toHaveLength(0);
        expect(posts.at(-1)!.text).toContain("nút");
      });
      it("ignores a reply from an unlinked Slack user and does not resolve", async () => {
        await setup();
        expect(await send("1", { userId: "UOTHER" })).toBe(true);
        expect(requests).toHaveLength(0);
      });
      it("treats a reply to an already-resolved item as stale", async () => {
        await setup();
        pending = [];
        await send("1");
        expect(requests).toHaveLength(0);
      });
      it("processes a redelivered event once", async () => {
        await setup();
        const reply = threadReply("1");
        const endpoint = await endpointRow();
        await handleInboxThreadReply(db, clickDeps(), endpoint, reply);
        await handleInboxThreadReply(db, clickDeps(), endpoint, reply);
        expect(requests).toHaveLength(1);
      });
      it("leaves unknown threads and link-only messages to the normal pipeline", async () => {
        await setup();
        expect(await send("1", { threadTs: "ts-999" })).toBe(false);
        await db.delete(chatActions).where(eq(chatActions.kind, "inbox_action"));
        expect(await send("1")).toBe(false);
        expect(requests).toHaveLength(0);
      });
    });

    it("parses only block_actions form payloads", () => {
      const payload = JSON.stringify({ type: "block_actions", user: { id: "U1" }, team: { id: "T1" }, actions: [{ action_id: "inbox:abc" }], container: { channel_id: "D1", message_ts: "1.2" } });
      expect(parseSlackBlockActions(`payload=${encodeURIComponent(payload)}`, "application/x-www-form-urlencoded")).toMatchObject({ userId: "U1", teamId: "T1", channelId: "D1", messageTs: "1.2" });
      expect(parseSlackBlockActions(payload, "application/json")).toBeNull();
      expect(parseSlackBlockActions(`payload=${encodeURIComponent('{"type":"view_submission"}')}`, "application/x-www-form-urlencoded")).toBeNull();
    });
  });
});
