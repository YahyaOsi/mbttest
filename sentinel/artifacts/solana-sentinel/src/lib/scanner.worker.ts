import { ScannerIndex, type ScannerQuery, type ScannerRecord } from './scanner-index';
const index = new ScannerIndex();
self.onmessage = (event: MessageEvent<
  { kind: 'index'; rows: ScannerRecord[] } | { kind: 'query'; id: number; query: ScannerQuery }
>) => {
  if (event.data.kind === 'index') index.load(event.data.rows);
  else self.postMessage({ id: event.data.id, ...index.query(event.data.query) });
};
