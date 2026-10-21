import type { CalibrationPoint } from './types'

/** Standard gravity — converts a reference mass in kg to newtons. */
export const STANDARD_GRAVITY = 9.80665

export function kgToNewtons(kg: number): number {
  return kg * STANDARD_GRAVITY
}

export interface CalibrationFit {
  gain: number
  offset: number
  points: CalibrationPoint[]
  maxErrorN: number
}

/**
 * Least-squares straight line through the captured points, mapping the raw
 * reading to the reference force: corrected = gain × raw + offset. Needs at
 * least two points at different loads.
 */
export function fitCalibration(points: { referenceN: number; rawN: number }[]): CalibrationFit {
  if (points.length < 2) throw new Error('At least two calibration points are needed.')
  const n = points.length
  const meanRaw = points.reduce((sum, p) => sum + p.rawN, 0) / n
  const meanRef = points.reduce((sum, p) => sum + p.referenceN, 0) / n
  let sxx = 0
  let sxy = 0
  for (const p of points) {
    sxx += (p.rawN - meanRaw) ** 2
    sxy += (p.rawN - meanRaw) * (p.referenceN - meanRef)
  }
  if (sxx < 1e-9) {
    throw new Error('The raw readings do not change between points. Check that the load is applied.')
  }
  const gain = sxy / sxx
  const offset = meanRef - gain * meanRaw
  const fitted = points.map((p) => {
    const correctedN = gain * p.rawN + offset
    return {
      referenceN: round(p.referenceN, 3),
      rawN: round(p.rawN, 3),
      correctedN: round(correctedN, 3),
      errorN: round(correctedN - p.referenceN, 3)
    }
  })
  return {
    gain: round(gain, 6),
    offset: round(offset, 4),
    points: fitted,
    maxErrorN: round(Math.max(...fitted.map((p) => Math.abs(p.errorN))), 3)
  }
}

export function applyCalibration(rawN: number, gain: number, offset: number): number {
  return gain * rawN + offset
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}
