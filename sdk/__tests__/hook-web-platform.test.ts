/**
 * @jest-environment jsdom
 *
 * rn-sdk-v1-calls T8 (RNV-26): the hook does not register a browser as an Android device.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { usePushNotifications } from '../src/hooks';
import { EspressoNotifyError } from '../src/errors';

const mockRegister = jest.fn().mockResolvedValue({ success: true });
const mockRequestPermissions = jest.fn().mockResolvedValue('granted');
const mockClientConfigs: any[] = [];

jest.mock('../src/index', () => ({
  PushClient: jest.fn().mockImplementation((config: any) => {
    mockClientConfigs.push(config);
    return { devices: { register: mockRegister, identify: jest.fn(), unregister: jest.fn() }, destroy: jest.fn() };
  }),
  resolvePushProvider: jest.fn(() => ({
    requestPermissions: (...a: any[]) => mockRequestPermissions(...a),
    getToken: () => Promise.resolve({ token: 'ExponentPushToken[t]', provider: 'expo' }),
  })),
}));
jest.mock('expo-notifications', () => ({}), { virtual: true });
// The factory runs when hooks.ts is required, before the constants of this file exist; it publishes the
// Platform object it hands out so each test can set the OS.
jest.mock(
  'react-native',
  () => {
    const Platform = { OS: 'ios' };
    (globalThis as any).__rnPlatform = Platform;
    return { Platform };
  },
  { virtual: true },
);
const setOS = (os: string) => {
  (globalThis as any).__rnPlatform.OS = os;
};

beforeEach(() => {
  jest.clearAllMocks();
  mockClientConfigs.length = 0;
  setOS('ios');
  mockRegister.mockResolvedValue({ success: true });
  mockRequestPermissions.mockResolvedValue('granted');
});

describe('usePushNotifications on the web (RNV-26)', () => {
  it('does not register and reports UNSUPPORTED_PLATFORM when Platform.OS is web and no platform was passed', async () => {
    setOS('web');
    const { result } = renderHook(() => usePushNotifications({ projectId: 'pk_test' }));

    await waitFor(() => expect(result.current.error).not.toBeNull());

    expect(result.current.error).toBeInstanceOf(EspressoNotifyError);
    expect((result.current.error as EspressoNotifyError).code).toBe('UNSUPPORTED_PLATFORM');
    expect(result.current.isReady).toBe(false);
    expect(mockRegister).not.toHaveBeenCalled();
    expect(mockClientConfigs).toHaveLength(0);
    expect(mockRequestPermissions).not.toHaveBeenCalled();
  });

  it('registers as the platform the app passed, even on the web', async () => {
    setOS('web');
    const { result } = renderHook(() => usePushNotifications({ projectId: 'pk_test', platform: 'ios' }));

    await waitFor(() => expect(result.current.isReady).toBe(true));

    expect(mockClientConfigs[0].platform).toBe('ios');
    expect(result.current.error).toBeNull();
  });

  it.each([
    ['ios', 'ios'],
    ['android', 'android'],
  ])('detects %s as before', async (os, expected) => {
    setOS(os);
    const { result } = renderHook(() => usePushNotifications({ projectId: 'pk_test' }));

    await waitFor(() => expect(result.current.isReady).toBe(true));

    expect(mockClientConfigs[0].platform).toBe(expected);
  });
});

export {};
