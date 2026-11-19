import { SerialPort } from 'serialport'
import { ErrorCode, type SerialPortInfo } from '@shared/types'
import { CommandError } from '../errors'
import { log } from '../logger'

type RawPort = Awaited<ReturnType<typeof SerialPort.list>>[number]

/** USB-to-serial adapter families by USB vendor id. */
export function chipName(vendorId: string | undefined): string | undefined {
  switch ((vendorId ?? '').toLowerCase()) {
    case '0403':
      return 'FTDI'
    case '1a86':
      return 'CH340'
    case '10c4':
      return 'CP210x'
    case '067b':
      return 'Prolific'
    default:
      return undefined
  }
}

// The Connection panel refreshes every 3 s; log a failure once, not every poll.
let lastLoggedFailure = ''

/**
 * Lists the COM ports the OS reports. If the OS lookup fails (e.g. the port
 * enumeration service is missing or broken), this raises a PORT_LIST_FAILED
 * error that says so and tells the operator to type the port name instead.
 */
export async function listSerialPorts(
  list: () => Promise<RawPort[]> = () => SerialPort.list()
): Promise<SerialPortInfo[]> {
  let ports: RawPort[]
  try {
    ports = await list()
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    if (reason !== lastLoggedFailure) {
      log.warn('COM port search failed', error)
      lastLoggedFailure = reason
    }
    throw new CommandError(
      ErrorCode.PORT_LIST_FAILED,
      `Could not search for COM ports (${reason}). Choose "Other" and type the port name, e.g. COM7.`
    )
  }
  lastLoggedFailure = ''
  return ports
    .map((p) => ({
      path: p.path,
      manufacturer: p.manufacturer,
      vendorId: p.vendorId,
      productId: p.productId,
      chip: chipName(p.vendorId)
    }))
    .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }))
}
