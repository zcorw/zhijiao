# 知交 · zhijiao

为自己的现实朋友与熟人保存档案、交往记录、感受与印象、约定和计划。事实与主观感受分开记录，感受可关联多个具体事件，并说明支持、矛盾或修正的缘由。项目面向一个账号的私人使用，不提供公开注册、邮件验证或邮件找回密码。

交往记录也可只写事件或感受、不关联人物，直接作为完整记录保存；标题可留空，从正文首行生成。无人物记录在首页近期交往和全部交往中按日期回顾，以后可补关联或解除关联并保留事件。详见 [人物关联可选说明与验证](docs/optional-participants.md)。

交往详情提供“分析人物与事项”：使用 DeepSeek 分区整理感受与印象、事项、事实与偏好及交往背景。先确认人物档案，再逐条筛选、编辑并补全不明来源或责任，确认后一次加密保存；交往背景仅供查看。描述中的第一人称默认当前用户，引语中的第一人称归说话者。实验室仅验证思路，正式功能独立运行。启用与数据发送范围见 [交往分析说明](docs/interaction-analysis.md)。

当前已完成可运行 v1 的本机开发与分层验证，功能覆盖和未完成范围见 [需求对照](docs/verification.md)，实际命令与结果见 [实现记录](docs/implementation-log.md)。生产域名、VPS、独立备份目的地及恢复目标仍未确定；尚未上线或通过独立安全审计。

议题与思考现已独立归档；手机保持五个底部栏位，设置移至顶部。使用方式、兼容与恢复边界见 [议题与思考](docs/topics-and-thoughts.md)。

## 项目结构

| 路径 | 作用 |
| --- | --- |
| `apps/web` | Vue 3、TypeScript、响应式 PWA |
| `apps/server` | NestJS，同源 `/api`、认证、密文同步及资产存储 |
| `packages/shared` | 模型与 API 协议 |
| `packages/client` | 浏览器加密、IndexedDB、outbox、同步及恢复 |
| `vendor/nest-account` | 固定来源的私有账号库集成副本，保留来源说明 |
| `scripts/ops` | 人工调用的 Linux VPS 备份、恢复演练及升级脚本 |

账号库来源为 `zcorw/nest-account` 的 `ff46461641917ca4dfc3b84284d31bcedb193159`。[上游 README](vendor/nest-account/UPSTREAM-README.md) 保留原说明，复用范围及集成修改见 [实现记录](docs/implementation-log.md)。上游未提供 LICENSE；本项目和镜像应保持私有，不将该代码公开再分发。

## 本机开发

需要 Node.js ≥ 22.12、npm、Git，以及可用的 PostgreSQL；容器验证需要 Docker Engine 和 Docker Compose v2。构建及 CI 固定 Node 22.23.4，数据库容器固定 PostgreSQL 17.11。安装依赖前先检查工作目录及现有文件。

```sh
npm ci
npm run typecheck
npm run lint
npm test
npm run build
```

PostgreSQL 集成检查使用专用空测试数据库，`TEST_DATABASE_URL` 指向该数据库，随后运行 `npm run test:integration`。测试会创建和清理测试数据，不能使用生产数据库。浏览器端验证使用 `npm run test:e2e`，需要本机可用的 Playwright 浏览器和测试服务；首次运行的完整条件应以测试文件为准。

Windows 沙箱中 esbuild 配置加载遇到工作区外路径限制时，使用支持的 `--configLoader runner`，如 `npx vitest run --configLoader runner` 和 `npx vitest run --config vitest.integration.config.ts --configLoader runner`。不要为此放宽系统权限。浏览器测试先 `npx playwright install chromium`，在可丢弃的本机实例用隐藏输入 CLI 创建 `tests/e2e/app.spec.ts` 中明确标注的虚构账号；该测试会新增虚构资料，不能针对正式账号或生产运行。`E2E_BASE_URL` 必须精确匹配测试实例的 `APP_ORIGIN`。浏览器测试必须显式设置 `E2E_BASE_URL`，没有默认实例地址，避免误写正在使用的本机资料库。自动 trace 与失败截图关闭；测试只手动保存不含秘密的虚构业务页面。

`npx playwright test --config playwright.recovery.config.ts` 用于已经恢复同一虚构数据库的独立实例；默认 `http://localhost:3318`，从全新浏览器解锁并核对历史及头像像素。恢复步骤、会话失效及目标必须为空的限制见 [运维文档](docs/operations.md)。这是演练入口，不会创建数据库、安装服务或触发部署。

完整应用的本机容器运行：

```sh
cp .env.example .env
bash scripts/ops/init-secrets.sh
# 修改 .env：本机验证用 NODE_ENV=development、APP_ORIGIN=http://localhost:3000。
# APP_PORT 改动时同步修改 APP_ORIGIN；生产使用可信 HTTPS 入口。
docker compose build app
docker compose up -d --wait db
docker compose run --rm --no-deps app node apps/server/dist/migrate.js
docker compose run --rm --no-deps app node apps/server/dist/account-cli.js create
docker compose up -d --wait app
```

Windows 可使用已有 Git Bash 执行 `scripts/ops/init-secrets.sh`，或用本机秘密管理方式准备 `.local/secrets/db-password` 与 `.local/secrets/session-secret` 两个文件；不要把秘密打印到聊天、命令参数或仓库。Linux VPS 脚本依赖 Bash、GNU coreutils、`flock`、OpenSSL、Docker Compose；备份与恢复另外需要官方 `age` 工具。此处命令不会安装定时服务。

账号命令在交互式终端隐藏密码输入，并要求确认。已有账号的密码管理：

```sh
docker compose run --rm --no-deps app node apps/server/dist/account-cli.js reset-password
```

登录密码重置会使已有会话失效；它不能解密资料库。迁移是独立单次命令，应用启动时不会自动运行迁移。详见 [配置、升级、备份与恢复](docs/operations.md)。

## 资料库与可靠保存

登录密码用于服务器身份认证；资料库解锁口令在本机解锁密钥包。这两个秘密应分别设置和保存。首次建立资料库时，客户端生成随机资料库密钥与独立随机恢复秘密，服务器只保存被包装的密钥包与业务密文。恢复秘密必须由用户另行保存，不能依赖登录密码找回。

新设备先登录，再下载密钥包并在本机解锁。忘记解锁口令时，使用自己的恢复秘密；服务器管理员重置登录密码不能帮助解密。改解锁口令会重包装密钥；数据密钥泄漏后的全面轮换是另一个流程，不能把重包装当作已完成数据密钥轮换。

记录、人物目录、关系及头像都经客户端认证加密。服务器仍可见账号、资料库及记录标识、版本、密文大小、同步路由和访问时序等必要元数据。解锁明文仅保留于会话内存，IndexedDB 保存密文与待上传操作；浏览器内存无法保证物理擦除。锁定必须让在途异步结果失效并释放图片 Blob URL。

主动使用交往分析时，本次交往的标题、正文及发生日期会以明文经过应用服务器发送至 DeepSeek 官方接口；其他档案及账号姓名不发送。该分析请求不写入本项目数据库或应用日志；外部服务的数据处理遵循其政策。未经确认的候选只保存在页面内存。普通保存和同步继续使用客户端加密。

人物轻量目录优先完整同步，然后正文及历史分块同步；头像按需下载。目录尚未完整时应显示同步提示，搜索无结果不能被当作全库无结果。离线操作通过原子 outbox 保存，提交使用 operationId 幂等与 expectedRevision CAS；冲突保留本机候选供比较，不静默覆盖。删除使用墓碑；恢复旧版本会生成新版本。登录后的每个资料库、记录和资产接口都检查对象归属。

独立加密备份覆盖整个 PostgreSQL 数据库，包括账号状态、密钥包、当前版本、不可变历史、变更日志和头像密文；每日一次、保存 30 天是初始方案。备份目的地与实际执行计划仍待确定。30 天备份保留期不等于业务历史保留期；业务历史默认不清理。

## 验证状态与交付边界

配置中已包含类型检查、lint、单元测试、真实 PostgreSQL 集成、应用构建及容器构建的 GitHub Actions。镜像发布只在人工执行工作流且检查成功后进行，输出提交标签和固定 digest；VPS 仍由人工执行拉取、备份、迁移和健康检查。

工作流定义不代表它已运行。请在交付时记录实际执行的命令、通过或失败结果、未运行的容器/浏览器/恢复演练，以及对应提交与镜像 digest。真实 HTTPS、独立备份目的地、干净设备恢复、手机布局、离线冲突、重复点击和锁定行为均需要在目标环境核验。

表单采用固定版本 vee-validate 4.15.1，中文行内提示与无障碍约定见 [表单验证说明](docs/form-validation.md)。
