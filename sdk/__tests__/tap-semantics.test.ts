/**
 * @jest-environment jsdom
 *
 * sdk-parity T26 (PAR-18, PAR-19): a tap on the body of a push is one `opened`, a tap on an action button is one
 * `clicked` that carries the button as `action_id`, and a tap never counts as both.
 *
 * feature: tracking.tap-semantics
 */

const flushPromises = () => new Promise((r) => setTimeout(r, 0))
const DEFAULT_ACTION = 'expo.modules.notifications.actions.DEFAULT'
const TRACK = '/v1/notifications/track'
const BATCH = '/v1/notifications/track/batch'

function response(notificationId: string, action: string) {
  return {
    actionIdentifier: action,
    notification: { date: Math.random(), request: { identifier: `req-${Math.random()}`, content: { data: { notificationId } } } },
  }
}

const fetchMock = jest.fn()

class MemoryStore {
  readonly map = new Map<string, string>()
  async getItem(key: string) { return this.map.get(key) ?? null }
  async setItem(key: string, value: string) { this.map.set(key, value) }
  async removeItem(key: string) { this.map.delete(key) }
  text() { return [...this.map.values()].join('\n') }
}

function setup(client: Record<string, unknown> = {}) {
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
  jest.doMock('react-native', () => ({ Platform: { OS: 'ios', Version: 17 }, AppState: null, Linking: null }), { virtual: true })
  const sdk = require('../src/index')
  const c = new sdk.PushClient({ projectId: 'pk_live_test', pushToken: 'tok', platform: 'ios', ...client })
  return { c, tap: (id: string, action: string = DEFAULT_ACTION) => listeners.forEach((l) => l(response(id, action))) }
}

/** The bodies sent to the single and batch track routes, in order, with the route. */
function tracked() {
  return fetchMock.mock.calls
    .filter(([url]) => String(url).endsWith(TRACK) || String(url).endsWith(BATCH))
    .map(([url, init]) => ({ route: String(url).endsWith(BATCH) ? 'batch' : 'single', body: JSON.parse(init.body) }))
}

beforeEach(() => jest.spyOn(console, 'warn').mockImplementation(() => {}))
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers() })

describe('what a tap sends (PAR-18, PAR-19)', () => {
  it('a tap on the body is one opened, with no action_id and no clicked', async () => {
    const { tap } = setup()
    tap('42')
    await flushPromises()

    expect(tracked()).toEqual([{ route: 'single', body: { notification_id: 42, event: 'opened', push_token: 'tok' } }])
  })

  it('a tap on a button is one clicked with the id of the button and no opened', async () => {
    const { tap } = setup()
    tap('42', 'reply')
    await flushPromises()

    expect(tracked()).toEqual([{ route: 'single', body: { notification_id: 42, event: 'clicked', push_token: 'tok', action_id: 'reply' } }])
  })

  it('the body and then a button give one opened and one clicked, in that order', async () => {
    const { tap } = setup()
    tap('1')
    await flushPromises()
    tap('2', 'archive')
    await flushPromises()

    expect(tracked().map((t) => [t.body.notification_id, t.body.event, t.body.action_id])).toEqual([
      [1, 'opened', undefined],
      [2, 'clicked', 'archive'],
    ])
  })

  it('autoTrack off sends nothing for either tap', async () => {
    const { tap } = setup({ autoTrack: false })
    tap('1')
    tap('2', 'reply')
    await flushPromises()

    expect(tracked()).toEqual([])
  })
})

describe('Devices.trackClick (PAR-19)', () => {
  it('sends the action id the app passes, beside the token of a call', async () => {
    const { c } = setup({ autoTrack: false })
    await c.devices.trackClick(7, 'other-tok', 'snooze')

    expect(tracked()).toEqual([{ route: 'single', body: { notification_id: 7, event: 'clicked', push_token: 'other-tok', action_id: 'snooze' } }])
  })

  it('still counts the click, without the id, when there is none or the server would refuse it', async () => {
    const { c } = setup({ autoTrack: false })
    await c.devices.trackClick(1)
    await c.devices.trackClick(2, undefined, '')
    await c.devices.trackClick(3, undefined, 'x'.repeat(65))
    await c.devices.trackClick(4, undefined, 'a\u0007b')
    await c.devices.trackClick(5, undefined, 'a‍b')

    expect(tracked().map((t) => t.body)).toEqual([1, 2, 3, 4, 5].map((id) => ({ notification_id: id, event: 'clicked', push_token: 'tok' })))
  })

  it('keeps an id of 64 characters, counted as characters and not as bytes', async () => {
    const { c } = setup({ autoTrack: false })
    const id = '\u{1F600}'.repeat(64)
    await c.devices.trackClick(1, undefined, id)

    expect(tracked()[0].body.action_id).toBe(id)
  })

  it('carries the id in the batch member when the click goes with another event', async () => {
    jest.useFakeTimers({ now: 1_700_000_000_000 })
    const { c } = setup({ autoTrack: false })
    await c.devices.trackReceived(10) // waits its random delay
    jest.setSystemTime(1_700_000_000_000 + 31_000) // past the delay, without letting the timer run
    await c.devices.trackClick(11, undefined, 'open_chat')

    expect(tracked()).toEqual([
      {
        route: 'batch',
        body: {
          push_token: 'tok',
          events: [
            { notification_id: 10, event: 'received' },
            { notification_id: 11, event: 'clicked', action_id: 'open_chat' },
          ],
        },
      },
    ])
  })

  it('keeps the id when the click waits in the offline queue and is sent again', async () => {
    const store = new MemoryStore()
    const { c } = setup({ autoTrack: false, _queueStore: store })
    fetchMock.mockRejectedValue(new TypeError('Network request failed'))
    await c.devices.trackClick(9, undefined, 'reply')
    expect(await c.queueStats()).toEqual({ pending: 1, dropped: 0 })
    expect(store.text()).toContain('"action_id":"reply"') // a button id names no user, so the store may hold it

    fetchMock.mockReset()
    fetchMock.mockResolvedValue({ ok: true, text: async () => '' })
    await c.flush()

    expect(tracked()).toEqual([{ route: 'single', body: { notification_id: 9, event: 'clicked', push_token: 'tok', action_id: 'reply' } }])
    expect(await c.queueStats()).toEqual({ pending: 0, dropped: 0 })
  })
})

// feature: tracking.auto-track
