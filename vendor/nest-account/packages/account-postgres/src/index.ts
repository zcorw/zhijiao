import { fileURLToPath } from "node:url";
import { runner } from "node-pg-migrate";
import type { Pool, PoolClient } from "pg";
import {
  AccountError,
  type Account,
  type AccountRepository,
  type StoredAccount,
} from "@tts-workbench/account-core";
const projection = 'id, login, display_name AS "displayName", status';
export class PostgresAccountRepository implements AccountRepository {
  constructor(private readonly pool: Pool) {}
  async create(a: StoredAccount): Promise<Account> {
    try {
      return (
        await this.pool.query(
          `INSERT INTO ac_accounts(id,login,display_name,password_hash,status) VALUES($1,$2,$3,$4,$5) RETURNING ${projection}`,
          [a.id, a.login, a.displayName, a.passwordHash, a.status],
        )
      ).rows[0];
    } catch (e) {
      if ((e as { code?: string }).code === "23505")
        throw new AccountError("ALREADY_EXISTS");
      throw e;
    }
  }
  async findByLogin(login: string): Promise<StoredAccount | undefined> {
    return (
      await this.pool.query(
        `SELECT ${projection}, password_hash AS "passwordHash" FROM ac_accounts WHERE login=$1`,
        [login],
      )
    ).rows[0];
  }
  async get(id: string): Promise<Account | undefined> {
    return (
      await this.pool.query(
        `SELECT ${projection} FROM ac_accounts WHERE id=$1`,
        [id],
      )
    ).rows[0];
  }
  async updateDisplayName(
    id: string,
    displayName: string,
  ): Promise<Account | undefined> {
    return (
      await this.pool.query(
        `UPDATE ac_accounts SET display_name=$2 WHERE id=$1 AND status='active' RETURNING ${projection}`,
        [id, displayName],
      )
    ).rows[0];
  }
  async disable(id: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "UPDATE ac_accounts SET status='disabled',auth_version=auth_version+1 WHERE id=$1",
        [id],
      );
      await client.query(
        "INSERT INTO ac_session_revocations(sid) SELECT sid FROM ac_sessions WHERE sess->>'accountId'=$1 ON CONFLICT DO NOTHING",
        [id],
      );
      await client.query("DELETE FROM ac_sessions WHERE sess->>'accountId'=$1", [id]);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
}
export async function migrateAccounts(databaseUrl: string | PoolClient): Promise<void> {
  await runner({
    ...(typeof databaseUrl === 'string' ? { databaseUrl } : { dbClient: databaseUrl }),
    dir: fileURLToPath(new URL("../migrations/", import.meta.url)),
    direction: "up",
    migrationsTable: "ac_migrations",
    log: () => {},
  });
}
