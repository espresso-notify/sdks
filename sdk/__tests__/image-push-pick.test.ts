/**
 * @jest-environment node
 *
 * IMG-04 AC 2: where the image of a push is, in the shapes Expo, Firebase and the notification service
 * extension of iOS agree on. `pickPushImage` takes an expo-notifications notification and returns the
 * https URL of its image, or undefined.
 */
import { pickPushImage } from '../src/image-push';

const URL_A = 'https://cdn.example.com/a.jpg';
const URL_B = 'https://cdn.example.com/b.jpg';

/** An expo-notifications notification (Android): `data` of the content and the FCM message of the trigger. */
function notification(opts: { data?: unknown; dataString?: string; imageUrl?: unknown } = {}): any {
  return {
    request: {
      identifier: 'id-1',
      content: { title: 'T', body: 'B', data: opts.data, dataString: opts.dataString },
      trigger: {
        type: 'push',
        remoteMessage: { notification: { imageUrl: opts.imageUrl, channelId: 'default' } },
      },
    },
  };
}

describe('pickPushImage: each shape', () => {
  it('reads trigger.remoteMessage.notification.imageUrl', () => {
    expect(pickPushImage(notification({ imageUrl: URL_A }))).toBe(URL_A);
  });

  it('reads data.body._richContent.image (the body the Expo push service wraps, as an object)', () => {
    expect(pickPushImage(notification({ data: { body: { _richContent: { image: URL_A } } } }))).toBe(URL_A);
  });

  it('reads data.body._richContent.image when the body is a JSON string', () => {
    const body = JSON.stringify({ _richContent: { image: URL_A }, notificationId: '7' });
    expect(pickPushImage(notification({ data: { body } }))).toBe(URL_A);
  });

  it('reads the JSON of the dataString of the content', () => {
    const dataString = JSON.stringify({ _richContent: { image: URL_A } });
    expect(pickPushImage(notification({ data: {}, dataString }))).toBe(URL_A);
  });

  it('reads data._richContent.image', () => {
    expect(pickPushImage(notification({ data: { _richContent: { image: URL_A } } }))).toBe(URL_A);
  });

  it('reads data.richContent.image', () => {
    expect(pickPushImage(notification({ data: { richContent: { image: URL_A } } }))).toBe(URL_A);
  });

  it('reads richContent given as a JSON string', () => {
    expect(pickPushImage(notification({ data: { richContent: JSON.stringify({ image: URL_A }) } }))).toBe(URL_A);
  });

  it('reads the top-level data.image', () => {
    expect(pickPushImage(notification({ data: { image: URL_A } }))).toBe(URL_A);
  });

  it('reads data.fcm_options.image as an object', () => {
    expect(pickPushImage(notification({ data: { fcm_options: { image: URL_A } } }))).toBe(URL_A);
  });

  it('reads data.fcm_options.image as a JSON string', () => {
    expect(pickPushImage(notification({ data: { fcm_options: JSON.stringify({ image: URL_A }) } }))).toBe(URL_A);
  });
});

describe('pickPushImage: order of preference', () => {
  it('prefers the FCM imageUrl over every data shape', () => {
    const n = notification({
      imageUrl: URL_A,
      data: { body: { _richContent: { image: URL_B } }, image: URL_B, fcm_options: { image: URL_B } },
    });
    expect(pickPushImage(n)).toBe(URL_A);
  });

  it('prefers data.body._richContent over data._richContent, richContent, image and fcm_options', () => {
    const n = notification({
      data: {
        body: { _richContent: { image: URL_A } },
        _richContent: { image: URL_B },
        richContent: { image: URL_B },
        image: URL_B,
        fcm_options: { image: URL_B },
      },
    });
    expect(pickPushImage(n)).toBe(URL_A);
  });

  it('prefers data._richContent over richContent, image and fcm_options', () => {
    const n = notification({
      data: { _richContent: { image: URL_A }, richContent: { image: URL_B }, image: URL_B, fcm_options: { image: URL_B } },
    });
    expect(pickPushImage(n)).toBe(URL_A);
  });

  it('prefers data.richContent over image and fcm_options', () => {
    const n = notification({ data: { richContent: { image: URL_A }, image: URL_B, fcm_options: { image: URL_B } } });
    expect(pickPushImage(n)).toBe(URL_A);
  });

  it('prefers data.image over fcm_options', () => {
    expect(pickPushImage(notification({ data: { image: URL_A, fcm_options: { image: URL_B } } }))).toBe(URL_A);
  });

  it('skips a shape that is not https and takes the next one that is', () => {
    const n = notification({ imageUrl: 'http://cdn.example.com/a.jpg', data: { image: URL_B } });
    expect(pickPushImage(n)).toBe(URL_B);
  });
});

describe('pickPushImage: what is not an image', () => {
  it.each([
    ['an http URL', { image: 'http://cdn.example.com/a.jpg' }],
    ['text that is not a URL', { image: 'not a url' }],
    ['a URL with a space', { image: 'https://cdn.example.com/a b.jpg' }],
    ['an empty string', { image: '' }],
    ['a number', { image: 42 }],
    ['an invalid fcm_options JSON', { fcm_options: '{not json' }],
    ['a richContent that is a list', { richContent: [URL_A] }],
    ['a body that is not JSON', { body: 'plain text' }],
  ])('returns undefined for %s', (_name, data) => {
    expect(pickPushImage(notification({ data }))).toBeUndefined();
  });

  it('returns undefined and does not throw when data is not an object', () => {
    for (const data of [null, undefined, 'text', 42, ['a']]) {
      expect(() => pickPushImage(notification({ data }))).not.toThrow();
      expect(pickPushImage(notification({ data }))).toBeUndefined();
    }
  });

  it('returns undefined for a notification without request, content or trigger', () => {
    expect(pickPushImage(undefined)).toBeUndefined();
    expect(pickPushImage({})).toBeUndefined();
    expect(pickPushImage({ request: {} })).toBeUndefined();
  });
});
