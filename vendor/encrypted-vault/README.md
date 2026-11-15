# encrypted-vault

为 Web 应用提供**客户端加密、本地密文缓存、离线写入队列和服务器版本同步**的 TypeScript 组件。业务系统通过同一个 `VaultClient<T>` 完成保存、同步、冲突比较、历史恢复和密钥管理，服务器保存密文及必要的路由、版本元数据。

模块通过业务记录、网络传输和存储适配接口接入不同应用。`examples/note.ts` 使用普通笔记模型演示客户端与服务器的独立接入方式。

本仓库同时提供客户端 SDK 和服务器同步模块，两者在各自的运行环境中分别使用。服务器核心依赖存储接口，不指定数据库。宿主应用负责账号登录、HTTP 路由和业务界面。尚未发布到 npm，也未经过独立安全审计。

## 客户端与服务器分别如何使用

| 部分 | 导入入口 | 运行位置与职责 |
| --- | --- | --- |
| 客户端 SDK | `@zcorw/encrypted-vault/client`（根入口也兼容） | 浏览器或具备 Web Crypto 的客户端；生成和解锁密钥、加解密、本地缓存、离线队列、发起同步 |
| 服务器同步核心 | `@zcorw/encrypted-vault/server` | Node.js 服务；处理归属、版本、幂等、冲突和增量同步；通过 `VaultRepository` 读写密文 |
| 数据库适配器 | `/adapters/postgres` 或宿主自定义模块 | 实现服务器存储、事务和并发隔离；选择适合宿主的数据库 |
| 内存参考适配器 | `/adapters/memory` | 在同一套服务器核心上运行测试，无持久化能力 |
| 共享协议 | `/protocol` | 两端使用同一密文、操作、版本和同步分页契约 |

这是同一个仓库提供的不同入口，不会把两端代码一起运行，也不要求浏览器安装数据库驱动。客户端只导入 SDK，服务器只导入同步核心及自己选择的存储适配器。解锁口令、恢复秘密和业务明文由客户端持有；服务器不需要解密密钥。

调用关系为：客户端 `VaultClient` → 宿主 HTTP 接口 → 服务器 `VaultService` → `VaultRepository` → 所选数据库。客户端自己的本机存储由独立的 `VaultStore` 接口管理。

## 能力与边界

| 能力 | 行为 |
| --- | --- |
| 加密 | Web Crypto AES-256-GCM，随机 nonce，认证资料库/记录/版本/通道等路由信息 |
| 密钥 | 随机数据密钥，PBKDF2-SHA-256 包装口令，独立随机恢复秘密，口令重包装和数据密钥轮换 |
| 本地持久化 | 显式注入 VaultStore；适配器仅保存密文、包装密钥、游标和 outbox，解锁明文保留在会话内存 |
| 离线修改 | 先以本地事务持久化操作，再上传；应用重载后仍保留待同步操作 |
| 同步 | 目录优先、分通道增量下载、固定高水位分页、operationId 幂等、expectedRevision CAS |
| 冲突 | 保留本机与云端候选，显式丢弃或由业务重新编辑；不自动合并文本 |
| 历史 | 不可变版本、删除墓碑；恢复旧版本生成新版本 |
| 备份 | 通用结构化记录的完整加密备份、验证预览及本地导入 |
| 服务端 | 无 HTTP 框架及数据库驱动依赖的同步核心、存储/事务接口；具体数据库使用可选适配器 |

业务校验、派生目录、关联删除、附件格式和图片处理由宿主适配层实现。v1 附件路由兼容 `main` / `thumb` 两种 variant；底层接口可以保存资产密文，但通用备份遇到资产会报 `BACKUP_ASSET_ADAPTER_REQUIRED`，需要宿主实现附件密钥封装、验证与备份扩展，避免把未经验证的附件标为可恢复。

客户端必须显式传入 `VaultStore`，库不会自动选择本地数据库。自带 `IndexedDbStore` 浏览器适配器及 `MemoryStore` 测试适配器。服务器必须显式传入 `VaultRepository`，自带 PostgreSQL 和非持久化内存实现。SQLite、MySQL 等可实现同一接口，但目前未附带这些数据库的驱动适配器；移动端安全存储及非 JavaScript 客户端也尚未提供。

## 目录与导出

```text
src/
  protocol.ts    密文、操作、版本和同步分页契约
  crypto.ts      加密与密钥管理；保留 v1 历史兼容常量
  storage.ts     VaultStore、IndexedDbStore、MemoryStore
  transport.ts   VaultTransport、HttpVaultTransport、ApiError
  adapter.ts     VaultRecord、RecordAdapter、扩展上下文
  client.ts      统一的加密缓存与同步引擎
  backup.ts      通用结构化记录备份
  server.ts      数据库无关的 VaultService、VaultError
  repository.ts  VaultReader、VaultTransaction、VaultRepository
  adapters/
    memory.ts           非持久化参考实现
    postgres.ts         可选 PostgreSQL 数据访问实现
    postgres-schema.ts  仅该适配器使用的表结构
examples/note.ts 可运行测试所使用的业务模型
tests/          单元、兼容性和真实 PostgreSQL 集成测试
```

包名为 `@zcorw/encrypted-vault`。根入口与 `/client` 导出客户端；`/protocol`、`/crypto`、`/storage`、`/transport` 可按需使用。`/server` 导出 `VaultService`、`VaultError`、存储接口和 `keyBundleSchema`，不导入任何数据库适配器或驱动。`/adapters/postgres` 单独导出 `PostgresVaultRepository`、`PostgresVaultTransaction`、`vaultSchema`、`validateTablePrefix`；`/adapters/memory` 导出服务器内存参考适配器。浏览器入口不导入 Node.js 服务端代码。

## 安装与开发

需要 Node.js ≥ 22.12.0、npm。浏览器必须支持安全上下文中的 Web Crypto 和 IndexedDB（生产使用 HTTPS）。服务器数据库由宿主选择。只有验证自带的 PostgreSQL 适配器时才需要 PostgreSQL 及独立的可丢弃测试库。

```sh
npm ci
npm run typecheck
npm run lint
npm test
npm run build
npm pack --dry-run
```

尚未发布 npm 包时，在本仓库执行 `npm pack`，再在消费项目中执行 `npm install /path/to/zcorw-encrypted-vault-0.2.0.tgz`。包中包含编译后的 ESM 和 `.d.ts`，无需依赖本仓库的源码路径。使用通用 `/server` 不需要安装 `pg`；选择 PostgreSQL 适配器时，宿主才需要安装 `pg`。该驱动在包声明中是可选 peer，仅被适配器及其测试使用。

```sh
# 仅用于可丢弃数据库；测试创建自己的随机前缀表并在完成后删除这些表。
TEST_DATABASE_URL=postgres://user:password@127.0.0.1:5432/encrypted_vault_test npm run test:integration
```

PowerShell 使用 `$env:TEST_DATABASE_URL = '...'` 后运行命令。没有配置该变量时集成测试会跳过，因此单独的 `npm test` 不代表数据库验证通过。CI 配置包含独立 PostgreSQL 服务。

## 客户端接入

业务记录至少包含 UUID `id`、UUID `ownerId` 和非空 `kind`。字段校验交由 `RecordAdapter<T>.parse`，请使用严格 schema，解密不等于业务数据已经有效。

```ts
import { z } from 'zod';
import {
  VaultClient, IndexedDbStore, HttpVaultTransport,
  type RecordAdapter,
} from '@zcorw/encrypted-vault/client';

const noteSchema = z.strictObject({
  id: z.string().uuid(), ownerId: z.string().uuid(), kind: z.literal('note'),
  title: z.string().min(1), content: z.string(), updatedAt: z.iso.datetime(),
});
type Note = z.infer<typeof noteSchema>;
const adapter: RecordAdapter<Note> = {
  parse: value => noteSchema.parse(value),
  lane: () => 'records',
};

// 三个值由宿主登录流程取得；解锁口令应与登录密码分别管理。
declare const authenticatedUserId: string;
declare const csrfToken: string;
declare const unlockPhrase: string;

const transport = new HttpVaultTransport('/api');
transport.csrfToken = csrfToken;
const client = new VaultClient<Note>({
  adapter, transport, ownerId: authenticatedUserId,
  store: new IndexedDbStore('my-notes-encrypted-v1'),
  autoSync: false,
});
const unsubscribe = client.subscribe(state => {
  // 将 state.pending、state.conflicts、state.syncing 等映射到界面。
  void state;
});

const { vault, recoverySecret } = await client.setup(unlockPhrase);
// 宿主应让用户单独、安全地保存 recoverySecret，不记录到日志或持久化明文缓存。
void recoverySecret;
await client.put({
  id: crypto.randomUUID(), ownerId: authenticatedUserId, kind: 'note',
  title: '第一条笔记', content: '正文', updatedAt: new Date().toISOString(),
});
await client.sync();

client.lock();
await client.open(vault.id);
await client.unlock(unlockPhrase);
await client.sync();
const notes = client.entities;
void notes;
unsubscribe();
client.lock();
```

`setup` 会联网创建资料库并完成本机解锁。新设备使用 `open(id)`、`unlock(secret)`。完全离线时用 `openCached(id)`、`unlock(secret)`；此时只读取本机已有资料，允许本机修改，上传会被阻止。宿主重新登录并更新传输层凭据后，调用 `resumeOnline()` 核对资料库归属，再允许同步。

`autoSync` 默认为 `true`，在解锁和本地写入后尝试同步；后台失败通过状态 `lastError` 暴露，不代表需要丢弃本地内容。设置为 `false` 可由宿主安排同步时机。`put` / `saveBatch` 成功表示本地事务已提交，**不代表云端已保存**；显式等待 `sync()` 并检查 `pending` 和 `conflicts`。

### 配置与业务适配

```ts
interface RecordAdapter<T extends VaultRecord> {
  parse(value: unknown): T;
  lane(record: T): 'directory' | 'records';
  references?(record: T): Array<{ id: string; kind: string }>;
}
interface VaultRecord {
  id: string;
  ownerId: string;
  kind: string;
  updatedAt?: string;
}
```

`references` 是可选的本机写入校验，会检查引用的记录是否已存在且类型一致。跨记录删除策略、目录投影、引用级联和只同步了目录时的业务规则由宿主实现。`ownerId` 配置应传入已登录账号 ID；传入后会检查资料库与备份归属。

显式选择 `new IndexedDbStore()` 时，该适配器的默认缓存名为 `encrypted-vault-v1`；通用引擎本身没有默认存储实现。不同应用应明确指定独立的数据库名，并使用独立的服务器表前缀或部署及独立密钥。数据库名用于本机隔离，不构成服务器应用访问控制。共用服务时，宿主仍需按应用及租户约束路由、账号和资料库授权。

### 客户端接口

| 接口 | 返回 / 说明 |
| --- | --- |
| `new VaultClient<T>({ adapter, transport, store, ownerId?, autoSync? })` | `store` 必填，显式选择本机存储；测试可使用 `MemoryStore` |
| `setup(passphrase)` | `{ vault, recoverySecret }`；口令长度 12–1024 字符 |
| `listLocalVaults()` | 本机已保存的 `VaultDescriptor[]` |
| `open(vaultId)` | 联网获取资料库；仅网络类失败且已有缓存时可回退本机，401/403 等 API 错误不降级 |
| `openCached(vaultId)` | 只打开已有缓存，进入限制上传的离线模式 |
| `unlock(secret, { recovery? })` | 本机解锁；`recovery:true` 使用恢复秘密 |
| `lock()` | 同步清理明文和密钥引用，使在途异步操作失效 |
| `resumeOnline()` | 通过宿主已恢复的认证连接核对资料库，再同步 |
| `put(record)` / `saveBatch(records)` | 返回本机持久化的 `Operation` |
| `mutateBatch(records, deleteIds)` | 同一原子操作中更新与删除，最多 100 个底层 mutation |
| `delete(recordId)` | 生成删除墓碑；普通保存不会复活墓碑 |
| `sync()` | 合并同实例的并发同步请求；上传并下载增量 |
| `history(recordId)` | `HistoryEntry<T>[]`，含 revision、tombstone、可选 entity |
| `deletedEntities()` | 本机历史中每条已删除正文的最新删除前版本；不是全库查询 |
| `restore(recordId, revision)` | 将选定历史恢复成新版本；不改写旧历史 |
| `conflicts()` | `ConflictView<T>[]`，含 operationId、code、local、remote |
| `discardConflict(operationId)` | 显式采用云端；同时丢弃依赖受影响记录的后续本机操作。应先备份候选 |
| `rewrap(newPassphrase)` | 只更换口令包装，不轮换数据密钥，原恢复秘密继续有效 |
| `rotateDataKey(newPassphrase)` | `{ recoverySecret, keyVersion, completed }`；换新数据密钥与恢复秘密，重写当前记录，保留旧历史密钥 |
| `resumeRotation()` | 继续中断的数据密钥轮换 |
| `exportBackup()` | 完整加密备份 JSON 字符串；需要联网同步完整历史 |
| `previewBackup(text, secret, { recovery? })` | 验证后返回不可伪造的本会话 `BackupPreview` 对象 |
| `importBackup(preview, { confirm:true })` | 只导入本机，目标同一资料库不能已有记录或待同步操作；不会删除现有内容 |
| `subscribe(listener)` | 立即推送一次状态并返回取消订阅函数 |
| `state` / `vault` / `entities` / `directoryEntries` | 状态、资料库描述、已解锁正文及目录的副本；锁定后记录数组为空 |

`HistoryEntry`、`ConflictView` 均支持泛型参数。版本、游标、`expectedRevision`、`keyBundleRevision` 使用十进制**字符串**，不能转为 JavaScript `number` 后运算；密钥版本和格式版本为数字。资料库与记录 ID 使用 UUID。

`ClientState` 字段为：`locked`、`vaultId?`、`directoryComplete`、`recordsComplete`、`pending`、`conflicts`、`syncing`、`rotating`、`offlineMode`、`lastError?`。`Complete` 表示已下载的快照完整，不表示不会再有远端修改。同步遇到业务冲突可以正常返回，应同时检查 `state.conflicts`。

`BackupPreview` 包含 `vaultId`、`createdAt`、`records`、`assets`、`pending`。它由验证结果关联到内部数据，复制字段或 JSON 反序列化得到的新对象不可用于导入。使用干净且锁定的客户端执行恢复。导入自身不上传；后续解锁时如启用自动同步，仍会按正常同步策略处理恢复的队列。

### 持久化适配器

```ts
interface VaultStore {
  read(id: string): Promise<StoredVault | undefined>;
  list(): Promise<VaultDescriptor[]>;
  update(
    id: string,
    mutate: (previous: StoredVault | undefined) => StoredVault,
    signal?: AbortSignal,
  ): Promise<void>;
}
```

`StoredVault` 包含 `descriptor`、`keyBundles`、`envelopes`、`outbox`、`cursors` 和 `complete`。自定义 SQLite 等适配器必须在同一事务中读取旧值、执行同步 `mutate` 回调并提交新值；异常与取消必须回滚，不能以独立 read/write 替代。适配器应提供值的副本并保留不可变历史检查；缓存和 outbox 不得写入业务明文。

现有 IndexedDB 实现以资料库快照为事务单位，适合当前规模；大数据量时读写放大会增加，需要新的存储布局与显式迁移。

### 网络适配器

`HttpVaultTransport(baseUrl = '/api', requestFetch = fetch)` 默认同源 cookie、JSON、`cache:'no-store'`；写请求携带其可更新的 `csrfToken` 属性。Bearer token、跨域等通过宿主注入的 fetch 包装器处理，并配套配置服务器 CORS、凭据与 CSRF 策略。

自定义传输必须实现以下方法（末尾均支持可选 `AbortSignal`）：

```ts
list(signal?): Promise<VaultDescriptor[]>;
get(id, signal?): Promise<VaultDescriptor>;
create(id, keyBundle, signal?): Promise<VaultDescriptor>;
keyBundles(id, signal?): Promise<unknown[]>;
rewrap(id, expectedRevision, keyBundle, signal?): Promise<VaultDescriptor>;
commit(id, operation, signal?): Promise<OperationResult>;
changes(id, lane, after, until?, signal?): Promise<ChangePage>;
history(id, recordId, signal?): Promise<CipherEnvelope[]>;
assets(id, signal?): Promise<AssetVersion[]>;
asset(id, recordId, revision, signal?): Promise<CipherEnvelope>;
```

自定义适配器应将服务端结构化错误转为 `ApiError(status, body)`，让客户端识别版本及密钥冲突。网络故障可保留普通网络异常；不要把认证失败包装成网络故障，以免触发离线回退。

## 服务端接入：先选择存储接口的实现

`VaultService<P, Tx>` 负责同步规则，通过 `VaultRepository<Tx>` 接口执行持久化操作。核心中没有 SQL、表名、连接池或数据库驱动类型。替换数据库只需要提供另一个适配器，客户端协议与 HTTP 路由保持一致。

```ts
import {
  VaultService, type VaultRepository, type VaultTransaction,
} from '@zcorw/encrypted-vault/server';

// 由宿主实现或注入，具体数据库不进入同步核心。
declare const repository: VaultRepository<VaultTransaction>;
type Principal = { id: string; sessionId: string };
declare function verifySessionInTransaction(
  transaction: VaultTransaction, principal: Principal,
): Promise<void>;

const service = new VaultService<Principal, VaultTransaction>(repository, {
  authorizeWrite: verifySessionInTransaction,
});
void service;
```

测试可以传入 `new MemoryVaultRepository()`（从 `/adapters/memory` 导入），该实现通过事务草稿和实例内互斥提供回滚与隔离，进程结束后数据会丢失。它是可运行的接口参考和测试工具，不能作为多进程生产持久化实现。客户端的 `MemoryStore` 与服务器的 `MemoryVaultRepository` 是两个不同接口的适配器。

### 服务器存储接口

`VaultReader` 定义读取能力；`VaultTransaction` 在同一读取视图上增加原子写入；`VaultRepository` 提供事务入口。完整类型从 `/server` 导出，定义位于 `src/repository.ts`。

```ts
interface VaultRepository<Tx extends VaultTransaction> extends VaultReader {
  transaction<T>(work: (transaction: Tx) => Promise<T>): Promise<T>;
}
interface VaultTransaction extends VaultReader {
  lockVault(id: string, ownerId: string): Promise<VaultRow | undefined>;
  createVault(descriptor: VaultDescriptor): Promise<boolean>;
  updateKeyBundle(id: string, revision: string, bundle: unknown): Promise<void>;
  appendVersions(id: string, changes: VaultChange[], cursor: string): Promise<void>;
  saveOperation(id: string, operationId: string, receipt: OperationReceipt): Promise<void>;
}
interface VaultRow extends VaultDescriptor { cursor: string }
interface VaultChange { envelope: CipherEnvelope; cursor: string }
interface OperationReceipt { requestHash: string; result: OperationResult }
```

| `VaultReader` 方法 | 返回及要求 |
| --- | --- |
| `listVaults(ownerId)` | 当前账号的资料库描述数组 |
| `getVault(id, ownerId)` | 带 cursor 的资料库；不存在或不属于该账号时 undefined |
| `keyBundles(vaultId)` | 按包装版本升序的密钥包历史 |
| `keyVersions(vaultId)` | 历史实际使用的数据密钥版本集合 |
| `getOperation(vaultId, operationId)` | 已提交的 requestHash 与原始确认结果，或 undefined |
| `current(vaultId, recordIds)` | 所选记录的当前密文，包括墓碑 |
| `changes(vaultId, lane, after, until, limit)` | cursor 升序的 VaultChange 数组；范围为 after < cursor ≤ until，最多 limit 条 |
| `history(vaultId, recordId)` | 目录/正文历史，revision 升序，不混入 assets |
| `assets(vaultId)` | 所有资产版本标识，按 cursor 排序 |
| `asset(vaultId, recordId, revision)` | 对应资产密文或 undefined |

适配器必须保证以下事务语义，否则无法安全替换数据库：

1. `transaction` 的回调成功才提交；任何异常都回滚密文版本、当前指针、游标、变更日志、密钥包历史与幂等确认记录，不允许部分提交或脏读。
2. `lockVault` 必须把同一资料库的并发写入串行化至事务结束，覆盖多个服务器实例/进程；可以使用该数据库的锁、可串行化事务或其他等价机制。
3. `createVault` 必须原子保留全局唯一的资料库 ID，并保存初始密钥包；并发重复创建返回 false，让同步核心统一返回 `VAULT_EXISTS`。
4. 历史版本、cursor 和 operationId 的唯一性必须由持久化实现保证。`appendVersions` 同时维护当前指针、变更日志与资料库水位；不能拆成事务外的多次写入。
5. 返回值是可分离的数据，调用方修改返回对象不能更改存储内容。事务句柄只在回调内有效，提交或回滚后必须拒绝继续使用。

这些是存储契约，而不是一层通用 `query(sql)` 包装；表结构、SQL 方言和驱动只存在于具体适配器。新适配器可以复用 `tests/repository-contract.ts` 的同一组契约测试，验证回滚、脏读、并发 CAS、ID 保留、返回值隔离、过期事务句柄和幂等确认。接口内部读取方法不是直接面向 HTTP 的授权入口，所有外部请求须经过 `VaultService` 及宿主认证。

### 可选 PostgreSQL 适配器

以下示例是宿主选择 PostgreSQL 的一种接法，不是库对所有应用的数据库要求。

```ts
import { Pool } from 'pg';
import { VaultService, VaultError } from '@zcorw/encrypted-vault/server';
import {
  PostgresVaultRepository, type PostgresVaultTransaction, vaultSchema,
} from '@zcorw/encrypted-vault/adapters/postgres';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
await pool.query(vaultSchema({ tablePrefix: 'notes_', ownerTable: 'app_users' }));
const repository = new PostgresVaultRepository(pool, { tablePrefix: 'notes_' });
type Principal = { id: string; sessionId: string };
const service = new VaultService<Principal, PostgresVaultTransaction>(repository, {
  authorizeWrite: async (transaction, principal) => {
    // client 是适配器扩展；通用 VaultTransaction 不包含数据库驱动。
    const db = transaction.client;
    const user = (await db.query(
      'SELECT active FROM app_users WHERE id=$1 FOR UPDATE', [principal.id],
    )).rows[0];
    const session = (await db.query(
      'SELECT 1 FROM app_sessions WHERE id=$1 AND user_id=$2 AND expires_at>now()',
      [principal.sessionId, principal.id],
    )).rowCount;
    if (!user?.active || !session) throw new VaultError(401, { code: 'AUTH_REQUIRED' });
  },
});
void service;
```

`app_users` / `app_sessions` 属于示例宿主，须先自行创建并实现会话管理。只有 PostgreSQL 适配器提供 `vaultSchema({ tablePrefix = 'ev_', ownerTable?, ownerColumn = 'id' })`；它生成六张带前缀的表：vaults、key_bundles、versions、current、changelog、operations。省略 ownerTable 时不绑定账号外键。表名必须是受控配置；其他适配器使用自己的迁移与存储布局，通用核心不要求这六张表。

构造器必须提供 `authorizeWrite`，没有默认放行实现。回调在 create、rewrap、operate 的事务内、资料库写入之前执行；宿主可以通过自己选择的适配器扩展，在同一事务内验证账号/会话并采用兼容的认证锁策略。回调不能自行提交、回滚或释放连接，也不能保存事务句柄稍后使用。

宿主 HTTP 认证中间件仍须保护所有读写路由，从已验证会话读取 principal，不能使用请求正文里的 ownerId 作为授权身份。cookie 接口还须由宿主提供 CSRF、请求体大小限制和适当的缓存头。核心不会创建账号、启动 HTTP 服务或替宿主选择数据库。

### HTTP 路由与 service 方法

以下路由相对于 `HttpVaultTransport` 的 baseUrl。宿主可使用 NestJS、Express、Fastify 或 Node HTTP 进行映射。

| HTTP | service 调用 | 输入 / 输出 |
| --- | --- | --- |
| `GET /vaults` | `list(ownerId)` | 资料库数组 |
| `POST /vaults` | `create(principal, body)` | `{ id, keyBundle }` → descriptor |
| `GET /vaults/:id` | `get(id, ownerId)` | descriptor，附带 keyBundleHistory |
| `GET /vaults/:id/key-bundles` | `bundles(id, ownerId)` | 密钥包历史 |
| `PUT /vaults/:id/key-bundle` | `rewrap(id, principal, body)` | `{ expectedRevision, keyBundle }` → descriptor |
| `POST /vaults/:id/operations` | `operate(id, principal, body)` | Operation → OperationResult |
| `GET /vaults/:id/changes` | `changes(id, ownerId, query)` | `lane, after?, until?, limit?` → ChangePage |
| `GET /vaults/:id/records/:recordId/history` | `history(id, ownerId, recordId)` | 按版本升序的正文/目录密文数组 |
| `GET /vaults/:id/assets` | `assets(id, ownerId)` | 资产版本标识数组 |
| `GET /vaults/:id/assets/:recordId?revision=…` | `asset(id, ownerId, recordId, revision)` | 指定资产密文 |

成功返回 JSON。捕获 `VaultError` 后使用其 `status` 与 `body` 返回；其他异常由宿主记录受控诊断，并向客户端返回固定错误码，不返回堆栈或数据库错误正文。未知/无权资料库返回 404。写操作通过所选适配器的事务执行：任何 mutation 冲突或失败都会回滚整批。

### 同步协议

```ts
interface Operation {
  operationId: string; // UUID；重试必须复用同一 ID 和原始输入
  mutations: Array<{ expectedRevision: string; envelope: CipherEnvelope }>;
}
interface OperationResult {
  operationId: string;
  envelopes: CipherEnvelope[];
  cursor: string;
}
interface ChangePage {
  envelopes: CipherEnvelope[];
  after: string;
  highWatermark: string;
  hasMore: boolean;
}
```

`CipherEnvelope` 包含 `vaultId`、`recordId`、`revision`、`formatVersion:1`、`keyVersion`、`lane`、`tombstone`、可选 `variant`，以及 base64 `nonce` / `ciphertext`。新记录 `expectedRevision:'0'`、`revision:'1'`，每次更新递增一。服务端不能重写加密认证元数据。

同一 operationId 与相同输入会得到原确认结果；重复 ID 携带不同输入会返回 `OPERATION_MISMATCH`。分页默认 100，最大 500；后续页沿用首个 `highWatermark` 作为 `until`，页尾推进至该水位。同步时先下载 directory，再下载 records；assets 按需读取，不出现在这两个通道的变化页中。

每批最多 100 个 mutation，解码后密文总量上限 12 MB；单个密文 base64 最长 6,000,000 字符。通用备份总大小上限 200 MB、历史密文条目上限 100,000、待同步操作上限 10,000。宿主反向代理和 JSON body 限额应与这些预算配套设置。

### 常用错误

| 错误 | 含义 / 宿主处理 |
| --- | --- |
| `AUTH_REQUIRED` / HTTP 401 | 重新登录，保留本机数据；不当作网络故障 |
| `VAULT_NOT_FOUND` / 404 | 不存在或无权访问 |
| `REVISION_CONFLICT` / 409 | 返回 current 密文候选；显示人工比较 |
| `KEY_VERSION_CONFLICT` / 409 | 本机操作使用旧数据密钥，保留候选，使用新口令重新解锁 |
| `OPERATION_MISMATCH` / 409 | 幂等 ID 被不同输入复用，不能自动重试不同请求 |
| `KEY_BUNDLE_CONFLICT` / 409 | 密钥包已被另一设备修改，重新获取 |
| `INVALID_PAYLOAD` / `INVALID_MUTATION` / 400 | 请求结构或版本、路由不合法 |
| `LOCAL_REVISION_CONFLICT` | 另一本机事务已推进记录版本，重新读取再提交 |
| `UNRESOLVED_CONFLICT` | 此记录仍有本机冲突，不允许覆盖候选 |
| `OFFLINE_MODE_SIGN_IN_REQUIRED` | 先由宿主登录，再 resumeOnline |
| `KEY_ROTATED_REUNLOCK_REQUIRED` | 已下载新密钥包，但当前会话尚未解锁新密钥 |
| `VAULT_LOCKED_OPERATION_CANCELLED` | 锁定后异步操作已失效，不再显示或落盘结果 |
| `BACKUP_IMPORT_REQUIRES_EMPTY_LOCAL_VAULT` | 使用干净目标恢复，不覆盖已有资料或队列 |

## 业务扩展与协议兼容

多数系统只需配置 `RecordAdapter<T>`。复杂业务可继承 `VaultClient<T>`，覆盖以下 protected 钩子；这些是 v0.2 的扩展接口，后续升级应回归验证。

| 钩子 | 用途 |
| --- | --- |
| `hydrateRecords(records, current, generation)` | 从已解密记录建立业务目录、默认记录及会话索引 |
| `prepareWrite(inputs, deleteIds, current)` | 校验业务关系并生成同批目录投影、扩展删除；返回 `{ entities, deleteIds }` |
| `prepareRestore(entity, keyVersion, lease)` | 验证恢复依赖、重包装附件引用，并返回待恢复的记录数组 |
| `rotateRecord(entity, newVersion, lease)` | 重包装业务记录携带的附件密钥等引用 |
| `onLock()` | 清理会话搜索索引、Blob URL 等业务资源 |
| `exportStoredBackup` / `previewStoredBackup` / `previewData` | 配套实现自定义备份格式、附件验证和不可伪造预览 |

需要自定义级联删除时覆盖 `mutateBatch`，通过受保护的串行队列和 `write` 提交同一操作。异步钩子应使用 `lease.signal`，并在等待后执行 `check(lease.generation)`，不要绕过通用引擎的取消与原子提交。

v1 的认证域标签和恢复秘密编码是固定协议常量，参与加解密和验证。直接改名会破坏已有数据的解密；修改这些常量须引入新的协议版本及迁移流程。通用备份格式为 `encrypted-vault-backup`，业务自定义格式由对应适配层负责验证。

接入系统应固定模块版本，并由自身配置存储命名空间与业务适配规则。更新模块时，需要验证接口、密文、备份及持久化数据的兼容性；使用源码副本的系统可通过导出脚本维护版本与校验清单。

从本仓库导出到宿主项目：

```sh
npm run export:vendor -- ../my-app/vendor/encrypted-vault
```

脚本导出库源码、包配置和说明，生成包含版本与 SHA-256 的 `SOURCE-MANIFEST.json`；不会复制 node_modules、账号库、宿主业务代码或本地数据库。目标目录必须为空或属于同名包。完整测试在本仓库维护，宿主应在自己的构建中校验快照并运行兼容回归。

## v0.1 → v0.2 迁移

- `PostgresVaultService(pool, options)` 替换为 `VaultService(new PostgresVaultRepository(pool, storageOptions), serviceOptions)`。
- `vaultSchema`、`validateTablePrefix` 从 `/adapters/postgres` 导入；`/server` 不再导出数据库专有接口。
- PostgreSQL 的认证回调从 `authorizeWrite(db, principal)` 改为 `authorizeWrite(transaction, principal)`，按需使用 `transaction.client.query`。
- 通用 `VaultClient` 必须传 `store`；`/client` 是明确的客户端入口，根入口仍兼容。
- v1 密文、恢复秘密和已保存 operationId 的哈希保持兼容；升级模块本身不要求转换已有密文。

## 数据与安全边界

服务器可见账号和资料库归属、记录 ID、版本、通道、密文大小及访问时序，不能将本方案描述为隐藏所有元数据。宿主仍需确保账号授权、TLS、XSS 防护和服务端备份。拥有用户页面执行权限的恶意脚本可能读取解锁内存。

锁定会清空应用持有的密钥、明文和会话资源引用，并使在途结果失效；浏览器/JavaScript 运行时不能保证物理擦除。IndexedDB 可能被浏览器或用户清理，应另存备份及恢复秘密。恢复秘密不能通过重置登录密码找回。

轮换会重写当前记录并保存旧历史所需的包装密钥，不能撤回泄漏的旧备份或离线密文。`completed:false` 表示新密钥包已安装但后续工作中断，必须保存返回的新恢复秘密，重新解锁后调用 `resumeRotation()`。

维护及许可状态见 [NOTICE.md](NOTICE.md)。实际本机验证记录见 [docs/verification.md](docs/verification.md)。
