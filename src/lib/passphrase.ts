/**
 * Passphrase acquisition for pod encryption.
 *
 * Resolution order:
 *   1. `CASCADE_POD_PASSPHRASE` environment variable (non-interactive / CI).
 *   2. Hidden interactive prompt on a TTY (input echoing suppressed).
 *
 * We deliberately do NOT accept a plaintext `--passphrase` argv value: it would
 * leak into the process table (`ps`) and shell history.
 */

const ENV_VAR = 'CASCADE_POD_PASSPHRASE';

/** Read the passphrase from the environment, or `undefined` if unset/empty. */
export function passphraseFromEnv(): string | undefined {
  const v = process.env[ENV_VAR];
  return v && v.length > 0 ? v : undefined;
}

/**
 * Prompt for a passphrase on the TTY with input hidden (no echo).
 * Rejects if stdin is not a TTY.
 */
export function promptHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    const output = process.stdout;

    if (!input.isTTY) {
      reject(new Error('Cannot prompt for passphrase: stdin is not a TTY.'));
      return;
    }

    output.write(prompt);

    let value = '';
    const wasRaw = input.isRaw ?? false;
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf-8');

    const cleanup = (): void => {
      input.setRawMode(wasRaw);
      input.pause();
      input.removeListener('data', onData);
      output.write('\n');
    };

    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        const code = ch.charCodeAt(0);
        if (ch === '\n' || ch === '\r' || code === 4 /* Ctrl-D */) {
          cleanup();
          resolve(value);
          return;
        }
        if (code === 3 /* Ctrl-C */) {
          cleanup();
          reject(new Error('Passphrase entry cancelled.'));
          return;
        }
        if (code === 127 /* DEL */ || code === 8 /* Backspace */) {
          value = value.slice(0, -1);
          continue;
        }
        // Ignore other control characters; accept printable input.
        if (ch >= ' ') value += ch;
      }
    };

    input.on('data', onData);
  });
}

/**
 * Obtain a passphrase for an existing encrypted pod (read path): env first,
 * then a hidden prompt if interactive. Throws a clean error when neither is
 * available (e.g. CI without the env var).
 */
export async function obtainPassphrase(prompt = 'Pod passphrase: '): Promise<string> {
  const fromEnv = passphraseFromEnv();
  if (fromEnv) return fromEnv;
  if (process.stdin.isTTY) {
    return promptHidden(prompt);
  }
  throw new Error(
    `Pod is encrypted. Set ${ENV_VAR} or run interactively to supply the passphrase.`,
  );
}

/**
 * Obtain a passphrase when CREATING encryption (init/encrypt): env first, then
 * a hidden prompt WITH confirmation if interactive. Throws when non-interactive
 * and the env var is unset.
 */
export async function obtainNewPassphrase(): Promise<string> {
  const fromEnv = passphraseFromEnv();
  if (fromEnv) return fromEnv;
  if (!process.stdin.isTTY) {
    throw new Error(
      `Encryption requested but no passphrase available. Set ${ENV_VAR} or run interactively.`,
    );
  }
  const first = await promptHidden('New pod passphrase: ');
  if (first.length === 0) {
    throw new Error('Passphrase cannot be empty.');
  }
  const second = await promptHidden('Confirm pod passphrase: ');
  if (first !== second) {
    throw new Error('Passphrases did not match.');
  }
  return first;
}

export { ENV_VAR as PASSPHRASE_ENV_VAR };
