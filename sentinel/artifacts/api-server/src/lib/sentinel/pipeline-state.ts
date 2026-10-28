import type { Candidate, State } from "./types";

/** Presentation and scheduling share this projection of the durable ledger.
 * Never create a new watch deadline just because an old label says watching. */
export function reconcilePipeline(s: State, at = Date.now()) {
  for (const c of s.candidates) {
    if (s.pending && s.positions.find(p => p.id === s.pending!.positionId)?.mint === c.mint) {
      c.pipelineStatus = "order-attempted"; c.watchExpiresAt = null; continue;
    }
    const held = s.positions.find(p => p.mint === c.mint && p.mode === s.settings.mode &&
      (p.mode !== "live" || p.walletAddress === s.walletBinding) &&
      ["open", "retained", "closed", "transferred", "pending"].includes(p.status));
    const row = s.watchlist?.[c.mint];
    if (held) {
      c.pipelineStatus = held.status === "pending" ? "order-attempted" : "filled";
      c.watchExpiresAt = null; continue;
    }
    if (row && !row.rejectedAt && at >= Date.parse(row.expiresAt)) {
      row.rejectedAt = new Date(at).toISOString();
      row.reason = "15-minute watch window expired without a completed entry.";
    }
    if (row?.rejectedAt || c.permanentlyRejectedAt) {
      c.permanentlyRejectedAt = row?.rejectedAt ?? c.permanentlyRejectedAt;
      c.status = "rejected"; c.pipelineStatus = "rejected-permanent";
      c.reasoning = row?.reason ?? c.reasoning; c.watchExpiresAt = null;
    } else if (c.status === "eligible") {
      c.pipelineStatus = "eligible";
    } else if (row) {
      c.status = "watching"; c.pipelineStatus = "active-watch";
      c.watchStartedAt = row.startedAt; c.watchExpiresAt = row.expiresAt;
    } else {
      c.watchExpiresAt = null;
      c.pipelineStatus = c.marketDataStatus === "awaiting_market_data" ? "awaiting-market" : "observed";
      if (c.status === "watching") c.status = "discovered";
    }
  }
  return s;
}
