import { useEffect, useRef, useState } from 'react';
import type { Candidate } from '@workspace/api-client-react';
import type { ScannerQuery } from '@/lib/scanner-index';

type Page = {
  shown: Candidate[]; total: number; pages: number; pg: number;
  counts: { all: number; watching: number; rejected: number };
};
export function useScannerPage(data: Candidate[] | undefined, query: ScannerQuery) {
  const worker = useRef<Worker | null>(null), request = useRef(0), currentData = useRef(data);
  const [result, setResult] = useState<Page>({ shown: [], total: 0, pages: 1, pg: 0, counts: { all: 0, watching: 0, rejected: 0 } });
  const [busy, setBusy] = useState(true), [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const w = new Worker(new URL('../lib/scanner.worker.ts', import.meta.url), { type: 'module' });
    worker.current = w;
    w.onmessage = event => {
      if (event.data.id !== request.current) return;
      const { indices, ...page } = event.data;
      setResult({ ...page, shown: indices.map((i: number) => currentData.current?.[i]).filter(Boolean) });
      setBusy(false);
    };
    w.onerror = () => { setError('Scanner display worker failed. Reload this page to retry. Background trading is unaffected.'); setBusy(false); };
    return () => { w.terminate(); worker.current = null; };
  }, []);
  useEffect(() => {
    currentData.current = data;
    worker.current?.postMessage({ kind: 'index', rows: (data ?? []).map(c => ({
      symbol: c.symbol, name: c.name, mint: c.mint, status: c.status,
      pipelineStatus: c.pipelineStatus,
      watchExpiresAt: c.watchExpiresAt, permanentlyRejectedAt: c.permanentlyRejectedAt,
    })) });
  }, [data]);
  useEffect(() => {
    setBusy(true);
    worker.current?.postMessage({ kind: 'query', id: ++request.current, query });
  }, [data, query.q, query.status, query.tab, query.page]);
  return { ...result, busy, workerError: error };
}
