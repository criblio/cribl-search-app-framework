/**
 * Minimal node:sqlite surface for the tests. The package's tsconfig
 * types only @cloudflare/workers-types (the runtime target); pulling
 * in all of @types/node would collide with the workers globals, and
 * the tests only need DatabaseSync's prepare/run/all.
 */
declare module 'node:sqlite' {
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): {
      run(...params: unknown[]): unknown;
      all(...params: unknown[]): unknown[];
    };
  }
}
