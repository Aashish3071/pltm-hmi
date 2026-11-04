import { createHmac, randomBytes, timingSafeEqual } from 'crypto'

/**
 * Codes for admin password recovery, shared by the app and the vendor's
 * `npm run recovery-code` tool. No Electron imports, so the tool can use it.
 *
 * The app shows a random request code; the vendor turns it, with the machine
 * ID, into a response code using a secret only the vendor's builds and tool
 * know. Codes use Crockford base32 (no I, L, O, U), so they read well over
 * the phone; O/I/L typed by mistake are read as 0/1/1.
 */

/** Used by builds made without PLTM_RECOVERY_SECRET. Public: never ship it. */
export const DEV_RECOVERY_SECRET = 'pltm-development-recovery-key-not-for-release'

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

function base32(bytes: Buffer, length: number): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5 && out.length < length) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  return out
}

/** Uppercases, drops spaces and dashes, and maps look-alike letters. */
export function normalizeCode(code: string): string {
  return String(code ?? '')
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
}

function group(code: string, size: number): string {
  return code.match(new RegExp(`.{1,${size}}`, 'g'))?.join('-') ?? code
}

/** A new request code, e.g. "7KQ2-M9XD" (40 random bits). */
export function newRequestCode(): string {
  return group(base32(randomBytes(5), 8), 4)
}

/** The response code for a request on a machine, e.g. "3FJ8R-W2N6T" (50 bits). */
export function responseCode(secret: string, requestCode: string, machineId: string): string {
  const mac = createHmac('sha256', secret)
    .update(`PLTM-ADMIN-RECOVERY|${normalizeCode(requestCode)}|${String(machineId).trim().toUpperCase()}`)
    .digest()
  return group(base32(mac, 10), 5)
}

export function responseMatches(secret: string, requestCode: string, machineId: string, entered: string): boolean {
  const expected = Buffer.from(normalizeCode(responseCode(secret, requestCode, machineId)))
  const actual = Buffer.from(normalizeCode(entered))
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}
