/** Reads the React Native CLI template files kept under __tests__/fixtures/bare-templates (see the README there). */
import { readFileSync } from 'fs';
import { join } from 'path';

export const TEMPLATE_VERSIONS = ['0.87.1', '0.79.7'];

export const FIXTURE_ROOT = join(__dirname, '..', 'fixtures', 'bare-templates');

/** The text of `rel` (for example `ios/Podfile`) in the template of React Native `version`. */
export function fixture(version: string, rel: string): string {
  return readFileSync(join(FIXTURE_ROOT, version, rel), 'utf8');
}

/** True when `after` holds every line of `before` in the same order (a patch only adds lines). */
export function onlyAddsLines(before: string, after: string): boolean {
  const oldLines = before.split(/\r?\n/);
  let next = 0;
  for (const line of after.split(/\r?\n/)) if (next < oldLines.length && line === oldLines[next]) next += 1;
  return next === oldLines.length;
}

/** The lines of `after` that are not in `before` (in order), assuming `onlyAddsLines`. */
export function addedLines(before: string, after: string): string[] {
  const oldLines = before.split(/\r?\n/);
  const added: string[] = [];
  let next = 0;
  for (const line of after.split(/\r?\n/)) {
    if (next < oldLines.length && line === oldLines[next]) next += 1;
    else added.push(line);
  }
  return added;
}
