/**
 * @jest-environment node
 *
 * setup-wizard-bare-rn T9 (SWB-01): the entry point `run` of `bin/setup.js` picks the flow. An `expo` dependency keeps the
 * Expo flow, `react-native` without `expo` goes to the React Native CLI flow, anything else is refused with exit 1.
 * Every test works in a temporary folder and replaces `spawn`.
 */
import { EventEmitter } from 'events';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PassThrough } from 'stream';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const wizard = require('../bin/setup.js');

const PLUGIN = '@espresso-notify/react-native';
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function project(files: Record<string, string | object>): string {
  const dir = mkdtempSync(join(tmpdir(), 'espresso-entry-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    const file = join(dir, name);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n');
  }
  return dir;
}

function snapshot(dir: string, prefix = ''): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(result, snapshot(dir, rel));
    else result[rel] = readFileSync(join(dir, rel), 'utf8');
  }
  return result;
}

async function run(argv: string[], cwd: string, opts: { stdin?: string; tty?: boolean } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const spawn = jest.fn((_cmd: string, _args: string[], _options: any) => {
    const child: any = new EventEmitter();
    setImmediate(() => child.emit('close', 0));
    return child;
  });
  const stdin = new PassThrough();
  if (opts.stdin !== undefined) stdin.end(opts.stdin);
  const code: number = await wizard.run(argv, {
    cwd,
    spawn,
    stdout: { write: (s: string) => out.push(s) },
    stderr: { write: (s: string) => err.push(s) },
    stdin,
    isTTY: opts.tty ?? false,
    platform: 'linux',
    env: {},
  });
  return { code, out: out.join(''), err: err.join(''), all: out.join('') + err.join(''), spawn };
}

const bareApp = (deps: Record<string, string> = { 'react-native': '0.87.1' }) => ({ 'package.json': { name: 'app', dependencies: deps } });

describe('the entry point picks the flow', () => {
  it('expo and react-native together stay on the Expo flow', async () => {
    const dir = project({
      ...bareApp({ expo: '~57.0.26', 'react-native': '0.85.0' }),
      'app.json': { expo: { name: 'App', slug: 'app', extra: { eas: { projectId: 'abc' } } } },
    });
    const r = await run(['setup', '--yes'], dir);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Expo project');
    expect(r.out).not.toContain('React Native CLI project');
    expect(r.spawn).toHaveBeenCalledTimes(1);
    expect(r.spawn.mock.calls[0][0]).toBe('npx');
    expect(r.spawn.mock.calls[0][1].slice(0, 2)).toEqual(['expo', 'install']);
    expect(readFileSync(join(dir, 'app.json'), 'utf8')).toContain(PLUGIN);
  });

  it('expo with a React Native below 0.79 is still the Expo flow (it has its own floor)', async () => {
    const dir = project({ ...bareApp({ expo: '~52.0.0', 'react-native': '0.76.0' }) });
    const r = await run(['setup'], dir);
    expect(r.code).toBe(1);
    expect(r.all).toMatch(/Expo SDK 52/);
  });

  it('react-native without expo reaches the React Native CLI flow', async () => {
    const dir = project(bareApp());
    const r = await run(['setup', '--yes'], dir);
    expect(r.code).toBe(0);
    expect(r.out).toContain('[1/6] Looking at the project');
    expect(r.out).toContain('React Native CLI project, React Native 0.87.1');
    expect(r.spawn).toHaveBeenCalledTimes(1);
    expect(r.spawn.mock.calls[0][0]).toBe('npm');
    expect(r.spawn.mock.calls[0][1]).toContain('@react-native-firebase/app@26');
  });

  it('a no at the question of the React Native CLI flow ends with 1 and writes nothing', async () => {
    const dir = project(bareApp());
    const before = snapshot(dir);
    const r = await run(['setup'], dir, { tty: true, stdin: 'n\n' });
    expect(r.code).toBe(1);
    expect(r.spawn).not.toHaveBeenCalled();
    expect(snapshot(dir)).toEqual(before);
  });

  it('--dry-run on a React Native CLI app prints the plan and leaves the folder as it was', async () => {
    const dir = project(bareApp());
    const before = snapshot(dir);
    const r = await run(['setup', '--dry-run'], dir);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Would run: npm install/);
    expect(r.spawn).not.toHaveBeenCalled();
    expect(snapshot(dir)).toEqual(before);
  });
});

describe('what the entry point refuses (exit 1, nothing written)', () => {
  it('a folder without package.json', async () => {
    const dir = project({});
    const r = await run(['setup'], dir);
    expect(r.code).toBe(1);
    expect(r.all).toMatch(/package\.json/);
    expect(r.spawn).not.toHaveBeenCalled();
  });

  it('a project with neither expo nor react-native says so and points to the guide', async () => {
    const dir = project({ 'package.json': { name: 'web', dependencies: { react: '19.0.0' } } });
    const before = snapshot(dir);
    const r = await run(['setup'], dir);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/expo/);
    expect(r.err).toMatch(/react-native/);
    expect(r.err).toContain('https://docs.espressonotify.com/docs/react-native/bare');
    expect(r.spawn).not.toHaveBeenCalled();
    expect(snapshot(dir)).toEqual(before);
  });

  it('React Native below 0.79 is refused with the floor', async () => {
    const dir = project(bareApp({ 'react-native': '0.78.0' }));
    const before = snapshot(dir);
    const r = await run(['setup', '--yes'], dir);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/0\.79/);
    expect(r.spawn).not.toHaveBeenCalled();
    expect(snapshot(dir)).toEqual(before);
  });

  it('a secret key is refused for a React Native CLI app without repeating it', async () => {
    const dir = project(bareApp());
    const before = snapshot(dir);
    const r = await run(['setup', '--yes', '--key', 'sk_live_supersecretvalue'], dir);
    expect(r.code).toBe(1);
    expect(r.all).toMatch(/SECRET/);
    expect(r.all).not.toContain('sk_live_supersecretvalue');
    expect(r.spawn).not.toHaveBeenCalled();
    expect(snapshot(dir)).toEqual(before);
  });
});

describe('the options', () => {
  it('--help lists the options and the exit codes of both flows', async () => {
    const r = await run(['--help'], project(bareApp()));
    expect(r.code).toBe(0);
    for (const word of ['--dry-run', '--yes', '--key', '--pods', 'Expo', 'React Native CLI', '0.79', 'Exit codes']) {
      expect(r.out).toContain(word);
    }
  });

  it('--pods is accepted', async () => {
    const r = await run(['setup', '--yes', '--pods'], project(bareApp()));
    expect(r.code).toBe(0);
    expect(r.err).not.toMatch(/Unknown option/);
  });

  it('--pods is accepted by parseArgs and an unknown option is still an error', () => {
    expect(wizard.parseArgs(['setup', '--pods']).pods).toBe(true);
    expect(wizard.parseArgs(['setup']).pods).toBe(false);
    expect(wizard.parseArgs(['setup', '--nope']).error).toMatch(/Unknown option: --nope/);
  });

  it('an unknown option is refused for a React Native CLI app too', async () => {
    const r = await run(['setup', '--nope'], project(bareApp()));
    expect(r.code).toBe(1);
    expect(r.all).toMatch(/--pods/);
    expect(r.spawn).not.toHaveBeenCalled();
  });
});

describe('the package stays free of third-party code', () => {
  it('every module under bin/lib requires only Node built-ins and files of the package', () => {
    const { readdirSync: list, statSync: stat } = require('fs');
    const root = join(__dirname, '..', 'bin', 'lib');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of list(dir)) {
        const full = join(dir, name);
        if (stat(full).isDirectory()) walk(full);
        else if (name.endsWith('.js')) files.push(full);
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThanOrEqual(8);
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/require\(['"]([^'"]+)['"]\)/g)) {
        expect(match[1]).toMatch(/^(node:|\.\.?\/)/);
      }
    }
  });

  it('bin/setup.js loads the flow from the package folder', () => {
    expect(typeof wizard.run).toBe('function');
    const source = readFileSync(join(__dirname, '..', 'bin', 'setup.js'), 'utf8');
    expect(source).toMatch(/require\(path\.join\(__dirname, 'lib', name\)\)/);
  });
});
