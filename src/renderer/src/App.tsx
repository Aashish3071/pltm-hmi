import { useEffect, useState } from 'react'
import { api } from './api/client'
import LoginScreen from './screens/Login/LoginScreen'
import HomeScreen from './screens/Home/HomeScreen'
import SettingsScreen from './screens/Settings/SettingsScreen'
import TitleBar from './components/TitleBar'
import ToastStack from './components/ToastStack'
import { connectMachineEvents, useMachineStore } from './state/machineStore'
import { useSessionStore } from './state/sessionStore'
import { toast } from './state/toastStore'

type Screen = 'login' | 'home' | 'settings'

export default function App(): JSX.Element {
  const [screen, setScreen] = useState<Screen>('login')
  const [reconnecting, setReconnecting] = useState(false)
  const user = useSessionStore((s) => s.user)
  const setUser = useSessionStore((s) => s.setUser)
  const connected = useMachineStore((s) => s.connected)

  useEffect(() => connectMachineEvents(), [])

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
          <span>MACHINE DISCONNECTED — check power and the Ethernet cable. Retrying automatically…</span>
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
            onLogout={handleLogout}
          />
        )}
        {screen === 'settings' && user && (
          <SettingsScreen onHome={leaveSettings} onLogout={handleLogout} />
        )}
      </div>
      <ToastStack />
    </div>
  )
}
