import { useEffect, useState } from 'react'
import { PushClient } from '@espresso-notify/react-native'
import type { PermissionStatus } from '@espresso-notify/react-native'
import { usePushIdentity } from '@espresso-notify/react-native/hooks'
import { PushTestScreen } from './src/PushTestScreen'
import { bootstrapPush } from './src/pushClient'

export default function App() {
  const [client, setClient] = useState<PushClient | null>(null)
  const [token, setToken] = useState<string | null>(null)
  const [permission, setPermission] = useState<PermissionStatus>(null)
  const [error, setError] = useState<string | null>(null)
  const [externalId, setExternalId] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    bootstrapPush().then((r) => {
      if (!active) return
      setPermission(r.permission)
      if (r.error) {
        setError(r.error)
        return
      }
      setClient(r.client)
      setToken(r.token)
    })
    return () => {
      active = false
    }
  }, [])

  // Reactive identity: identify() when externalId is set, unregister() when cleared.
  usePushIdentity(client, externalId)

  return (
    <PushTestScreen
      mode="bare"
      isReady={client != null}
      pushToken={token}
      client={client}
      permissionStatus={permission}
      error={error ? new Error(error) : null}
      externalId={externalId}
      onIdentify={setExternalId}
      onLogout={() => setExternalId(null)}
    />
  )
}
