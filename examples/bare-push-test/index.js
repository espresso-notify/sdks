import { AppRegistry } from 'react-native'
import notifyKit from 'react-native-notify-kit'
import App from './App'
import { name as appName } from './app.json'

// Must run BEFORE AppRegistry.registerComponent — handles background notification events.
// Foreground events (received / press / dismissed) are auto-wired by the SDK's BareDisplayAdapter.
notifyKit.onBackgroundEvent(async ({ type, detail }) => {
  console.log('[notifyKit] background event', type, detail?.notification?.id)
})

AppRegistry.registerComponent(appName, () => App)
