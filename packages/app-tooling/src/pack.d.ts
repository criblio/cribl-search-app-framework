/** Types for `@criblio/app-tooling/pack` (deprecated packer; prefer `apps package`).
 * Hand-written: the module is plain ESM. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Readable } from 'node:stream';

export interface CreateAppPackOptions {
  /** App root. Default `process.cwd()`. */
  root?: string;
  /** Development pack: no `dist/`, name prefixed `__dev__`. */
  dev?: boolean;
}

export interface AppPackStream {
  /** Settles when `tar` exits and the staging directory is removed. */
  closePromise: Promise<void>;
  /** The gzipped tar stream. */
  stdout: Readable;
}

/** Create a deterministic Cribl App tgz stream from an app root. */
export function createAppPack(options?: CreateAppPackOptions): Promise<AppPackStream>;

/** Write one deterministic release candidate to `build/<name>-<version>.tgz`;
 * resolves to its path. */
export function packageApp(root?: string): Promise<string>;

/** Vite development handler for packaging through the local app server. */
export function servePackageTgz(req: IncomingMessage, res: ServerResponse, root: string): Promise<void>;
