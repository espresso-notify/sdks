import { useState } from 'react'
import type { NotificationOpenedEvent } from '@espresso-notify/react-native'
import { usePushNotifications } from '@espresso-notify/react-native/hooks'
import { PushTestScreen } from './src/PushTestScreen'

const PROJECT_ID = process.env.EXPO_PUBLIC_ESPRESSO_PROJECT_ID ?? 'pk_live_REPLACE_ME'

export default function App() {
  return <PushApp />
}

function PushApp() {
  // Reactive auth state: the hook calls identify() when set and unregister() when null.
  const [externalId, setExternalId] = useState<string | null>(null)
  // The last notification the user tapped, to show on the screen.
  const [lastTap, setLastTap] = useState<NotificationOpenedEvent | null>(null)

  const { isReady, pushToken, client, permissionStatus, error } = usePushNotifications({
    projectId: PROJECT_ID,
    externalId,
    metadata: { app_name: 'expo-push-test' },
    // Called once for every tap on a notification, also for the tap that opened the app.
    onNotificationOpened: (event) => setLastTap(event),
  })

  return (
    <PushTestScreen
      mode="expo"
      isReady={isReady}
      pushToken={pushToken}
      client={client}
      permissionStatus={permissionStatus}
      error={error}
      externalId={externalId}
      lastTap={lastTap}
      onIdentify={setExternalId}
      onLogout={() => setExternalId(null)}
    />
  )
}
