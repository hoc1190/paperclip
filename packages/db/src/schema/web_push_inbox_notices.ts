import { pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/** Durable dedup for Inbox web pushes. `item_key = "__baseline__"` marks a user+company baseline. */
export const webPushInboxNotices = pgTable("web_push_inbox_notices", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  itemKey: text("item_key").notNull(),
  notifiedAt: timestamp("notified_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  userCompanyItemUq: uniqueIndex("web_push_inbox_notices_user_company_item_uq").on(table.userId, table.companyId, table.itemKey),
}));
