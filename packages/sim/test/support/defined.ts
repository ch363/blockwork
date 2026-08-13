/**
 * Narrowing assertion for tests.
 *
 * `expect(x).toBeDefined()` asserts at runtime but does not narrow the type,
 * so the line after it still needs `x!` — which hard rule 6 and the lint config
 * both forbid. This throws instead, which narrows, and carries a message that
 * names what was missing so a failure reads as well as the matcher would.
 */
export function definedOrThrow<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    throw new Error(`Expected ${what} to be defined, got ${String(value)}.`)
  }
  return value
}
