import { useEffect, useRef } from 'react'
import { filtfiltMovingAverage, sortedPoints } from '@shared/analysis'
import type { ModelConfig, Sample } from '@shared/types'

/**
 * Load vs height graph: x 0–150 N, y 0 to travel + 400 mm. The model's
 * reference envelope, dashed guide lines at its first four heights, and the
 * last three tests (n, n-1, n-2) with the load smoothed (70-sample zero-phase
 * moving average).
 */

export interface PlotData {
  model: Pick<ModelConfig, 'points'> | null
  n: Sample[] | null
  n1: Sample[] | null
  n2: Sample[] | null
  /** Settings preview: the reference only, no legend or guides. */
  referenceOnly?: boolean
}

export const CURVE_COLORS = { ref: '#d64545', n: '#0f9d8f', n1: '#e8a317', n2: '#7d8b99' }
const FONT = '"Segoe UI", Inter, Roboto, Arial, sans-serif'

export function yLimit(model: Pick<ModelConfig, 'points'> | null): number {
  const points = model ? sortedPoints(model) : []
  const top = points.length ? Math.max(...points.map((p) => p.heightMm)) : 0
  const travel = points.length >= 4 ? points[3].heightMm : top
  return Math.max(travel, top, 0) + 400 || 4000
}

/** 1, 2, 2.5, 5 × 10ⁿ steps, about 8 ticks. */
function niceTicks(max: number): number[] {
  const raw = max / 8
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag
  const ticks: number[] = []
  for (let v = 0; v <= max + 1e-9; v += step) ticks.push(Math.round(v * 1000) / 1000)
  return ticks
}

export function drawPlot(canvas: HTMLCanvasElement, width: number, height: number, data: PlotData, scale = 1): void {
  const dpr = scale * (window.devicePixelRatio || 1)
  canvas.width = Math.max(1, Math.round(width * dpr))
  canvas.height = Math.max(1, Math.round(height * dpr))
  const ctx = canvas.getContext('2d')!
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.fillStyle = 'white'
  ctx.fillRect(0, 0, width, height)

  const ymax = yLimit(data.model)
  const xmax = 150
  const yticks = niceTicks(ymax)
  ctx.font = `12px ${FONT}`
  const tickW = Math.max(...yticks.map((t) => ctx.measureText(String(t)).width))
  const left = Math.round(tickW + 34)
  const right = 12
  const top = 12
  const bottom = 46
  const pw = width - left - right
  const ph = height - top - bottom
  const X = (v: number): number => left + (v / xmax) * pw
  const Y = (v: number): number => top + ph - (v / ymax) * ph

  ctx.strokeStyle = '#e3e9ee'
  ctx.lineWidth = 1
  ctx.beginPath()
  for (let v = 0; v <= xmax; v += 25) {
    ctx.moveTo(Math.round(X(v)) + 0.5, top)
    ctx.lineTo(Math.round(X(v)) + 0.5, top + ph)
  }
  for (const v of yticks) {
    ctx.moveTo(left, Math.round(Y(v)) + 0.5)
    ctx.lineTo(left + pw, Math.round(Y(v)) + 0.5)
  }
  ctx.stroke()

  ctx.save()
  ctx.beginPath()
  ctx.rect(left, top, pw, ph)
  ctx.clip()

  const points = data.model ? sortedPoints(data.model) : []
  if (!data.referenceOnly) {
    ctx.setLineDash([4, 3])
    ctx.strokeStyle = '#9aa8b5'
    ctx.fillStyle = '#7d8b99'
    ctx.font = `11px ${FONT}`
    ctx.textBaseline = 'bottom'
    ctx.textAlign = 'right'
    for (const p of points.slice(0, 4)) {
      ctx.beginPath()
      ctx.moveTo(left, Y(p.heightMm))
      ctx.lineTo(left + pw, Y(p.heightMm))
      ctx.stroke()
      ctx.fillText(`${p.heightMm} mm`, left + pw - 4, Y(p.heightMm) - 1)
    }
    ctx.setLineDash([])
  }

  const line = (xs: number[], ys: number[], color: string, widthPx: number): void => {
    if (xs.length < 2) return
    ctx.strokeStyle = color
    ctx.lineWidth = widthPx
    ctx.lineJoin = 'round'
    ctx.beginPath()
    ctx.moveTo(X(xs[0]), Y(ys[0]))
    for (let i = 1; i < xs.length; i++) ctx.lineTo(X(xs[i]), Y(ys[i]))
    ctx.stroke()
  }

  line(points.map((p) => p.loadN), points.map((p) => p.heightMm), CURVE_COLORS.ref, 2.5)
  if (!data.referenceOnly) {
    for (const [key, samples] of [['n2', data.n2], ['n1', data.n1], ['n', data.n]] as const) {
      if (!samples || samples.length < 2) continue
      line(filtfiltMovingAverage(samples.map((s) => s.loadN)), samples.map((s) => s.positionMm), CURVE_COLORS[key], 2.5)
    }
  }
  ctx.restore()

  ctx.strokeStyle = '#8a98a6'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(left + 0.5, top)
  ctx.lineTo(left + 0.5, top + ph + 0.5)
  ctx.lineTo(left + pw, top + ph + 0.5)
  ctx.stroke()

  ctx.fillStyle = '#44566a'
  ctx.font = `12px ${FONT}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  for (let v = 0; v <= xmax; v += 25) ctx.fillText(String(v), X(v), top + ph + 5)
  ctx.textAlign = 'right'
  ctx.textBaseline = 'middle'
  for (const v of yticks) ctx.fillText(String(v), left - 6, Y(v))

  ctx.fillStyle = '#0f2233'
  ctx.font = `600 13px ${FONT}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'bottom'
  ctx.fillText('Load (N)', left + pw / 2, height - 4)
  ctx.save()
  ctx.translate(14, top + ph / 2)
  ctx.rotate(-Math.PI / 2)
  ctx.textBaseline = 'middle'
  ctx.fillText('Height (mm)', 0, 0)
  ctx.restore()

  if (!data.referenceOnly) {
    const entries: [string, string][] = [
      ['Reference', CURVE_COLORS.ref],
      ['n', CURVE_COLORS.n],
      ['n-1', CURVE_COLORS.n1],
      ['n-2', CURVE_COLORS.n2]
    ]
    ctx.font = `12px ${FONT}`
    const lh = 18
    const lw = 34 + Math.max(...entries.map(([t]) => ctx.measureText(t).width)) + 10
    const lx = left + pw - lw - 8
    const ly = top + 8
    ctx.fillStyle = 'rgba(255,255,255,0.92)'
    ctx.strokeStyle = '#d5dde5'
    ctx.fillRect(lx, ly, lw, entries.length * lh + 8)
    ctx.strokeRect(lx + 0.5, ly + 0.5, lw, entries.length * lh + 8)
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    entries.forEach(([text, color], i) => {
      const cy = ly + 4 + lh * i + lh / 2
      ctx.fillStyle = color
      ctx.fillRect(lx + 8, cy - 2, 18, 4)
      ctx.fillStyle = '#0f2233'
      ctx.fillText(text, lx + 32, cy)
    })
  }
}

/** The graph image embedded in the report (3× for print). */
export function plotPng(data: PlotData, width = 520, height = 620): string {
  const canvas = document.createElement('canvas')
  drawPlot(canvas, width, height, data, 3 / (window.devicePixelRatio || 1))
  return canvas.toDataURL('image/png')
}

export function PlotView({ data, testId }: { data: PlotData; testId?: string }): JSX.Element {
  const box = useRef<HTMLDivElement>(null)
  const ref = useRef<HTMLCanvasElement>(null)
  const frame = useRef(0)
  const size = useRef({ w: 0, h: 0 })
  const draw = (): void => {
    cancelAnimationFrame(frame.current)
    frame.current = requestAnimationFrame(() => {
      if (ref.current && size.current.w > 0) drawPlot(ref.current, size.current.w, size.current.h, data)
    })
  }
  useEffect(() => {
    const el = box.current
    if (!el) return
    const observer = new ResizeObserver(() => {
      size.current = { w: el.clientWidth, h: el.clientHeight }
      draw()
    })
    observer.observe(el)
    return () => observer.disconnect()
  })
  useEffect(() => {
    draw()
    return () => cancelAnimationFrame(frame.current)
  })
  return (
    <div ref={box} className="plot" data-testid={testId}>
      <canvas ref={ref} />
    </div>
  )
}
