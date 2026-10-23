/**
 * @jest-environment node
 *
 * FE-12 (SDKS-05): `enableSigning: true` without the native signer must not be a
 * silent downgrade. The client keeps working (app boot never fails) but logs ONE
 * warning that requests go out unsigned. This file has its own module registry
 * because the signer package has to be absent for every test in it.
 */
jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }), { virtual: true })
jest.mock('expo-notifications', () => ({}), { virtual: true })
jest.mock(
  'react-native-secure-sign',
  () => {
    throw new Error("Cannot find module 'react-native-secure-sign'")
  },
  { virtual: true },
)

import { PushClient } from '../src/index'

const BASE = { projectId: 'pk_live_abcdefghijklmnop', pushToken: 'ExponentPushToken[abc]', platform: 'ios' as const, autoTrack: false }

let warn: jest.SpyInstance
beforeEach(() => {
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => warn.mockRestore())

const secureSignWarnings = () => warn.mock.calls.filter((c) => String(c[0]).includes('react-native-secure-sign'))

describe('enableSigning without react-native-secure-sign (SDKS-05)', () => {
  it('warns that requests go out unsigned, once per process, and does not throw', async () => {
    const fetchMock = jest.fn(async () => ({ ok: true, status: 200, statusText: 'OK', text: async () => '{}' }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const first = new PushClient({ ...BASE, enableSigning: true })
    new PushClient({ ...BASE, enableSigning: true })

    expect(secureSignWarnings()).toHaveLength(1)
    expect(String(secureSignWarnings()[0][0])).toContain('unsigned')

    await first.devices.register({})
    const headers = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>
    expect(headers['X-KM-Signature']).toBeUndefined()
  })

  it('does not warn when signing was not asked for', () => {
    warn.mockClear()
    new PushClient({ ...BASE })
    expect(secureSignWarnings()).toHaveLength(0)
  })
})
