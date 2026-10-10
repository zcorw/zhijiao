# Nest Account

独立 NestJS 账户库，无 TTS 或应用源码依赖。Node 22.12+，Nest 12，ESM。

```sh
npm ci
npm run build
# TEST_DATABASE_URL 指向隔离 PostgreSQL，未提供时DB测试明确skip
npm test
npm run pack:all
```

`@tts-workbench/account-core` 提供 AccountModule.registerAsync、AccountService、Repository/PasswordHasher端口、Zod账户校验与Argon2id适配；没有HTTP路由、全局Guard或导入时连接数据库。宿主通过 useFactory 显式注入 repository/passwords/randomId。

`@tts-workbench/account-postgres` 提供 PostgreSQL 参数化SQL实现、node-pg-migrate显式迁移；`/session` 是可选的Express HTTP适配入口，使用express-session与connect-pg-simple，核心包不依赖Express。宿主负责Cookie路由/CSRF/权限，不传客户端身份到业务存储。会话ID只按标准SHA-256摘要落库；密码使用@node-rs/argon2的Argon2id（19MiB、2次、1并行，基准见测试）。禁用状态每次请求读取；并发禁用后即使旧在途请求留下Session记录也不能再认证。

迁移必须由宿主显式调用 `migrateAccounts(databaseUrl)`；import不迁移。宿主持有Pool并负责关闭。登录后regenerate Session以防固定攻击，再写accountId及absoluteExpiresAt；resolveAccountSession逐次验证状态/绝对到期，数据库expire控制空闲到期。绝对7天、空闲24小时为当前宿主默认，可按产品另设策略。

本地分发使用artifacts内0.1.1 tgz，应用复制至自身vendor并锁定完整性，不能用兄弟src依赖。发布新版本时更新版本/产物/消费锁；正式私有registry可替代tgz。

独立消费检查在tests/consumer：只安装vendor包，`npm ci && npm test`，可复制该目录至其他路径执行；账户核心可在无数据库的第二Nest宿主使用。数据库测试必须使用专用测试库，测试仅清理由自身随机ID创建的账号。

成熟工具：[Argon2](https://github.com/napi-rs/node-rs/tree/main/packages/argon2)、[express-session](https://github.com/expressjs/session)、[connect-pg-simple](https://github.com/voxpelli/node-connect-pg-simple)、[node-pg-migrate](https://github.com/salsita/node-pg-migrate)。本项目自行实现的是账户用例和身份状态边界，未自写密码算法、Cookie签名或迁移框架。

密码规则：创建与登录统一接受8–128字符；没有修改密码接口。无需迁移数据库或重置已有密码。
