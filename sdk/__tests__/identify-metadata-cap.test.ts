/**
 * rn-sdk-v1-calls T4 (RNV-16): identify refuses user metadata over 4096 bytes before the call.
 */
import { PushClient, EspressoNotifyError } from '../src/index';

jest.mock('expo-notifications', () => ({}), { virtual: true });

const mockFetch = jest.fn();
globalThis.fetch = mockFetch;

function client() {
  return new PushClient({ projectId: 'pk_live_test', pushToken: 'tok-1', platform: 'ios', autoTrack: false });
}

/** A metadata document that serializes to exactly `size` bytes: {"k":"aaa..."} (ASCII). */
function padded(size: number): Record<string, unknown> {
  return { k: 'a'.repeat(size - '{"k":""}'.length) };
}

describe('identify metadata cap (RNV-16)', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, text: () => Promise.resolve('{}') });
  });

  it('accepts a document of exactly 4096 bytes', async () => {
    const metadata = padded(4096);
    expect(JSON.stringify(metadata)).toHaveLength(4096);

    await client().devices.identify({ externalId: 'u1', metadata });

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('refuses 4097 bytes with METADATA_TOO_LARGE and makes no request', async () => {
    const err: any = await client().devices.identify({ externalId: 'u1', metadata: padded(4097) }).catch((e) => e);

    expect(err).toBeInstanceOf(EspressoNotifyError);
    expect(err.code).toBe('METADATA_TOO_LARGE');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('measures bytes, not characters', async () => {
    // 1400 three-byte characters are 1400 characters but 4200 bytes of UTF-8.
    const metadata = { k: '€'.repeat(1400) };
    expect(JSON.stringify(metadata).length).toBeLessThan(4096);

    const err: any = await client().devices.identify({ externalId: 'u1', metadata }).catch((e) => e);

    expect(err.code).toBe('METADATA_TOO_LARGE');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does nothing about a call without metadata', async () => {
    await client().devices.identify({ externalId: 'u1', name: 'Ana' });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

export {};
