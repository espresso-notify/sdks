/**
 * @jest-environment jsdom
 *
 * send-scale T39 (SCALE-39, D-159): the hook calls `register` and `identify` only when what it sends differs from the
 * last call that worked, or when that call belongs to an earlier session (a cold start, or a return to the foreground
 * after at least 30 seconds out of it). A call that fails is not remembered and is tried again at the next foreground.
 * The client is a fake; the tracker is the real one, over a fake store and a fake clock.
 */
import { renderHook, act, waitFor } from '@testing-library/react'
import { usePushNotifications } from '../src/hooks'
import { EspressoNotifyHttpError } from '../src/errors'

// ─── The store and the clock the trackers share (a cold start is a new tracker over the same store) ───────────────────
const mockStore = {
  map: new Map<string, string>(),
  async getItem(key: string) { return this.map.get(key) ?? null },
  async setItem(key: string, value: string) { this.map.set(key, value) },
}
const mockClock = { now: 1_700_000_000_000 }

const mockRegister   = jest.fn()
const mockIdentify   = jest.fn()
const mockUnregister = jest.fn()
const mockDestroy    = jest.fn()
const mockAttest     = jest.fn()
let mockToken: string | undefined

jest.mock('../src/index', () => ({
  PushClient: jest.fn().mockImplementation((config: any) => {
    const { RegistrationTracker } = jest.requireActual('../src/registration')
    mockToken = config.pushToken
    return {
      get pushToken() { return mockToken },
      set pushToken(v: string | undefined) { mockToken = v },
      provider: undefined,
      registration: new RegistrationTracker(mockStore, 'espresso.registration.pk_test', { now: () => mockClock.now, getAppVersion: () => '1.0.0' }),
      devices: { register: mockRegister, identify: mockIdentify, unregister: mockUnregister, attest: mockAttest, recordLifecycle: jest.fn().mockResolvedValue(undefined) },
      destroy: mockDestroy,
    }
  }),
  resolvePushProvider: jest.fn(() => null),
}))

let appStateCb: ((s: string) => void) | null = null
let appStateCurrent = 'active'
jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  AppState: {
    get currentState() { return appStateCurrent },
    addEventListener: (_e: string, cb: (s: string) => void) => { appStateCb = cb; return { remove: jest.fn() } },
  },
}), { virtual: true })

const http = (status: number) => new EspressoNotifyHttpError(`HTTP ${status}`, status, undefined, '/v1/devices/register')

function makeProvider(token = 'ExponentPushToken[reg-1]') {
  let refresh: ((t: { token: string; provider: 'expo' }) => void) | null = null
  return {
    provider: {
      requestPermissions: async () => 'granted',
      getToken: async () => ({ token, provider: 'expo' as const }),
      onTokenRefresh: (cb: any) => { refresh = cb; return jest.fn() },
      getPermissionStatus: async () => 'granted',
    },
    rotate: (t: string) => refresh?.({ token: t, provider: 'expo' }),
  }
}

/** The app goes to the background, `seconds` pass, and it comes back. */
async function leaveAndReturn(seconds: number) {
  await act(async () => { appStateCurrent = 'background'; appStateCb?.('background') })
  mockClock.now += seconds * 1000
  await act(async () => { appStateCurrent = 'active'; appStateCb?.('active') })
  await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
}

beforeEach(() => {
  jest.clearAllMocks()
  mockStore.map.clear()
  mockClock.now = 1_700_000_000_000
  appStateCb = null
  appStateCurrent = 'active'
  mockRegister.mockReset().mockResolvedValue({ success: true })
  mockIdentify.mockReset().mockResolvedValue({ success: true })
  mockUnregister.mockReset().mockResolvedValue({ success: true })
  mockAttest.mockReset().mockResolvedValue(undefined)
})

async function mount(props: Record<string, unknown> = {}) {
  const { provider, rotate } = makeProvider()
  const hook = renderHook((p: Record<string, unknown>) => usePushNotifications({ projectId: 'pk_test', provider: provider as any, ...p }), { initialProps: props })
  await waitFor(() => expect(hook.result.current.isReady).toBe(true))
  return { ...hook, rotate, provider }
}

describe('the foreground', () => {
  it('two foregrounds 10 s apart send one register and one identify', async () => {
    await mount({ externalId: 'u1' })
    await waitFor(() => expect(mockIdentify).toHaveBeenCalledTimes(1))
    expect(mockRegister).toHaveBeenCalledTimes(1)

    await leaveAndReturn(10)
    await leaveAndReturn(10)

    expect(mockRegister).toHaveBeenCalledTimes(1)
    expect(mockIdentify).toHaveBeenCalledTimes(1)
  })

  it('a return after 31 s in the background sends one of each', async () => {
    await mount({ externalId: 'u1' })
    await waitFor(() => expect(mockIdentify).toHaveBeenCalledTimes(1))

    await leaveAndReturn(31)

    expect(mockRegister).toHaveBeenCalledTimes(2)
    expect(mockIdentify).toHaveBeenCalledTimes(2)
    expect(mockIdentify).toHaveBeenLastCalledWith({ externalId: 'u1' }, 'ExponentPushToken[reg-1]')

    await leaveAndReturn(5) // the new session is remembered: a short return sends nothing
    expect(mockRegister).toHaveBeenCalledTimes(2)
    expect(mockIdentify).toHaveBeenCalledTimes(2)
  })

  it('an anonymous device registers on a new session and identifies nothing', async () => {
    await mount()
    await leaveAndReturn(40)
    expect(mockRegister).toHaveBeenCalledTimes(2)
    expect(mockIdentify).not.toHaveBeenCalled()
  })

  it('sends nothing on a foreground before the first register worked', async () => {
    let release: () => void = () => {}
    mockRegister.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({}) }))
    const { provider } = makeProvider()
    const hook = renderHook(() => usePushNotifications({ projectId: 'pk_test', provider: provider as any }))
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    await leaveAndReturn(40)
    expect(mockRegister).toHaveBeenCalledTimes(1) // the first one is still on its way
    await act(async () => { release() })
    await waitFor(() => expect(hook.result.current.isReady).toBe(true))
  })
})

describe('a change of what is sent', () => {
  it('a changed user is identified at once', async () => {
    const { rerender } = await mount({ externalId: 'u1' })
    await waitFor(() => expect(mockIdentify).toHaveBeenCalledTimes(1))

    rerender({ externalId: 'u2' })

    await waitFor(() => expect(mockIdentify).toHaveBeenCalledTimes(2))
    expect(mockIdentify).toHaveBeenLastCalledWith({ externalId: 'u2' }, 'ExponentPushToken[reg-1]')
  })

  it('a changed name of the same user is identified again', async () => {
    const { rerender } = await mount({ externalId: 'u1', userName: 'Ana' })
    await waitFor(() => expect(mockIdentify).toHaveBeenCalledTimes(1))
    rerender({ externalId: 'u1', userName: 'Ana B' })
    await waitFor(() => expect(mockIdentify).toHaveBeenCalledTimes(2))
  })

  it('a changed token registers and identifies the new one, and the new state is remembered', async () => {
    const { rotate } = await mount({ externalId: 'u1' })
    await waitFor(() => expect(mockIdentify).toHaveBeenCalledTimes(1))

    await act(async () => { rotate('ExponentPushToken[reg-2]') })
    await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(mockIdentify).toHaveBeenCalledTimes(2))
    expect(mockRegister).toHaveBeenLastCalledWith(expect.objectContaining({ pushToken: 'ExponentPushToken[reg-2]' }))

    await leaveAndReturn(10)
    expect(mockRegister).toHaveBeenCalledTimes(2)
    expect(mockIdentify).toHaveBeenCalledTimes(2)
  })

  it('logging out and in again as the same user in one session identifies again', async () => {
    const { rerender } = await mount({ externalId: 'u1' })
    await waitFor(() => expect(mockIdentify).toHaveBeenCalledTimes(1))

    rerender({ externalId: null })
    await waitFor(() => expect(mockUnregister).toHaveBeenCalledTimes(1))
    rerender({ externalId: 'u1' })

    await waitFor(() => expect(mockIdentify).toHaveBeenCalledTimes(2))
  })
})

describe('a call that fails', () => {
  it('a failed identify is not remembered and is tried again at the next foreground', async () => {
    mockIdentify.mockRejectedValueOnce(http(403))
    await mount({ externalId: 'u1' })
    await waitFor(() => expect(mockIdentify).toHaveBeenCalledTimes(1))

    await leaveAndReturn(5) // the same session: a call that worked would be skipped, this one did not work

    expect(mockIdentify).toHaveBeenCalledTimes(2)
    expect(mockRegister).toHaveBeenCalledTimes(1)
    await leaveAndReturn(5)
    expect(mockIdentify).toHaveBeenCalledTimes(2) // now it worked: remembered
  })

  it('a register that failed for good sets the error, and the next foreground registers again and turns ready', async () => {
    mockRegister.mockRejectedValueOnce(http(400))
    const { provider } = makeProvider()
    const hook = renderHook(() => usePushNotifications({ projectId: 'pk_test', provider: provider as any }))
    await waitFor(() => expect(hook.result.current.error).not.toBeNull())
    expect(hook.result.current.isReady).toBe(false)

    await leaveAndReturn(5)

    await waitFor(() => expect(hook.result.current.isReady).toBe(true))
    expect(hook.result.current.error).toBeNull()
    expect(mockRegister).toHaveBeenCalledTimes(2)
  })

  it('a foreground while the register keeps failing for good tries once per foreground, without a second client', async () => {
    mockRegister.mockRejectedValue(http(400))
    const { provider } = makeProvider()
    const { PushClient } = require('../src/index')
    const hook = renderHook(() => usePushNotifications({ projectId: 'pk_test', provider: provider as any }))
    await waitFor(() => expect(hook.result.current.error).not.toBeNull())

    await leaveAndReturn(5)
    await leaveAndReturn(5)

    expect(mockRegister).toHaveBeenCalledTimes(3)
    expect(PushClient).toHaveBeenCalledTimes(1)
    expect(hook.result.current.error).not.toBeNull()
  })
})

describe('a new run of the app', () => {
  it('a cold start registers and identifies again even when nothing changed', async () => {
    const first = await mount({ externalId: 'u1' })
    await waitFor(() => expect(mockIdentify).toHaveBeenCalledTimes(1))
    first.unmount()

    await mount({ externalId: 'u1' }) // same store, a new tracker, a new session
    await waitFor(() => expect(mockIdentify).toHaveBeenCalledTimes(2))
    expect(mockRegister).toHaveBeenCalledTimes(2)
  })

  it('a value left by the previous SDK (or garbage) counts as "changed" once and is not an error', async () => {
    mockStore.map.set('espresso.registration.pk_test', 'registered-by-sdk-0.0.1')
    const { result } = await mount({ externalId: 'u1' })
    await waitFor(() => expect(mockIdentify).toHaveBeenCalledTimes(1))
    expect(mockRegister).toHaveBeenCalledTimes(1)
    expect(result.current.error).toBeNull()
  })
})

describe('a client without a tracker', () => {
  it('registers and identifies as before (the mocks of the other tests of the hook)', async () => {
    const { PushClient } = require('../src/index')
    PushClient.mockImplementationOnce((config: any) => ({
      pushToken: config.pushToken, provider: undefined,
      devices: { register: mockRegister, identify: mockIdentify, unregister: mockUnregister },
      destroy: mockDestroy,
    }))
    const { provider } = makeProvider()
    const { result } = renderHook(() => usePushNotifications({ projectId: 'pk_test', provider: provider as any, externalId: 'u1' }))
    await waitFor(() => expect(result.current.isReady).toBe(true))
    await waitFor(() => expect(mockIdentify).toHaveBeenCalledTimes(1))
    expect(mockRegister).toHaveBeenCalledTimes(1)

    await leaveAndReturn(60) // nothing says what the server has: a foreground does not repeat the calls
    expect(mockRegister).toHaveBeenCalledTimes(1)
    expect(mockIdentify).toHaveBeenCalledTimes(1)
  })
})
