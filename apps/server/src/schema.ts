import { vaultSchema } from '@zcorw/encrypted-vault/adapters/postgres';
export const applicationSchema = `
CREATE UNIQUE INDEX IF NOT EXISTS ac_single_account ON ac_accounts ((true));
CREATE TABLE IF NOT EXISTS zj_schema (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS zj_login_limits (key text PRIMARY KEY, window_start timestamptz NOT NULL, attempts integer NOT NULL);
CREATE TABLE IF NOT EXISTS zj_analysis_preferences (
  account_id uuid PRIMARY KEY REFERENCES ac_accounts(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK(provider IN('deepseek','openai')));
${vaultSchema({tablePrefix:'zj_',ownerTable:'ac_accounts'})}
INSERT INTO zj_schema(version) VALUES(1) ON CONFLICT DO NOTHING;
`;
