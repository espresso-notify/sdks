/**
 * @jest-environment node
 *
 * rn-sdk-v1-calls T10 (RNV-27, RNV-20): no runtime dependencies, and floors on the Expo peers.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const manifest = require('../package.json');

describe('package manifest (#928, RNV-27)', () => {
  it('has no runtime dependencies (the config plugin API comes from the Expo app)', () => {
    expect(manifest.dependencies).toBeUndefined();
  });

  it('lists expo as an optional peer from SDK 53', () => {
    expect(manifest.peerDependencies.expo).toBe('>=53.0.0');
    expect(manifest.peerDependenciesMeta.expo).toEqual({ optional: true });
  });

  it('lists AsyncStorage as an optional peer', () => {
    expect(manifest.peerDependencies['@react-native-async-storage/async-storage']).toBeDefined();
    expect(manifest.peerDependenciesMeta['@react-native-async-storage/async-storage']).toEqual({ optional: true });
  });

  it('gives each Expo peer the floor of Expo SDK 53, the SDK of the React Native floor', () => {
    const floors = {
      'expo-notifications': '>=0.31.0',
      'expo-constants': '>=17.1.0',
      'expo-crypto': '>=14.1.0',
      'expo-application': '>=6.1.0',
      'expo-device': '>=7.1.0',
      'expo-localization': '>=16.1.0',
      'expo-secure-store': '>=14.2.0',
    };
    for (const [name, range] of Object.entries(floors)) {
      expect(manifest.peerDependencies[name]).toBe(range);
    }
  });

  it('gives each third-party peer the floor the owner approved on 2026-10-16 (D-123), measured in the compat report', () => {
    const floors = {
      '@react-native-firebase/messaging': '>=20.5.0',
      '@react-native-firebase/app-check': '>=20.5.0 <26',
      'react-native-notify-kit': '>=9.7.0',
      '@react-native-async-storage/async-storage': '>=1.24.0',
      'react-native-ssl-public-key-pinning': '>=1.2.6',
      'react-native-ios-appattest': '>=0.10.0',
      'react-native-secure-sign': '>=0.0.2',
    };
    for (const [name, range] of Object.entries(floors)) {
      expect(manifest.peerDependencies[name]).toBe(range);
      expect(manifest.peerDependenciesMeta[name]).toEqual({ optional: true });
    }
  });

  it('leaves no peer at "*"', () => {
    const open = Object.entries(manifest.peerDependencies).filter(([, range]) => range === '*');
    expect(open).toEqual([]);
  });

  it('keeps every peer but react-native optional', () => {
    const required = Object.keys(manifest.peerDependencies).filter(
      (p) => manifest.peerDependenciesMeta?.[p]?.optional !== true,
    );
    expect(required).toEqual(['react-native']);
  });
});

// A module, so that its top-level names do not clash with the other test files that are scripts.
export {}
