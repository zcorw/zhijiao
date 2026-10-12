# 相识日期组件与验证

本次仅替换人物 `metOn`（相识日期），生日及其他日期输入、共享 partial-date 模型、客户端加密、同步 API 均保持原有实现。基线提交为 `94521b3995d758c60286e8f62369caec9ce9829f`，分支 `codex/zhijiao-v1`。本机验证及预览完成后，用户已明确授权“推送到github”；提交和远端 CI 的实际结果以最终交付报告为准。没有手动发布镜像或部署 VPS。

## 实现

固定 `@vuepic/vue-datepicker` **14.0.0** 和中文 locale 依赖 `date-fns` **4.4.0**；组件要求 Vue >=3.5，与当前 3.5.43 兼容。依据：[官方安装](https://vue3datepicker.com/installation/)、[日/月/年模式](https://vue3datepicker.com/props/modes/)、[模型类型](https://vue3datepicker.com/props/general-configuration/)、[本地化](https://vue3datepicker.com/props/localization/)、[主题](https://vue3datepicker.com/customization/theming/)。

`PartialDateInput.vue` 提供一个输入框、日历按钮和可清空按钮。弹层内使用组件的 inline 日、月、年模式与中文精度按钮；颜色局部覆盖为奶油/鼠尾草绿，采用 v14 的 `dp--` 类名。年份网格围绕已知年份前后75年，键盘直接输入可以使用所有符合已有 schema 的0001..9999年份，重新打开后网格围绕该年定位。

弹层草稿仅在“确定日期”时更新人物编辑草稿；取消、Escape、外部点击不会改变原值。减少精度只保留已知部分；增加精度不选择缺失月份或日期，必须主动选择后才能确认。日历按年/月定位时使用的视图日期不会写回记录。弹层内按钮为 `type=button`，Enter 不会意外提交人物表单。

存储依然是 `YYYY`、`YYYY-MM`、`YYYY-MM-DD` 或旧 `--MM-DD` 字符串。旧的仅知月日数据原样回显；日历不猜测年份。年月不转成1月1日；日值通过本地年月日 getters/setFullYear 来回转换，不用 UTC/ISO 截断。对于历史时区中整日被跳过、无法形成相同本地 Date 的值，不默认选中替代日；原字符串仍可输入及保存。

通过现有 FormField 的 custom slot 接入 vee-validate 的 id/name、aria-invalid/required/describedby 和 blur。弹层保留在 Drawer 的 DOM 焦点范围内，限制 Tab/Escape 作用范围；监听窗口、visualViewport 和自身尺寸以重排，缩短视口时保留可见确认按钮。关闭、锁定和卸载后释放草稿与监听。

## 最终检查

| 检查 | 实际结果 |
| --- | --- |
| 全工作区 `npm run typecheck` | 通过；修改后另行 web typecheck 及最终容器内完整构建通过 |
| `npm run lint` | 通过 |
| `npm test` | **51/51**通过，新增7项日期适配测试 |
| `node .tools/run-date-integration.cjs` | **17/17** PostgreSQL 17.11 集成回归通过，独立测试数据库 |
| 隔离 Docker 构建 | 安装、类型检查、完整应用构建及依赖裁剪通过 |
| `npx playwright test --config .tools/playwright-date.config.ts` | **8/8**通过（26.2秒），包含新增2项日期专项与原6项回归 |
| 桌面/手机像素查看 | 最终1440×1000桌面、390×844手机截图已打开查看 |
| `git diff --check` | 通过 |

日期专项覆盖精度减少/增加、取消日期选择和取消人物编辑、明确选年份/月/日、空值/清空、闰日与非法日期、0001/0078/9999边界、旧 `--MM-DD`、加密保存及编辑/锁定后回显、重复开闭、Enter不提交表单、Escape与Tab回环、错误焦点及aria、America/Los_Angeles与Pacific/Kiritimati时区、390×520缩短视口后的弹层和确认按钮。既有加密CRUD、离线、头像及表单回归全部通过。

## 本机交付与边界

复用独立虚构实例 `zhijiao-date-check`，`http://127.0.0.1:3338`，最终健康。镜像 `zhijiao:date-check` 的本机 image ID 为 `sha256:0b752827b2bd7ef565fe5cb6a8fe0e25e067de5151beda6c34817e2afa37466b`，没有上传到注册表。原用户实例及账号未修改。

最终截图为 `.local/date-check/screenshots/met-date-desktop.png`、`met-date-mobile.png`，只含虚构资料和日历，无真实口令、恢复秘密或用户数据。自动 trace/失败截图关闭。初次视觉发现的默认蓝色样式已修正为 v14 局部绿色主题；手机重排检查已补尺寸监听和等待实际重排后的断言。

手机检查使用真实 Chromium 渲染的视口模拟；尚未在 iOS/Android 实机及真实系统软键盘上验证。构建仍有主 JS 块超过500kB及上游注释的非致命提示。未将此局部组件改造扩展到其他日期字段。
