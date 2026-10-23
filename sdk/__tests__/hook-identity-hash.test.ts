/**
 * @jest-environment jsdom
 *
 * rn-sdk-v1-calls T7 (RNV-15): the identityHash option of the hook and of usePushIdentity.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { usePushNotifications, usePushIdentity } from '../src/hooks';

const mockRegister = jest.fn().mockResolvedValue({ success: true });
const mockIdentify = jest.fn().mockResolvedValue({ success: true });
const mockUnregister = jest.fn().mockResolvedValue({ success: true });

jest.mock('../src/index', () => ({
  PushClient: jest.fn().mockImplementation(() => ({
    devices: { register: mockRegister, identify: mockIdentify, unregister: mockUnregister },
    destroy: jest.fn(),
  })),
  resolvePushProvider: jest.fn(() => ({
    requestPermissions: () => Promise.resolve('granted'),
    getToken: () => Promise.resolve({ token: 'ExponentPushToken[t]', provider: 'expo' }),
  })),
}));
jest.mock('expo-notifications', () => ({}), { virtual: true });
jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }), { virtual: true });

beforeEach(() => {
  jest.clearAllMocks();
  mockRegister.mockResolvedValue({ success: true });
  mockIdentify.mockResolvedValue({ success: true });
});

describe('usePushNotifications identityHash (RNV-15)', () => {
  it('passes the hash to the first identify', async () => {
    const { result } = renderHook(() =>
      usePushNotifications({ projectId: 'pk_test', externalId: 'u1', identityHash: 'h1' }),
    );
    await waitFor(() => expect(result.current.isReady).toBe(true));
    await waitFor(() => expect(mockIdentify).toHaveBeenCalledTimes(1));

    expect(mockIdentify).toHaveBeenCalledWith({ externalId: 'u1', identityHash: 'h1' }, 'ExponentPushToken[t]');
  });

  it('identifies again with the hash when it arrives after the external id', async () => {
    let identityHash: string | null = null;
    const { result, rerender } = renderHook(() =>
      usePushNotifications({ projectId: 'pk_test', externalId: 'u1', identityHash }),
    );
    await waitFor(() => expect(result.current.isReady).toBe(true));
    await waitFor(() => expect(mockIdentify).toHaveBeenCalledTimes(1));
    expect(mockIdentify).toHaveBeenLastCalledWith({ externalId: 'u1' }, 'ExponentPushToken[t]');

    identityHash = 'h1';
    rerender();

    await waitFor(() => expect(mockIdentify).toHaveBeenCalledTimes(2));
    expect(mockIdentify).toHaveBeenLastCalledWith({ externalId: 'u1', identityHash: 'h1' }, 'ExponentPushToken[t]');
  });

  it('does not identify again when the hash goes away and the user stays', async () => {
    let identityHash: string | null = 'h1';
    const { result, rerender } = renderHook(() =>
      usePushNotifications({ projectId: 'pk_test', externalId: 'u1', identityHash }),
    );
    await waitFor(() => expect(result.current.isReady).toBe(true));
    await waitFor(() => expect(mockIdentify).toHaveBeenCalledTimes(1));

    identityHash = null;
    rerender();
    await new Promise((r) => setTimeout(r, 20));

    expect(mockIdentify).toHaveBeenCalledTimes(1);
  });

  it('does not identify again when the same hash is rendered again', async () => {
    const { result, rerender } = renderHook(() =>
      usePushNotifications({ projectId: 'pk_test', externalId: 'u1', identityHash: 'h1' }),
    );
    await waitFor(() => expect(result.current.isReady).toBe(true));
    await waitFor(() => expect(mockIdentify).toHaveBeenCalledTimes(1));
    rerender();
    rerender();
    await new Promise((r) => setTimeout(r, 20));
    expect(mockIdentify).toHaveBeenCalledTimes(1);
  });

  it('sends the name and the hash together, and a new hash with a new user', async () => {
    let externalId = 'u1';
    let identityHash = 'h1';
    const { result, rerender } = renderHook(() =>
      usePushNotifications({ projectId: 'pk_test', externalId, userName: 'Ana', identityHash }),
    );
    await waitFor(() => expect(result.current.isReady).toBe(true));
    await waitFor(() => expect(mockIdentify).toHaveBeenCalledTimes(1));
    expect(mockIdentify).toHaveBeenLastCalledWith(
      { externalId: 'u1', name: 'Ana', identityHash: 'h1' },
      'ExponentPushToken[t]',
    );

    externalId = 'u2';
    identityHash = 'h2';
    rerender();
    await waitFor(() => expect(mockIdentify).toHaveBeenCalledTimes(2));
    expect(mockIdentify).toHaveBeenLastCalledWith(
      { externalId: 'u2', name: 'Ana', identityHash: 'h2' },
      'ExponentPushToken[t]',
    );
  });

  it('identify has the same arguments as before when no hash is given', async () => {
    const { result } = renderHook(() => usePushNotifications({ projectId: 'pk_test', externalId: 'u1' }));
    await waitFor(() => expect(result.current.isReady).toBe(true));
    await waitFor(() => expect(mockIdentify).toHaveBeenCalledTimes(1));
    const [user] = mockIdentify.mock.calls[0];
    expect(Object.keys(user)).toEqual(['externalId']);
  });
});

describe('usePushIdentity identityHash (RNV-15)', () => {
  const client = () => ({ devices: { identify: mockIdentify, unregister: mockUnregister } }) as any;

  it('passes the hash and identifies again when it changes', () => {
    const c = client();
    let hash: string | undefined = 'h1';
    const { rerender } = renderHook(() => usePushIdentity(c, 'u1', hash));
    expect(mockIdentify).toHaveBeenCalledTimes(1);
    expect(mockIdentify).toHaveBeenLastCalledWith({ externalId: 'u1', identityHash: 'h1' });

    hash = 'h2';
    rerender();
    expect(mockIdentify).toHaveBeenCalledTimes(2);
    expect(mockIdentify).toHaveBeenLastCalledWith({ externalId: 'u1', identityHash: 'h2' });
  });

  it('keeps the old call shape without a hash', () => {
    renderHook(() => usePushIdentity(client(), 'u1'));
    expect(mockIdentify).toHaveBeenCalledWith({ externalId: 'u1' });
  });
});

export {};
