import { useEffect, useState } from 'react'
import { disconnectedHint, type ModbusTransport } from '@shared/types'
import { api } from './api/client'
import LoginScreen from './screens/Login/LoginScreen'
import HomeScreen from './screens/Home/HomeScreen'
import SettingsScreen from './screens/Settings/SettingsScreen'
import HistoryScreen from './screens/History/HistoryScreen'
import TitleBar from './components/TitleBar'
import ToastStack from './components/ToastStack'
import { connectMachineEvents, useMachineStore } from './state/machineStore'
import { useSessionStore } from './state/sessionStore'
import { toast } from './state/toastStore'

type Screen = 'login' | 'home' | 'settings' | 'history'

export default function App(): JSX.Element {
  const [screen, setScreen] = useState<Screen>('login')
  const [reconnecting, setReconnecting] = useState(false)
  const user = useSessionStore((s) => s.user)
  const setUser = useSessionStore((s) => s.setUser)
  const connected = useMachineStore((s) => s.connected)

  useEffect(() => connectMachineEvents(), [])

  // The banner's advice depends on how the machine is wired (USB-RS485 or Ethernet).
  const [transport, setTransport] = useState<ModbusTransport | undefined>()
  useEffect(() => {
    if (connected) return
    void api.app.systemInfo().then((result) => {
      if (result.ok) setTransport(result.data.transport)
    })
  }, [connected])

  const handleLogout = async (): Promise<void> => {
    await api.auth.logout()
    setUser(null)
    setScreen('login')
  }

  const leaveSettings = async (): Promise<void> => {
    await api.auth.adminLock()
    setScreen('home')
  }

  const reconnect = async (): Promise<void> => {
    setReconnecting(true)
    const result = await api.hardware.reconnect()
    setReconnecting(false)
    if (result.ok) toast.success('Machine connected.')
    else toast.error(result.message)
  }

  return (
    <div className="app">
      <TitleBar />
      {!connected && screen !== 'login' && (
        <div className="disconnect-banner">
          <span>MACHINE DISCONNECTED — {disconnectedHint(transport)} Retrying automatically…</span>
          <button className="btn small" onClick={reconnect} disabled={reconnecting}>
            {reconnecting ? 'CONNECTING…' : 'RECONNECT NOW'}
          </button>
        </div>
      )}
      <div className="screen">
        {screen === 'login' && (
          <LoginScreen
            onLogin={(account) => {
              setUser(account)
              setScreen('home')
            }}
          />
        )}
        {screen === 'home' && user && (
          <HomeScreen
            user={user}
            onOpenSettings={() => setScreen('settings')}
            onOpenHistory={() => setScreen('history')}
            onLogout={handleLogout}
          />
        )}
        {screen === 'history' && user && <HistoryScreen onHome={() => setScreen('home')} />}
        {screen === 'settings' && user && (
          <SettingsScreen onHome={leaveSettings} onLogout={handleLogout} />
        )}
      </div>
      <ToastStack />
    </div>
  )
}
