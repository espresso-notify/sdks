/**
 * sdk-parity T25 (PAR-12): identify and unregister record the `identity` lifecycle event, so `user.identified`
 * fires for React Native devices.
 *
 * feature: identity.lifecycle-event
 */
import { PushClient } from '../src/index';

jest.mock('expo-notifications', () => ({}), { virtual: true });

const mockFetch = jest.fn();
globalThis.fetch = mockFetch;

const EVENT_ID = /^[A-Za-z0-9_-]{8,64}$/;
const ok = () => Promise.resolve({ ok: true, text: () => Promise.resolve('{}') });

function client() {
  return new PushClient({ projectId: 'pk_live_test', pushToken: 'tok-1', platform: 'ios', autoTrack: false });
}

/** The bodies sent to the lifecycle route, in order. */
function lifecycleBodies() {
  return mockFetch.mock.calls
    .filter(([url]) => String(url).endsWith('/v1/devices/lifecycle'))
    .map(([, init]) => JSON.parse(init.body));
}

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockImplementation(ok);
});

describe('identity lifecycle event (PAR-12)', () => {
  it('records one event per change of user: U1, U1 again, U2, then the logout', async () => {
    const c = client();

    await c.devices.identify({ externalId: 'U1' });
    expect(lifecycleBodies()).toEqual([
      { push_token: 'tok-1', kind: 'identity', from: '', to: 'U1', external_id: 'U1', event_id: expect.stringMatching(EVENT_ID) },
    ]);

    await c.devices.identify({ externalId: 'U1' });
    expect(lifecycleBodies()).toHaveLength(1);

    await c.devices.identify({ externalId: 'U2' });
    expect(lifecycleBodies()[1]).toEqual({
      push_token: 'tok-1', kind: 'identity', from: 'U1', to: 'U2', external_id: 'U2', event_id: expect.stringMatching(EVENT_ID),
    });

    await c.devices.unregister();
    expect(lifecycleBodies()).toHaveLength(3);
    expect(lifecycleBodies()[2]).toEqual({
      push_token: 'tok-1', kind: 'identity', from: 'U2', to: '', event_id: expect.stringMatching(EVENT_ID),
    });
  });

  it('sends the event after the identify answered, and not when the identify failed', async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve({ ok: false, status: 500, statusText: 'No', text: () => Promise.resolve('{}') }),
    );
    await expect(client().devices.identify({ externalId: 'U1' })).rejects.toBeDefined();
    expect(lifecycleBodies()).toHaveLength(0);
  });

  it('does not record a logout when no user was identified', async () => {
    await client().devices.unregister();
    expect(lifecycleBodies()).toHaveLength(0);
  });

  it('keeps one event_id when the event is replayed after an outage', async () => {
    const c = client();
    mockFetch.mockImplementation((url: string) =>
      String(url).endsWith('/v1/devices/lifecycle') ? Promise.reject(new TypeError('Network request failed')) : ok(),
    );
    await c.devices.identify({ externalId: 'U1' });
    const first = lifecycleBodies();
    expect(first).toHaveLength(1);

    mockFetch.mockImplementation(ok);
    await c.flush();
    const all = lifecycleBodies();
    expect(all).toHaveLength(2);
    expect(all[1].event_id).toBe(all[0].event_id);
    expect(all[1]).toMatchObject({ kind: 'identity', from: '', to: 'U1' });
  });

  it('never sends a user id the server would refuse (over 255 bytes)', async () => {
    const c = client();
    await c.devices.identify({ externalId: 'u'.repeat(256) });
    expect(lifecycleBodies()).toHaveLength(0);
    await c.devices.identify({ externalId: 'U2' });
    expect(lifecycleBodies()).toHaveLength(0); // from is the long id: nothing is sent either
    await c.devices.identify({ externalId: 'U3' });
    expect(lifecycleBodies()).toHaveLength(1);
    expect(lifecycleBodies()[0]).toMatchObject({ from: 'U2', to: 'U3' });
  });
});
