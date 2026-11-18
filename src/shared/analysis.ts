import {
  LOWERING_CODES,
  RAISING_CODES,
  type ModelConfig,
  type ModelPoint,
  type Sample,
  type TestResults
} from './types'

/** The plotted load is smoothed with a 70-sample moving average, run forwards and backwards. */
export const FILTER_TAPS = 70

/**
 * Zero-phase moving average (forward-backward FIR, N taps) with odd-extension
 * padding of 3 × N samples each side. Series no longer than the padding are
 * returned unfiltered.
 */
export function filtfiltMovingAverage(x: number[], taps = FILTER_TAPS): number[] {
  const padlen = 3 * taps
  if (x.length <= padlen) return [...x]
  const first = x[0]
  const last = x[x.length - 1]
  const ext: number[] = []
  for (let i = padlen; i >= 1; i--) ext.push(2 * first - x[i])
  for (const v of x) ext.push(v)
  for (let i = x.length - 2; i >= x.length - 1 - padlen; i--) ext.push(2 * last - x[i])

  const forward = movingAverage(ext, taps)
  forward.reverse()
  const backward = movingAverage(forward, taps)
  backward.reverse()
  return backward.slice(padlen, padlen + x.length)
}

/**
 * lfilter(ones(N)/N, 1, x, zi = lfilter_zi · x[0]): the filter starts in the
 * steady state for x[0], i.e. as if every earlier input equalled x[0].
 */
function movingAverage(x: number[], taps: number): number[] {
  const out = new Array<number>(x.length)
  let sum = x[0] * taps
  for (let i = 0; i < x.length; i++) {
    sum += x[i] - (i - taps >= 0 ? x[i - taps] : x[0])
    out[i] = sum / taps
  }
  return out
}

export function sortedPoints(model: Pick<ModelConfig, 'points'>): ModelPoint[] {
  return [...model.points].sort((a, b) => a.rowIndex - b.rowIndex)
}

/**
 * The heights the averages are taken between: the model's 2nd and 3rd points
 * (the straight part of the reference envelope).
 */
export function averagingWindow(model: Pick<ModelConfig, 'points'> | null): { from: number; to: number } {
  const points = model ? sortedPoints(model) : []
  if (points.length >= 3) {
    const a = points[1].heightMm
    const b = points[2].heightMm
    return { from: Math.min(a, b), to: Math.max(a, b) }
  }
  return { from: 840, to: 2910 }
}

/**
 * Test results:
 * - up/down: the last load recorded at each height while raising (codes 61, 71) / lowering (81);
 * - average up/down force: mean of those loads between the window heights;
 * - mean force = (up + down) / 2, hysteresis = down − up;
 * - peak friction = max(lowering loads) − min(raising loads) in the window;
 * - max height: the highest height reached while raising.
 */
export function computeResults(samples: Sample[], model: Pick<ModelConfig, 'points'> | null): TestResults {
  const up = new Map<number, number>()
  const down = new Map<number, number>()
  for (const s of samples) {
    if (RAISING_CODES.includes(s.code)) up.set(s.positionMm, s.loadN)
    else if (LOWERING_CODES.includes(s.code)) down.set(s.positionMm, s.loadN)
  }
  const { from, to } = averagingWindow(model)
  const inWindow = (map: Map<number, number>): number[] =>
    [...map.entries()].filter(([h]) => h >= from && h <= to).map(([, load]) => load)
  const filteredUp = inWindow(up)
  const filteredDown = inWindow(down)
  const avgUp = filteredUp.length ? mean(filteredUp) : 0
  const avgDown = filteredDown.length ? mean(filteredDown) : 0
  const peak =
    filteredUp.length && filteredDown.length ? Math.max(...filteredDown) - Math.min(...filteredUp) : 0
  return {
    avgUpN: avgUp,
    avgDownN: avgDown,
    meanN: (avgUp + avgDown) / 2,
    peakFrictionN: peak,
    hysteresisN: avgDown - avgUp,
    maxHeightMm: up.size ? Math.max(...up.keys()) : 0,
    windowFromMm: from,
    windowToMm: to
  }
}

function mean(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length
}

/** Python's str(float) for the result boxes: up to 5 decimals, trailing zeros dropped. */
export function formatResult(value: number): string {
  if (!Number.isFinite(value)) return '0'
  const rounded = Math.round(value * 1e5) / 1e5
  return Number.isInteger(rounded) ? String(rounded) : String(rounded)
}
