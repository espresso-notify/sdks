/**
 * @jest-environment jsdom
 *
 * Token rotation keeps the user and the metadata of the hook, and the `subscription` lifecycle event leaves only
 * after the new token is registered (and identified): acceptance defects D-A and D-B of 2026-10-16.
 */
import { renderHook, act, waitFor } from '@testing-library/react'
import { usePushNotifications } from '../src/hooks'

const calls: string[] = []
const mockRegister        = jest.fn()
const mockIdentify        = jest.fn()
const mockUnregister      = jest.fn()
const mockRecordLifecycle = jest.fn()
const mockDestroy         = jest.fn()

let _token: string | undefined
let _provider: string | undefined

jest.mock('../src/index', () => ({
  PushClient: jest.fn().mockImplementation((config: any) => {
    _token = config.pushToken
    _provider = config.provider
    return {
      get pushToken() { return _token },
      set pushToken(v: string | undefined) { _token = v },
      get provider() { return _provider },
      set provider(v: string | undefined) { _provider = v },
      devices: {
        register: mockRegister,
        identify: mockIdentify,
        unregister: mockUnregister,
        recordLifecycle: mockRecordLifecycle,
      },
      destroy: mockDestroy,
    }
  }),
  resolvePushProvider: jest.fn(() => null),
}))

jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
}), { virtual: true })

type Deferred = { promise: Promise<unknown>; resolve: (v?: unknown) => void; reject: (e: unknown) => void }
function deferred(): Deferred {
  let resolve!: (v?: unknown) => void
  let reject!: (e: unknown) => void
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function makeProvider() {
  let refresh: ((tok: any) => void) | null = null
  const provider = {
    requestPermissions: jest.fn().mockResolvedValue('granted'),
    getToken: jest.fn().mockResolvedValue({ token: 'ExponentPushToken[old]', provider: 'expo' }),
    onTokenRefresh: jest.fn((cb: (tok: any) => void) => { refresh = cb; return jest.fn() }),
    getPermissionStatus: jest.fn().mockResolvedValue('granted'),
  }
  return { provider, rotate: (token: string) => refresh!({ token, provider: 'expo' }) }
}

beforeEach(() => {
  jest.clearAllMocks()
  calls.length = 0
  _token = undefined
  _provider = undefined
  mockRegister.mockImplementation(async () => { calls.push('register'); return { success: true } })
  mockIdentify.mockImplementation(async () => { calls.push('identify'); return { success: true } })
  mockUnregister.mockResolvedValue({ success: true })
  mockRecordLifecycle.mockImplementation(async () => { calls.push('lifecycle') })
})

describe('token rotation keeps the identity of the hook (D-A)', () => {
  it('registers the new token with the metadata of the hook and identifies the current user right after', async () => {
    const { provider, rotate } = makeProvider()
    const { result } = renderHook(() =>
      usePushNotifications({
        projectId: 'pk_test', provider: provider as any,
        externalId: 'user-7', userName: 'Ana', metadata: { plan: 'pro' },
      }),
    )
    await waitFor(() => expect(result.current.isReady).toBe(true))
    await waitFor(() => expect(mockIdentify).toHaveBeenCalledTimes(1)) // the first identify, at login
    mockRegister.mockClear(); mockIdentify.mockClear(); calls.length = 0

    await act(async () => { rotate('ExponentPushToken[new]') })

    await waitFor(() => expect(mockRecordLifecycle).toHaveBeenCalledTimes(1))
    expect(mockRegister).toHaveBeenCalledTimes(1)
    expect(mockRegister).toHaveBeenCalledWith({ metadata: { plan: 'pro' }, pushToken: 'ExponentPushToken[new]', provider: 'expo' })
    expect(mockIdentify).toHaveBeenCalledTimes(1)
    expect(mockIdentify).toHaveBeenCalledWith({ externalId: 'user-7', name: 'Ana' }, 'ExponentPushToken[new]')
    expect(calls).toEqual(['register', 'identify', 'lifecycle'])
    expect(mockRecordLifecycle).toHaveBeenCalledWith('subscription', 'ExponentPushToken[old]', 'ExponentPushToken[new]')
  })

  it('sends the identity hash of the user along with the identify of the new token', async () => {
    const { provider, rotate } = makeProvider()
    const { result } = renderHook(() =>
      usePushNotifications({ projectId: 'pk_test', provider: provider as any, externalId: 'user-7', identityHash: 'abc123' }),
    )
    await waitFor(() => expect(result.current.isReady).toBe(true))
    await waitFor(() => expect(mockIdentify).toHaveBeenCalledTimes(1))
    mockIdentify.mockClear()

    await act(async () => { rotate('ExponentPushToken[new]') })

    await waitFor(() => expect(mockIdentify).toHaveBeenCalledTimes(1))
    expect(mockIdentify).toHaveBeenCalledWith({ externalId: 'user-7', identityHash: 'abc123' }, 'ExponentPushToken[new]')
  })

  it('identifies nobody when the app has no user: the new token stays anonymous', async () => {
    const { provider, rotate } = makeProvider()
    const { result } = renderHook(() =>
      usePushNotifications({ projectId: 'pk_test', provider: provider as any, externalId: null }),
    )
    await waitFor(() => expect(result.current.isReady).toBe(true))

    await act(async () => { rotate('ExponentPushToken[new]') })

    await waitFor(() => expect(mockRecordLifecycle).toHaveBeenCalledTimes(1))
    expect(mockIdentify).not.toHaveBeenCalled()
    expect(calls).toEqual(['register', 'register', 'lifecycle'])
  })

  it('uses the user of the moment of the rotation, not the one the hook started with', async () => {
    const { provider, rotate } = makeProvider()
    let externalId: string | null = null
    const { result, rerender } = renderHook(() =>
      usePushNotifications({ projectId: 'pk_test', provider: provider as any, externalId }),
    )
    await waitFor(() => expect(result.current.isReady).toBe(true))
    externalId = 'user-9'
    rerender()
    await waitFor(() => expect(mockIdentify).toHaveBeenCalledTimes(1))
    mockIdentify.mockClear()

    await act(async () => { rotate('ExponentPushToken[new]') })

    await waitFor(() => expect(mockIdentify).toHaveBeenCalledTimes(1))
    expect(mockIdentify).toHaveBeenCalledWith({ externalId: 'user-9' }, 'ExponentPushToken[new]')
  })
})

describe('token rotation orders its calls (D-B)', () => {
  it('records the subscription event only after register and identify finished', async () => {
    const { provider, rotate } = makeProvider()
    const { result } = renderHook(() =>
      usePushNotifications({ projectId: 'pk_test', provider: provider as any, externalId: 'user-7' }),
    )
    await waitFor(() => expect(result.current.isReady).toBe(true))
    await waitFor(() => expect(mockIdentify).toHaveBeenCalledTimes(1))
    mockRegister.mockClear(); mockIdentify.mockClear(); calls.length = 0

    const reg = deferred()
    const ident = deferred()
    mockRegister.mockImplementationOnce(() => reg.promise)
    mockIdentify.mockImplementationOnce(() => ident.promise)

    await act(async () => { rotate('ExponentPushToken[new]') })
    await new Promise((r) => setTimeout(r, 20))
    // register is still pending: neither identify nor the lifecycle event may have gone out
    expect(mockRegister).toHaveBeenCalledTimes(1)
    expect(mockIdentify).not.toHaveBeenCalled()
    expect(mockRecordLifecycle).not.toHaveBeenCalled()

    await act(async () => { reg.resolve({ success: true }) })
    await waitFor(() => expect(mockIdentify).toHaveBeenCalledTimes(1))
    expect(mockRecordLifecycle).not.toHaveBeenCalled()

    await act(async () => { ident.resolve({ success: true }) })
    await waitFor(() => expect(mockRecordLifecycle).toHaveBeenCalledTimes(1))
    expect(mockRecordLifecycle).toHaveBeenCalledWith('subscription', 'ExponentPushToken[old]', 'ExponentPushToken[new]')
  })

  it('keeps the client on the old token until the new one is registered, then moves it', async () => {
    const { provider, rotate } = makeProvider()
    const { result } = renderHook(() =>
      usePushNotifications({ projectId: 'pk_test', provider: provider as any }),
    )
    await waitFor(() => expect(result.current.isReady).toBe(true))
    const reg = deferred()
    mockRegister.mockImplementationOnce(() => reg.promise)

    await act(async () => { rotate('ExponentPushToken[new]') })
    expect(_token).toBe('ExponentPushToken[old]')
    expect(result.current.pushToken).toBe('ExponentPushToken[new]') // the hook state follows at once

    await act(async () => { reg.resolve({ success: true }) })
    await waitFor(() => expect(_token).toBe('ExponentPushToken[new]'))
  })

  it('moves the client to the new token even when register failed (a later register call needs it)', async () => {
    const { provider, rotate } = makeProvider()
    const { result } = renderHook(() =>
      usePushNotifications({ projectId: 'pk_test', provider: provider as any }),
    )
    await waitFor(() => expect(result.current.isReady).toBe(true))
    mockRegister.mockRejectedValueOnce(new Error('offline'))

    await act(async () => { rotate('ExponentPushToken[new]') })

    await waitFor(() => expect(_token).toBe('ExponentPushToken[new]'))
  })

  it('still records the event when register fails, and skips the identify that would be refused', async () => {
    const { provider, rotate } = makeProvider()
    const { result } = renderHook(() =>
      usePushNotifications({ projectId: 'pk_test', provider: provider as any, externalId: 'user-7' }),
    )
    await waitFor(() => expect(result.current.isReady).toBe(true))
    await waitFor(() => expect(mockIdentify).toHaveBeenCalledTimes(1))
    mockIdentify.mockClear()
    mockRegister.mockRejectedValueOnce(new Error('offline'))

    await act(async () => { rotate('ExponentPushToken[new]') })

    await waitFor(() => expect(mockRecordLifecycle).toHaveBeenCalledTimes(1))
    expect(mockIdentify).not.toHaveBeenCalled()
    expect(result.current.error).toBeNull()
  })

  it('handles two rotations in a row one after the other, each with its own from and to', async () => {
    const { provider, rotate } = makeProvider()
    const { result } = renderHook(() =>
      usePushNotifications({ projectId: 'pk_test', provider: provider as any, externalId: 'user-7' }),
    )
    await waitFor(() => expect(result.current.isReady).toBe(true))
    await waitFor(() => expect(mockIdentify).toHaveBeenCalledTimes(1))
    mockRegister.mockClear(); mockIdentify.mockClear(); calls.length = 0

    const first = deferred()
    mockRegister.mockImplementationOnce(async () => { calls.push('register'); await first.promise })

    await act(async () => { rotate('ExponentPushToken[b]'); rotate('ExponentPushToken[c]') })
    await new Promise((r) => setTimeout(r, 20))
    expect(mockRegister).toHaveBeenCalledTimes(1) // the second waits for the first

    await act(async () => { first.resolve() })
    await waitFor(() => expect(mockRecordLifecycle).toHaveBeenCalledTimes(2))
    expect(calls).toEqual(['register', 'identify', 'lifecycle', 'register', 'identify', 'lifecycle'])
    expect(mockRecordLifecycle).toHaveBeenNthCalledWith(1, 'subscription', 'ExponentPushToken[old]', 'ExponentPushToken[b]')
    expect(mockRecordLifecycle).toHaveBeenNthCalledWith(2, 'subscription', 'ExponentPushToken[b]', 'ExponentPushToken[c]')
    expect(mockRegister).toHaveBeenNthCalledWith(1, { metadata: undefined, pushToken: 'ExponentPushToken[b]', provider: 'expo' })
    expect(mockRegister).toHaveBeenNthCalledWith(2, { metadata: undefined, pushToken: 'ExponentPushToken[c]', provider: 'expo' })
  })

  it('does not run the steps of a rotation after the hook unmounted', async () => {
    const { provider, rotate } = makeProvider()
    const { result, unmount } = renderHook(() =>
      usePushNotifications({ projectId: 'pk_test', provider: provider as any, externalId: 'user-7' }),
    )
    await waitFor(() => expect(result.current.isReady).toBe(true))
    await waitFor(() => expect(mockIdentify).toHaveBeenCalledTimes(1))
    mockIdentify.mockClear()
    const reg = deferred()
    mockRegister.mockImplementationOnce(() => reg.promise)

    await act(async () => { rotate('ExponentPushToken[new]') })
    act(() => { unmount() })
    await act(async () => { reg.resolve({ success: true }) })
    await new Promise((r) => setTimeout(r, 20))

    expect(mockIdentify).not.toHaveBeenCalled()
    expect(mockRecordLifecycle).not.toHaveBeenCalled()
  })
})

describe('an identity change during a rotation waits for the rotation', () => {
  it('identifies the new user only after the rotation registered the new token', async () => {
    const { provider, rotate } = makeProvider()
    let externalId: string | null = 'user-7'
    const { result, rerender } = renderHook(() =>
      usePushNotifications({ projectId: 'pk_test', provider: provider as any, externalId }),
    )
    await waitFor(() => expect(result.current.isReady).toBe(true))
    await waitFor(() => expect(mockIdentify).toHaveBeenCalledTimes(1))
    mockIdentify.mockClear(); calls.length = 0
    const reg = deferred()
    mockRegister.mockImplementationOnce(async () => { calls.push('register'); await reg.promise })

    await act(async () => { rotate('ExponentPushToken[new]') })
    externalId = 'user-8'
    rerender()
    await new Promise((r) => setTimeout(r, 20))
    expect(mockIdentify).not.toHaveBeenCalled() // the register of the rotation is still pending

    await act(async () => { reg.resolve() })
    await waitFor(() => expect(mockIdentify).toHaveBeenCalledTimes(2))
    expect(calls).toEqual(['register', 'identify', 'lifecycle', 'identify'])
    expect(mockIdentify).toHaveBeenLastCalledWith({ externalId: 'user-8' }, 'ExponentPushToken[new]')
  })
})
