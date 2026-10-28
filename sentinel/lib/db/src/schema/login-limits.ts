import { pgTable, text, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import type { z } from "zod/v4";

export const loginLimits = pgTable("sentinel_login_limits", {
  key: text("key").primaryKey(), // Keyed IP fingerprint or global bucket, no raw IP stored.
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  attempts: integer("attempts").notNull(),
});
export const insertLoginLimitSchema = createInsertSchema(loginLimits);
export type InsertLoginLimit = z.infer<typeof insertLoginLimitSchema>;
