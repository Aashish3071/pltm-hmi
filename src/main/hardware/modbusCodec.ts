import type { RegisterDataType, RegisterSpec } from '@shared/types'

export function registerCount(spec: RegisterSpec): number {
  if (spec.area === 'coil' || spec.area === 'discrete') return 1
  const type = spec.dataType ?? 'uint16'
  return type === 'int16' || type === 'uint16' ? 1 : 2
}

/** Decodes raw 16-bit words (or a single bit) into an engineering value. */
export function decode(spec: RegisterSpec, words: number[]): number {
  if (spec.area === 'coil' || spec.area === 'discrete') return words[0] ? 1 : 0
  const raw = decodeRaw(spec.dataType ?? 'uint16', words, spec.wordOrder ?? 'BE')
  return raw * (spec.scale ?? 1)
}

/** Encodes an engineering value into the 16-bit words to write. */
export function encode(spec: RegisterSpec, value: number): number[] {
  const type = spec.dataType ?? 'uint16'
  const raw = value / (spec.scale ?? 1)
  const buffer = Buffer.alloc(4)
  switch (type) {
    case 'uint16':
      return [clampInt(raw, 0, 0xffff)]
    case 'int16':
      buffer.writeInt16BE(clampInt(raw, -0x8000, 0x7fff), 0)
      return [buffer.readUInt16BE(0)]
    case 'uint32':
      buffer.writeUInt32BE(clampInt(raw, 0, 0xffffffff), 0)
      break
    case 'int32':
      buffer.writeInt32BE(clampInt(raw, -0x80000000, 0x7fffffff), 0)
      break
    case 'float32':
      buffer.writeFloatBE(raw, 0)
      break
  }
  const high = buffer.readUInt16BE(0)
  const low = buffer.readUInt16BE(2)
  return (spec.wordOrder ?? 'BE') === 'BE' ? [high, low] : [low, high]
}

function decodeRaw(type: RegisterDataType, words: number[], wordOrder: 'BE' | 'LE'): number {
  if (type === 'uint16') return words[0] & 0xffff
  if (type === 'int16') return ((words[0] & 0xffff) << 16) >> 16
  const [high, low] = wordOrder === 'BE' ? [words[0], words[1]] : [words[1], words[0]]
  const buffer = Buffer.alloc(4)
  buffer.writeUInt16BE(high & 0xffff, 0)
  buffer.writeUInt16BE(low & 0xffff, 2)
  if (type === 'uint32') return buffer.readUInt32BE(0)
  if (type === 'int32') return buffer.readInt32BE(0)
  return buffer.readFloatBE(0)
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.round(value), min), max)
}

/**
 * Groups register reads by area into contiguous blocks so a poll costs one
 * request per area rather than one per value — important at RTU baud rates.
 */
export interface ReadBlock {
  area: RegisterSpec['area']
  start: number
  count: number
}

const MAX_BLOCK = { holding: 120, input: 120, coil: 2000, discrete: 2000 }

export function planReads(specs: RegisterSpec[]): ReadBlock[] {
  const byArea = new Map<RegisterSpec['area'], { start: number; end: number }[]>()
  const sorted = [...specs].sort((a, b) => a.address - b.address)
  for (const spec of sorted) {
    const start = spec.address
    const end = spec.address + registerCount(spec) - 1
    const ranges = byArea.get(spec.area) ?? []
    const last = ranges[ranges.length - 1]
    if (last && end - last.start < MAX_BLOCK[spec.area] && start <= last.end + 8) {
      last.end = Math.max(last.end, end)
    } else {
      ranges.push({ start, end })
    }
    byArea.set(spec.area, ranges)
  }
  const blocks: ReadBlock[] = []
  for (const [area, ranges] of byArea) {
    for (const r of ranges) blocks.push({ area, start: r.start, count: r.end - r.start + 1 })
  }
  return blocks
}

/** Pulls one spec's words out of the block results. */
export function extract(
  spec: RegisterSpec,
  blocks: ReadBlock[],
  results: number[][]
): number[] | undefined {
  const count = registerCount(spec)
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    if (block.area !== spec.area) continue
    const offset = spec.address - block.start
    if (offset >= 0 && offset + count <= block.count) return results[i].slice(offset, offset + count)
  }
  return undefined
}
