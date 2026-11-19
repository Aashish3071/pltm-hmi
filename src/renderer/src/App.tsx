import { useEffect, useLayoutEffect, useState, type ReactNode } from 'react'
import { api } from './api/client'
import { MessageBoxHost } from './components/MessageBox'
import LoginScreen from './screens/LoginScreen'
import SettingsScreen from './screens/SettingsScreen'
import HomeScreen from './screens/HomeScreen'
import HistoryScreen from './screens/HistoryScreen'
import { connectMachine, useMachine } from './state/machine'

type Screen = 'login' | 'main' | 'settings' | 'history'

/** The 1366 × 768 touchscreen layout, scaled to the window. */
function Stage({ children }: { children: ReactNode }): JSX.Element {
  const [transform, setTransform] = useState('')
  useLayoutEffect(() => {
    const fit = (): void => {
      const s = Math.min(window.innerWidth / 1366, window.innerHeight / 768)
      const x = (window.innerWidth - 1366 * s) / 2
      const y = (window.innerHeight - 768 * s) / 2
      setTransform(`translate(${x}px, ${y}px) scale(${s})`)
    }
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [])
  return (
    <div className="viewport">
      <div className="stage" style={{ transform }}>
        {children}
      </div>
    </div>
  )
}

export default function App(): JSX.Element {
  const [screen, setScreen] = useState<Screen>('login')
  const setUser = useMachine((s) => s.setUser)

  useEffect(() => connectMachine(), [])

  const quit = (): void => void api.app.quit()
  const logout = async (): Promise<void> => {
    await api.auth.logout()
    setUser(null)
    setScreen('login')
  }
  const home = async (): Promise<void> => {
    await api.auth.adminLock()
    setScreen('main')
  }

  return (
    <Stage>
      <div data-screen={screen} style={{ position: 'absolute', inset: 0 }}>
        {screen === 'login' && (
          <LoginScreen
            onLogin={(user) => {
              setUser(user)
              setScreen('main')
            }}
            onExit={quit}
          />
        )}
        {screen === 'main' && (
          <HomeScreen
            onSettings={() => setScreen('settings')}
            onHistory={() => setScreen('history')}
            onLogout={() => void logout()}
            onClose={quit}
          />
        )}
        {screen === 'history' && <HistoryScreen onHome={() => setScreen('main')} />}
        {screen === 'settings' && <SettingsScreen onHome={() => void home()} onLogout={() => void logout()} onClose={quit} />}
      </div>
      <MessageBoxHost />
    </Stage>
  )
}
