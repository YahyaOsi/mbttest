import { randomBytes, createHmac } from "node:crypto";
import { Router, type Request, type RequestHandler, type IRouter } from "express";
import { pool } from "@workspace/db";
import { UnlockOwnerBody } from "@workspace/api-zod";
import { derivePassword, passwordEpoch, passwordEqual, passwordReady, PASSWORD_MINIMUM, SESSION_MS, tokenHash } from "./owner-policy";

// Preserve existing configured owner's ledger, if any. Authentication no longer
// accepts Clerk IDs, signup, roles, or any client-provided account identifier.
export const ownerId = () => process.env.SENTINEL_OWNER_USER_ID || "sentinel-owner";
export const passwordConfigured = () => passwordReady(process.env.SENTINEL_APP_PASSWORD, process.env.SESSION_SECRET);
const epoch = () => passwordEpoch(process.env.SENTINEL_APP_PASSWORD!, process.env.SESSION_SECRET!);
const COOKIE = "__Secure-sentinel-owner";
// Preview runs in an iframe. Partitioning supports that context without sharing
// a session across embedding sites; mandatory HTTPS Origin checks protect writes.
const cookieOptions = { httpOnly: true, secure: true, sameSite: "none" as const, partitioned: true, path: "/api" };
function cookieToken(req: Request) {
  const value = (req.get("cookie") || "").split(";").map(x => x.trim()).find(x => x.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  return value && /^[a-f0-9]{64}$/.test(value) ? value : null;
}
export const sameOrigin: RequestHandler = (req, res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) { next(); return; }
  const origin = req.get("origin");
  const host = (req.get("x-forwarded-host") || req.get("host") || "").split(",")[0].trim();
  try {
    if (!origin || new URL(origin).host !== host || new URL(origin).protocol !== "https:") {
      res.status(403).json({ error: "A same-origin HTTPS request is required." }); return;
    }
  } catch { res.status(403).json({ error: "Invalid request origin." }); return; }
  next();
};
async function session(req: Request) {
  const token = cookieToken(req);
  if (!token || !passwordConfigured()) return null;
  const id = tokenHash(token);
  const r = await pool.query("SELECT id FROM sentinel_owner_sessions WHERE id=$1 AND epoch=$2 AND expires_at>NOW()", [id, epoch()]);
  return r.rows.length ? id : null;
}
export const requireOwner: RequestHandler = async (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  if (!await session(req)) { res.status(401).json({ error: "Unlock your private console with its password." }); return; }
  next();
};
let verifier: { epoch: string; hash: Promise<Buffer> } | null = null;
async function passwordValid(input: string) {
  const current = epoch();
  if (!verifier || verifier.epoch !== current) verifier = { epoch: current, hash: derivePassword(process.env.SENTINEL_APP_PASSWORD!, process.env.SESSION_SECRET!) };
  return passwordEqual(await derivePassword(input, process.env.SESSION_SECRET!), await verifier.hash);
}
async function reserveLogin(req: Request) {
  const ip = createHmac("sha256", process.env.SESSION_SECRET!).update(req.ip || req.socket.remoteAddress || "unknown").digest("hex");
  const reserve = async (key: string, limit: number) => {
    const r = await pool.query(
      `INSERT INTO sentinel_login_limits(key,started_at,attempts) VALUES($1,NOW(),1)
       ON CONFLICT(key) DO UPDATE SET
         attempts=CASE WHEN sentinel_login_limits.started_at<NOW()-INTERVAL '15 minutes' THEN 1 ELSE sentinel_login_limits.attempts+1 END,
         started_at=CASE WHEN sentinel_login_limits.started_at<NOW()-INTERVAL '15 minutes' THEN NOW() ELSE sentinel_login_limits.started_at END
       RETURNING attempts`, [key]);
    return Number(r.rows[0].attempts) <= limit;
  };
  if (!await reserve("global", 100)) return { allowed: false, ipKey: `ip:${ip}` };
  await pool.query("DELETE FROM sentinel_login_limits WHERE started_at<NOW()-INTERVAL '1 day'");
  return { allowed: await reserve(`ip:${ip}`, 12), ipKey: `ip:${ip}` };
}
export const ownerAuthRouter: IRouter = Router();
ownerAuthRouter.use("/auth", (_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
ownerAuthRouter.use("/auth", sameOrigin);
ownerAuthRouter.get("/auth/session", async (req, res): Promise<void> => {
  res.json({ authenticated: !!await session(req), configured: passwordConfigured(), minimumPasswordLength: PASSWORD_MINIMUM });
});
ownerAuthRouter.post("/auth/login", async (req, res): Promise<void> => {
  if (!passwordConfigured()) { res.status(503).json({ error: "Password access is not configured. Set SENTINEL_APP_PASSWORD (16–256 characters) and a strong SESSION_SECRET in Secrets. The console stays locked." }); return; }
  const attempt = await reserveLogin(req);
  if (!attempt.allowed) { res.setHeader("Retry-After", "900"); res.status(429).json({ error: "Too many unlock attempts. Wait 15 minutes and try again." }); return; }
  const parsed = UnlockOwnerBody.safeParse(req.body);
  if (!parsed.success || !await passwordValid(parsed.data.password)) { res.status(401).json({ error: "Incorrect password." }); return; }
  const previous = cookieToken(req);
  const token = randomBytes(32).toString("hex");
  await pool.query("DELETE FROM sentinel_owner_sessions WHERE expires_at<=NOW() OR epoch!=$1 OR id=$2", [epoch(), previous ? tokenHash(previous) : ""]);
  await pool.query("INSERT INTO sentinel_owner_sessions(id,epoch,expires_at) VALUES($1,$2,$3)", [tokenHash(token), epoch(), new Date(Date.now() + SESSION_MS)]);
  await pool.query("DELETE FROM sentinel_login_limits WHERE key=$1 OR started_at<NOW()-INTERVAL '1 day'", [attempt.ipKey]);
  res.cookie(COOKIE, token, { ...cookieOptions, maxAge: SESSION_MS });
  res.json({ authenticated: true, configured: true, minimumPasswordLength: PASSWORD_MINIMUM });
});
ownerAuthRouter.post("/auth/logout", async (req, res): Promise<void> => {
  const token = cookieToken(req);
  if (token) await pool.query("DELETE FROM sentinel_owner_sessions WHERE id=$1", [tokenHash(token)]);
  res.clearCookie(COOKIE, cookieOptions);
  res.json({ success: true, message: "Console locked. The trading worker continues independently; use Pause or Emergency to stop trading." });
});
