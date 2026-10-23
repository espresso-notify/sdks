// iOS 27 SDK: apps must adopt the UIScene life cycle or UIKit aborts at launch
// ("UIScene life cycle is required for apps built with this SDK").
// Expo SDK 57 ships `ExpoAppSceneDelegate` but its prebuild template still starts
// React Native from the app delegate. This plugin wires the scene delegate in:
// the app delegate keeps creating the factory, the scene delegate creates the window.
const { withAppDelegate, withInfoPlist } = require('expo/config-plugins')

const WINDOW_START = /\n#if os\(iOS\) \|\| os\(tvOS\)\n\s*window = UIWindow\(frame: UIScreen\.main\.bounds\)\n\s*factory\.startReactNative\([\s\S]*?\)\n#endif\n/

function adoptSceneDelegate(contents) {
  if (contents.includes('ExpoReactNativeFactoryProvider')) return contents
  if (!WINDOW_START.test(contents)) {
    throw new Error('[with-scene-lifecycle] AppDelegate.swift does not match the SDK 57 template')
  }
  return contents
    .replace('class AppDelegate: ExpoAppDelegate {', 'class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {')
    .replace(WINDOW_START, '\n    // The window and startReactNative live in ExpoAppSceneDelegate (scene life cycle).\n')
}

module.exports = function withSceneLifecycle(config) {
  config = withAppDelegate(config, (c) => {
    if (c.modResults.language !== 'swift') {
      throw new Error('[with-scene-lifecycle] expected a Swift AppDelegate')
    }
    c.modResults.contents = adoptSceneDelegate(c.modResults.contents)
    return c
  })
  return withInfoPlist(config, (c) => {
    c.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          {
            UISceneConfigurationName: 'Default Configuration',
            UISceneDelegateClassName: 'EXExpoAppSceneDelegate',
          },
        ],
      },
    }
    return c
  })
}
