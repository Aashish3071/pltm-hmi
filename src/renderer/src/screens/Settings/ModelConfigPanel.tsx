import { useEffect, useState } from 'react'
import type { ModelConfig, ModelPoint } from '@shared/types'
import { api } from '../../api/client'
import { toast } from '../../state/toastStore'

const ROWS = 9
/** Id used while drafting a model that has not been saved yet. */
export const NEW_MODEL_ID = 0

interface Props {
  models: ModelConfig[]
  selectedId: number
  onSelect: (id: number) => void
  onModelsChange: (models: ModelConfig[]) => void
  /** Live draft so the graph beside the editor previews unsaved edits. */
  onDraftChange: (points: ModelPoint[]) => void
}

function emptyPoints(): ModelPoint[] {
  return Array.from({ length: ROWS }, (_, i) => ({ rowIndex: i + 1, loadN: 0, heightMm: 0 }))
}

function pointsOf(model: ModelConfig | undefined): ModelPoint[] {
  const base = emptyPoints()
  model?.points.forEach((p) => {
    if (p.rowIndex >= 1 && p.rowIndex <= ROWS) base[p.rowIndex - 1] = { ...p }
  })
  return base
}

type Cell = { loadN: string; heightMm: string }

function toCells(points: ModelPoint[]): Cell[] {
  return points.map((p) => ({ loadN: String(p.loadN), heightMm: String(p.heightMm) }))
}

function toPoints(cells: Cell[]): ModelPoint[] {
  return cells.map((c, i) => ({
    rowIndex: i + 1,
    loadN: Number(c.loadN),
    heightMm: Number(c.heightMm)
  }))
}

export default function ModelConfigPanel({
  models,
  selectedId,
  onSelect,
  onModelsChange,
  onDraftChange
}: Props): JSX.Element {
  const selected = models.find((m) => m.id === selectedId)
  const isNew = selectedId === NEW_MODEL_ID
  const [name, setName] = useState(selected?.name ?? '')
  // Cells keep the raw text so "12." or "" can be typed without being coerced.
  const [cells, setCells] = useState<Cell[]>(toCells(pointsOf(selected)))
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setName(selected?.name ?? '')
    setCells(toCells(pointsOf(selected)))
  }, [selected, selectedId])

  useEffect(() => {
    onDraftChange(toPoints(cells).map((p) => ({
      ...p,
      loadN: Number.isFinite(p.loadN) ? p.loadN : 0,
      heightMm: Number.isFinite(p.heightMm) ? p.heightMm : 0
    })))
  }, [cells, onDraftChange])

  const updateCell = (index: number, field: keyof Cell, value: string): void => {
    if (!/^\d*\.?\d*$/.test(value)) return
    setCells((prev) => prev.map((c, i) => (i === index ? { ...c, [field]: value } : c)))
  }

  const save = async (): Promise<void> => {
    if (!name.trim()) {
      toast.error('Model name is required.')
      return
    }
    if (cells.some((c) => c.loadN === '' || c.heightMm === '')) {
      toast.error('Fill in every load and height value.')
      return
    }
    setSaving(true)
    const points = toPoints(cells)
    const result = await api.models.save({
      id: isNew ? undefined : selectedId,
      name: name.trim(),
      distanceMm: points[3].heightMm,
      points
    })
    setSaving(false)
    if (!result.ok) {
      toast.error(result.message)
      return
    }
    onModelsChange(result.data)
    const saved = result.data.find((m) => m.name.toLowerCase() === name.trim().toLowerCase())
    if (saved) onSelect(saved.id)
    toast.success(isNew ? 'Model created.' : 'Model saved.')
  }

  const remove = async (): Promise<void> => {
    if (isNew || !selected) return
    if (!window.confirm(`Delete model "${selected.name}"? Past test reports keep their data.`)) return
    const result = await api.models.remove(selected.id)
    if (!result.ok) {
      toast.error(result.message)
      return
    }
    onModelsChange(result.data)
    onSelect(result.data[0]?.id ?? NEW_MODEL_ID)
    toast.success('Model deleted.')
  }

  const startNew = (): void => {
    onSelect(NEW_MODEL_ID)
    setName('')
    setCells(toCells(emptyPoints()))
  }

  const revert = (): void => {
    setName(selected?.name ?? '')
    setCells(toCells(pointsOf(selected)))
  }

  return (
    <div className="panel">
      <div className="field-row">
        <label>MODEL :</label>
        <select value={selectedId} onChange={(e) => onSelect(Number(e.target.value))}>
          {isNew && <option value={NEW_MODEL_ID}>— new model —</option>}
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </div>
      <div className="field-row">
        <label>NAME :</label>
        <input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field-row">
        <label>DISTANCE :</label>
        <input value={cells[3]?.heightMm ?? ''} readOnly title="Taken from row 4 height" />
      </div>

      <div className="points-grid" style={{ marginTop: 10 }}>
        <div />
        <div className="head">LOAD (N)</div>
        <div className="head">HEIGHT (mm)</div>
        {cells.map((c, i) => (
          <div key={i} style={{ display: 'contents' }} className={i === 3 ? 'row-4' : ''}>
            <div className="row-num">{i + 1}</div>
            <input
              inputMode="decimal"
              value={c.loadN}
              onChange={(e) => updateCell(i, 'loadN', e.target.value)}
            />
            <input
              inputMode="decimal"
              value={c.heightMm}
              onChange={(e) => updateCell(i, 'heightMm', e.target.value)}
            />
          </div>
        ))}
      </div>
      <div className="hint">Row 4 height (red) sets the distance the pantograph travels.</div>

      <div className="settings-actions">
        <button className="btn green" onClick={save} disabled={saving}>
          OK
        </button>
        <button className="btn red" onClick={revert} disabled={saving}>
          CLEAR
        </button>
      </div>
      <div className="settings-actions">
        <button className="btn small" onClick={startNew} disabled={saving || isNew}>
          + NEW MODEL
        </button>
        <button className="btn small" onClick={remove} disabled={saving || isNew}>
          DELETE MODEL
        </button>
      </div>
    </div>
  )
}
