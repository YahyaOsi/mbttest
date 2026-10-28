import { scrypt, timingSafeEqual, createHmac, createHash } from "node:crypto";

export const PASSWORD_MINIMUM = 16;
export const SESSION_MS = 12 * 60 * 60 * 1000;
export function passwordReady(password?: string, sessionSecret?: string) {
  return !!password && password.length >= PASSWORD_MINIMUM && password.length <= 256 &&
    !!sessionSecret && sessionSecret.length >= 32;
}
export function passwordEpoch(password: string, sessionSecret: string) {
  return createHmac("sha256", sessionSecret).update("sentinel-owner-v1:").update(password).digest("hex");
}
export function tokenHash(token: string) { return createHash("sha256").update(token).digest("hex"); }
export function derivePassword(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 32, { N: 16384, r: 8, p: 1 }, (err, key) => err ? reject(err) : resolve(key));
  });
}
export function passwordEqual(actual: Buffer, expected: Buffer) {
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
