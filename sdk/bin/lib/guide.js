'use strict';

/**
 * The text of the steps the setup wizard for React Native CLI apps does not do itself. The wizard never creates the
 * Firebase files, never edits the Xcode project, and never uploads a credential: it says where each thing goes and where to
 * get it. Everything here is plain English text; a line is returned without indentation, the caller indents it.
 */

const ANDROID_GOOGLE_SERVICES = 'android/app/google-services.json';

/** The lines of the background handler for `index.js` (the same code as the guide). */
const INDEX_SNIPPET = [
  "import notifyKit from 'react-native-notify-kit'",
  '',
  '// before AppRegistry.registerComponent: it receives the events of notifications that arrive in the background',
  'notifyKit.onBackgroundEvent(async ({ type, detail }) => {',
  "  console.log('background event', type, detail?.notification?.id)",
  '})',
];

/**
 * The steps for the last part of the wizard.
 * @param {object} state
 * @param {boolean} state.hasIos there is an ios/ folder
 * @param {boolean} state.hasAndroid there is an android/ folder
 * @param {string | null} state.iosAppDir the folder of the app inside ios/ (`ios/<App>`), when it is known
 * @param {boolean} state.hasGoogleServicesJson android/app/google-services.json is in place
 * @param {boolean} state.hasPlist GoogleService-Info.plist is in place
 * @param {boolean} state.hasAsyncStorage the project lists @react-native-async-storage/async-storage
 * @param {string} state.guideUrl the manual guide
 * @returns {string[]} the lines, a step per bullet
 */
function manualSteps(state) {
  const lines = [];
  const bullet = (first, ...rest) => {
    lines.push(`- ${first}`);
    for (const line of rest) lines.push(line === '' ? '' : `  ${line}`);
  };
  const iosDir = state.iosAppDir || 'ios/<YourApp>';

  if (state.hasAndroid && !state.hasGoogleServicesJson) {
    bullet(
      `Android: put google-services.json in ${ANDROID_GOOGLE_SERVICES}.`,
      'Get it in the Firebase console: Project settings, Your apps, your Android app, Download google-services.json.',
    );
  }
  if (state.hasIos && !state.hasPlist) {
    bullet(
      `iOS: put GoogleService-Info.plist in ${iosDir}/GoogleService-Info.plist.`,
      'Get it in the Firebase console: Project settings, Your apps, your iOS app, Download GoogleService-Info.plist.',
      'Until the file is in the app the wizard guards FirebaseApp.configure(), so the app opens without it.',
    );
  }
  if (state.hasIos) {
    bullet(
      'iOS, in Xcode: drag GoogleService-Info.plist into the app target (check "Copy items if needed" and your app target).',
      'Then open Signing & Capabilities and add the Push Notifications capability, and add Background Modes with',
      'Remote notifications checked. Without the first the app gets no APNs token; without the second a silent push does not wake it.',
    );
    bullet(
      'iOS: upload an APNs key (a .p8 file) in the Firebase console, Project settings, Cloud Messaging.',
      'The APNs key goes to Firebase, not to the Espresso Notify dashboard.',
    );
  }
  bullet(
    'Dashboard: give Espresso Notify the Firebase service account so it can send through FCM.',
    'In the dashboard open your project, Settings, Native Push, and upload the service account JSON file.',
    'Get that file in the Firebase console: Project settings, Service accounts, Generate new private key.',
    'It is not the google-services.json of the app.',
  );
  bullet('index.js: register the background handler of react-native-notify-kit before AppRegistry.registerComponent:', '', ...INDEX_SNIPPET.map((line) => (line ? `  ${line}` : '')));
  if (state.hasAndroid) {
    bullet(
      'Android 13 and later: the notification permission android.permission.POST_NOTIFICATIONS comes with react-native-notify-kit;',
      'if you removed that package, add <uses-permission android:name="android.permission.POST_NOTIFICATIONS"/>',
      'to android/app/src/main/AndroidManifest.xml.',
    );
  }
  if (state.hasIos) {
    bullet(
      'Building with the iOS 27 SDK: an app built with it must adopt the UIScene life cycle, and the React Native template still',
      `creates the window in the app delegate. The guide shows the scene delegate: ${state.guideUrl}#building-with-the-ios-27-sdk`,
    );
  }
  if (!state.hasAsyncStorage) {
    bullet(
      'Tip: without @react-native-async-storage/async-storage the queue of events is kept only in memory and is lost when the app closes.',
      'Install it (and run pod install) if you want the queue to survive.',
    );
  }
  return lines;
}

module.exports = { manualSteps, INDEX_SNIPPET, ANDROID_GOOGLE_SERVICES };
