# Account library reuse and server integration

`vendor/nest-account` preserves the user's private `zcorw/nest-account` source at commit `ff46461641917ca4dfc3b84284d31bcedb193159`, version `0.1.1`, default branch `codex/article-management`. The original README is preserved as `UPSTREAM-README.md`. There is no upstream LICENSE. This private project uses the owner's explicit authorization; this is not permission to publicly redistribute the source. The original checkout and PR #1 were not edited or merged.

The application imports the actual upstream `AccountModule`, `AccountService`, `PostgresAccountRepository`, Argon2id password hasher, and `HashedSessionStore`. Node >=22.12 and Nest 12.1.2 satisfy the upstream ESM and Nest peer requirements. Dependencies and the source commit are fixed. The single-account restriction is enforced by this application's database unique index, while the reusable account service keeps its existing creation API.

## Changes to propose upstream separately

The local integration copy fixes `resolveAccountSession` so rolling cookies retain `idleMs` (or the original configured maxAge) and are bounded by absolute expiry. It adds account `auth_version`, durable SHA-256 SID revocation rows, and account/session transaction locks. Session expiration uses timestamptz so a Node host in another timezone cannot lengthen or shorten the stored lifetime. Save and touch validate account state/version; save rejects revoked SIDs, and touch only updates an existing unexpired row. Destroy records the SID before deleting it. Disabling an account increments its auth version and durably revokes its existing sessions. These changes require the added upstream migrations; applying them invalidates legacy sessions.

`migrateAccounts` also accepts a PostgreSQL pool client so the application can retain one advisory migration lock while running the original migration files. No automatic migration occurs at startup. The application migration adds the single-account index and encrypted storage schema under that same lock. Re-running the migration is safe; schema versions are recorded. Forward migrations are supported; restore a pre-upgrade database backup when rolling back incompatible schema changes.

These changes need review and consumer tests before a separately coordinated upstream PR. They have not been submitted to or merged into `nest-account`.

## Application security responsibilities

The application implements login, logout, current account, a Nest guard, observed user-agent session summaries, and single/other-session revocation. Login regenerates the SID and CSRF token. A password-hash/version snapshot is rechecked after credential verification; a reset overlapping verification cannot issue a surviving session. Persisting the new session checks the version again, covering a reset after the snapshot transaction. Password reset locks the account, increments the version, records revocations, and deletes its sessions in one transaction. Revoking other sessions also advances the account version while atomically retaining the current SID under that version, invalidating pending login verification. Resource writes recheck the same account version and live SID before locking the owned vault.

Every unsafe API request requires the exact configured Origin and an ASCII CSRF token. Login attempts are limited by persistent, HMAC-obscured IP and login buckets. Cookies use HttpOnly, SameSite=Lax, an idle limit and an absolute limit; Secure is enabled for an HTTPS APP_ORIGIN, which production requires. Configure proxy trust only for the actual trusted proxy hop. Account registration, email verification and email recovery have no HTTP route. There is no route to reset a login password.

Run `npm run account -- create` or `npm run account -- reset-password` in an interactive container TTY after migration. Login/display name are prompted; password and confirmation use hidden input. No password argument or password environment variable is accepted. SQL receives only the Argon2id hash. The login password reset leaves all encrypted vault keys unchanged and cannot unlock the vault. JavaScript strings cannot promise physical memory erasure.

## Ciphertext storage and synchronization

Business record bodies, relationships, sensitive fields and avatar references remain encrypted client-side. The server accepts only strict envelope fields and bounded ciphertext; asset ciphertext is stored in bytea and loaded through a separate versioned API. Every vault, history, key-bundle, change and asset route checks ownership. Sensitive payloads and raw session IDs are not logged. API responses disable caching.

One vault row lock allocates transaction-ordered BIGINT cursors, transmitted as decimal strings. Each operation atomically applies CAS checks, current pointers, immutable versions, changelog entries and its idempotent result. A reused operation ID with another payload fails. Fixed high-watermark pages read immutable versions and advance across gaps in other lanes. Person and directory mutations share this batch boundary; the server cannot inspect their encrypted semantic relationship. Tombstones remain versioned, stale offline revisions conflict, and restoration submits a new revision rather than deleting history.

The key-bundle schema validates PBKDF2/SHA-256 iterations 600000–2000000, canonical 16-byte salt, 12-byte nonce and 48-byte wrapped AES keys. Optional previous wrapped keys are unique, older than the current version, and limited to 1000. Rewrapping retains the key version; rotation advances one version and must cover all versions used by stored ciphertext. New writes must use the current key version; stale devices receive `409 KEY_VERSION_CONFLICT` with `keyVersion` and `keyBundleRevision`. Successful operation retries remain idempotent after rotation. Algorithms and browser implementations are not claimed to be audited.

All asset versions and key-bundle history can be enumerated for complete backups. Historical wrappers and independent backups may remain decryptable with an old phrase; rewrapping does not revoke an already acquired wrapper/key. A data-key rotation protects future writes but cannot erase old copies. Revocation tombstones and record history currently have no automatic expiration. Their retention policy needs an explicit decision; the 30-day backup policy does not implicitly expire them.

## Validation

Tests use fictional accounts and a dedicated real PostgreSQL database selected by `TEST_DATABASE_URL`; the database name must contain `test` or `ci`. Without that variable the integration suite is explicitly skipped, not reported as validated. Tests cover migration replay, the single-account constraint, authentication/Origin/CSRF/SID rotation, session listing and revocation, competing session saves and destroy, password resets overlapping login, disabled accounts, persistent rate limits, CAS rollback/idempotency, immutable high-watermark pages, tombstones/restoration, key rotation and all asset/key-bundle versions. Unit tests also check idle/absolute boundaries and non-ASCII CSRF rejection.

Real PostgreSQL checks do not replace browser, HTTPS proxy, Docker image, external backup storage or VPS restore validation. Those environments must be tested before production use; this task does not deploy production.
