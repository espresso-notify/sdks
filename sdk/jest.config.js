module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.ts'],
  // The SDK's devDependencies pull real copies of these native packages into
  // node_modules. They cannot load under Node, and every test replaces them with
  // `jest.doMock(name, factory, { virtual: true })`. When the real package is
  // resolvable, jest's per-worker resolution cache sometimes keys the mock by
  // the real path and sometimes by the name, so a test file intermittently got
  // the real module (seen in capabilities, bare-provider and the
  // sdk-launch-fixes suites). Hiding them makes every require of these names
  // hit the virtual mock.
  modulePathIgnorePatterns: [
    '<rootDir>/node_modules/react-native/',
    '<rootDir>/node_modules/expo-notifications/',
    '<rootDir>/node_modules/expo-constants/',
    '<rootDir>/node_modules/expo-application/',
    '<rootDir>/node_modules/expo-device/',
    '<rootDir>/node_modules/expo-localization/',
    // Text copies of the React Native CLI template for the setup wizard tests: two `package.json` with the same name
    // would be a haste naming collision, and they are data, never modules.
    '<rootDir>/__tests__/fixtures/bare-templates/',
  ],
  setupFiles: ['<rootDir>/jest/native-modules-absent.js'],
};
