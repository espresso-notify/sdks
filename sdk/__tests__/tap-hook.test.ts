/**
 * @jest-environment jsdom
 *
 * rn-tap-and-offline-queue, T4 (TAP-06): usePushNotifications takes onNotificationOpened and hands the client the
 * latest function the component passed.
 */

import { renderHook, waitFor } from '@testing-library/react'
import { usePushNotifications } from '../src/hooks'

const mockClientConfigs: any[] = []

jest.mock('../src/index', () => ({
  PushClient: jest.fn().mockImplementation((config: any) => {
    mockClientConfigs.push(config)
    return {
      devices: { register: jest.fn().mockResolvedValue({ success: true }), identify: jest.fn(), unregister: jest.fn() },
      destroy: jest.fn(),
    }
  }),
  resolvePushProvider: jest.fn(() => ({
    requestPermissions: async () => 'granted',
    getToken: async () => ({ token: 'ExponentPushToken[hook]', provider: 'expo' }),
  })),
}))

jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }), { virtual: true })

beforeEach(() => { mockClientConfigs.length = 0 })

const event = { notificationId: '1', data: { notificationId: '1' }, url: undefined, actionId: undefined }

describe('usePushNotifications onNotificationOpened', () => {
  it('passes a function to the client that calls the handler of the component (TAP-06)', async () => {
    const handler = jest.fn()
    const { result } = renderHook(() => usePushNotifications({ projectId: 'pk_test', onNotificationOpened: handler }))
    await waitFor(() => expect(result.current.isReady).toBe(true))

    expect(typeof mockClientConfigs[0].onNotificationOpened).toBe('function')
    mockClientConfigs[0].onNotificationOpened(event)
    expect(handler).toHaveBeenCalledWith(event)
  })

  it('calls the latest function after a rerender (TAP-06)', async () => {
    let handler = jest.fn()
    const { result, rerender } = renderHook(() => usePushNotifications({ projectId: 'pk_test', onNotificationOpened: handler }))
    await waitFor(() => expect(result.current.isReady).toBe(true))
    const first = handler
    handler = jest.fn()
    rerender()

    mockClientConfigs[0].onNotificationOpened(event)
    expect(first).not.toHaveBeenCalled()
    expect(handler).toHaveBeenCalledTimes(1)
    expect(mockClientConfigs).toHaveLength(1)
  })

  it('gives the client no handler when the component passed none (TAP-06)', async () => {
    const { result } = renderHook(() => usePushNotifications({ projectId: 'pk_test' }))
    await waitFor(() => expect(result.current.isReady).toBe(true))

    expect(mockClientConfigs[0].onNotificationOpened).toBeUndefined()
  })

  it('passes handleDeepLinks and deepLinkAllowList to the client, and nothing when the component sets none (DLK-08)', async () => {
    const { result } = renderHook(() =>
      usePushNotifications({ projectId: 'pk_test', handleDeepLinks: true, deepLinkAllowList: ['myapp://'] }),
    )
    await waitFor(() => expect(result.current.isReady).toBe(true))
    expect(mockClientConfigs[0]).toMatchObject({ handleDeepLinks: true, deepLinkAllowList: ['myapp://'] })

    mockClientConfigs.length = 0
    const plain = renderHook(() => usePushNotifications({ projectId: 'pk_test' }))
    await waitFor(() => expect(plain.result.current.isReady).toBe(true))
    expect('handleDeepLinks' in mockClientConfigs[0]).toBe(false)
    expect('deepLinkAllowList' in mockClientConfigs[0]).toBe(false)
  })

  it('passes offlineQueue to the client, and nothing when the component sets none (OFQ-14)', async () => {
    const { result } = renderHook(() =>
      usePushNotifications({ projectId: 'pk_test', offlineQueue: { enabled: false, maxItems: 10 } }),
    )
    await waitFor(() => expect(result.current.isReady).toBe(true))
    expect(mockClientConfigs[0].offlineQueue).toEqual({ enabled: false, maxItems: 10 })

    mockClientConfigs.length = 0
    const plain = renderHook(() => usePushNotifications({ projectId: 'pk_test' }))
    await waitFor(() => expect(plain.result.current.isReady).toBe(true))
    expect('offlineQueue' in mockClientConfigs[0]).toBe(false)
  })
})
