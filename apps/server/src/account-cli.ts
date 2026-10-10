import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { StringDecoder } from 'node:string_decoder';
import { Pool } from 'pg';
import { AccountService, argon2Passwords, passwordSchema } from '@tts-workbench/account-core';
import { PostgresAccountRepository } from '@tts-workbench/account-postgres';
import { databaseConfig } from './config.js';
import { transaction } from './database.js';
/** CLI-only password reset; never receives the plaintext in SQL, logs or process arguments. */
export async function resetPassword(pool: Pool, password: string): Promise<void> {
  const parsed = passwordSchema.safeParse(password); if (!parsed.success) throw new Error('Password must contain 8–128 characters.');
  const hash = await argon2Passwords.hash(parsed.data);
  await transaction(pool, async db => {
    const accounts = (await db.query('SELECT id FROM ac_accounts FOR UPDATE')).rows;
    if (accounts.length !== 1) throw new Error('Exactly one account is required.');
    const id = accounts[0].id;
    await db.query('UPDATE ac_accounts SET password_hash=$2,auth_version=auth_version+1 WHERE id=$1', [id, hash]);
    await db.query("INSERT INTO ac_session_revocations(sid) SELECT sid FROM ac_sessions WHERE sess->>'accountId'=$1 ON CONFLICT DO NOTHING", [id]);
    await db.query("DELETE FROM ac_sessions WHERE sess->>'accountId'=$1", [id]);
  });
}
export async function hiddenInput(prompt: string, input: NodeJS.ReadStream = process.stdin, output: NodeJS.WriteStream = process.stdout): Promise<string> {
  if (!input.isTTY || !output.isTTY || !input.setRawMode) throw new Error('An interactive TTY is required.');
  output.write(prompt); const priorRaw = input.isRaw;
  input.setRawMode(true); input.resume();
  return new Promise((resolve, reject) => {
    let value = ''; let overflow = false; const decoder = new StringDecoder('utf8'); let escape = '';
    const cleanup = () => { input.off('data', onData); input.setRawMode(priorRaw); input.pause(); output.write('\n'); };
    const onData = (chunk: Buffer) => {
      for (const char of decoder.write(chunk)) {
        if (char === '\u0003' || char === '\u0004') { value = ''; cleanup(); reject(new Error('Cancelled.')); return; }
        if (escape) {
          if (escape === 'start') escape = char === '[' || char === 'O' ? 'sequence' : '';
          else if (char >= '@' && char <= '~') escape = '';
          continue;
        }
        if (char === '\u001b') { escape = 'start'; continue; }
        if (char === '\r' || char === '\n') { cleanup(); if (overflow || value.length > 128) reject(new Error('Password is too long.')); else resolve(value); value = ''; return; }
        if (char === '\u007f' || char === '\b') value = Array.from(value).slice(0, -1).join('');
        else if (char >= ' ') { if (value.length < 4096) value += char; else overflow = true; }
      }
    };
    input.on('data', onData);
  });
}
async function cli() {
  const command = process.argv[2];
  if (process.argv.length !== 3 || !['create', 'reset-password'].includes(command ?? '')) throw new Error('Usage: account create | account reset-password (interactive only).');
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Use an interactive container terminal.');
  const pool = new Pool(databaseConfig());
  try {
    let login = ''; let displayName = '';
    if (command === 'create') {
      const readline = createInterface({ input: process.stdin, output: process.stdout });
      try { login = await readline.question('Login: '); displayName = await readline.question('Display name: '); }
      finally { readline.close(); }
    }
    let password = await hiddenInput('New login password (hidden): ');
    let confirmation = await hiddenInput('Repeat login password (hidden): ');
    if (password !== confirmation) throw new Error('Passwords do not match.');
    if (command === 'create') {
      const accounts = new AccountService({ repository: new PostgresAccountRepository(pool), passwords: argon2Passwords, randomId: randomUUID });
      await accounts.createAccount({ login, displayName, password });
    } else { await resetPassword(pool, password); }
    password = ''; confirmation = '';
    console.log(command === 'create' ? 'Account created.' : 'Login password reset. All account sessions revoked; the vault unlock phrase is unchanged.');
  } finally { await pool.end(); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { await cli(); } catch { console.error('Account command failed. Check the command, TTY, password confirmation and database state.'); process.exitCode = 1; }
}
