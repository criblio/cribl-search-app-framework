/**
 * Strict argv parsing for the app-tooling bins.
 *
 * Every bin used to pick the flags it knew out of argv with
 * `args.includes(...)` and ignore the rest, so a typo was not an error — it
 * was a different command. `npm run deploy -- --dry` performed a REAL
 * deploy: `--dry` matched nothing, and nothing complained. A bin that
 * mutates a workspace must refuse anything it does not understand BEFORE it
 * does any work, so this parser throws on an unknown flag, a missing value,
 * a repeated flag and an unexpected positional.
 *
 * Internal to the bins; not a public export.
 */

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

/**
 * @param {string[]} argv  process.argv.slice(2)
 * @param {{
 *   flags?: Record<string, 'boolean' | 'string'>,
 *   positionals?: number,
 * }} spec  flag names include the leading `--`; `positionals` is the
 *   maximum number of bare arguments (default 0)
 * @returns {{ values: Record<string, string | true>, positionals: string[], help: boolean }}
 */
export function parseArgs(argv, spec = {}) {
  const flags = { ...(spec.flags ?? {}) };
  const maxPositionals = spec.positionals ?? 0;
  const values = {};
  const positionals = [];
  let help = false;
  let onlyPositionals = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (onlyPositionals || arg === '-' || !arg.startsWith('-')) {
      positionals.push(arg);
      continue;
    }
    if (arg === '--') {
      onlyPositionals = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }
    const eq = arg.indexOf('=');
    const name = eq >= 0 ? arg.slice(0, eq) : arg;
    const inline = eq >= 0 ? arg.slice(eq + 1) : undefined;
    const kind = flags[name];
    if (!kind) {
      const known = Object.keys(flags);
      throw new UsageError(
        `unknown option ${JSON.stringify(name)}` +
        (known.length ? `; accepted options: ${known.join(', ')}` : '; this command takes no options'),
      );
    }
    if (name in values) throw new UsageError(`${name} was given more than once`);
    if (kind === 'boolean') {
      if (inline !== undefined) throw new UsageError(`${name} does not take a value`);
      values[name] = true;
      continue;
    }
    const value = inline ?? argv[i + 1];
    if (value === undefined || value === '' || (inline === undefined && value.startsWith('--'))) {
      throw new UsageError(`${name} requires a value`);
    }
    if (inline === undefined) i++;
    values[name] = value;
  }

  if (positionals.length > maxPositionals) {
    const extra = positionals.slice(maxPositionals).map((p) => JSON.stringify(p)).join(' ');
    throw new UsageError(
      maxPositionals === 0
        ? `unexpected argument(s): ${extra}; this command takes no positional arguments`
        : `unexpected argument(s): ${extra}; at most ${maxPositionals} positional argument(s) allowed`,
    );
  }
  return { values, positionals, help };
}

/**
 * Run a bin's argv through `parseArgs`, printing usage and exiting on
 * `--help` (0) or a usage error (2) — before the bin does anything else.
 */
export function parseArgsOrExit(argv, spec, { command, usage }) {
  let parsed;
  try {
    parsed = parseArgs(argv, spec);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`${command}: ${error.message}\n\n${usage}`);
    process.exit(2);
  }
  if (parsed.help) {
    console.log(usage);
    process.exit(0);
  }
  return parsed;
}
