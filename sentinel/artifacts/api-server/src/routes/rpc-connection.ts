import { Router, type IRouter } from "express";
import { ownerId } from "../lib/owner-auth";
import { GetRpcConnectionResponse, UpdateRpcConnectionBody, ResetRpcConnectionResponse, TestRpcConnectionBody, TestRpcConnectionResponse } from "@workspace/api-zod";
import { event, latch, now, readState, TradingError, withState } from "../lib/sentinel/store";
import { rpcConfigProblem, rpcEncryptionReady, rpcEndpoint, rpcIsOverride, sealRpc, environmentRpcEndpoints } from "../lib/sentinel/rpc-config";
import { rpcPool } from "../lib/sentinel/rpc-pool";
import { rpcFailureMessage, rpcWebsocketsAllowed, testRpcEndpoint } from "../lib/sentinel/rpc-endpoint";
import { resetRpcRiskStreams } from "../lib/sentinel/risk-stream";
import { resetLaunchDiscoveryConnection } from "../lib/sentinel/market";
import type { State } from "../lib/sentinel/types";

const router: IRouter = Router();
function status(s: State) {
  const configured = !!s.rpcConnection?.encryptedUrl;
  const source = configured ? "app" : environmentRpcEndpoints().length ? "environment" : "public";
  const broken = rpcConfigProblem();
  const trustedProvider = configured && !broken ? rpcWebsocketsAllowed(rpcEndpoint()) : false;
  // A saved custom host is eligible for the separate DNS-pinned WS client;
  // this reports transport support, not a live subscription health check.
  const websockets = !broken;
  return GetRpcConnectionResponse.parse({
    source, configured, updatedAt: s.rpcConnection?.updatedAt ?? null,
    paused: !s.running, canChange: !s.running && !s.pending,
    environmentAvailable: !!environmentRpcEndpoints().length, encryptionReady: rpcEncryptionReady(),
    endpoints: broken ? [] : rpcPool.status(),
    websocketAlerts: websockets && !broken,
    message: broken ?? (configured
      ? `App RPC saved and encrypted. The URL is hidden. ${trustedProvider ? "Provider websocket subscriptions are supported." : "Custom-host websocket subscriptions use public DNS validation and pinned connections."} Configuration is not a live health check; polling remains active and alert delivery is not guaranteed.`
      : source === "environment" ? "Workspace RPC is active. You can replace it here without republishing." :
        "Public RPC is not suitable for live trading; connect a dedicated mainnet provider."),
  });
}
router.get("/", async (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(status(await readState(ownerId())));
});
router.post("/test", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const parsed = TestRpcConnectionBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Enter an HTTPS RPC URL (up to 4,096 characters)." }); return; }
  try {
    const urls = [parsed.data.url, ...(parsed.data.additionalUrls ?? [])];
    if (new Set(urls).size !== urls.length) throw new TradingError("RPC endpoints must be distinct.");
    await Promise.all(urls.map(url => testRpcEndpoint(url)));
    res.json(TestRpcConnectionResponse.parse({ success: true, message: "Solana mainnet, balance reads and slot reads verified. No changes saved; no trading started." }));
  } catch (e) {
    res.json(TestRpcConnectionResponse.parse({ success: false, message: rpcFailureMessage(e) }));
  }
});
router.put("/", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const parsed = UpdateRpcConnectionBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Enter an HTTPS RPC URL (up to 4,096 characters)." }); return; }
  const id = ownerId(), current = await readState(id);
  if (current.running || current.pending) { res.status(409).json({ error: "Pause entries and reconcile pending transactions before switching RPC. Open positions remain monitored." }); return; }
  if (!rpcEncryptionReady()) { res.status(503).json({ error: "RPC encryption is unavailable. Configure a strong SESSION_SECRET; nothing was saved." }); return; }
  let urls: string[];
  try {
    const supplied = [parsed.data.url, ...(parsed.data.additionalUrls ?? [])];
    if (new Set(supplied).size !== supplied.length) throw new TradingError("RPC endpoints must be distinct.");
    urls = await Promise.all(supplied.map(url => testRpcEndpoint(url)));
    if (new Set(urls).size !== urls.length) throw new TradingError("RPC endpoints must be distinct after URL normalization.");
  }
  catch (e) { res.status(400).json({ error: rpcFailureMessage(e) }); return; }
  const encryptedUrl = sealRpc(urls.length === 1 ? urls[0] : JSON.stringify(urls), id);
  await withState(id, async s => {
    if (s.running || s.pending) throw new TradingError("Pause entries and reconcile pending transactions before switching RPC.", 409);
    await latch(id, true);
    s.running = false;
    s.rpcConnection = { encryptedUrl, updatedAt: now() };
    s.lastError = null;
    event(s, "rpc", "Verified Solana mainnet RPC switched. Entries remain paused; existing positions keep their wallet binding, and no trade was submitted.", "success");
  });
  resetLaunchDiscoveryConnection(); resetRpcRiskStreams();
  res.json(status(await readState(id)));
});
router.delete("/", async (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const id = ownerId(), current = await readState(id);
  if (current.running || current.pending) { res.status(409).json({ error: "Pause entries and reconcile pending transactions before switching RPC." }); return; }
  try { await Promise.all((environmentRpcEndpoints().length ? environmentRpcEndpoints() : ["https://api.mainnet-beta.solana.com"]).map(url => testRpcEndpoint(url))); }
  catch (e) { res.status(400).json({ error: `Fallback RPC failed: ${rpcFailureMessage(e)} Current connection remains unchanged.` }); return; }
  await withState(id, async s => {
    if (s.running || s.pending) throw new TradingError("Pause entries and reconcile pending transactions before switching RPC.", 409);
    await latch(id, true);
    s.running = false;
    s.rpcConnection = { encryptedUrl: null, updatedAt: now() };
    s.lastError = null;
    event(s, "rpc", "Verified workspace/public RPC fallback restored. Entries remain paused and no trade was submitted.", "success");
  });
  resetLaunchDiscoveryConnection(); resetRpcRiskStreams();
  res.json(ResetRpcConnectionResponse.parse(status(await readState(id))));
});
export default router;
