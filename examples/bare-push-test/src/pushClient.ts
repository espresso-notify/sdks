import { Platform } from 'react-native'
import { getApps } from '@react-native-firebase/app'
import notifyKit, { AuthorizationStatus } from 'react-native-notify-kit'
import { PushClient, BareProvider } from '@espresso-notify/react-native'
import type { PermissionStatus } from '@espresso-notify/react-native'
import { PROJECT_ID } from './config'

export type BootstrapResult =
  | { client: PushClient; token: string; permission: PermissionStatus; error: null }
  | { client: null; token: null; permission: PermissionStatus; error: string }

export const FIREBASE_NOT_CONFIGURED =
  'Firebase is not configured: add google-services.json (Android) / GoogleService-Info.plist (iOS) to get an FCM token'

/** True when the native Firebase default app exists (its config file was bundled). */
export function isFirebaseConfigured(): boolean {
  try {
    return getApps().length > 0
  } catch {
    return false
  }
}

/**
 * OS notification permission. With Firebase it goes through the SDK's BareProvider; without it
 * (no config files yet) notify-kit asks the OS directly, so the dialog still shows.
 */
export async function requestPushPermission(): Promise<PermissionStatus> {
  if (isFirebaseConfigured()) return new BareProvider().requestPermissions()
  const settings = await notifyKit.requestPermission()
  switch (settings.authorizationStatus) {
    case AuthorizationStatus.AUTHORIZED:
    case AuthorizationStatus.PROVISIONAL:
      return 'granted'
    case AuthorizationStatus.DENIED:
      return 'denied'
    default:
      return 'undetermined'
  }
}

/** Imperative bare-RN bootstrap: permission → FCM token → PushClient → register(). */
export async function bootstrapPush(): Promise<BootstrapResult> {
  if (!isFirebaseConfigured()) {
    // Without the Firebase files messaging() has no default app; skip it and say so on screen.
    const permission = await requestPushPermission()
    return { client: null, token: null, permission, error: FIREBASE_NOT_CONFIGURED }
  }
  const provider = new BareProvider()
  const permission = await provider.requestPermissions()
  if (permission !== 'granted') {
    return { client: null, token: null, permission, error: `permission ${permission}` }
  }
  const tokenData = await provider.getToken()
  if (!tokenData) {
    return { client: null, token: null, permission, error: 'no FCM token' }
  }
  const client = new PushClient({
    projectId: PROJECT_ID,
    pushToken: tokenData.token,
    platform: Platform.OS === 'ios' ? 'ios' : 'android',
    provider: tokenData.provider, // 'fcm'
  })
  await client.devices.register({ metadata: { app_name: 'bare-push-test' } })
  return { client, token: tokenData.token, permission, error: null }
}
