// The pairing code: made once and kept in the user's config folder, so the page pairs once and connects again by
// itself whenever Claude starts this server. --new-code (or deleting the file) makes a new one.

import { randomInt } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// No 0/O, 1/I/L: the code is read off a chat and typed in.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function newCode(): string {
  const part = () => Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  return `${part()}-${part()}`;
}

export function configDir(env = process.env): string {
  if (env.MIB2C_CONFIG_DIR) return env.MIB2C_CONFIG_DIR;
  if (process.platform === 'win32') return join(env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'mib2c-mcp');
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'mib2c-mcp');
}

/** The saved pairing code, or a new one (saved) when there is none or `fresh` is set. */
export function pairingCode(dir: string, fresh = false): string {
  const file = join(dir, 'pairing.json');
  if (!fresh) {
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      if (typeof saved.code === 'string' && /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(saved.code)) return saved.code;
    } catch {
      /* none yet */
    }
  }
  const code = newCode();
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify({ code }, null, 2) + '\n', { mode: 0o600 });
  } catch {
    /* read-only home: the code lasts until the server stops */
  }
  return code;
}
