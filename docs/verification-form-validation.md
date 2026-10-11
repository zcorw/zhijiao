# 本轮表单验证交付记录

本轮表单改造已在本机完成验证，随后获得用户“上传到github”的明确授权。工作区：`C:\Users\zhzhw\Documents\Codex\2026-10-10\task`；分支：`codex/zhijiao-v1`；基线提交：`df23496e792877fa6e430c8c362e00917ca50251`。本次上传范围为相关代码、依赖、测试及文档；提交和 CI 的实际结果以最终交付报告及 [zcorw/zhijiao](https://github.com/zcorw/zhijiao) 为准。未手动触发 GHCR 镜像发布、运行生产迁移或部署 VPS。

## 已完成

固定使用 vee-validate 4.15.1，统一登录、资料库建立/解锁、人物及关联记录、快捷交往、口令重包装、密钥更换确认、备份验证的中文行内反馈。保留米白和柔和绿色；提供首次失焦、提交检查、首个错误焦点、折叠区域自动展开、动态字段注销和无障碍描述。服务端及底层业务检查保留。

实际修正了提交后主动清空秘密导致虚假必填提示、重复口令的关联字段更新不及时、收起事项仍被日期检查阻止提交以及备份选择后可能复用旧文件内容的问题。锁定和取消会销毁表单，释放表单持有的值。

## 通过的检查

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 全工作区通过；最后修改亦经容器构建内 `vue-tsc --noEmit` 验证 |
| `npm run lint` | 通过 |
| `npm test` | 44/44 单元测试通过，含新增 5 项表单规则测试 |
| `node .tools/run-form-integration.cjs` | 17/17 真实 PostgreSQL 17.11 集成测试通过，使用单独测试数据库 |
| `docker compose --env-file .local/form-check/compose.env -p zhijiao-form-check build app` | 安装、完整应用构建、生产依赖裁剪和镜像构建通过 |
| `npx playwright test --config .tools/playwright-form.config.ts` | 最终 6/6 实际 Chromium 浏览器测试通过（18.1 秒） |
| Playwright 默认入口检查 | 缺少 `E2E_BASE_URL` 时按预期拒绝启动；提供独立地址后正常列出 6 项测试 |
| `git diff --check` | 通过 |

浏览器回归包括真实加密 CRUD、重复保存、人物搜索、删除历史恢复、跨查询选择、快速新建取消、返回、离线重载、头像方向/像素/Blob 回收。新增验证覆盖空白、日历格式、失焦与提交时机、无原生气泡、首个错误聚焦及描述、服务端错误、重复登录点击、可选事项收起、感受模式切换与移除、折叠时间区自动展开、重复口令即时纠错、备份缺少文件/秘密、取消与锁定。手机采用 390×844 和 390×520 视口，确认无横向溢出且底部提交按钮可见。

## 本机证据

独立项目 `zhijiao-form-check`，地址 `http://127.0.0.1:3328`，数据库与卷均独立。最终应用健康检查为 `healthy`。本机镜像 `zhijiao:form-check` 的镜像 ID 为 `sha256:c7ebe7e58109c1c56a22f6f3a4b1541d44eb4a3fe665e371ef9fdae9fd5ec0b8`；这是本机镜像 ID，不是已发布镜像 digest。

已打开查看以下 PNG 像素，均为虚构资料或空字段，不含真实密码、解密密钥或恢复秘密：

- `.local/form-check/screenshots/desktop-login-errors.png`
- `.local/form-check/screenshots/desktop-person-errors.png`
- `.local/form-check/screenshots/mobile-journal-errors.png`
- `.local/form-check/screenshots/mobile-backup-errors.png`

另有首次建立资料库的错误状态 `desktop-setup-errors.png`。浏览器自动 trace、失败截图关闭；运行入口要求明确设置测试地址，避免误写正在使用的默认本机实例。

## 迭代中的失败与剩余边界

首次 lint 的组件命名冲突已修正。沙箱中的 Vitest runner 遇到 Windows 路径解析问题，改用获准的正常 `npm test` 运行通过。浏览器首次路径/旧标签定位问题已核实并修正；测试发现的秘密清空和关联字段更新问题均已修正后复验通过。反复测试触发了专用库的 429 限流，通过带数据库名及虚构账号核验的临时脚本清理该库的尝试计数后复验；没有修改限流策略、现有账号、当前用户数据或生产设置。容器保持只读根文件系统。

构建仍输出非致命的单 JS 块超过 500 kB 提示及上游注释提示。iOS/Android 实机、真实系统键盘、真实 HTTPS/VPS 和独立备份目的地未在本轮验证。全新设备完整备份恢复没有重复演练；相关既有客户端和 PostgreSQL 集成测试已通过，本轮新增了恢复表单检查。
