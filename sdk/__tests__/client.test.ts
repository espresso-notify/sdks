import { PushClient } from '../src/index';

// Mock expo-notifications to ensure PushClient initializes successfully
jest.mock('expo-notifications', () => ({}), { virtual: true });

// Mock global fetch
const mockFetch = jest.fn();
globalThis.fetch = mockFetch;

describe('PushClient', () => {
  let client: PushClient;

  beforeEach(() => {
    mockFetch.mockClear();
    client = new PushClient({ projectId: 'pk_live_test-key' });
  });

  it('should initialize with correct config', () => {
    expect(client).toBeDefined();
  });

  it('should throw error if secret key (sk_) is used', () => {
    expect(() => {
      new PushClient({ projectId: 'sk_live_secret-key' });
    }).toThrow(/Security Alert/);
  });

  it('should warn if prefix is missing but not throw (for backward compatibility or other formats)', () => {
    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
    new PushClient({ projectId: 'legacy-key-without-prefix' });
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('should typically start with'));
    consoleSpy.mockRestore();
  });

  it('should register a user successfully', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ success: true })),
    });

    const result = await client.devices.register({
      pushToken: 'token123',
      platform: 'ios',
      metadata: { tag: 'test' }
    });

    expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('/v1/devices/register'), expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({
        'Authorization': 'Bearer pk_live_test-key',
        'Content-Type': 'application/json',
      }),
    }));
    expect(result).toEqual({ success: true });
  });

  it('should use globally configured token and platform', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ success: true })),
    });

    const globalClient = new PushClient({
      projectId: 'pk_live_global',
      pushToken: 'global-token',
      platform: 'android'
    });

    await globalClient.devices.register({
      metadata: { key: 'val' }
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.pushToken).toBe('global-token');
    expect(body.platform).toBe('android');
    expect(body.metadata).toMatchObject({ key: 'val' });
  });

  it('should identify user with global token', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ success: true })),
    });

    const globalClient = new PushClient({
      projectId: 'pk_live_global',
      pushToken: 'global-token',
      platform: 'ios'
    });

    await globalClient.devices.identify({
      externalId: 'u123',
      metadata: { role: 'admin' }
    });

    expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('/v1/devices/identify'), expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        pushToken: 'global-token',
        user: {
          external_id: 'u123',
          metadata: { role: 'admin' }
        }
      })
    }));
  });

  it('identify without name omits name from payload', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ success: true })),
    });

    const globalClient = new PushClient({
      projectId: 'pk_live_global',
      pushToken: 'global-token',
    });

    await globalClient.devices.identify({ externalId: 'u123' });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.user.external_id).toBe('u123');
    expect(body.user.name).toBeUndefined();
  });

  it('should unregister with global token', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ success: true })),
    });

    const globalClient = new PushClient({
      projectId: 'pk_live_global',
      pushToken: 'global-token'
    });

    await globalClient.devices.unregister();

    expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('/v1/devices/unregister'), expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        pushToken: 'global-token'
      })
    }));
  });

  it('should update metadata with global token', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ success: true })),
    });

    const globalClient = new PushClient({
      projectId: 'pk_live_global',
      pushToken: 'global-token'
    });

    await globalClient.devices.updateMetadata({
      theme: 'dark'
    });

    expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('/v1/devices/metadata'), expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({
        push_token: 'global-token',
        metadata: { theme: 'dark' }
      })
    }));
  });

  it('register error includes root cause from HTTP response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: '',
      text: () => Promise.resolve('Internal Server Error'),
    });

    await expect(client.devices.register({
      pushToken: 'token123',
      platform: 'android'
    })).rejects.toThrow('[espresso-notify] register failed');
  });

  it('register error includes root cause on network failure', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network failure'));

    await expect(client.devices.register({
      pushToken: 'token123',
      platform: 'android'
    })).rejects.toThrow('[espresso-notify] register failed');
  });

  it('merges auto-collected device metadata with provided metadata', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ success: true })),
    });

    await client.devices.register({
      pushToken: 'tok',
      platform: 'ios',
      metadata: { plan: 'pro' },
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.metadata).toMatchObject({ plan: 'pro' });
    expect(body.pushToken).toBe('tok');
    expect(body.platform).toBe('ios');
  });

  it('register includes provider in POST body when set via ClientConfig', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ success: true })),
    });

    const clientWithProvider = new PushClient({
      projectId: 'pk_live_test-key',
      pushToken: 'tok',
      platform: 'ios',
      provider: 'apns',
    });

    await clientWithProvider.devices.register({});

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.provider).toBe('apns');
  });

  it('register includes provider from data argument, overriding ClientConfig', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ success: true })),
    });

    const clientWithProvider = new PushClient({
      projectId: 'pk_live_test-key',
      pushToken: 'tok',
      platform: 'android',
      provider: 'expo',
    });

    await clientWithProvider.devices.register({ provider: 'fcm' });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.provider).toBe('fcm');
  });

  it('register OMITS provider key from POST body when provider is unset', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ success: true })),
    });

    await client.devices.register({
      pushToken: 'tok',
      platform: 'android',
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(Object.prototype.hasOwnProperty.call(body, 'provider')).toBe(false);
  });

  it('register includes provider:"expo" when client was configured with expo provider', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ success: true })),
    });

    const expoClient = new PushClient({
      projectId: 'pk_live_test-key',
      pushToken: 'ExponentPushToken[test]',
      platform: 'ios',
      provider: 'expo',
    });

    await expoClient.devices.register({});

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.provider).toBe('expo');
  });

  it('trackOpen is silent on network error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network failure'));

    const c = new PushClient({ projectId: 'pk_live_test-key', pushToken: 'tok', platform: 'ios' });
    await expect(c.devices.trackOpen(42)).resolves.toBeUndefined();
  });

  it('trackClick is silent on network error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network failure'));

    const c = new PushClient({ projectId: 'pk_live_test-key', pushToken: 'tok', platform: 'ios' });
    await expect(c.devices.trackClick(42)).resolves.toBeUndefined();
  });
});

describe('PushClient.destroy()', () => {
  beforeEach(() => {
    mockFetch.mockClear();
    jest.resetModules();
  });

  it('removes the auto-tracking listener and is idempotent', () => {
    const removeSpy = jest.fn();
    jest.mock('expo-notifications', () => ({
      addNotificationResponseReceivedListener: () => ({ remove: removeSpy }),
    }), { virtual: true });

    const { PushClient: FreshClient } = require('../src/index');
    const c = new FreshClient({ projectId: 'pk_live_test-key' });

    c.destroy();
    expect(removeSpy).toHaveBeenCalledTimes(1);

    // Second call is a no-op (subscription already nulled)
    c.destroy();
    expect(removeSpy).toHaveBeenCalledTimes(1);
  });
});

describe('PushClient.warnMissingOptionalDeps()', () => {
  beforeEach(() => {
    mockFetch.mockClear();
    jest.resetModules();
  });

  it('warns when optional dependencies are missing', () => {
    jest.doMock('expo-notifications', () => ({}), { virtual: true });
    jest.doMock('expo-localization', () => { throw new Error('not found'); }, { virtual: true });
    jest.doMock('expo-application', () => { throw new Error('not found'); }, { virtual: true });
    jest.doMock('expo-device', () => { throw new Error('not found'); }, { virtual: true });

    const origEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    (globalThis as any).__DEV__ = true; // the warning is for development builds only (expo-setup-simpler ES-02)
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

    try {
      const { PushClient: FreshClient } = require('../src/index');
      new FreshClient({ projectId: 'pk_live_test-key' });
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[espresso-notify]'));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('expo-localization'));
    } finally {
      process.env.NODE_ENV = origEnv;
      delete (globalThis as any).__DEV__;
      warnSpy.mockRestore();
    }
  });

  it('does not warn in test environment', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
    // NODE_ENV is 'test' by default in jest
    new PushClient({ projectId: 'pk_live_test-key' });
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('[espresso-notify]'));
    warnSpy.mockRestore();
  });
});

describe('Devices.registerCategories', () => {
  const mockSetNotificationCategoryAsync = jest.fn();

  beforeEach(() => {
    mockFetch.mockClear();
    mockSetNotificationCategoryAsync.mockClear();
    jest.resetModules();
    jest.mock('expo-notifications', () => ({
      setNotificationCategoryAsync: mockSetNotificationCategoryAsync,
    }), { virtual: true });
  });

  it('should fetch categories and call setNotificationCategoryAsync for each', async () => {
    const categories = [
      {
        identifier: 'order_update',
        actions: [
          { identifier: 'track', buttonTitle: 'Track', opensAppToForeground: true, isDestructive: false },
          { identifier: 'dismiss', buttonTitle: 'Dismiss', opensAppToForeground: false, isDestructive: false },
        ],
      },
      {
        identifier: 'promo',
        actions: [
          { identifier: 'view', buttonTitle: 'View Offer', opensAppToForeground: true, isDestructive: false },
        ],
      },
    ];

    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(JSON.stringify(categories)),
    });
    mockSetNotificationCategoryAsync.mockResolvedValue(undefined);

    const { PushClient: FreshPushClient } = require('../src/index');
    const freshClient = new FreshPushClient({ projectId: 'pk_live_test-key' });

    await freshClient.devices.registerCategories();

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/v1/notifications/categories'),
      expect.objectContaining({
        headers: expect.objectContaining({
          'Authorization': 'Bearer pk_live_test-key',
        }),
      }),
    );

    expect(mockSetNotificationCategoryAsync).toHaveBeenCalledTimes(2);
    expect(mockSetNotificationCategoryAsync).toHaveBeenCalledWith(
      'order_update',
      [
        { identifier: 'track', buttonTitle: 'Track', options: { opensAppToForeground: true, isDestructive: false } },
        { identifier: 'dismiss', buttonTitle: 'Dismiss', options: { opensAppToForeground: false, isDestructive: false } },
      ],
    );
    expect(mockSetNotificationCategoryAsync).toHaveBeenCalledWith(
      'promo',
      [
        { identifier: 'view', buttonTitle: 'View Offer', options: { opensAppToForeground: true, isDestructive: false } },
      ],
    );
  });

  it('should apply default values for optional action fields', async () => {
    const categories = [
      {
        identifier: 'simple',
        actions: [{ identifier: 'ok', buttonTitle: 'OK' }],
      },
    ];

    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(JSON.stringify(categories)),
    });
    mockSetNotificationCategoryAsync.mockResolvedValue(undefined);

    const { PushClient: FreshPushClient } = require('../src/index');
    const freshClient = new FreshPushClient({ projectId: 'pk_live_test-key' });

    await freshClient.devices.registerCategories();

    expect(mockSetNotificationCategoryAsync).toHaveBeenCalledWith(
      'simple',
      [{ identifier: 'ok', buttonTitle: 'OK', options: { opensAppToForeground: true, isDestructive: false } }],
    );
  });

  it('should be silent on network error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network failure'));

    const { PushClient: FreshPushClient } = require('../src/index');
    const freshClient = new FreshPushClient({ projectId: 'pk_live_test-key' });

    await expect(freshClient.devices.registerCategories()).resolves.toBeUndefined();
    expect(mockSetNotificationCategoryAsync).not.toHaveBeenCalled();
  });

  it('should be silent when setNotificationCategoryAsync is unavailable', async () => {
    jest.resetModules();
    jest.mock('expo-notifications', () => ({}), { virtual: true });

    const { PushClient: FreshPushClient } = require('../src/index');
    const freshClient = new FreshPushClient({ projectId: 'pk_live_test-key' });

    await expect(freshClient.devices.registerCategories()).resolves.toBeUndefined();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
