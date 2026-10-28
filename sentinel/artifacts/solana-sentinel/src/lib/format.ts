const usdFmt = (d: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: d, maximumFractionDigits: d });
export const usd = (n: number, d = 2) => usdFmt(d).format(n);
export const signedUsd = (n: number) => `${n > 0 ? '+' : n < 0 ? '-' : ''}${usd(Math.abs(n))}`;
export const compact = (n: number) =>
  '$' + new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
export const price = (n: number) => {
  if (!n) return '$0';
  if (n >= 1) return usd(n, 2);
  if (n >= 0.01) return usd(n, 4);
  return '$' + n.toFixed(Math.min(12, 2 - Math.floor(Math.log10(n))));
};
export const pct = (n: number, d = 1) => `${n > 0 ? '+' : ''}${n.toFixed(d)}%`;
export const shortMint = (m: string) => (m.length > 12 ? `${m.slice(0, 4)}…${m.slice(-4)}` : m);
export const ago = (iso: string | null | undefined) => {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};
export const age = (min: number) =>
  min < 60 ? `${Math.round(min)}m` : min < 1440 ? `${(min / 60).toFixed(1)}h` : `${(min / 1440).toFixed(1)}d`;
export const stamp = (iso: string) =>
  new Date(iso).toLocaleString('en-US', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
export const errMsg = (e: unknown) => {
  const x = e as { message?: string; data?: { error?: string; message?: string } } | null;
  return x?.data?.error || x?.data?.message || x?.message || 'Request failed';
};
