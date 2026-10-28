import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type { PasswordHasher } from "../../ports/index.js";

// scrypt (memory-hard, built into Node: no native dependency). Stored as
//   scrypt$<log2 N>$<r>$<p>$<salt b64>$<hash b64>
// so the cost can be raised later and old hashes still verify. Asynchronous, so hashing never blocks the event loop.

const KEYLEN = 32;
const R = 8;
const P = 1;

function derive(password: string, salt: Buffer, log2n: number, r: number, p: number): Promise<Buffer> {
  const N = 2 ** log2n;
  return new Promise((resolve, reject) => {
    scrypt(password.normalize("NFKC"), salt, KEYLEN, { N, r, p, maxmem: 256 * N * r + 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export class ScryptHasher implements PasswordHasher {
  /** log2N 15 (32 MiB, ~100 ms) is the default; tests lower it. */
  constructor(private readonly log2n = 15) {}

  async hash(password: string): Promise<string> {
    const salt = randomBytes(16);
    const key = await derive(password, salt, this.log2n, R, P);
    return ["scrypt", this.log2n, R, P, salt.toString("base64"), key.toString("base64")].join("$");
  }

  async verify(password: string, stored: string): Promise<boolean> {
    const [scheme, n, r, p, salt, hash] = stored.split("$");
    if (scheme !== "scrypt" || !n || !r || !p || !salt || !hash) return false;
    const expected = Buffer.from(hash, "base64");
    const actual = await derive(password, Buffer.from(salt, "base64"), Number(n), Number(r), Number(p));
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }
}
