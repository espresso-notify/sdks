/**
 * @jest-environment jsdom
 *
 * Unit tests for TLS certificate / public-key pinning (#808).
 * Uses virtual mocks — no native device or installed lib required.
 */

describe('enableCertificatePinning()', () => {
  beforeEach(() => jest.resetModules());

  it('calls initializeSslPinning with the exact options and returns true', async () => {
    const initializeSslPinning = jest.fn().mockResolvedValue(undefined);
    jest.doMock(
      'react-native-ssl-public-key-pinning',
      () => ({ initializeSslPinning, disableSslPinning: jest.fn() }),
      { virtual: true },
    );
    const { enableCertificatePinning } = require('../src/index');

    const opts = {
      'api.espressonotify.com': {
        includeSubdomains: true,
        publicKeyHashes: ['hash1', 'hash2'],
      },
    };
    const result = await enableCertificatePinning(opts);

    expect(result).toBe(true);
    expect(initializeSslPinning).toHaveBeenCalledWith(opts);
  });

  it('returns false and warns when the library is not installed', async () => {
    jest.doMock(
      'react-native-ssl-public-key-pinning',
      () => { throw new Error('Module not found'); },
      { virtual: true },
    );
    const { enableCertificatePinning } = require('../src/index');
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await enableCertificatePinning({
      'example.com': { publicKeyHashes: ['h1'] },
    });

    expect(result).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('react-native-ssl-public-key-pinning is not installed'),
    );

    warnSpy.mockRestore();
  });

  it('does not throw when the library is not installed', async () => {
    jest.doMock(
      'react-native-ssl-public-key-pinning',
      () => { throw new Error('Module not found'); },
      { virtual: true },
    );
    const { enableCertificatePinning } = require('../src/index');
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(
      enableCertificatePinning({ 'example.com': { publicKeyHashes: [] } }),
    ).resolves.not.toThrow();

    (console.warn as jest.Mock).mockRestore();
  });

  // SPEC_AMENDMENT (sdk-private-transport T14a, owner decision D-6): the warning is a fixed SDK message with the code
  // PINNING_INIT_FAILED and no longer appends the message of the library's error ('Bad hash' was the second argument).
  it('returns false and warns when initializeSslPinning rejects, and does not throw', async () => {
    const initializeSslPinning = jest.fn().mockRejectedValue(new Error('Bad hash'));
    jest.doMock(
      'react-native-ssl-public-key-pinning',
      () => ({ initializeSslPinning }),
      { virtual: true },
    );
    const { enableCertificatePinning } = require('../src/index');
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await enableCertificatePinning({
      'example.com': { publicKeyHashes: ['h1'] },
    });

    expect(result).toBe(false);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]).toHaveLength(1);
    expect(warnSpy.mock.calls[0][0]).toContain('Certificate pinning initialization failed (PINNING_INIT_FAILED)');
    expect(String(warnSpy.mock.calls[0][0])).not.toContain('Bad hash');

    warnSpy.mockRestore();
  });
});

describe('enableEspressoPinning()', () => {
  beforeEach(() => jest.resetModules());

  it('returns false and warns when API_URL is still the build placeholder', async () => {
    // API_URL in test env is "__ESPRESSO_API_URL__" (the raw placeholder)
    jest.doMock(
      'react-native-ssl-public-key-pinning',
      () => ({ initializeSslPinning: jest.fn(), disableSslPinning: jest.fn() }),
      { virtual: true },
    );
    const { enableEspressoPinning } = require('../src/index');
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await enableEspressoPinning(['hash1', 'hash2']);

    expect(result).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('API_URL is a placeholder or unparseable'),
    );

    warnSpy.mockRestore();
  });

  it('does not throw when API_URL is the placeholder', async () => {
    jest.doMock(
      'react-native-ssl-public-key-pinning',
      () => ({ initializeSslPinning: jest.fn() }),
      { virtual: true },
    );
    const { enableEspressoPinning } = require('../src/index');
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(enableEspressoPinning(['hash1'])).resolves.not.toThrow();

    (console.warn as jest.Mock).mockRestore();
  });
});

describe('_extractHost() host-parsing helper', () => {
  beforeEach(() => jest.resetModules());

  it('extracts hostname from a standard HTTPS URL', () => {
    const { _extractHost } = require('../src/index');
    expect(_extractHost('https://api.espressonotify.com/v1')).toBe('api.espressonotify.com');
  });

  it('extracts hostname from a URL with a port', () => {
    const { _extractHost } = require('../src/index');
    expect(_extractHost('https://api.espressonotify.com:8443/v1')).toBe('api.espressonotify.com');
  });

  it('returns null for the build placeholder', () => {
    const { _extractHost } = require('../src/index');
    expect(_extractHost('__ESPRESSO_API_URL__')).toBeNull();
  });

  it('returns null for an unparseable string', () => {
    const { _extractHost } = require('../src/index');
    expect(_extractHost('not a url')).toBeNull();
  });

  it('returns null for an empty string', () => {
    const { _extractHost } = require('../src/index');
    expect(_extractHost('')).toBeNull();
  });
});

describe('disableCertificatePinning()', () => {
  beforeEach(() => jest.resetModules());

  it('calls disableSslPinning when the library is present', async () => {
    const disableSslPinning = jest.fn().mockResolvedValue(undefined);
    jest.doMock(
      'react-native-ssl-public-key-pinning',
      () => ({ initializeSslPinning: jest.fn(), disableSslPinning }),
      { virtual: true },
    );
    const { disableCertificatePinning } = require('../src/index');

    await disableCertificatePinning();

    expect(disableSslPinning).toHaveBeenCalledTimes(1);
  });

  it('is a no-op (does not throw) when the library is absent', async () => {
    jest.doMock(
      'react-native-ssl-public-key-pinning',
      () => { throw new Error('Module not found'); },
      { virtual: true },
    );
    const { disableCertificatePinning } = require('../src/index');

    await expect(disableCertificatePinning()).resolves.not.toThrow();
  });

  it('is a no-op when disableSslPinning is not exported', async () => {
    jest.doMock(
      'react-native-ssl-public-key-pinning',
      () => ({ initializeSslPinning: jest.fn() /* no disableSslPinning */ }),
      { virtual: true },
    );
    const { disableCertificatePinning } = require('../src/index');

    await expect(disableCertificatePinning()).resolves.not.toThrow();
  });
});

// Torna o arquivo um módulo: sem isso o ts-jest o trata como script global e
// nomes de topo repetidos entre testes colidem (TS2451) em cache frio.
export {}
