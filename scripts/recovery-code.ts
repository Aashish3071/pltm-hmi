/**
 * Vendor tool: turns the request code and machine ID a customer reads out
 * from "FORGOT ADMIN PASSWORD?" into the response code that lets them set a
 * new ADMIN password.
 *
 *   PLTM_RECOVERY_SECRET=... npm run recovery-code -- 7KQ2-M9XD PLTM-0001
 *
 * PLTM_RECOVERY_SECRET must be the same secret the installer was built with
 * (the PLTM_RECOVERY_SECRET repository secret). Keep it private: anyone who
 * has it can reset the ADMIN password on any machine. For a development build
 * (made without the secret), pass --dev instead.
 */
import { DEV_RECOVERY_SECRET, normalizeCode, responseCode } from '../src/main/services/recoveryCode'

const args = process.argv.slice(2)
const dev = args.includes('--dev')
const [request, ...machine] = args.filter((a) => a !== '--dev')
const machineId = machine.join(' ')

if (!request || !machineId) {
  console.error('Usage: npm run recovery-code -- <REQUEST-CODE> <MACHINE-ID> [--dev]')
  process.exit(2)
}
if (normalizeCode(request).length !== 8) {
  console.error(`"${request}" is not a request code: it has 8 letters/digits, e.g. 7KQ2-M9XD.`)
  process.exit(2)
}
const secret = dev ? DEV_RECOVERY_SECRET : process.env.PLTM_RECOVERY_SECRET
if (!secret) {
  console.error('Set PLTM_RECOVERY_SECRET to the secret the installer was built with (or pass --dev).')
  process.exit(2)
}
console.log(`\nMachine ${machineId}, request ${request.toUpperCase()}`)
console.log(`Response code: ${responseCode(secret, request, machineId)}\n`)
