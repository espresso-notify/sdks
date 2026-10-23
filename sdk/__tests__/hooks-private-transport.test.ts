/**
 * @jest-environment jsdom
 *
 * sdk-private-transport T22 (SPT-08): `usePushNotifications({ privateTransport })` reaches the client the hook builds.
 *
 * The REAL PushClient runs (only the url is given, because the source holds the build placeholder and the native
 * transport refuses a url without a scheme). The native module is a fake that answers `{}` to every request.
 */
import { renderHook, waitFor } from '@testing-library/react'
import { usePushNotifications } from '../src/hooks'

const mockNativeRequest = jest.fn()
let moduleLinked = true

jest.mock(
  'react-native',
  () => ({
    Platform: { OS: 'ios' },
    TurboModuleRegistry: {
      get: (name: string) =>
        name === 'EspressoNotifyTransport' && moduleLinked
          ? {
              getConstants: () => ({ contractVersion: 1 }),
              request: (...args: unknown[]) => mockNativeRequest(...args),
              setPins: jest.fn(),
              clearPins: jest.fn(),
            }
          : null,
    },
  }),
  { virtual: true },
)
jest.mock('expo-notifications', () => ({}), { virtual: true })

// The hook builds its client from `./index`; this subclass gives it a real https base, nothing else.
jest.mock('../src/index', () => {
  const actual = jest.requireActual('../src/index')
  class PushClientWithUrl extends actual.PushClient {
    constructor(config: Record<string, unknown>) {
      super({ ...config, _apiUrl: 'https://api.example.test' })
    }
  }
  return { ...actual, PushClient: PushClientWithUrl }
})

const mockFetch = jest.fn()
const BASE = { projectId: 'pk_live_abcdefghijklmnop', pushToken: 'ExponentPushToken[abc]', platform: 'ios' as const }

beforeEach(() => {
  jest.clearAllMocks()
  moduleLinked = true
  mockNativeRequest.mockResolvedValue({ status: 200, statusText: 'OK', retryAfter: '', body: '{}' })
  mockFetch.mockResolvedValue({ ok: true, status: 200, statusText: 'OK', text: async () => '{}' })
  globalThis.fetch = mockFetch as unknown as typeof fetch
  jest.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => jest.restoreAllMocks())

describe('the privateTransport option of the hook (SPT-08)', () => {
  it("with 'js' the client reports 'js' and sends through fetch even though the module is linked", async () => {
    const { result } = renderHook(() => usePushNotifications({ ...BASE, privateTransport: 'js' }))
    await waitFor(() => expect(result.current.isReady).toBe(true))
    expect(result.current.client!.transportKind).toBe('js')
    expect(mockFetch).toHaveBeenCalled()
    expect(mockNativeRequest).not.toHaveBeenCalled()
  })

  it("without the option the client reports 'native' and sends through the module", async () => {
    const { result } = renderHook(() => usePushNotifications({ ...BASE }))
    await waitFor(() => expect(result.current.isReady).toBe(true))
    expect(result.current.client!.transportKind).toBe('native')
    expect(mockNativeRequest).toHaveBeenCalled()
    expect(mockNativeRequest.mock.calls[0][1]).toBe('https://api.example.test/v1/devices/register')
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it("with 'native' and no usable module the hook reports the refusal as its error and sends nothing", async () => {
    moduleLinked = false
    const { result } = renderHook(() => usePushNotifications({ ...BASE, privateTransport: 'native' }))
    await waitFor(() => expect(result.current.error).not.toBeNull())
    expect((result.current.error as { code?: string }).code).toBe('NATIVE_TRANSPORT_UNAVAILABLE')
    expect(result.current.isReady).toBe(false)
    expect(mockFetch).not.toHaveBeenCalled()
    expect(mockNativeRequest).not.toHaveBeenCalled()
  })

  it('an invalid value surfaces the validation error of the constructor as the error of the hook', async () => {
    const { result } = renderHook(() => usePushNotifications({ ...BASE, privateTransport: 'fast' as never }))
    await waitFor(() => expect(result.current.error).not.toBeNull())
    expect(result.current.error!.message).toBe("❌ Validation Error: 'privateTransport' must be 'auto', 'native' or 'js'.")
    expect(result.current.isReady).toBe(false)
    expect(mockFetch).not.toHaveBeenCalled()
  })
})
