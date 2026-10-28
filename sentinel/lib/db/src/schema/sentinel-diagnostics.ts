import { pgTable, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import type { z } from "zod/v4";

/** Append-only trading funnel, independent of the rolling UI activity list. */
export const sentinelDiagnostics = pgTable("sentinel_diagnostics", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  time: timestamp("time", { withTimezone: true }).notNull(),
  kind: text("kind").notNull(),
  mint: text("mint"),
  data: jsonb("data").notNull(),
}, t => [index("sentinel_diagnostics_owner_time").on(t.userId, t.time)]);
export const insertSentinelDiagnosticSchema = createInsertSchema(sentinelDiagnostics);
export type InsertSentinelDiagnostic = z.infer<typeof insertSentinelDiagnosticSchema>;
