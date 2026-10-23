/**
 * @jest-environment jsdom
 *
 * rn-tap-and-offline-queue, T5 (DLK-01 to DLK-06, DLK-08): the SDK opens the link of a tap only when the app opts in
 * with handleDeepLinks, and only for the schemes and hosts of deepLinkAllowList. Native modules are virtual mocks.
 */

const flushPromises = () => new Promise((r) => setTimeout(r, 0))
const DEFAULT_ACTION = 'expo.modules.notifications.actions.DEFAULT'

function response(data: Record<string, unknown>, action = DEFAULT_ACTION) {
  return {
    actionIdentifier: action,
    notification: { date: Math.random(), request: { identifier: `req-${Math.random()}`, content: { data } } },
  }
}

const fetchMock = jest.fn()

function setup(opts: { linking?: any; client?: Record<string, unknown> } = {}) {
  jest.resetModules()
  fetchMock.mockReset()
  fetchMock.mockResolvedValue({ ok: true, text: async () => '' })
  ;(globalThis as any).fetch = fetchMock
  const listeners: Array<(r: any) => void> = []
  jest.doMock('expo-notifications', () => ({
    DEFAULT_ACTION_IDENTIFIER: DEFAULT_ACTION,
    addNotificationResponseReceivedListener: (cb: (r: any) => void) => { listeners.push(cb); return { remove: jest.fn() } },
    addNotificationReceivedListener: () => ({ remove: jest.fn() }),
    getLastNotificationResponseAsync: jest.fn().mockResolvedValue(null),
  }), { virtual: true })
  const linking = 'linking' in opts ? opts.linking : { openURL: jest.fn().mockResolvedValue(undefined) }
  jest.doMock('react-native', () => ({ Platform: { OS: 'ios', Version: 17 }, AppState: null, Linking: linking }), { virtual: true })
  const sdk = require('../src/index')
  const client = new sdk.PushClient({ projectId: 'pk_live_test', pushToken: 'tok', platform: 'ios', ...opts.client })
  return { client, linking, tap: (data: Record<string, unknown>, action?: string) => listeners.forEach((l) => l(response(data, action))) }
}

let warn: jest.SpyInstance
beforeEach(() => { warn = jest.spyOn(console, 'warn').mockImplementation(() => {}) })
afterEach(() => warn.mockRestore())

const OPT_IN = { handleDeepLinks: true, deepLinkAllowList: ['myapp://', 'https://shop.example.com'] }

describe('the default is closed (DLK-01)', () => {
  it('never opens a link without handleDeepLinks, and the handler still gets the url', async () => {
    const { client, linking, tap } = setup({ client: { deepLinkAllowList: ['myapp://'] } })
    const handler = jest.fn()
    client.onNotificationOpened(handler)

    tap({ notificationId: '1', url: 'myapp://orders/1' })
    await flushPromises()

    expect(linking.openURL).not.toHaveBeenCalled()
    expect(handler.mock.calls[0][0].url).toBe('myapp://orders/1')
  })

  it('never opens a link when handleDeepLinks is not exactly true', async () => {
    for (const flag of [undefined, false, 'true', 1]) {
      const { linking, tap } = setup({ client: { handleDeepLinks: flag, deepLinkAllowList: ['myapp://'] } })
      tap({ notificationId: '1', url: 'myapp://orders/1' })
      await flushPromises()
      expect(linking.openURL).not.toHaveBeenCalled()
    }
  })
})

describe('an allowed link opens once (DLK-02)', () => {
  it.each([
    ['a custom scheme written as myapp://', 'myapp://orders/1042?tab=items'],
    ['a custom scheme in capitals', 'MYAPP://orders/1'],
    ['an HTTPS URL on a listed host', 'https://shop.example.com/orders/1042'],
    ['the listed host in capitals', 'https://SHOP.Example.com/x'],
  ])('%s', async (_name, url) => {
    const { linking, tap } = setup({ client: OPT_IN })
    tap({ notificationId: '1', url })
    await flushPromises()
    expect(linking.openURL).toHaveBeenCalledTimes(1)
    expect(linking.openURL).toHaveBeenCalledWith(url)
  })

  it('accepts a scheme entry written as myapp: and as a bare HTTPS origin with a port', async () => {
    const { linking, tap } = setup({ client: { handleDeepLinks: true, deepLinkAllowList: ['other:', 'https://dev.example.com:8443'] } })
    tap({ notificationId: '1', url: 'other:thing/1' })
    tap({ notificationId: '2', url: 'https://dev.example.com:8443/a' })
    tap({ notificationId: '3', url: 'https://dev.example.com/a' })
    await flushPromises()
    expect(linking.openURL.mock.calls.map(([u]: [string]) => u)).toEqual(['other:thing/1', 'https://dev.example.com:8443/a'])
  })

  it('opens the link after the handler ran, and the handler sees the same url', async () => {
    const order: string[] = []
    const { client, linking, tap } = setup({ client: OPT_IN })
    linking.openURL.mockImplementation(async () => { order.push('open') })
    client.onNotificationOpened(() => { order.push('handler') })
    tap({ notificationId: '1', url: 'myapp://orders/1' })
    await flushPromises()
    expect(order).toEqual(['handler', 'open'])
  })

  it('opens the link of the tap that launched the app even when no handler exists', async () => {
    const { linking, tap } = setup({ client: OPT_IN })
    tap({ notificationId: '1', url: 'myapp://orders/1' })
    await flushPromises()
    expect(linking.openURL).toHaveBeenCalledTimes(1)
  })
})

describe('what is not in the allow-list is not opened (DLK-03)', () => {
  it.each([
    ['a scheme that is not listed', 'otherapp://x'],
    ['an HTTPS host that is not listed', 'https://evil.example.org/x'],
    ['a host that only starts like the listed one', 'https://shop.example.com.evil.org/x'],
    ['a subdomain of the listed host', 'https://a.shop.example.com/x'],
    ['plain http on the listed host', 'http://shop.example.com/x'],
  ])('%s', async (_name, url) => {
    const { linking, tap } = setup({ client: OPT_IN })
    tap({ notificationId: '1', url })
    await flushPromises()
    expect(linking.openURL).not.toHaveBeenCalled()
  })

  it.each([[undefined], [[]]])('opens nothing when the allow-list is %p', async (list) => {
    const { linking, tap } = setup({ client: { handleDeepLinks: true, deepLinkAllowList: list } })
    tap({ notificationId: '1', url: 'myapp://orders/1' })
    await flushPromises()
    expect(linking.openURL).not.toHaveBeenCalled()
  })

  it('logs one warning per run, and no URL in it', async () => {
    const { linking, tap } = setup({ client: OPT_IN })
    tap({ notificationId: '1', url: 'otherapp://secret-token-123' })
    tap({ notificationId: '2', url: 'otherapp://secret-token-456' })
    await flushPromises()
    expect(linking.openURL).not.toHaveBeenCalled()
    const lines = warn.mock.calls.map((c) => String(c[0]))
    expect(lines.filter((l) => l.includes('deepLinkAllowList'))).toHaveLength(1)
    expect(lines.join('\n')).not.toContain('secret-token')
  })

  it('ignores an entry of the allow-list that is neither a scheme nor an HTTPS origin', async () => {
    const { linking, tap } = setup({ client: { handleDeepLinks: true, deepLinkAllowList: ['shop.example.com', 'https://shop.example.com/path', '*', ''] } })
    tap({ notificationId: '1', url: 'https://shop.example.com/path' })
    tap({ notificationId: '2', url: 'shop.example.com' })
    await flushPromises()
    expect(linking.openURL).not.toHaveBeenCalled()
  })
})

describe('what is never opened, even when the allow-list names it (DLK-04)', () => {
  const everything = ['javascript:', 'data:', 'file:', 'vbscript:', 'blob:', 'about:', 'intent:', 'content:', 'javascript://', 'data://']
  it.each([
    ['javascript:alert(1)'],
    ['JavaScript:alert(1)'],
    ['data:text/html;base64,PHNjcmlwdD4='],
    ['DATA:text/html,x'],
    ['file:///etc/passwd'],
    ['FILE:///etc/passwd'],
    ['vbscript:msgbox'],
    ['blob:https://x/abc'],
    ['about:blank'],
    ['intent://scan/#Intent;scheme=zxing;end'],
    ['content://com.android.contacts/contacts'],
  ])('%s', async (url) => {
    const { linking, tap } = setup({ client: { handleDeepLinks: true, deepLinkAllowList: everything } })
    tap({ notificationId: '1', url })
    await flushPromises()
    expect(linking.openURL).not.toHaveBeenCalled()
  })

  it.each([
    ['a URL over 2048 characters', 'myapp://' + 'a'.repeat(2041)],
    ['a space in the URL', 'myapp://orders/1 2'],
    ['a newline in the URL', 'myapp://orders/1\n2'],
    ['a tab in the URL', 'myapp://orders/1\t2'],
    ['a NUL in the URL', 'myapp://orders/1\u00002'],
    ['credentials in an HTTPS URL', 'https://user:pass@shop.example.com/x'],
    ['a user name in an HTTPS URL', 'https://shop.example.com@evil.org/x'],
    ['a URL with no scheme', '/orders/1'],
    ['a scheme-relative URL', '//shop.example.com/x'],
  ])('%s', async (_name, url) => {
    const { linking, tap } = setup({ client: OPT_IN })
    tap({ notificationId: '1', url })
    await flushPromises()
    expect(linking.openURL).not.toHaveBeenCalled()
  })

  it('refuses credentials in an HTTPS URL even when every HTTPS URL is allowed', async () => {
    const { linking, tap } = setup({ client: { handleDeepLinks: true, deepLinkAllowList: ['https://'] } })
    tap({ notificationId: '1', url: 'https://user:pass@shop.example.com/x' })
    tap({ notificationId: '2', url: 'https://shop.example.com@evil.org/x' })
    tap({ notificationId: '3', url: 'https://shop.example.com/x' })
    await flushPromises()
    expect(linking.openURL.mock.calls.map(([u]: [string]) => u)).toEqual(['https://shop.example.com/x'])
  })

  it('accepts a URL of exactly 2048 characters', async () => {
    const { linking, tap } = setup({ client: OPT_IN })
    tap({ notificationId: '1', url: 'myapp://' + 'a'.repeat(2040) })
    await flushPromises()
    expect(linking.openURL).toHaveBeenCalledTimes(1)
  })
})

describe('only a tap on the notification itself opens the link (DLK-05)', () => {
  it('does not open it for an action button', async () => {
    const { linking, tap } = setup({ client: OPT_IN })
    tap({ notificationId: '1', url: 'myapp://orders/1' }, 'reply')
    await flushPromises()
    expect(linking.openURL).not.toHaveBeenCalled()
  })
})

describe('a failure of the opener ends there (DLK-06)', () => {
  it('swallows a throw and a rejection of openURL', async () => {
    const { client, linking, tap } = setup({ client: OPT_IN })
    const handler = jest.fn()
    client.onNotificationOpened(handler)

    linking.openURL.mockImplementationOnce(() => { throw new Error('no activity') })
    tap({ notificationId: '1', url: 'myapp://orders/1' })
    linking.openURL.mockImplementationOnce(() => Promise.reject(new Error('no handler')))
    tap({ notificationId: '2', url: 'myapp://orders/2' })
    await flushPromises()

    expect(handler).toHaveBeenCalledTimes(2)
    // Two taps in one tick are two `opened` events: they may share one request of the batch route (T40).
    const tracked = fetchMock.mock.calls.flatMap(([u, init]) => {
      if (String(u).endsWith('/v1/notifications/track')) return [JSON.parse(init.body)]
      if (String(u).endsWith('/v1/notifications/track/batch')) return JSON.parse(init.body).events
      return []
    })
    expect(tracked.map((e) => e.notification_id)).toEqual([1, 2])
  })

  it('does nothing when react-native has no Linking', async () => {
    const { client, tap } = setup({ client: OPT_IN, linking: undefined })
    const handler = jest.fn()
    client.onNotificationOpened(handler)
    expect(() => tap({ notificationId: '1', url: 'myapp://orders/1' })).not.toThrow()
    await flushPromises()
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('a handler that throws does not stop the link', async () => {
    const { client, linking, tap } = setup({ client: OPT_IN })
    client.onNotificationOpened(() => { throw new Error('boom') })
    tap({ notificationId: '1', url: 'myapp://orders/1' })
    await flushPromises()
    expect(linking.openURL).toHaveBeenCalledTimes(1)
  })
})

describe('a tap without a usable url opens nothing (DLK-07)', () => {
  it.each([[undefined], [''], [42], [{ a: 1 }], [null]])('url = %p', async (url) => {
    const { linking, tap } = setup({ client: OPT_IN })
    tap({ notificationId: '1', url })
    await flushPromises()
    expect(linking.openURL).not.toHaveBeenCalled()
  })
})

// A module, so that its top-level names do not clash with the other test files that are scripts.
export {}
