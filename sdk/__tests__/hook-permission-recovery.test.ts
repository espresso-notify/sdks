/**
 * @jest-environment jsdom
 *
 * SDKFIX-04 AC 3 (sdk-launch-fixes): when the first permission answer is not
 * 'granted', the hook keeps the provider and, once the app is active again and
 * the provider reads 'granted', gets the token and registers once.
 */
import { renderHook, act, waitFor } from '@testing-library/react'
import { usePushNotifications } from '../src/hooks'
import type { PushProvider } from '../src/index'

const mockRegister = jest.fn().mockResolvedValue({ success: true })
const mockRecordLifecycle = jest.fn().mockResolvedValue(undefined)

jest.mock('../src/index', () => ({
  PushClient: function () {
    return {
      devices: { register: mockRegister, identify: jest.fn(), unregister: jest.fn(), recordLifecycle: mockRecordLifecycle },
      destroy: jest.fn(),
    }
  },
  resolvePushProvider: jest.fn(() => null),
}))

let listeners: Array<(s: string) => void> = []
let currentState = 'active'
jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  AppState: {
    get currentState() { return currentState },
    addEventListener: (_e: string, cb: (s: string) => void) => {
      listeners.push(cb)
      return { remove: () => { listeners = listeners.filter((l) => l !== cb) } }
    },
  },
}), { virtual: true })

function fire(state: string) {
  currentState = state
  listeners.forEach((l) => l(state))
}

/** The system prompt makes the app inactive; answering it makes it active. */
async function promptAnswered() {
  await act(async () => { fire('inactive') })
  await act(async () => { fire('active') })
}

function makeProvider(request: string, reads: string[]): PushProvider & { getToken: jest.Mock } {
  const queue = [...reads]
  return {
    requestPermissions: jest.fn().mockResolvedValue(request),
    getPermissionStatus: jest.fn(async () => (queue.length > 1 ? queue.shift() : queue[0]) as any),
    getToken: jest.fn().mockResolvedValue({ token: 'ExponentPushToken[late]', provider: 'expo' }),
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  listeners = []
  currentState = 'active'
  mockRegister.mockResolvedValue({ success: true })
})

it('registers once after the provider reads granted on the next active transition', async () => {
  const provider = makeProvider('undetermined', ['granted'])
  const { result } = renderHook(() => usePushNotifications({ projectId: 'pk_test', provider }))

  await waitFor(() => expect(result.current.permissionStatus).toBe('undetermined'))
  expect(result.current.error?.message).toContain('undetermined')
  expect(mockRegister).not.toHaveBeenCalled()

  await promptAnswered()

  await waitFor(() => expect(result.current.isReady).toBe(true))
  expect(result.current.permissionStatus).toBe('granted')
  expect(result.current.error).toBeNull()
  expect(result.current.pushToken).toBe('ExponentPushToken[late]')
  expect(provider.requestPermissions).toHaveBeenCalledTimes(1)
  expect(provider.getToken).toHaveBeenCalledTimes(1)
  expect(mockRegister).toHaveBeenCalledTimes(1)
})

it('does not register twice on two active transitions in a row', async () => {
  const provider = makeProvider('undetermined', ['granted'])
  const { result } = renderHook(() => usePushNotifications({ projectId: 'pk_test', provider }))
  await waitFor(() => expect(result.current.permissionStatus).toBe('undetermined'))

  await promptAnswered()
  await waitFor(() => expect(result.current.isReady).toBe(true))
  await promptAnswered()
  await act(async () => { await Promise.resolve() })

  expect(mockRegister).toHaveBeenCalledTimes(1)
  expect(provider.getToken).toHaveBeenCalledTimes(1)
})

it('stays unregistered and reports denied when the re-read is denied', async () => {
  const provider = makeProvider('undetermined', ['denied'])
  const { result } = renderHook(() => usePushNotifications({ projectId: 'pk_test', provider }))
  await waitFor(() => expect(result.current.permissionStatus).toBe('undetermined'))

  await promptAnswered()

  await waitFor(() => expect(result.current.permissionStatus).toBe('denied'))
  expect(result.current.isReady).toBe(false)
  expect(mockRegister).not.toHaveBeenCalled()
  expect(provider.getToken).not.toHaveBeenCalled()
})

it('recovers later when the user grants it in Settings after a denial', async () => {
  const provider = makeProvider('denied', ['denied', 'granted'])
  const { result } = renderHook(() => usePushNotifications({ projectId: 'pk_test', provider }))
  await waitFor(() => expect(result.current.permissionStatus).toBe('denied'))

  await promptAnswered()
  await act(async () => { await Promise.resolve() })
  expect(mockRegister).not.toHaveBeenCalled()

  await promptAnswered()
  await waitFor(() => expect(result.current.isReady).toBe(true))
  expect(result.current.permissionStatus).toBe('granted')
  expect(mockRegister).toHaveBeenCalledTimes(1)
})
