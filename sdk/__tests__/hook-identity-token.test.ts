/**
 * @jest-environment jsdom
 *
 * identity-jwt T21 (JWT-23, JWT-24, JWT-28): the identityToken option of the hook and of usePushIdentity.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { usePushNotifications, usePushIdentity } from '../src/hooks';
import { PushClient } from '../src/index';

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

describe('usePushNotifications identityToken (JWT-23)', () => {
  it('passes the token to the first identify', async () => {
    const { result } = renderHook(() =>
      usePushNotifications({ projectId: 'pk_test', externalId: 'u1', identityToken: 't1' }),
    );
    await waitFor(() => expect(result.current.isReady).toBe(true));
    await waitFor(() => expect(mockIdentify).toHaveBeenCalledTimes(1));

    expect(mockIdentify).toHaveBeenCalledWith({ externalId: 'u1', identityToken: 't1' }, 'ExponentPushToken[t]');
  });

  it('identifies again with the token when it arrives after the external id', async () => {
    let identityToken: string | null = null;
    const { result, rerender } = renderHook(() =>
      usePushNotifications({ projectId: 'pk_test', externalId: 'u1', identityToken }),
    );
    await waitFor(() => expect(result.current.isReady).toBe(true));
    await waitFor(() => expect(mockIdentify).toHaveBeenCalledTimes(1));
    expect(mockIdentify).toHaveBeenLastCalledWith({ externalId: 'u1' }, 'ExponentPushToken[t]');

    identityToken = 't1';
    rerender();

    await waitFor(() => expect(mockIdentify).toHaveBeenCalledTimes(2));
    expect(mockIdentify).toHaveBeenLastCalledWith({ externalId: 'u1', identityToken: 't1' }, 'ExponentPushToken[t]');
  });

  it('does not identify again when the token goes away and the user stays', async () => {
    let identityToken: string | null = 't1';
    const { result, rerender } = renderHook(() =>
      usePushNotifications({ projectId: 'pk_test', externalId: 'u1', identityToken }),
    );
    await waitFor(() => expect(result.current.isReady).toBe(true));
    await waitFor(() => expect(mockIdentify).toHaveBeenCalledTimes(1));

    identityToken = null;
    rerender();
    await new Promise((r) => setTimeout(r, 20));

    expect(mockIdentify).toHaveBeenCalledTimes(1);
  });

  it('does not identify again when the same token is rendered again', async () => {
    const { result, rerender } = renderHook(() =>
      usePushNotifications({ projectId: 'pk_test', externalId: 'u1', identityToken: 't1' }),
    );
    await waitFor(() => expect(result.current.isReady).toBe(true));
    await waitFor(() => expect(mockIdentify).toHaveBeenCalledTimes(1));
    rerender();
    rerender();
    await new Promise((r) => setTimeout(r, 20));
    expect(mockIdentify).toHaveBeenCalledTimes(1);
  });

  it('sends the name and the token together, and a new token with a new user', async () => {
    let externalId = 'u1';
    let identityToken = 't1';
    const { result, rerender } = renderHook(() =>
      usePushNotifications({ projectId: 'pk_test', externalId, userName: 'Ana', identityToken }),
    );
    await waitFor(() => expect(result.current.isReady).toBe(true));
    await waitFor(() => expect(mockIdentify).toHaveBeenCalledTimes(1));
    expect(mockIdentify).toHaveBeenLastCalledWith(
      { externalId: 'u1', name: 'Ana', identityToken: 't1' },
      'ExponentPushToken[t]',
    );

    externalId = 'u2';
    identityToken = 't2';
    rerender();
    await waitFor(() => expect(mockIdentify).toHaveBeenCalledTimes(2));
    expect(mockIdentify).toHaveBeenLastCalledWith(
      { externalId: 'u2', name: 'Ana', identityToken: 't2' },
      'ExponentPushToken[t]',
    );
  });

  it('identify has the same arguments as before when no token is given', async () => {
    const { result } = renderHook(() => usePushNotifications({ projectId: 'pk_test', externalId: 'u1' }));
    await waitFor(() => expect(result.current.isReady).toBe(true));
    await waitFor(() => expect(mockIdentify).toHaveBeenCalledTimes(1));
    const [user] = mockIdentify.mock.calls[0];
    expect(Object.keys(user)).toEqual(['externalId']);
  });
});

describe('usePushNotifications identityToken, the same user and the logout (JWT-23, JWT-28)', () => {
  it('identifies again when the token of the same user changes', async () => {
    let identityToken = 't1';
    const { result, rerender } = renderHook(() =>
      usePushNotifications({ projectId: 'pk_test', externalId: 'u1', identityToken }),
    );
    await waitFor(() => expect(result.current.isReady).toBe(true));
    await waitFor(() => expect(mockIdentify).toHaveBeenCalledTimes(1));

    identityToken = 't2';
    rerender();

    await waitFor(() => expect(mockIdentify).toHaveBeenCalledTimes(2));
    expect(mockIdentify).toHaveBeenLastCalledWith({ externalId: 'u1', identityToken: 't2' }, 'ExponentPushToken[t]');
  });

  it('logout unregisters, and the same user logging in again sends the token again', async () => {
    let externalId: string | null = 'u1';
    const { result, rerender } = renderHook(() =>
      usePushNotifications({ projectId: 'pk_test', externalId, identityToken: 't1' }),
    );
    await waitFor(() => expect(result.current.isReady).toBe(true));
    await waitFor(() => expect(mockIdentify).toHaveBeenCalledTimes(1));

    externalId = null;
    rerender();
    await waitFor(() => expect(mockUnregister).toHaveBeenCalledTimes(1));

    externalId = 'u1';
    rerender();
    await waitFor(() => expect(mockIdentify).toHaveBeenCalledTimes(2));
    expect(mockIdentify).toHaveBeenLastCalledWith({ externalId: 'u1', identityToken: 't1' }, 'ExponentPushToken[t]');
  });
});

describe('usePushNotifications identityTokenProvider (JWT-24)', () => {
  const providerOfTheClient = () => (PushClient as unknown as jest.Mock).mock.calls[0][0].identityTokenProvider as (id: string) => Promise<string>;

  it('gives the client a provider that asks the function of the app with the external id', async () => {
    const mine = jest.fn().mockResolvedValue('fresh');
    const { result } = renderHook(() =>
      usePushNotifications({ projectId: 'pk_test', externalId: 'u1', identityToken: 't1', identityTokenProvider: mine }),
    );
    await waitFor(() => expect(result.current.isReady).toBe(true));

    await expect(providerOfTheClient()('u1')).resolves.toBe('fresh');
    expect(mine).toHaveBeenCalledWith('u1');
  });

  it('asks the latest function the component passed, so an inline function works', async () => {
    let which = 'first';
    const { result, rerender } = renderHook(() =>
      usePushNotifications({
        projectId: 'pk_test',
        externalId: 'u1',
        identityTokenProvider: async () => which,
      }),
    );
    await waitFor(() => expect(result.current.isReady).toBe(true));
    await expect(providerOfTheClient()('u1')).resolves.toBe('first');

    which = 'second';
    rerender();
    await expect(providerOfTheClient()('u1')).resolves.toBe('second');
  });

  it('with no function the provider of the client fails, so the client hands the error to the app', async () => {
    const { result } = renderHook(() => usePushNotifications({ projectId: 'pk_test', externalId: 'u1' }));
    await waitFor(() => expect(result.current.isReady).toBe(true));

    await expect(providerOfTheClient()('u1')).rejects.toThrow();
  });
});

describe('usePushIdentity identityToken (JWT-23)', () => {
  const client = () => ({ devices: { identify: mockIdentify, unregister: mockUnregister } }) as any;

  it('passes the token and identifies again when it changes', () => {
    const c = client();
    let token: string | undefined = 't1';
    const { rerender } = renderHook(() => usePushIdentity(c, 'u1', token));
    expect(mockIdentify).toHaveBeenCalledTimes(1);
    expect(mockIdentify).toHaveBeenLastCalledWith({ externalId: 'u1', identityToken: 't1' });

    token = 't2';
    rerender();
    expect(mockIdentify).toHaveBeenCalledTimes(2);
    expect(mockIdentify).toHaveBeenLastCalledWith({ externalId: 'u1', identityToken: 't2' });
  });

  it('keeps the old call shape without a token', () => {
    renderHook(() => usePushIdentity(client(), 'u1'));
    expect(mockIdentify).toHaveBeenCalledWith({ externalId: 'u1' });
  });
});

export {};
