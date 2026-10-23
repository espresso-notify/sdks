/**
 * @jest-environment node
 *
 * send-scale T39: the client hands the hooks a tracker over the store of the offline queue, with the app version of the
 * device in every fingerprint, and a key of its own per project.
 */
class FakeStore {
  readonly map = new Map<string, string>()
  async getItem(key: string) { return this.map.get(key) ?? null }
  async setItem(key: string, value: string) { this.map.set(key, value) }
}

function boot(appVersion: string, projectId = 'pk_live_reg-test') {
  jest.resetModules()
  jest.doMock('react-native', () => ({ Platform: { OS: 'ios' }, AppState: null }), { virtual: true })
  const sdk = require('../src/index')
  const store = new FakeStore()
  const client = new sdk.PushClient({
    projectId, pushToken: 'ExponentPushToken[c]', platform: 'ios', transport: { request: jest.fn() }, autoTrack: false,
    _queueStore: store,
    deviceInfo: { collect: () => ({ meta: {}, appVersion, osVersion: '17' }) },
  })
  return { client, store }
}

describe('PushClient.registration', () => {
  it('writes under a key of its own per project, in the store of the queue', async () => {
    const { client, store } = boot('1.0.0')
    const parts = { token: 'ExponentPushToken[c]', userId: null }
    const ticket = await client.registration.plan('register', parts)
    await client.registration.commit(ticket!)
    expect([...store.map.keys()].filter((k) => k.startsWith('espresso.registration'))).toEqual(['espresso.registration.pk_live_reg-test'])
  })

  it('puts the app version of the device into the fingerprint', async () => {
    const parts = { token: 'ExponentPushToken[c]', userId: null }
    const a = boot('1.0.0')
    const b = boot('1.0.1')
    const ticketA = await a.client.registration.plan('register', parts)
    const ticketB = await b.client.registration.plan('register', parts)
    expect(ticketA!.fingerprint).not.toBe(ticketB!.fingerprint)
  })

  it('keeps the projects apart', async () => {
    const one = boot('1.0.0', 'pk_live_one-project')
    const two = boot('1.0.0', 'pk_live_two-project')
    const parts = { token: 'ExponentPushToken[c]', userId: null }
    await one.client.registration.commit((await one.client.registration.plan('register', parts))!)
    expect([...two.store.map.keys()].filter((k) => k.startsWith('espresso.registration'))).toEqual([])
  })
})

// A module, not a script: ts-jest type-checks script files in one shared scope, where two of them declaring the same
// top-level name fail to compile.
export {};
