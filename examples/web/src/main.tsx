import '@fontsource-variable/ibm-plex-sans'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import './styles.css'
import { connect, type Database } from '@azora-db/client'
import { AzoraProvider } from '@azora-db/client/react'
import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'

const url = import.meta.env.VITE_AZORA_WS_URL as string | undefined
const token = import.meta.env.VITE_AZORA_TOKEN as string | undefined

/** Connects once, then hands the database to the app. */
function Root() {
  const [db, setDb] = useState<Database | null>(null)
  const [error, setError] = useState<string | null>(url && token ? null : 'missing')

  useEffect(() => {
    if (!url || !token) return
    let closed = false
    let opened: Database | undefined
    // In production the token comes from your backend: token: () => fetch('/api/azora-token').then((r) => r.text())
    connect(url, { token, clientName: 'orders-board/1' }).then(
      (d) => {
        if (closed) return void d.close()
        opened = d
        setDb(d)
      },
      (e: Error) => !closed && setError(e.message),
    )
    return () => {
      closed = true
      void opened?.close()
    }
  }, [])

  if (error) {
    return (
      <main className="shell">
        <section className="notice" role="alert">
          <h1>Cannot reach the engine</h1>
          {error === 'missing' ? (
            <p>
              Start a local engine first: run <code>pnpm dev:engine</code> in the SDK folder, then restart this dev server so it
              reads <code>examples/.env</code>.
            </p>
          ) : (
            <p>
              <code>{error}</code>
            </p>
          )}
        </section>
      </main>
    )
  }
  if (!db) {
    return (
      <main className="shell" aria-busy="true">
        <p className="connecting">Connecting to the engine…</p>
      </main>
    )
  }
  return (
    <AzoraProvider db={db}>
      <App />
    </AzoraProvider>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
