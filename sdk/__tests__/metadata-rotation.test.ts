/**
 * @jest-environment jsdom
 *
 * feature: metadata.register-merge
 *
 * sdk-parity T63 (PAR-11, RN half): a device registers, the app calls `updateMetadata`, then the push token rotates.
 * The server keeps the `updateMetadata` keys only if the rotation register names the same device (`device_id`) and
 * does not send a `null` for a key the app set (a `null` removes the key, PAR-08). The server half is proved by the
 * Postgres race test of T2; here the REAL client runs and only `fetch` and the provider are fake.
 */
import { renderHook, act, waitFor } from '@testing-library/react'
import { usePushNotifications } from '../src/hooks'

jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
}), { virtual: true })
jest.mock('expo-notifications', () => ({}), { virtual: true })

interface Call { path: string; method: string; body: any }
let calls: Call[]

function installFetch() {
  calls = []
  globalThis.fetch = jest.fn(async (url: unknown, init: RequestInit = {}) => {
    calls.push({
      path: String(url).replace(/^.*(?=\/v1\/)/, ''),
      method: String(init.method ?? 'GET'),
      body: typeof init.body === 'string' && init.body ? JSON.parse(init.body) : undefined,
    })
    return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ success: true }) }
  }) as unknown as typeof fetch
}

function makeProvider() {
  let refresh: ((tok: { token: string; provider: 'expo' }) => void) | null = null
  const provider = {
    requestPermissions: jest.fn().mockResolvedValue('granted'),
    getToken: jest.fn().mockResolvedValue({ token: 'ExponentPushToken[old]', provider: 'expo' }),
    onTokenRefresh: jest.fn((cb: any) => { refresh = cb; return jest.fn() }),
    getPermissionStatus: jest.fn().mockResolvedValue('granted'),
  }
  return { provider, rotate: (token: string) => refresh!({ token, provider: 'expo' }) }
}

const registers = () => calls.filter((c) => c.path === '/v1/devices/register')

beforeEach(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => {})
  installFetch()
})
afterEach(() => jest.restoreAllMocks())

describe('rotation after updateMetadata (PAR-11, RN half)', () => {
  it('re-registers the same device and sends no null for the keys the app set', async () => {
    const { provider, rotate } = makeProvider()
    const { result } = renderHook(() =>
      usePushNotifications({ projectId: 'pk_live_abcdefghijklmnop', provider: provider as any, metadata: { plan: 'pro' } }),
    )
    await waitFor(() => expect(result.current.isReady).toBe(true))
    const first = registers()[0].body
    expect(first.device_id).toMatch(/^[0-9a-f]{32}$/)

    await act(async () => {
      await result.current.client!.devices.updateMetadata({ theme: 'dark', beta: true })
    })
    const update = calls.find((c) => c.path === '/v1/devices/metadata')!
    expect(update.body.metadata).toEqual({ theme: 'dark', beta: true })

    await act(async () => { rotate('ExponentPushToken[new]') })
    await waitFor(() => expect(registers()).toHaveLength(2))
    const rotation = registers()[1].body

    expect(rotation.pushToken).toBe('ExponentPushToken[new]')
    expect(rotation.device_id).toBe(first.device_id)
    expect(rotation.sdk).toBe('react-native')
    // no key of the request is null, so the merge of the server removes nothing the app set with updateMetadata
    expect(Object.values(rotation.metadata ?? {}).some((v) => v === null)).toBe(false)
    expect(rotation.metadata?.plan).toBe('pro')
  })
})
