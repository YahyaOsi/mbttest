export type ScannerRecord = {
  symbol: string; name: string; mint: string; status: string;
  pipelineStatus?: string;
  watchExpiresAt?: string | null; permanentlyRejectedAt?: string | null;
};
export type ScannerQuery = { q: string; status: string; tab: string; page: number };
export class ScannerIndex {
  private records: { text: string; status: string; watching: boolean; rejected: boolean }[] = [];
  private counts = { all: 0, watching: 0, rejected: 0 };
  load(rows: ScannerRecord[]) {
    this.counts = { all: rows.length, watching: 0, rejected: 0 };
    this.records = rows.map(c => {
      const watching = c.pipelineStatus ? c.pipelineStatus === 'active-watch'
        : !!c.watchExpiresAt && Date.parse(c.watchExpiresAt) > Date.now() && !c.permanentlyRejectedAt && c.status !== 'rejected';
      const rejected = c.status === 'rejected' || !!c.permanentlyRejectedAt;
      if (watching) this.counts.watching++;
      if (rejected) this.counts.rejected++;
      return { text: `${c.symbol} ${c.name} ${c.mint}`.toLowerCase(), status: c.pipelineStatus ?? c.status, watching, rejected };
    });
  }
  query({ q, status, tab, page }: ScannerQuery) {
    const needle = q.toLowerCase(), matches: number[] = [];
    this.records.forEach((r, i) => {
      if ((tab === 'all' || (tab === 'watching' ? r.watching : r.rejected)) &&
          (status === 'all' || status === r.status) && r.text.includes(needle)) matches.push(i);
    });
    const pages = Math.max(1, Math.ceil(matches.length / 50));
    const pg = Math.max(0, Math.min(page, pages - 1));
    return { indices: matches.slice(pg * 50, pg * 50 + 50), total: matches.length, pages, pg, counts: this.counts };
  }
}
