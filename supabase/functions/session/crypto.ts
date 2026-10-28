// Small crypto helpers shared by the Witcher edge functions (this file is copied into each function folder;
// tests/functions.test.js checks the copies are identical). Pure: no Deno or network access, so Node can test it.

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** URL-safe random token (default 32 random bytes = 256 bits). */
export function randomToken(bytes = 32): string {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = "";
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Uniform random numeric code (no modulo bias): rejection sampling on 32-bit values. */
export function randomCode(digits = 6, random: () => number = () => crypto.getRandomValues(new Uint32Array(1))[0]): string {
  const range = 10 ** digits;
  const limit = Math.floor(0x100000000 / range) * range;
  let value = random();
  while (value >= limit) value = random();
  return String(value % range).padStart(digits, "0");
}

/** Salted hash of an access code. */
export function hashCode(salt: string, code: string): Promise<string> {
  return sha256Hex(`${salt}:${code}`);
}

/** Constant-time comparison of two strings (compares every character, even after a difference). */
export function timingSafeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
}
