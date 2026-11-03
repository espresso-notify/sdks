/**
 * @jest-environment jsdom
 *
 * identity-jwt T21 (JWT-25, JWT-27): the hook over the REAL client and a fake server. A token rotation re-identifies
 * the user with the stored token; when the server answers that it expired, the provider is asked once and the call is
 * repeated once.
 */
import { renderHook, act, waitFor } from '@testing-library/react';
import { usePushNotifications } from '../src/hooks';

jest.mock('expo-notifications', () => ({}), { virtual: true });
jest.mock(
  'react-native',
  () => ({ Platform: { OS: 'ios' }, AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) } }),
  { virtual: true },
);

const mockFetch = jest.fn();
globalThis.fetch = mockFetch;

const ok = () => Promise.resolve({ ok: true, status: 200, statusText: 'OK', text: () => Promise.resolve('{}') });
const expired = () =>
  Promise.resolve({
    ok: false,
    status: 401,
    statusText: 'No',
    text: () => Promise.resolve(JSON.stringify({ error: 'identity_token_expired', code: 'identity_token_expired' })),
  });

function makeProvider() {
  let refresh: ((tok: any) => void) | null = null;
  const provider = {
    requestPermissions: jest.fn().mockResolvedValue('granted'),
    getToken: jest.fn().mockResolvedValue({ token: 'ExponentPushToken[old]', provider: 'expo' }),
    onTokenRefresh: jest.fn((cb: (tok: any) => void) => {
      refresh = cb;
      return jest.fn();
    }),
    getPermissionStatus: jest.fn().mockResolvedValue('granted'),
  };
  return { provider, rotate: (token: string) => refresh!({ token, provider: 'expo' }) };
}

/** The identify requests the fake server saw, in order, with the token each carried. */
function identifies() {
  return mockFetch.mock.calls
    .filter(([url]) => String(url).endsWith('/v1/devices/identify'))
    .map(([, init]) => JSON.parse(init.body) as { pushToken: string; user: { external_id: string }; identity_token?: string });
}

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockImplementation(() => ok());
});

describe('identify after a token rotation with the stored token (JWT-27)', () => {
  it('sends the token the app passed with the identify of the new push token', async () => {
    const { provider, rotate } = makeProvider();
    const { result } = renderHook(() =>
      usePushNotifications({ projectId: 'pk_test', provider: provider as any, externalId: 'u1', identityToken: 'tkn', privateTransport: 'js' }),
    );
    await waitFor(() => expect(result.current.isReady).toBe(true));
    await waitFor(() => expect(identifies()).toHaveLength(1));

    await act(async () => { rotate('ExponentPushToken[new]'); });

    await waitFor(() => expect(identifies()).toHaveLength(2));
    expect(identifies()[1]).toMatchObject({ pushToken: 'ExponentPushToken[new]', identity_token: 'tkn' });
  });

  it('a stored token that expired meanwhile: one provider call, one repeated identify with the new token', async () => {
    const { provider, rotate } = makeProvider();
    const mine = jest.fn().mockResolvedValue('fresh');
    // The first identify (at login) is accepted with the token of the app; later it is expired for the server.
    let acceptStale = true;
    mockFetch.mockImplementation((url: string, init: any) => {
      if (String(url).endsWith('/v1/devices/identify') && JSON.parse(init.body).identity_token === 'stale' && !acceptStale) return expired();
      return ok();
    });
    const { result } = renderHook(() =>
      usePushNotifications({
        projectId: 'pk_test', provider: provider as any, externalId: 'u1', identityToken: 'stale',
        identityTokenProvider: mine, privateTransport: 'js',
      }),
    );
    await waitFor(() => expect(result.current.isReady).toBe(true));
    await waitFor(() => expect(identifies()).toHaveLength(1));
    expect(mine).not.toHaveBeenCalled();
    acceptStale = false;

    await act(async () => { rotate('ExponentPushToken[new]'); });

    await waitFor(() => expect(identifies()).toHaveLength(3)); // login, the rotation, the one repeat
    const [, tried, repeated] = identifies();
    expect(tried).toMatchObject({ pushToken: 'ExponentPushToken[new]', identity_token: 'stale' });
    expect(repeated).toMatchObject({ pushToken: 'ExponentPushToken[new]', identity_token: 'fresh' });
    expect(mine).toHaveBeenCalledTimes(1);
    expect(mine).toHaveBeenCalledWith('u1');
  });

  it('a second rotation sends the renewed token and does not ask the provider again', async () => {
    const { provider, rotate } = makeProvider();
    const mine = jest.fn().mockResolvedValue('fresh');
    mockFetch.mockImplementation((url: string, init: any) =>
      String(url).endsWith('/v1/devices/identify') && JSON.parse(init.body).identity_token === 'stale' ? expired() : ok(),
    );
    const { result } = renderHook(() =>
      usePushNotifications({
        projectId: 'pk_test', provider: provider as any, externalId: 'u1', identityToken: 'stale',
        identityTokenProvider: mine, privateTransport: 'js',
      }),
    );
    await waitFor(() => expect(result.current.isReady).toBe(true));
    await waitFor(() => expect(identifies()).toHaveLength(2)); // login with the stale token, then the repeat
    expect(mine).toHaveBeenCalledTimes(1);

    await act(async () => { rotate('ExponentPushToken[new]'); });

    await waitFor(() => expect(identifies()).toHaveLength(3));
    expect(identifies()[2]).toMatchObject({ pushToken: 'ExponentPushToken[new]', identity_token: 'fresh' });
    expect(mine).toHaveBeenCalledTimes(1);
  });

  it('with no provider an expired token ends the identify of the rotation with no repeat', async () => {
    const { provider, rotate } = makeProvider();
    let acceptStale = true;
    mockFetch.mockImplementation((url: string, init: any) =>
      String(url).endsWith('/v1/devices/identify') && !acceptStale ? expired() : ok(),
    );
    const { result } = renderHook(() =>
      usePushNotifications({ projectId: 'pk_test', provider: provider as any, externalId: 'u1', identityToken: 'stale', privateTransport: 'js' }),
    );
    await waitFor(() => expect(result.current.isReady).toBe(true));
    await waitFor(() => expect(identifies()).toHaveLength(1));
    acceptStale = false;

    await act(async () => { rotate('ExponentPushToken[new]'); });

    await waitFor(() => expect(identifies()).toHaveLength(2));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(identifies()).toHaveLength(2);
  });
});

export {};

// feature: registration.token-rotation
// feature: identity.token-renewal
