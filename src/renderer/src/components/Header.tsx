import { useEffect, useState, type ReactNode } from 'react'
import { PRODUCT_NAME, PRODUCT_TAGLINE } from '@shared/brand'
import logo from '../assets/logo.png'

export function Brand(): JSX.Element {
  return (
    <div className="brand">
      <img src={logo} alt="" draggable={false} />
      <div>
        <div className="brand-name">{PRODUCT_NAME}</div>
        <div className="brand-tag">{PRODUCT_TAGLINE}</div>
      </div>
    </div>
  )
}

export function Clock(): JSX.Element {
  const [now, setNow] = useState(new Date())
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 1000)
    return () => window.clearInterval(t)
  }, [])
  return (
    <div className="clock" data-testid="clock">
      <b>{now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })}</b>
      <div>
        {now.toLocaleDateString('en-US', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' })}
      </div>
    </div>
  )
}

export function Header({ title, children }: { title?: string; children?: ReactNode }): JSX.Element {
  return (
    <div className="header">
      <Brand />
      {title && <div style={{ marginLeft: 18, fontSize: 15, color: '#c8d6e3', fontWeight: 600 }}>{title}</div>}
      <div className="spacer" />
      {children}
      <Clock />
    </div>
  )
}
