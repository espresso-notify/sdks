/**
 * @jest-environment node
 *
 * IMG-06: the notification service extension sample in `sdk/examples/notification-service/`. The Swift is compiled and
 * exercised by a local test program (it needs Xcode, so CI cannot run it); this test holds what a text check can: the
 * target config, the five shapes of the image key, the https rule, the single call of the content handler, and that
 * the sample carries nothing of a client.
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const DIR = join(__dirname, '..', 'examples', 'notification-service');
const SWIFT = join(DIR, 'NotificationService.swift');
const CONFIG = join(DIR, 'expo-target.config.js');

describe('notification service extension sample', () => {
  it('ships the Swift file and the config of @bacons/apple-targets', () => {
    expect(existsSync(SWIFT)).toBe(true);
    expect(existsSync(CONFIG)).toBe(true);
  });

  it('the config declares a notification-service target', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const build = require(CONFIG);
    expect(typeof build).toBe('function');
    expect(build({})).toMatchObject({ type: 'notification-service' });
  });

  it('the Swift reads the five shapes of the image key, in the documented order', () => {
    const swift = readFileSync(SWIFT, 'utf-8');
    const order = [
      'dictionary(body?["_richContent"])?["image"]',
      'dictionary(userInfo["_richContent"])?["image"]',
      'dictionary(userInfo["richContent"])?["image"]',
      '      userInfo["image"],\n',
      'dictionary(userInfo["fcm_options"])?["image"]',
    ].map((snippet) => swift.indexOf(snippet));
    expect(order.every((at) => at > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('the Swift accepts only https and attaches only JPEG, PNG and GIF', () => {
    const swift = readFileSync(SWIFT, 'utf-8');
    expect(swift).toContain('url.scheme?.lowercased() == "https"');
    expect(swift).toMatch(/case "image\/jpeg", "image\/jpg": return "jpg"/);
    expect(swift).toMatch(/case "image\/png": return "png"/);
    expect(swift).toMatch(/case "image\/gif": return "gif"/);
    expect(swift).not.toMatch(/image\/webp/);
  });

  it('the Swift calls the content handler through one guarded function', () => {
    const swift = readFileSync(SWIFT, 'utf-8');
    expect(swift).toContain('guard !finished, let handler = contentHandler else { return }');
    // ...and it marks itself finished right before calling the handler, so a second path (a late download after the
    // expiry) cannot call it again: dropping this line makes the guard above never trip.
    expect(swift).toMatch(/guard !finished, let handler = contentHandler else \{ return \}\s*\n\s*finished = true\s*\n\s*handler\(content\)/);
    expect((swift.match(/\bfinished = true\b/g) ?? []).length).toBe(1);
    // the handler is invoked only inside finish(): every path goes through it
    const calls = swift.match(/\bhandler\(/g) ?? [];
    expect(calls).toHaveLength(1);
    expect((swift.match(/\bfinish\(/g) ?? []).length).toBeGreaterThanOrEqual(4); // the definition and the three paths
    expect(swift).toContain('override func serviceExtensionTimeWillExpire()');
  });

  it('carries nothing of a client: only example hosts and identifiers', () => {
    for (const file of [SWIFT, CONFIG]) {
      const text = readFileSync(file, 'utf-8');
      const hosts = [...text.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1].toLowerCase());
      for (const host of hosts) expect(host).toMatch(/(^|\.)example\.com$|^docs\.expo\.dev$/);
      const ids = [...text.matchAll(/\b((?:com|io|net|org|br|app)\.[a-z0-9-]+\.[A-Za-z0-9.-]+)/g)].map((m) => m[1]);
      for (const id of ids) expect(id).toMatch(/^(com\.example\.|com\.apple\.)/);
    }
  });
});
