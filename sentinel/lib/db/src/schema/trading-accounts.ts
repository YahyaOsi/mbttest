import { pgTable, text, jsonb, timestamp, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import type { z } from "zod/v4";

// One durable, versioned state document per authenticated account. All writers
// acquire the same PostgreSQL advisory lock, including background workers.
export const tradingAccounts = pgTable("trading_accounts", {
  userId: text("user_id").primaryKey(),
  state: jsonb("state").notNull(),
  halted: boolean("halted").notNull().default(true),
  emergencyRequested: boolean("emergency_requested").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export const insertTradingAccountSchema = createInsertSchema(tradingAccounts);
export type InsertTradingAccount = z.infer<typeof insertTradingAccountSchema>;
