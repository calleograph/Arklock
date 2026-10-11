#!/usr/bin/env node
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { run, type Config, type Io } from './commands.js';

const dir =
  process.env.ARKLOCK_CONFIG_DIR ??
  path.join(process.env.XDG_CONFIG_HOME ?? path.join(homedir(), '.config'), 'arklock');
const file = path.join(dir, 'config.json');

function loadConfig(): Config {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Config;
  } catch {
    return {};
  }
}

/** Файл доступен только владельцу: в нём токен. Мастер-пароль и ключи на диск не попадают. */
function saveConfig(c: Config): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(c, null, 2), { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* файловая система без прав POSIX */
  }
}

/** Запрос строки; при hidden ввод не отображается. */
function ask(prompt: string, hidden: boolean): Promise<string | null> {
  if (!process.stdin.isTTY) return Promise.resolve(null);
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    if (hidden) {
      const rlAny = rl as unknown as { _writeToOutput: (s: string) => void };
      rlAny._writeToOutput = (s: string) => {
        if (s.startsWith(prompt)) process.stderr.write(prompt);
      };
    }
    rl.question(prompt, (answer) => {
      rl.close();
      if (hidden) process.stderr.write('\n');
      resolve(answer);
    });
  });
}

const io: Io = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
  env: process.env,
  loadConfig,
  saveConfig,
  ask,
};

process.exitCode = await run(process.argv.slice(2), io);
