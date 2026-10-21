import { useEffect, useState } from 'react'
import type { MachineSettings } from '@shared/types'
import { api } from '../../api/client'
import { toast } from '../../state/toastStore'

interface Props {
  settings: MachineSettings
  onChange: (settings: MachineSettings) => void
}

export default function MachinePanel({ settings, onChange }: Props): JSX.Element {
  const [machineId, setMachineId] = useState(settings.machineId)
  const [load, setLoad] = useState(String(settings.loadCapacityN))
  const [height, setHeight] = useState(String(settings.heightCapacityMm))
  const [companyName, setCompanyName] = useState(settings.companyName)
  const [companyAddress, setCompanyAddress] = useState(settings.companyAddress)

  useEffect(() => {
    setMachineId(settings.machineId)
    setLoad(String(settings.loadCapacityN))
    setHeight(String(settings.heightCapacityMm))
    setCompanyName(settings.companyName)
    setCompanyAddress(settings.companyAddress)
  }, [settings])

  const save = async (): Promise<void> => {
    const result = await api.settings.setMachine({
      machineId,
      loadCapacityN: Number(load),
      heightCapacityMm: Number(height),
      companyName,
      companyAddress
    })
    if (result.ok) {
      onChange(result.data)
      toast.success('Machine settings saved.')
    } else {
      toast.error(result.message)
    }
  }

  return (
    <div className="panel orange">
      <div className="section-title">
        <span className="glyph">&#127981;</span> MACHINE
      </div>
      <div className="field-row">
        <label>MACHINE ID</label>
        <input value={machineId} maxLength={40} onChange={(e) => setMachineId(e.target.value)} />
      </div>
      <div className="field-row">
        <label>LOAD CAPACITY (N)</label>
        <input inputMode="decimal" value={load} onChange={(e) => setLoad(e.target.value)} />
      </div>
      <div className="field-row">
        <label>HEIGHT CAPACITY (mm)</label>
        <input inputMode="decimal" value={height} onChange={(e) => setHeight(e.target.value)} />
      </div>
      <div className="hint">
        On the real machine both capacities are also sent to the PLC as its overload and travel
        limits.
      </div>
      <div className="field-row" style={{ marginTop: 8 }}>
        <label>COMPANY NAME</label>
        <input value={companyName} maxLength={80} onChange={(e) => setCompanyName(e.target.value)} />
      </div>
      <div className="field-row field-row-top">
        <label>COMPANY ADDRESS</label>
        <textarea
          className="address-input"
          rows={2}
          maxLength={200}
          value={companyAddress}
          onChange={(e) => setCompanyAddress(e.target.value)}
        />
      </div>
      <div className="hint">Printed at the top of every test certificate.</div>
      <button className="btn yellow small" style={{ marginTop: 8 }} onClick={save}>
        SAVE
      </button>
    </div>
  )
}
