import { existsSync, readFileSync, writeFileSync } from 'fs';

const API_URL = process.env.ESPRESSO_API_URL;
if (!API_URL) {
  console.error('[inject-url] ERROR: ESPRESSO_API_URL env var is required');
  console.error('[inject-url] Example: ESPRESSO_API_URL=https://api.espressonotify.com npm run build');
  process.exit(1);
}
console.info(`[inject-url] Injecting API URL: ${API_URL}`);

function injectFile(filePath) {
  if (!existsSync(filePath)) {
    console.error(`[inject-url] ERROR: ${filePath} does not exist; build it before injecting`);
    process.exit(1);
  }
  const raw = readFileSync(filePath, 'utf-8');
  if (!raw.includes('__ESPRESSO_API_URL__')) {
    console.info(`[inject-url] No placeholder found in ${filePath} — skipping`);
    return;
  }
  const injected = raw.replaceAll('__ESPRESSO_API_URL__', API_URL);
  if (injected.includes('__ESPRESSO_API_URL__')) {
    console.error(`[inject-url] ERROR: placeholder still present after injection in ${filePath}`);
    process.exit(1);
  }
  writeFileSync(filePath, injected);
  console.info(`[inject-url] Done — ${filePath}`);
}

injectFile('./dist/index.js');
// The service worker reports clicks to the API compiled into it (it never reads one from a push).
injectFile('./dist/sw.js');
