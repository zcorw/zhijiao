# 配置、账号管理与人工运维

本文件提供可审阅的操作流程和脚本，不会自动连接 VPS、修改 GitHub secrets、配置 SSH、安装定时服务或触发生产部署。运行前由操作者确认目标主机、工作目录、Compose 项目和固定镜像 digest。服务器地址、域名、独立备份目的地以及 RPO/RTO 尚待确定。

## 容器与配置

一个应用镜像同时提供 Vue 静态资源和 NestJS `/api`，监听容器内 `0.0.0.0:3000`；另一个 PostgreSQL 容器只在 Compose 私有网络提供数据库服务。宿主只发布一个可配置应用端口，默认 `127.0.0.1:3000`，数据库没有宿主端口。数据库使用项目专属持久卷 `postgres-data`。

| 配置 | 默认值/用途 |
| --- | --- |
| `APP_BIND_HOST` / `APP_PORT` | `127.0.0.1` / `3000`，宿主应用端口 |
| `APP_ORIGIN` | 必填，浏览器实际访问的完整 origin；生产为 HTTPS |
| `NODE_ENV` | `production`；仅本机 HTTP 验证可显式设 `development` |
| `TRUST_PROXY` | `0`；只有可信单层反代才设 `1` |
| `APP_IMAGE` | 本机为 `zhijiao:local`；生产使用完整 GHCR `@sha256:…` |
| `DATABASE_USER` / `DATABASE_NAME` | `zhijiao` / `zhijiao` |
| `DATABASE_PASSWORD_PATH` | 宿主秘密文件；挂载为 `/run/secrets/db_password` |
| `SESSION_SECRET_PATH` | 宿主随机会话秘密文件；挂载为 `/run/secrets/session_secret` |
| `COMPOSE_PROJECT_NAME` | `zhijiao`；恢复演练必须另用项目名和持久卷 |

生产外部访问经可信 HTTPS 反向代理，再转发到宿主 loopback 应用端口。仅开启 HTTPS 后才使用生产登录 Cookie。反代应替换不可信的转发头，并限制请求体大小、连接超时及暴露路径。暂未提供具体域名或反代供应商配置，不应为测试而关闭 Cookie、Origin、CSRF 或数据库认证。

`scripts/ops/init-secrets.sh` 在选定的空专用目录一次生成两个随机服务器秘密文件，拒绝覆盖已有文件，不输出值。它不生成用户密码、资料库密钥或备份解密身份。文件父目录为 `0700`，文件为 `0444`，以兼容 Compose 的只读文件秘密挂载及容器内 `node` 用户；父目录限制宿主其他用户读取。实际主机应验证目录所有者、挂载后的权限及 `node` 能读取秘密。`_FILE` 读取是服务器配置的一部分，真实秘密不得放入镜像、命令参数、Git 或日志。

Compose 配置由 `.env` 作为数据读取。运维脚本不会 `source .env` 执行其中的文本。脚本执行选项由调用者环境传入：`ENV_FILE`、`COMPOSE_PROJECT_NAME`、`DEPLOY_STATE_DIR`、`BACKUP_DIR`、`AGE_RECIPIENT_FILE`、`BACKUP_RETENTION_DAYS`、`AGE_IDENTITY_FILE`、`RESTORE_PROJECT`。默认 `ENV_FILE` 是仓库根 `.env`；脚本默认项目名为 `zhijiao`，使用其他项目时显式设置 `COMPOSE_PROJECT_NAME`，与 `.env` 一致。

## 首次安装与账号管理

在专用目录保留经审阅的代码、Compose 和 `.env`；准备宿主秘密文件。通过现有正常 GHCR 登录方式获取私有镜像读取权限，不把登录 token 放命令参数、聊天或仓库，不生成新长期授权。确认 GHCR 包仍为 private。选择工作流输出的固定 digest，写入 `.env` 的 `APP_IMAGE`。

```sh
docker compose config --quiet
docker compose pull app db
docker compose up -d --wait db
docker compose run --rm --no-deps app node apps/server/dist/migrate.js
docker compose run --rm --no-deps app node apps/server/dist/account-cli.js create
docker compose up -d --no-build --wait app
```

`create` 在交互式 TTY 内询问账号名称、显示名和隐藏的密码，再次输入确认；数据库已有账号时拒绝创建第二个账号。不要加 `-T`、管道输入或密码参数。重置登录密码使用：

```sh
docker compose run --rm --no-deps app node apps/server/dist/account-cli.js reset-password
```

密码重置改变账户认证版本并撤销既有会话；并发登录或迟到的会话保存不得复活旧会话。没有公开注册或通用 HTTP 管理员重置接口。资料库解锁口令、恢复秘密和数据密钥均不参与此命令。单次迁移使用数据库 advisory lock；应用启动不自动迁移。

首次访问时建立资料库，用户单独保存恢复秘密。新设备登录后下载密钥包并本机解锁。改解锁口令只是重包装；资料库数据密钥泄漏需要另行执行完整轮换，当前交付状态须由实现记录确认。丢失解锁口令及恢复秘密时，密文备份不能替代解密材料。

## GitHub 检查与镜像

`check.yml` 在 push、PR 或手动运行时执行安装、类型检查、lint、单元、真实 PostgreSQL 集成、应用构建及应用镜像构建。集成数据库只含虚构测试数据，使用专用 CI 账号；运行日志不得记录真实业务数据或用户秘密。

`image.yml` 只接受 `workflow_dispatch`，限 `zcorw/zhijiao` 当前默认分支，先运行同一套检查，再通过工作流短期 `GITHUB_TOKEN` 发布 GHCR。首次上传可以保留本任务分支；以后调整默认分支时无需硬编码不存在的 main。发布要求仓库为 private，拒绝覆盖已有 `sha-<完整提交>` 标签，并输出 `ghcr.io/zcorw/zhijiao@sha256:…`。所有 VPS 操作均在工作流之外；没有自动生产部署或 SSH 步骤。镜像目前构建 `linux/amd64`，VPS 架构未确认；其他架构需要先修改并测试构建目标。

根据 [GitHub Container registry 文档](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)，新建 GHCR 包默认私有。发布工作流会用只读 API 检查已存在包的可见性，已有公开包则拒绝发布，其他权限或网络错误也会阻止发布。首次发布后仍须核验实际包权限再使用。镜像中含用户授权复用的私有账号库，不应公开发布。镜像发布失败、权限不足或不能核实已有标签时应停下，不改变权限或安全设置来绕过。生产始终使用 digest，不能只依赖标签。

固定构建工具与数据库版本为 Node `22.23.3-bookworm-slim`、PostgreSQL `17.11-bookworm`。版本源于 [Docker 官方 Node 映像清单](https://github.com/docker-library/official-images/blob/master/library/node) 和 [Docker 官方 PostgreSQL 映像清单](https://github.com/docker-library/official-images/blob/master/library/postgres)，数据库修订说明见 [PostgreSQL 17.11](https://www.postgresql.org/docs/17/release-17-11.html)。这些版本标签仍可能被基础映像维护者重建；生产应用镜像由发布输出的 digest 固定，每次升级基础镜像须重新构建及验证。

## 独立加密备份

初始方案为每日成功备份一次、保留 30 天。脚本是手工运行的构件；目的地、离机传输、执行时间、失败通知和实际恢复目标尚未配置，仓库不会自行安装计划任务。只放同一 VPS 的备份不是独立备份：应将密文和校验文件可靠传送到独立存储，验证副本并定期演练恢复。

使用 [官方 age](https://github.com/FiloSottile/age) 软件。备份机只需已经由用户管理的公开 recipient 文件；私有 identity 留在独立受控位置。脚本不会创建、复制到仓库或打印这个长期解密身份。备份 identity 与用户资料库恢复秘密是不同的材料；`age` 外层解密只得到业务密文数据库。

```sh
export BACKUP_DIR=/var/backups/zhijiao/encrypted
export AGE_RECIPIENT_FILE=/etc/zhijiao/backup-recipients.txt
export BACKUP_RETENTION_DAYS=30
bash scripts/ops/backup.sh
```

脚本在该 Compose 项目取得操作锁，使用 `pg_dump --format=custom` 对整个库取得一致快照，再通过管道交给 age 认证加密。宿主不生成明文 dump。备份包含账号与持久会话状态、密钥包、当前记录、所有不可变历史、变更日志、头像资产及版本。输出完整密文文件和 SHA-256 校验文件；`pg_dump`、加密或写入任一步失败即停止，未完成密文不进入保留清理。

清理仅在成功备份之后发生。脚本要求显式绝对路径，将其解析为真实目录并创建专用 marker，拒绝 `/` 等宽泛目录。只清理已确认目录顶层、符合脚本生成名称且超过保留期的密文和 sidecar，不递归删除、不跟随文件符号链接、不删数据库历史或远程副本。30 天只约束备份快照，业务历史保留期独立待定，默认不清理。数据删除不能保证擦掉离线副本或未过期备份。

记录每次成功备份的时间、固定应用 digest、校验值及离机传输状态。RPO 是最后一份可恢复备份到故障之间的间隔，RTO 必须通过演练测量，不能仅凭“每日备份”作承诺。

## 人工升级

先确认新提交检查、镜像架构、私有包权限、固定 digest、备份目的地及可用空间。以下命令仅在操作者已批准的 VPS 工作目录运行：

```sh
export BACKUP_DIR=/var/backups/zhijiao/encrypted
export AGE_RECIPIENT_FILE=/etc/zhijiao/backup-recipients.txt
bash scripts/ops/deploy.sh ghcr.io/zcorw/zhijiao@sha256:<已核验的64位digest>
```

脚本要求明确固定 digest 并取得 `flock` 升级锁，校验配置、拉取新应用镜像、停止应用写入、完成加密备份、执行一次带数据库 advisory lock 的迁移，最后启动应用并等待健康检查。每一步失败都阻止后续步骤；停止写入后失败会留下停机或不健康应用，必须人工诊断恢复。脚本不会自动降级数据库或删除卷。

部署目录存在 `compose.deepseek.yaml` 时，`deploy.sh` 自动在基础 `compose.yaml` 之后加载它，配置检查、拉取、备份、迁移及启动全程使用同一套配置，一次升级即可保留 DeepSeek 密钥挂载和模型设置，无需再手动执行第二次 `up`。执行前须准备好 `.env` 中 `DEEPSEEK_API_KEY_PATH` 指向的密钥文件（默认 `.local/secrets/deepseek-api-key`），并确保容器内的应用用户能够读取它；`config --quiet` 不代替密钥文件可读性检查。覆盖文件 `compose.deepseek.yaml` 不存在时沿用基础升级流程。独立备份与恢复脚本保持原有配置。

`bash tests/ops/deploy.test.sh` 使用隔离的模拟 Docker/备份工具检查覆盖文件保留、路径含空格、镜像选择及失败处理，已接入 CI；不会访问真实容器或 VPS。

健康成功后，本机 `.local/deployment-<项目>.env` 记录固定 digest，后续运维脚本会作为 Compose 的第二个数据文件读取它。直接调用 `docker compose` 时需同样加 `--env-file .env --env-file .local/deployment-zhijiao.env`，或将核验后的 digest 同步到 `.env`；启用 DeepSeek 时同时指定 `-f compose.yaml -f compose.deepseek.yaml`，避免误用旧的 `APP_IMAGE` 或移除密钥挂载。保留升级前 digest、备份文件和迁移版本。数据库镜像升级另行审阅，部署脚本不会顺带升级 PostgreSQL 容器。

`/api/health` 的成功仅表示应用及数据库可用。升级后还需人工检查登录、解锁、人物搜索、目录状态、写入并同步到另一设备、历史恢复、头像、退出、锁定与当前会话撤销，不把容器 healthy 当作完整业务验收。

## 干净数据库恢复演练

使用独立项目名、全新持久卷及单独配置；演练项目应位于隔离工作目录，并使用独立的 `.env.restore`、秘密文件和宿主端口。不要把恢复脚本指向生产 Compose 项目，也不要挂载生产持久卷。脚本要求 `RESTORE_PROJECT` 以 `zhijiao-restore-` 开头，且恢复前检测目标库没有用户表；已有数据时拒绝覆盖。

```sh
export ENV_FILE=/srv/zhijiao-rehearsal/.env.restore
export RESTORE_PROJECT=zhijiao-restore-20261010
export AGE_IDENTITY_FILE=/受控的独立位置/backup-identity.txt
bash scripts/ops/restore-check.sh /独立存储的副本/zhijiao-时间-编号.dump.age
```

先校验密文 sidecar，完整 age 解密到 `/dev/null` 验证认证标签，再向干净 PostgreSQL `pg_restore --single-transaction --exit-on-error`。脚本从不自动启动应用，也不对生产执行 destructive restore。失败时保留隔离目标供诊断；下次演练选新的空项目，不覆盖失败目标。

在对外开放恢复库前，准备独立新会话秘密并运行交互式 `reset-password`，使备份中的旧账号密码和会话状态不能重新使用。恢复会带回备份时的认证版本，因此这一步不能省略。然后在仅 loopback 的演练应用中检查账号、资料库密钥包、记录、历史版本、变更游标、头像版本和引用，使用干净浏览器设备登录、本机解锁或恢复，并完成目录、正文和按需资产下载。对比备份前选取的虚构记录及计数，测试新写入和历史恢复，并记录耗时、缺失项和实际 RPO/RTO。

恢复后重置登录密码仍不会解密资料库；需要独立的解锁口令或恢复秘密。备份解密 identity、服务器配置和资料库恢复材料应分别管理。恢复验证前不要销毁原卷、唯一备份或旧镜像。

## 手动回滚边界

只有确认当前数据库 schema 同时兼容旧应用时，才能用旧应用 digest 回滚。应用降级不会撤销数据库迁移；本项目不提供未经验证的自动 down migration。schema 不兼容时，停写后从升级前备份恢复到新隔离卷、重置登录密码使恢复的旧会话失效、完成干净设备与业务验证，再经人工决定切换流量。恢复会丢失备份之后的新写入，不能承诺零数据损失。

不要运行 `docker compose down -v` 作为升级、回滚或故障处理步骤；它会删除持久数据。演练卷清理也必须先确认精确项目和卷、保留恢复证据，再由操作者单独执行。历史保留策略未定，不能在运维中顺便清空历史。

## 验证记录

2026-10-10 在本机用宿主 Git Bash、已校验官方 age v1.3.2、MSYS2 官方 `flock.exe` 和两个隔离 PostgreSQL 17.11 Compose 项目，实际运行了原始 `backup.sh` 与 `restore-check.sh`。全库 `pg_dump` 经 age 加密后恢复到空库通过；恢复前后及再次恢复被拒绝后的业务快照逐字相同，SHA-256 为 `1bae6ae3f5e75d051f5abeadab5d4529e373fa5bce157e12afa129f28553a569`。

数据是明确的虚构 fixture，业务表结构取自当前 `applicationSchema`，账号表使用对应结构的测试 fixture。检查覆盖 6 个密文版本（含历史和墓碑）、4 个当前记录、6 个 changelog、1 个幂等 operation、2 个密钥包版本、1 个资料库、账号/会话/撤销行，以及 main/thumb 两个 bytea 资产共 1152 字节。字节是合成测试值，此次演练验证备份保存这些数据，不能替代客户端 AEAD、图像编码或真实用户解锁验证。

真实通过的失败边界还包括：`flock` 争用拒绝、保留期 0 拒绝、age 加密失败不清理旧备份、成功后只删除匹配名称的过期文件、重算外层校验值后的篡改由 age 认证拒绝、错误 identity 拒绝、非空库拒绝且数据不变、生产项目名恢复拒绝，以及部署脚本拒绝可变标签与格式错误的 digest。测试发现并修复 Windows OpenSSL CRLF 秘密输出和 GNU `sha256sum` 二进制 `*` 标记兼容问题。

完整 SQL、快照、汇总和实际日志保存在本机任务 `.local/ops-live-20261010-v2`；首次 CRLF 初始化失败证据在 `.local/ops-live-20261010`。三个明确创建的测试 PostgreSQL 容器已停止，一次性 age identity 和测试服务器秘密文件已删除，卷与密文证据保留。自动审批拒绝了挂载 Docker socket 的测试控制器方案，因此该控制器从未启动；最终验证完全使用宿主正常 Docker 命令，没有 socket 代理或安全设置变更。

随后对真实客户端 WebCrypto 创建的虚构人物、交往和裁剪头像执行了原始备份与空库恢复，源项目为 `zhijiao-local-check`，恢复项目为 `zhijiao-restore-app-check`。恢复前后业务密文、密钥包与元数据快照逐字相同，SHA-256 为 `fbe7cc392de49d3d65cb0c210206e5378236a29949aa8221c84e45b1ac8672d0`。包括 1 个资料库及密钥包、27 个不可变版本、19 个当前记录、27 个 changelog、11 个幂等操作；其中 8 个 main/thumb 头像资产版本共 32272 密文字节，保留 8 个历史版本。比对后仅在恢复库的事务中递增账号认证版本、持久撤销旧会话并删除会话，确认认证版本为 2、旧会话为 0；登录密码及资料库密钥未更改。恢复应用预留 loopback 3318，备份脚本没有启动应用。汇总、快照、日志与加密备份位于本机 `.local/restore-app-check`。

准备阶段的完整读取源 Compose 环境文件被自动审批拒绝，该读取没有执行；之后直接向 Compose 传递路径，并仅检查项目标签、健康状态、端口和明确非秘密数据库名称。未通过其他方式读取环境文件，也没有修改安全设置。

尚未运行成功 GHCR digest 的完整升级、生产部署、恢复后的应用账号密码重置或独立远程存储传输，也未安装每日计划任务。恢复后干净浏览器的登录、资料库解锁与头像检查由应用验证继续执行，结果应在实现记录中补充。GitHub 工作流 YAML/命令语法及 Compose 配置校验通过，但其定义不代表云端工作流已执行。整体应用的实际安装、typecheck、lint、unit、PostgreSQL 集成、镜像、浏览器、离线冲突与锁定结果应在实现记录中另外记录，并附分支、提交、GitHub 链接与镜像 digest。
