import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const webPushSubscriptions = pgTable("web_push_subscriptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull(),
  endpoint: text("endpoint").notNull(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  vapidKeyId: text("vapid_key_id").notNull(),
  userAgent: text("user_agent"),
  lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
  lastFailureAt: timestamp("last_failure_at", { withTimezone: true }),
  lastFailureCode: text("last_failure_code"),
  failureCount: integer("failure_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  endpointUq: uniqueIndex("web_push_subscriptions_endpoint_uq").on(table.endpoint),
  userIdx: index("web_push_subscriptions_user_idx").on(table.userId),
}));
