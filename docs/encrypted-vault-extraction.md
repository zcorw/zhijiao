# 加密离线资料库模块抽取

独立模块已上传至 [zcorw/encrypted-vault](https://github.com/zcorw/encrypted-vault)，npm 包名为 `@zcorw/encrypted-vault`。本次固定 v0.2.0 源码提交 [a593514](https://github.com/zcorw/encrypted-vault/commit/a5935144be63846a5f6b79bc392cb140efe29a62)。用途、完整接口和通用接入示例维护在独立仓库 README 中。尚未发布 npm 或部署。

## 边界

- 独立库：密文协议、Web Crypto 加密/密钥管理、本地密文缓存、原子 outbox、增量同步、CAS/幂等、冲突保留、不可变历史、通用结构化记录备份，以及无 HTTP 框架和数据库驱动依赖的服务器同步核心。
- 知交适配层：人物与目录、拼音搜索、关系/议题校验与级联删除、默认“我”档案、头像处理、头像密钥重包装及旧业务备份验证。
- 知交宿主：现有 NestJS 路由、账号会话和 CSRF；写事务中的账号/会话二次认证通过 `authorizeWrite` 回调保留。

`packages/client` 的 `VaultClient` 继承独立通用引擎。原 crypto、storage、transport 文件保留导出入口；`packages/shared` 重导出通用协议。`apps/server/src/vaults.ts` 保留现有 controller 和认证适配，将 `PostgresVaultRepository` 注入数据库无关的 `VaultService`；全局异常过滤器将 `VaultError` 映射为原结构化 HTTP 响应。

v0.2 中，客户端必须传入 `VaultStore`，服务器必须传入 `VaultRepository`，通用层不替宿主选择数据库。知交的业务适配层仍明确选择 IndexedDB 和 PostgreSQL；数据库建表接口从 `/adapters/postgres` 导入，认证使用该适配器的 `transaction.client`。独立仓库同时提供客户端 `/client` 与服务器 `/server` 入口，在两个运行环境中分别调用。`/server` 不导入数据库驱动；可选 PostgreSQL 与内存参考实现位于 `/adapters/*`。其他数据库可以实现同样的事务接口，目前没有附带 SQLite/MySQL 驱动适配器。

## 兼容性

继续使用 `zhijiao-encrypted-v1` 本地库名、`zj_` PostgreSQL 表前缀、现有 UUID 与目录 ID 派生、v1 密文 AAD、包装密钥格式和 `ZJ1-` 恢复秘密。头像与 `zhijiao-backup` 的格式和业务校验继续留在知交。本次不清空缓存、不重命名数据库表、不要求重新加密原数据。

通用库的新备份格式为 `encrypted-vault-backup`，不声称能跳过业务适配直接恢复知交实体或头像。仅使用通用结构化记录的系统可直接使用默认备份；资产密钥封装与内容验证由对应业务扩展完成。

## 依赖固定与后续更新

知交的 `vendor/encrypted-vault` 是独立源码的固定快照，已纳入 npm workspaces 和锁文件。构建从该目录开始，不读取相邻项目，也不连接远端下载私有仓库代码。单独 checkout 或 Docker `COPY . .` 后仍可构建。

`SOURCE-MANIFEST.json` 保存版本和源码/包配置的 SHA-256；`npm run verify:vault` 检查副本完整性，`build:base` 会先执行此检查。

更新流程：

1. 在独立项目修改源码，执行类型、Lint、单元和 PostgreSQL 集成验证；修改通用行为时递增版本。
2. 在独立项目运行 `npm run export:vendor -- ../zhijiao/vendor/encrypted-vault`。脚本只导出源码及配置，刷新校验清单。
3. 知交显式调整依赖版本并更新锁文件，执行 `npm run verify:vault`、类型、Lint、单元、真实 HTTP/PostgreSQL 集成及相关浏览器回归。
4. 独立仓库有远端和提交后，在来源说明中记录具体提交/标签；不要在 vendor 副本单独修改引擎。

独立仓库不包含 `vendor/nest-account`，也不引用知交业务包。知交仅保存固定版本的通用模块源码；来源与校验清单随本仓库提交。

## 本轮验证

2026-11-15，v0.2 独立项目类型、Lint、构建、24 项单元/兼容和 17 项真实 PostgreSQL 集成通过。内存与 PostgreSQL 共用同一组 10 项存储/事务契约。实际 npm 包在仓库外的新消费项目中不安装 pg 驱动，分别导入客户端、通用服务器及内存适配器并完成加密保存与锁定。

知交完整类型、Lint、构建、271 项单元、23 项真实 HTTP/PostgreSQL 集成、22 项完整浏览器回归及 9 项模拟部署用例通过。浏览器覆盖日期、表单、桌面保存/删除/历史恢复/锁定、手机离线重载、头像、分析服务选择与候选确认、可选人物及议题思考。分析响应全部拦截模拟。临时应用和数据库已停止，仅使用虚构数据，未触发真实模型或生产操作。未执行本轮 Docker 镜像构建、GitHub Actions 或真实设备验证。
