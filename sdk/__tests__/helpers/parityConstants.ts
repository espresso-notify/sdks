/**
 * sdk-parity T45 (PAR-46): the shared behaviour numbers of the SDKs, read from the copy of `sdk-parity/constants.json`
 * that lives in this tree (the SDK is mirrored alone, so tests cannot read the repository root).
 */
import { readFileSync } from 'fs'
import { join } from 'path'

export type ParitySdk = 'rn' | 'web' | 'ios' | 'android'

interface Entry {
  value: unknown
  applies_to: string[]
  exceptions?: Record<string, { value: unknown; gap?: string }>
}

const FILE = join(__dirname, '..', 'fixtures', 'parity-constants.json')
const constants: Record<string, Entry> = JSON.parse(readFileSync(FILE, 'utf8')).constants

/** The value `key` has for `sdk`: its exception when the SDK has one, else the shared value. */
export function effective<T = number>(key: string, sdk: ParitySdk): T {
  const entry = constants[key]
  if (!entry) throw new Error(`unknown parity constant ${key}`)
  if (!entry.applies_to.includes(sdk)) throw new Error(`parity constant ${key} does not apply to ${sdk}`)
  const exception = entry.exceptions?.[sdk]
  return (exception ? exception.value : entry.value) as T
}

/** Every key that applies to `sdk`. */
export function keysFor(sdk: ParitySdk): string[] {
  return Object.keys(constants).filter((key) => constants[key].applies_to.includes(sdk))
}
