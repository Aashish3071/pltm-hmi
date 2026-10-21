/**
 * Turns a run's recorded samples into the figures a static contact force test
 * reports. Following EN 50206-1's definitions: Fr is the force while raising,
 * Fl while lowering, and the mean static contact force is (Fr + Fl) / 2.
 * Friction opposes motion, so a healthy pantograph pushes less while rising
 * than while being pushed down: the hysteresis Fl − Fr is normally positive.
 */

export interface RunSample {
  loadN: number
  heightMm: number
  phase: string
}

export interface ForceStats {
  minN: number
  maxN: number
  meanN: number
}

export interface HeightRow {
  heightMm: number
  raisingN: number | null
  loweringN: number | null
  meanN: number | null
  /** Fl − Fr */
  hysteresisN: number | null
}

export interface RunAnalysis {
  /** The evaluated band of heights; the turnarounds at each end are excluded. */
  fromMm: number
  toMm: number
  raising: ForceStats | null
  lowering: ForceStats | null
  meanStaticN: number | null
  /** Largest Fl − Fr over the evaluated band (by magnitude, sign kept). */
  maxHysteresisN: number | null
  rows: HeightRow[]
  samples: number
}

/** Share of the travel left out at the bottom and top, where the arm accelerates and turns. */
const TURNAROUND_FRACTION = 0.05

export function analyseRun(samples: RunSample[], rowCount = 10): RunAnalysis {
  const moving = samples.filter((s) => s.phase === 'up' || s.phase === 'down')
  if (moving.length === 0) {
    return emptyAnalysis(samples.length)
  }
  const heights = moving.map((s) => s.heightMm)
  const low = Math.min(...heights)
  const high = Math.max(...heights)
  const margin = (high - low) * TURNAROUND_FRACTION
  const fromMm = low + margin
  const toMm = high - margin
  if (toMm <= fromMm) return emptyAnalysis(samples.length)

  const inBand = (s: RunSample): boolean => s.heightMm >= fromMm && s.heightMm <= toMm
  const raisingSamples = moving.filter((s) => s.phase === 'up' && inBand(s))
  const loweringSamples = moving.filter((s) => s.phase === 'down' && inBand(s))

  const step = rowCount > 1 ? (toMm - fromMm) / (rowCount - 1) : 0
  const window = Math.max(step / 4, 10)
  // Readings just outside the band are still valid neighbours for interpolation.
  const upSorted = moving.filter((s) => s.phase === 'up').sort((a, b) => a.heightMm - b.heightMm)
  const downSorted = moving.filter((s) => s.phase === 'down').sort((a, b) => a.heightMm - b.heightMm)
  /** Averages readings close to the height; with sparse data, interpolates between neighbours. */
  const forceAt = (sorted: RunSample[], height: number): number | null => {
    const near = sorted.filter((s) => Math.abs(s.heightMm - height) <= window)
    if (near.length >= 2) return near.reduce((sum, s) => sum + s.loadN, 0) / near.length
    const below = [...sorted].reverse().find((s) => s.heightMm <= height)
    const above = sorted.find((s) => s.heightMm >= height)
    if (!below || !above) return near.length ? near[0].loadN : null
    if (above.heightMm === below.heightMm) return (above.loadN + below.loadN) / 2
    const ratio = (height - below.heightMm) / (above.heightMm - below.heightMm)
    return below.loadN + (above.loadN - below.loadN) * ratio
  }

  const rows: HeightRow[] = []
  for (let i = 0; i < rowCount; i++) {
    const heightMm = fromMm + step * i
    const raisingN = forceAt(upSorted, heightMm)
    const loweringN = forceAt(downSorted, heightMm)
    const both = raisingN !== null && loweringN !== null
    rows.push({
      heightMm: round(heightMm, 0),
      raisingN: maybeRound(raisingN),
      loweringN: maybeRound(loweringN),
      meanN: both ? round((raisingN + loweringN) / 2) : null,
      hysteresisN: both ? round(loweringN - raisingN) : null
    })
  }

  const raising = stats(raisingSamples)
  const lowering = stats(loweringSamples)
  const gaps = rows.map((r) => r.hysteresisN).filter((f): f is number => f !== null)
  const largestGap = gaps.reduce<number | null>(
    (best, g) => (best === null || Math.abs(g) > Math.abs(best) ? g : best),
    null
  )
  return {
    fromMm: round(fromMm, 0),
    toMm: round(toMm, 0),
    raising,
    lowering,
    meanStaticN: raising && lowering ? round((raising.meanN + lowering.meanN) / 2) : null,
    maxHysteresisN: largestGap,
    rows,
    samples: samples.length
  }
}

function emptyAnalysis(samples: number): RunAnalysis {
  return {
    fromMm: 0,
    toMm: 0,
    raising: null,
    lowering: null,
    meanStaticN: null,
    maxHysteresisN: null,
    rows: [],
    samples
  }
}

function stats(list: RunSample[]): ForceStats | null {
  if (list.length === 0) return null
  const loads = list.map((s) => s.loadN)
  return {
    minN: round(Math.min(...loads)),
    maxN: round(Math.max(...loads)),
    meanN: round(loads.reduce((sum, v) => sum + v, 0) / loads.length)
  }
}

function maybeRound(value: number | null): number | null {
  return value === null ? null : round(value)
}

function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}
