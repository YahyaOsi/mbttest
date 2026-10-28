import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import type { z } from "zod/v4";

export const ownerSessions = pgTable("sentinel_owner_sessions", {
  id: text("id").primaryKey(), // SHA-256 of a random cookie, never the cookie itself.
  epoch: text("epoch").notNull(), // Keyed password fingerprint; rotation invalidates sessions.
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, t => [index("sentinel_session_expiry").on(t.expiresAt)]);
export const insertOwnerSessionSchema = createInsertSchema(ownerSessions);
export type InsertOwnerSession = z.infer<typeof insertOwnerSessionSchema>;
