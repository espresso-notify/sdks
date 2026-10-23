// Default for every test file: the native packages below are absent, exactly
// as if they were not installed. A test that needs one mocks it with
// jest.mock / jest.doMock(name, factory, { virtual: true }), which replaces this
// factory. Registering them here for every file keeps jest's module ids for
// these names identical across files in the same worker; without it the
// first file to require an unmocked name could make a later file's virtual
// mock unreachable.
const ABSENT = [
  'react-native',
  'expo-notifications',
  'expo-constants',
  'expo-application',
  'expo-device',
  'expo-localization',
];
for (const name of ABSENT) {
  jest.mock(name, () => { throw new Error(`Cannot find module '${name}' (absent in tests)`); }, { virtual: true });
}

// The Espresso config plugin (app.plugin.js) applies the `expo-notifications` config plugin. The real one
// needs the full Expo plugin API, which the plugin tests replace with fakes, so by default it is a pass-through.
// config-plugin-notifications.test.ts replaces it with the cases it checks (applied, forwarded options, absent).
jest.mock('expo-notifications/app.plugin', () => (config) => config, { virtual: true });
