import { useEffect, useRef } from 'react'
import { useMachineStore } from '../../state/machineStore'

type Point = { loadN: number; heightMm: number }

interface GraphData {
  points: Point[]
  /** Envelope from the selected model, drawn faintly behind the live trace. */
  envelope?: Point[]
  maxHeightMm: number
  maxLoadN: number
}

interface Props {
  envelope?: Point[]
  maxHeightMm: number
  maxLoadN: number
  /** When set, plots these points instead of the live trace. */
  points?: Point[]
}

const PADDING = { left: 52, right: 14, top: 12, bottom: 40 }

/** Pure drawing routine shared by the live panel and report rendering. */
export function drawGraph(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  { points, envelope, maxHeightMm, maxLoadN }: GraphData
): void {
  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)

  const plotW = width - PADDING.left - PADDING.right
  const plotH = height - PADDING.top - PADDING.bottom
  if (plotW <= 0 || plotH <= 0 || maxHeightMm <= 0 || maxLoadN <= 0) return

  const xOf = (loadN: number): number => PADDING.left + (loadN / maxLoadN) * plotW
  const yOf = (heightMm: number): number => PADDING.top + plotH - (heightMm / maxHeightMm) * plotH

  ctx.strokeStyle = '#dcdcdc'
  ctx.fillStyle = '#444'
  ctx.lineWidth = 1
  ctx.font = '10px Segoe UI, sans-serif'

  const xTicks = 6
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  for (let i = 0; i <= xTicks; i++) {
    const value = (maxLoadN / xTicks) * i
    const x = xOf(value)
    ctx.beginPath()
    ctx.moveTo(x, PADDING.top)
    ctx.lineTo(x, PADDING.top + plotH)
    ctx.stroke()
    ctx.fillText(String(Math.round(value)), x, PADDING.top + plotH + 6)
  }

  const yTicks = 7
  ctx.textAlign = 'right'
  ctx.textBaseline = 'middle'
  for (let i = 0; i <= yTicks; i++) {
    const value = (maxHeightMm / yTicks) * i
    const y = yOf(value)
    ctx.beginPath()
    ctx.moveTo(PADDING.left, y)
    ctx.lineTo(PADDING.left + plotW, y)
    ctx.stroke()
    ctx.fillText(String(Math.round(value)), PADDING.left - 6, y)
  }

  ctx.strokeStyle = '#333'
  ctx.lineWidth = 1.2
  ctx.strokeRect(PADDING.left, PADDING.top, plotW, plotH)

  ctx.fillStyle = '#000'
  ctx.font = 'bold 11px Segoe UI, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  ctx.fillText('Load(N)', PADDING.left + plotW / 2, height - 16)
  ctx.save()
  ctx.translate(12, PADDING.top + plotH / 2)
  ctx.rotate(-Math.PI / 2)
  ctx.fillText('Height(mm)', 0, 0)
  ctx.restore()

  const trace = (data: Point[], color: string, lineWidth: number, dashed: boolean): void => {
    if (data.length < 2) return
    ctx.save()
    ctx.beginPath()
    ctx.rect(PADDING.left, PADDING.top, plotW, plotH)
    ctx.clip()
    ctx.strokeStyle = color
    ctx.lineWidth = lineWidth
    ctx.setLineDash(dashed ? [4, 4] : [])
    ctx.beginPath()
    data.forEach((p, i) => {
      const x = xOf(p.loadN)
      const y = yOf(p.heightMm)
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    ctx.stroke()
    ctx.restore()
  }

  if (envelope && envelope.length > 1) trace(envelope, '#b9b9c4', 1.2, true)
  trace(points, '#e03131', 1.8, false)
}

/** Renders a graph off-screen and returns it as a PNG data URL. */
export function renderGraphPng(data: GraphData, width = 800, height = 600): string | undefined {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return undefined
  drawGraph(ctx, width, height, data)
  return canvas.toDataURL('image/png')
}

/** Axis range for a model's envelope, with headroom, never below the manual's 150 N. */
export function loadAxisMax(envelope: Point[], floor = 150): number {
  return Math.max(floor, ...envelope.map((p) => p.loadN * 1.5))
}

export default function GraphPanel({ envelope, maxHeightMm, maxLoadN, points }: Props): JSX.Element {
  const livePoints = useMachineStore((s) => s.points)
  const shown = points ?? livePoints
  const ref = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return

    const draw = (): void => {
      const parent = canvas.parentElement
      if (!parent) return
      const dpr = window.devicePixelRatio || 1
      const width = parent.clientWidth
      const height = parent.clientHeight
      canvas.width = width * dpr
      canvas.height = height * dpr
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      drawGraph(ctx, width, height, { points: shown, envelope, maxHeightMm, maxLoadN })
    }

    draw()
    const observer = new ResizeObserver(draw)
    if (canvas.parentElement) observer.observe(canvas.parentElement)
    return () => observer.disconnect()
  }, [shown, envelope, maxHeightMm, maxLoadN])

  return (
    <div className="graph-panel">
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <canvas ref={ref} />
      </div>
    </div>
  )
}
