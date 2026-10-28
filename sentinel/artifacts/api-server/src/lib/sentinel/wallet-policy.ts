import type { State } from "./types";

export function walletProblem(s: Pick<State, "walletBinding" | "positions" | "pending">, configured: string | null) {
  if (!configured) return "Configure the burner private key securely in Secrets.";
  if (s.pending && s.pending.wallet !== configured) return "Pending transaction belongs to the previous wallet. Restore that wallet key and reconcile before switching.";
  const live = s.positions.filter(p => p.mode === "live" && ["open", "pending"].includes(p.status));
  if (live.some(p => p.walletAddress !== configured)) return "Open exposure belongs to another or unverified wallet. Restore the original key and close/reconcile before switching.";
  if (!s.walletBinding) return "Independently verify and confirm the configured burner address in Setup.";
  if (s.walletBinding !== configured) return "Burner key changed. New entries are blocked. Restore the original key for any exits, or pause and verify the new address in Setup after closing all live exposure.";
  return null;
}
