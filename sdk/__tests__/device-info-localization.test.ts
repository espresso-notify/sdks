/**
 * @jest-environment node
 *
 * expo-setup-simpler T3 (ES-03): the language and the time zone come from the `expo-localization` of
 * today (`getLocales()` and `getCalendars()`), with the old `locale` and `timezone` fields as a fallback.
 */

// A module, not a script: two test files that declare `ABSENT` in the global scope collide (TS2451) in a whole-suite run.
export {};

const ABSENT = () => {
  throw new Error('not found');
};

const mockFetch = jest.fn();

/** Registers a device through a fresh SDK whose expo-localization is `localization` (null: not installed). */
async function registeredMetadata(localization: unknown): Promise<Record<string, unknown>> {
  jest.resetModules();
  jest.doMock('expo-notifications', () => ({}), { virtual: true });
  jest.doMock('expo-device', ABSENT, { virtual: true });
  jest.doMock('expo-application', ABSENT, { virtual: true });
  jest.doMock('expo-localization', localization === null ? ABSENT : () => localization, { virtual: true });
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({ ok: true, text: () => Promise.resolve(JSON.stringify({ success: true })) });
  (globalThis as any).fetch = mockFetch;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { PushClient } = require('../src/index');
  const client = new PushClient({ projectId: 'pk_live_test-key' });
  await client.devices.register({ pushToken: 'token123', platform: 'ios' });
  const body = JSON.parse(mockFetch.mock.calls[0][1].body);
  return body.metadata ?? {};
}

describe('device language and time zone (ES-03)', () => {
  it('sends the language tag of the first locale and the time zone of the first calendar', async () => {
    const metadata = await registeredMetadata({
      getLocales: () => [{ languageTag: 'pt-BR', languageCode: 'pt' }, { languageTag: 'en-US' }],
      getCalendars: () => [{ timeZone: 'America/Sao_Paulo' }],
    });

    expect(metadata.locale).toBe('pt-BR');
    expect(metadata.timezone).toBe('America/Sao_Paulo');
  });

  it('prefers getLocales and getCalendars over the old fields', async () => {
    const metadata = await registeredMetadata({
      locale: 'en-US',
      timezone: 'UTC',
      getLocales: () => [{ languageTag: 'es-ES' }],
      getCalendars: () => [{ timeZone: 'Europe/Madrid' }],
    });

    expect(metadata.locale).toBe('es-ES');
    expect(metadata.timezone).toBe('Europe/Madrid');
  });

  it('falls back to the old locale and timezone fields of an older expo-localization', async () => {
    const metadata = await registeredMetadata({ locale: 'fr-FR', timezone: 'Europe/Paris' });

    expect(metadata.locale).toBe('fr-FR');
    expect(metadata.timezone).toBe('Europe/Paris');
  });

  it('falls back field by field: a null time zone keeps the language', async () => {
    const metadata = await registeredMetadata({
      getLocales: () => [{ languageTag: 'de-DE' }],
      getCalendars: () => [{ timeZone: null }],
      timezone: 'Europe/Berlin',
    });

    expect(metadata.locale).toBe('de-DE');
    expect(metadata.timezone).toBe('Europe/Berlin');
  });

  it('sends nothing, and does not throw, when the functions fail or return empty lists', async () => {
    const metadata = await registeredMetadata({
      getLocales: () => {
        throw new Error('native module not ready');
      },
      getCalendars: () => [],
    });

    expect(metadata.locale).toBeUndefined();
    expect(metadata.timezone).toBeUndefined();
  });

  it('sends neither field when expo-localization is not installed', async () => {
    const metadata = await registeredMetadata(null);

    expect(metadata.locale).toBeUndefined();
    expect(metadata.timezone).toBeUndefined();
  });
});
