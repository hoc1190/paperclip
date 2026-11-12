import { Writable } from "node:stream";
import express from "express";
import pino from "pino";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createHttpLogger } from "../middleware/logger.js";
import { HTTP_LOG_REDACT_PATHS } from "../middleware/http-log-redaction.js";

describe("web push request logs", () => {
  it("does not log the endpoint or keys of a failed web push request", async () => {
    const canary = "synthetic-push-endpoint-canary";
    const chunks: string[] = [];
    const stream = new Writable({ write(chunk, _encoding, callback) { chunks.push(chunk.toString()); callback(); } });
    const app = express();
    app.use(express.json());
    app.use(createHttpLogger(pino({ redact: [...HTTP_LOG_REDACT_PATHS] }, stream)));
    app.put("/api/web-push/subscriptions/me", (_req, res) => res.status(400).json({ error: "bad" }));
    await request(app).put("/api/web-push/subscriptions/me")
      .send({ endpoint: `https://fcm.googleapis.com/fcm/send/${canary}`, keys: { p256dh: canary, auth: canary } });
    const output = chunks.join("");
    expect(output).not.toContain(canary);
    expect(JSON.parse(output.trim()).reqBody).toBe("[REDACTED]");
  });
});
