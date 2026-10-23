# React Native CLI template fixtures

Text files of the app that `npx @react-native-community/cli init` creates, used by the tests of the setup wizard
(`wizard-bare-*.test.ts`) so each patcher is tested against the real shape of the template.

| Folder | React Native | Template package |
| --- | --- | --- |
| `0.87.1/` | 0.87.1 | `@react-native-community/template@0.87.1` |
| `0.79.7/` | 0.79.7 | `@react-native-community/template@0.79.7` |

Source: the files of the `template/` folder of those two npm packages, copied on 2026-10-23 without change. The folder
`HelloWorld` is the template's own placeholder: `init` renames it to the app name (`ios/HelloWorld/` becomes
`ios/<App>/`, `target 'HelloWorld'` becomes `target '<App>'`). Nothing was generated or built, so no `Pods/`,
`node_modules/`, `.xcodeproj`, keystore or lock file is here.

Kept: `package.json`, `ios/Podfile`, `ios/HelloWorld/AppDelegate.swift`, `android/build.gradle`,
`android/app/build.gradle`, `android/app/src/main/AndroidManifest.xml`.

Do not edit these files to make a test pass. If a template changes, copy the new one and add the folder.
