/**
 * @jest-environment jsdom
 *
 * expo-setup-simpler T5 (ES-08): `expo-notifications` is required in Expo mode. It stays `optional` in
 * `peerDependenciesMeta` (npm 7+ installs non-optional peers by itself, which would push Expo modules into
 * React Native CLI apps), so the hook checks it when it runs and fails with the command that fixes it.
 */
import { renderHook, waitFor } from '@testing-library/react'
import * as React from 'react'
import * as fs from 'fs'
import * as path from 'path'

const ABSENT = () => {
  throw new Error('Cannot find module (absent in this test)')
}

type Installed = {
  constants?: boolean; device?: boolean; application?: boolean; localization?: boolean; firebase?: boolean
  /** `@react-native-firebase/messaging` is there but its require throws this (code MODULE_NOT_FOUND when `code` is set). */
  firebaseThrows?: { message: string; code?: string }
}

const throwing = (message: string, code?: string) => () => {
  const err: any = new Error(message)
  if (code) err.code = code
  throw err
}

/** A fresh SDK where expo-notifications is NOT installed and the given other modules are. */
function freshHook(installed: Installed) {
  jest.resetModules()
  // the hook must use the React that renderHook uses, not a second copy loaded after resetModules
  jest.doMock('react', () => React)
  jest.doMock('react-native', () => ({ Platform: { OS: 'android' } }), { virtual: true })
  jest.doMock('expo-notifications', ABSENT, { virtual: true })
  jest.doMock('expo-constants', installed.constants ? () => ({ expoConfig: {} }) : ABSENT, { virtual: true })
  jest.doMock('expo-device', installed.device ? () => ({}) : ABSENT, { virtual: true })
  jest.doMock('expo-application', installed.application ? () => ({}) : ABSENT, { virtual: true })
  jest.doMock('expo-localization', installed.localization ? () => ({}) : ABSENT, { virtual: true })
  jest.doMock(
    '@react-native-firebase/messaging',
    installed.firebaseThrows
      ? throwing(installed.firebaseThrows.message, installed.firebaseThrows.code)
      : installed.firebase
      ? () => ({ default: Object.assign(() => ({ requestPermission: async () => 1, getToken: async () => 'fcm-token' }), { AuthorizationStatus: { AUTHORIZED: 1 } }) })
      : ABSENT,
    { virtual: true },
  )
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require('../src/hooks') as typeof import('../src/hooks')).usePushNotifications
}

async function errorOf(installed: Installed): Promise<Error> {
  const usePushNotifications = freshHook(installed)
  const { result } = renderHook(() => usePushNotifications({ projectId: 'pk_test' }))
  await waitFor(() => expect(result.current.error).not.toBeNull())
  expect(result.current.isReady).toBe(false)
  return result.current.error as Error
}

describe('expo-notifications is missing in Expo mode (ES-08)', () => {
  it.each([
    ['expo-constants', { constants: true }],
    ['expo-device', { device: true }],
    ['expo-application', { application: true }],
    ['expo-localization', { localization: true }],
  ])('fails with the install command when %s is there and expo-notifications is not', async (_name, installed) => {
    const error = await errorOf(installed)

    expect(error.message).toContain('[espresso-notify]')
    expect(error.message).toContain('npx expo install expo-notifications')
  })

  it('says that Expo mode needs the package', async () => {
    const error = await errorOf({ constants: true })

    expect(error.message).toMatch(/expo-notifications/)
    expect(error.message).toMatch(/required|needs/i)
  })
})

describe('no push provider and no sign of Expo (ES-08)', () => {
  it('names both ways: expo-notifications for Expo, @react-native-firebase/messaging for React Native CLI', async () => {
    const error = await errorOf({})

    expect(error.message).toContain('[espresso-notify]')
    expect(error.message).toContain('npx expo install expo-notifications')
    expect(error.message).toContain('@react-native-firebase/messaging')
  })
})

describe('Firebase messaging that is installed but cannot load (G5)', () => {
  it.each([
    ['a dependency of it is missing', { message: "Cannot find module '@react-native-firebase/app'", code: 'MODULE_NOT_FOUND' }],
    ['its own code throws', { message: 'boom while loading messaging' }],
  ])('names both ways, and the cause, when %s, even with an Expo module around', async (_label, firebaseThrows) => {
    const error = await errorOf({ constants: true, firebaseThrows })

    expect(error.message).toContain('[espresso-notify]')
    expect(error.message).toContain('npx expo install expo-notifications')
    expect(error.message).toContain('@react-native-firebase/messaging')
    expect(error.message).toContain(firebaseThrows.message)
  })

  it('keeps the Expo-mode message when messaging itself is not installed, as in every Expo app', async () => {
    const error = await errorOf({
      constants: true,
      firebaseThrows: { message: "Cannot find module '@react-native-firebase/messaging'", code: 'MODULE_NOT_FOUND' },
    })

    expect(error.message).toContain('it is required in an Expo app')
    expect(error.message).not.toContain('No push provider found')
  })

  it('keeps the Expo-mode message when the bundler says it with other words (Unable to resolve)', async () => {
    const error = await errorOf({
      constants: true,
      firebaseThrows: { message: 'Unable to resolve module @react-native-firebase/messaging from /app/node_modules/x.js' },
    })

    expect(error.message).toContain('it is required in an Expo app')
  })
})

describe('a bare React Native app with Firebase is not an Expo-mode failure (ES-08)', () => {
  it('registers through Firebase even if some Expo module is around', async () => {
    const usePushNotifications = freshHook({ constants: true, firebase: true })
    const { result } = renderHook(() => usePushNotifications({ projectId: 'pk_test', autoRequestPermission: false }))
    // no expo-notifications error: whatever happens next, it is not the "install expo-notifications" failure
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(String(result.current.error?.message ?? '')).not.toContain('npx expo install expo-notifications')
  })
})

describe('the package manifest (ES-08)', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'))

  it.each(['expo-notifications', 'expo-constants'])('keeps %s optional in peerDependenciesMeta', (name) => {
    expect(manifest.peerDependencies[name]).toBeDefined()
    expect(manifest.peerDependenciesMeta[name]).toEqual({ optional: true })
  })
})
