# 全部日期与时间输入

本文保留上回日期输入专项的验证记录。后续与人物关联可选一起提交的复核结果见 [optional-participants.md](optional-participants.md)。下文 `.tools` 为本机忽略的验证辅助脚本；干净检出可按 README 准备独立虚构实例，显式设置 `E2E_BASE_URL` 后运行根配置 `npx playwright test`，无需这些辅助脚本。

本轮沿用固定版本 `@vuepic/vue-datepicker@14.0.0`、Vue 3 和 vee-validate，统一到 `DateTimeInput.vue`。暖米白与柔绿主题、确认后回填、取消保留原值、清空、焦点恢复及手机视口定位均复用原相识日期组件。没有新增组件库、服务端字段或数据库迁移。

## 已盘点的 13 个可编辑入口

| 表单 | 字段 | 模式与保存格式 |
| --- | --- | --- |
| 人物 | `metOn`、`birthday` | 部分日期 |
| 事实与偏好 | `learnedOn`、`validFrom`、`validTo` | 部分日期 |
| 交往 | `occurredOn` | 部分日期 |
| 交往 | `occurredAt` | 日期时间 |
| 感受与印象 | `recordedOn` | 部分日期 |
| 事项 | `dueDate` | 部分日期 |
| 事项 | `dueAt` | 日期时间 |
| 记一笔 | `date`、`dueDate` | 部分日期 |
| 记一笔 | `exactTime` | 日期时间 |

当前没有独立的纯时间或独立完整日期字段。完整日期是部分日期的“日”精度。只读日期、历史版本时间、`createdAt` / `updatedAt`、自动完成时间以及时区文本不属于这次替换范围。

部分日期仍保存 `YYYY`、`YYYY-MM`、`YYYY-MM-DD` 或 `--MM-DD`；提高精度必须显式选择未知部分。年份未知的月日保留手输与旧值，打开日历不补年份、不将日历的定位日期当作选中值。日期不经过 UTC 转换。

日期时间使用中文 24 小时制，保持原生 `datetime-local` 的本机民用时间语义和分钟编辑精度；提交仍转换成 UTC ISO，独立的 IANA 时区字段仍按原逻辑保存与校验。所属时区字段并不改变本机输入的解释规则。新文本入口显式校验真实日历、小时分钟范围和夏令时跳过的时间，避免 `Date` 自动纠正输入。夏令时重复时间仍采用原浏览器 `Date` 的解析规则，未引入额外时区转换。

配置依据：[官方模式文档](https://vue3datepicker.com/props/modes/)、[时间配置](https://vue3datepicker.com/props/time-picker-configuration/)、[图标插槽](https://vue3datepicker.com/slots/icons/)。手机时间增减按钮从默认 8 像素条形区域改为 44×44 像素上下箭头，小时分钟数字区同样提供至少 44 像素点击高度。

## 本地验证

新预览使用 `http://127.0.0.1:3348`，Compose 项目 `zhijiao-all-date-check`、数据库 `zhijiao_all_date_test` 和独立持久卷。账号与业务资料均虚构。未替换 3308、3318、3328、3338 的既有实例，未进行 VPS 部署。

最终检查于 2026-10-12 在本机完成，以下均基于两处问题补丁后的源码与隔离实例；手机箭头修正后再次运行 Web 类型检查、lint、完整本机和容器构建、全部浏览器回归并重新查看截图。

| 检查 | 最终结果 |
| --- | --- |
| `npm run typecheck`（全部工作区） | 通过 |
| `npm run typecheck -w @zhijiao/web`（最终视觉修正后） | 通过 |
| `npm run lint` | 通过 |
| `npm test` | **55/55** 通过，含 7 项部分日期、4 项日期时间适配测试 |
| PostgreSQL 专用集成库 `zhijiao_date_integration_test`（55459） | **17/17** 通过 |
| `npm run build`（正常本机权限） | 通过 |
| Docker 干净 `npm ci`、完整构建与启动 | 通过，3348 实例健康 |
| `npx playwright test --config .tools/playwright-all-date.config.ts` | **10/10** 通过，最终一轮 34.5 秒 |
| 源码 diff 检查与范围复核 | 通过，无服务器 schema 或业务必填规则放宽 |

首轮新增浏览器测试发现的两个问题已修复并验证：空正文交往编辑时保留原业务 schema 允许的空字符串；在弹层捕获阶段统一处理 Esc。浏览器额外确认事实与感受的正文仍然必填，没有为允许空交往正文而放宽其他规则。

浏览器覆盖全部 13 个入口的选择、精度、旧 `--02-29` 生日保存回显、取消、清空、重复保存、Esc 后重新打开、错误焦点、时区校验及本机/UTC 日期时间回显。原有锁定、离线、头像与表单回归也全部通过。桌面使用 1440×1000 / America/Los_Angeles，手机使用 390×844 / Pacific/Kiritimati，并验证 390×520 短视口下确认按钮可用、弹层及页面没有水平溢出。

最终运行镜像为本机 `zhijiao:all-date-check`，image ID：`sha256:05d7bce3fd3375818699dce9f1613e2f4af42ff6709401b811fc04a74ae79f7a`。既有实例及真实数据未修改。本轮没有提交、推送、发布镜像或部署 VPS。

## 截图与剩余限制

两张最终截图已逐张查看实际像素，确认暖米白/绿色主题、清晰的时间箭头、完整日历及可见确认按钮；均仅含虚构资料，没有登录密码、解锁口令或恢复秘密。Library 已确认保存成功：

| 截图 | 本地路径 | Library ID |
| --- | --- | --- |
| 桌面 | `.local/all-date-check/screenshots/all-date-desktop.png` | `libfile_4473e0adc6d0819182a01b376f7876c9` |
| 手机 | `.local/all-date-check/screenshots/all-date-mobile.png` | `libfile_e15a1e3e6ebc8191bf12d5ed33f01ba7` |

本环境的准备上传接口不可用，按官方 Library 流程使用支持的批量创建保存。Windows 不支持辅助工具使用的本地扩展属性；Library 保存成功，路径、文件 ID 与版本对照另存于本机 `.tools/library-all-date-final-1791789110340/correlation.json`。以后更新这些截图应替换上述 Library ID，不能重复创建。

尚未验证实体 iOS/Android 键盘及系统手势；短视口验证是浏览器模拟。年份未知的月日仍通过输入 `--MM-DD` 记录，日历不会自动推断年份。夏令时重复时间保留原浏览器解析规则，所属时区字段继续独立保存，未新增按指定时区转换功能。构建保留既有大 bundle 提示，未扩展到无关的打包优化。
