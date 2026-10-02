/**
 * Types for `@criblio/app-tooling/proxies` — the proxies.yml reader,
 * comparator and schema check. Hand-written: the module is plain ESM.
 */

/** A scalar the proxies.yml YAML subset can hold. */
export type ProxiesScalar = string | number | boolean | null;

/** A parsed proxies.yml node: nested maps of scalars plus scalar lists. */
export type ProxiesValue = ProxiesScalar | ProxiesValue[] | { [key: string]: ProxiesValue };

/**
 * A parsed proxies.yml document. Valid documents are a map keyed by bare
 * hostname (`{ 'api.example.com': { paths, headers, timeout } }`); the
 * parser returns whatever shape the text has, so run `validateProxies` on
 * the result before trusting it. An empty document parses to `{}`.
 */
export type ParsedProxies = ProxiesValue;

/** Parse a proxies.yml document (comments and blank lines ignored).
 * Throws on anything outside the supported YAML subset. */
export function parseProxiesYaml(text: string): ParsedProxies;

export interface DiffProxiesOptions {
  /** Default `'packaged proxies.yml'`. */
  actualLabel?: string;
  /** Default `'expected manifest'`. */
  expectedLabel?: string;
}

/** Deep-compare two parsed proxies structures; list order is ignored.
 * Returns human-readable differences — empty means they match. */
export function diffProxies(
  actual: ParsedProxies | null | undefined,
  expected: ParsedProxies | null | undefined,
  options?: DiffProxiesOptions,
): string[];

/** Validate a parsed proxies.yml against the platform schema (a map keyed
 * by host). Returns human-readable problems; empty means valid. */
export function validateProxies(parsed: ParsedProxies | null | undefined): string[];
