import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';

// The one step of the build that runs after `tsc`: it writes the API URL of the environment the package is built for
// into the `API_URL` constant. It changes nothing else: the code in `dist` is what `tsc` wrote, readable (the SDK is open
// source, D-54), and the build is deterministic.
//
// The placeholder is replaced in that one declaration only. It used to be replaced wherever it appeared, which also
// rewrote the check in `_extractHost` that tells a build without a URL from a real one; the published
// `_extractHost('https://api.espressonotify.com')` then returned null and certificate pinning never turned on (BUG-1 of
// the Expo 53 compatibility run). A placeholder anywhere else is now a build error, and nothing is written.
const PLACEHOLDER = '__ESPRESSO_API_URL__';
const DECLARATION = /^(\s*(?:const|let|var)\s+API_URL\s*=\s*)"__ESPRESSO_API_URL__"/m;

const API_URL = process.env.ESPRESSO_API_URL;
if (!API_URL) {
  console.error('[inject-url] ERROR: ESPRESSO_API_URL env var is required');
  console.error('[inject-url] Example: ESPRESSO_API_URL=https://api.espressonotify.com npm run build');
  process.exit(1);
}
console.info(`[inject-url] Injecting API URL: ${API_URL}`);

if (!existsSync('./dist')) {
  console.error('[inject-url] ERROR: ./dist does not exist; build it with tsc before injecting');
  process.exit(1);
}

/** The lines of `text` that hold the placeholder, as `file:line`. */
function placeholderLines(file, text) {
  return text
    .split('\n')
    .map((line, i) => (line.includes(PLACEHOLDER) ? `${file}:${i + 1}` : null))
    .filter(Boolean);
}

const writes = [];
const problems = [];
for (const file of readdirSync('./dist').filter((f) => f.endsWith('.js')).sort()) {
  const path = `./dist/${file}`;
  const raw = readFileSync(path, 'utf-8');
  if (!raw.includes(PLACEHOLDER)) {
    console.info(`[inject-url] No placeholder found in ${path} — skipping`);
    continue;
  }
  // A function replacer: the URL is inserted as text, never read for `$` patterns.
  const injected = raw.replace(DECLARATION, (_m, head) => `${head}${JSON.stringify(API_URL)}`);
  const left = placeholderLines(path, injected);
  if (left.length > 0) {
    problems.push(...left);
    continue;
  }
  writes.push([path, injected]);
}

if (problems.length > 0) {
  console.error('[inject-url] ERROR: the placeholder is outside the API_URL constant at:');
  for (const where of problems) console.error(`[inject-url]   ${where}`);
  console.error('[inject-url] Only `const API_URL = "' + PLACEHOLDER + '"` may hold it. Nothing was written.');
  process.exit(1);
}
for (const [path, injected] of writes) {
  writeFileSync(path, injected);
  console.info(`[inject-url] Done — ${path}`);
}
