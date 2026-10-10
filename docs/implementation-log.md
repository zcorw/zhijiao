# 本机实施与验收记录

任务日期：2026-10-10。工作区：`C:\Users\zhzhw\Documents\Codex\2026-10-10\task`。分支：`codex/zhijiao-v1`。仓库：私有 [zcorw/zhijiao](https://github.com/zcorw/zhijiao)。最终提交及对应 CI 由交付消息注明；本文不伪造自身提交哈希。

## 基线、环境与复用

初始目录已核查，无其他项目实现、AGENTS.md 或适用 .agents 工作流；现有文件保留。完整 Notion 审阅稿只读取得，保存为 requirements-notion.md，未修改 Notion。模块按明确授权并行开发，统一协议后集成；逐项范围见 [verification.md](verification.md)。

本机 Node22.12.0、npm10.9.0、Git2.47.0。gh/rg不存在；正常 Git Credential Manager 已有 zcorw 身份，使用正常 Git 访问和已登录浏览器创建私有仓库。没有提取凭据、生成长期 token 或修改全局信任；不同沙箱属主仅用每次命令的精确工作区 safe.directory。

Docker最初未启动，用户启动后实际 Engine28.3.3/desktop-linux 正常。官方 Node22.23.3 与 PG17.11 镜像实际用于构建和容器；运行项目为 zhijiao-local-check（loopback3308），独立恢复为 zhijiao-restore-app-check（loopback3318）。数据库均无宿主端口。

固定源码 ff46461641917ca4dfc3b84284d31bcedb193159，实际复用 AccountModule/AccountService/PostgresAccountRepository/HashedSessionStore，保留原README。没有LICENSE，保持私有；没有修改原账号工作树或合并其PR。集成副本 idleMs/authVersion/持久撤销与迁移修改见 [account-reuse.md](account-reuse.md)，未回补上游。

## 分层验证

| 检查 | 命令或实际流程 | 结果 |
| --- | --- | --- |
| 安装/构建 | Docker内Node22.23.3 npm ci、全部workspace build、生产prune | 通过；生产依赖audit报告0已知漏洞，不等于安全审计 |
| 类型 | npm run typecheck | 全workspace通过 |
| lint | npm run lint | 通过 |
| 单元 | npx vitest run --configLoader runner | 39/39：客户端27、会话4、CLI3、共享3、Web格式2 |
| 真实PG/HTTP | 独立PG17.10测试库；vitest.integration.config.ts --configLoader runner | 17/17：服务端15、真实WebCrypto客户端-服务端2 |
| Docker迁移/账号 | PG17.11；显式单次迁移及重跑；TTY隐藏输入创建虚构账号 | 通过；应用不自动迁移；无注册/邮件/HTTP重置 |
| Docker运行 | 单应用镜像+DB实际启动，/api/health，单loopback端口，非root/只读挂载 | 通过；没有VPS部署 |
| UI浏览器 | npx playwright test | 最终3/3通过，含桌面删除恢复、手机离线选择器、头像；不是仅单元模拟 |
| 恢复浏览器 | npx playwright test --config playwright.recovery.config.ts | 1/1通过：全新浏览器登录/解锁恢复库、历史及头像像素 |
| 备份脚本 | 原backup.sh/restore-check.sh；宿主Bash/flock/官方age；PG17.11 | 合成边界夹具和真实应用密文分别恢复通过 |

PG覆盖会话撤销/重置/保存并发、禁用账号、Origin/CSRF/限流/Secure Cookie、每对象归属、CAS整批回滚/幂等、提交有序游标/固定历史快照、墓碑/新版本恢复、真实密钥轮换/旧设备冲突及头像版本。客户端覆盖AEAD篡改/替换、恢复秘密/KDF、锁定晚到结果/事务撤销、备份认证/图片缺失、50人轮换中断续作、双尺寸历史头像及已删除记录安全枚举。

浏览器实际验证1440×1000和390×844：登录/解锁分离、真实加密CRUD、IndexedDB无人物/事件/口令明文、重复保存一条、同名只提示、删除后设置入口历史恢复；选择器不聚焦、跨查询多选/2名字+N/确认人数、快速新建取消不落盘、Back关闭表单、无横向溢出、PWA离线刷新后缓存解锁。头像验证横图裁剪、JPEG orientation=6红上蓝下像素、128/512 PNG仅IHDR/IDAT/IEND、锁定实际revoke Blob URL。

调试曾修复原生fetch receiver、Zod JIT/严格CSP、横图裁剪边界和avatar badge定位。测试标题/Origin不匹配按实际页面/配置修正，未降低Origin或CSP。反复登录曾正常触发15分钟限流429；不清空或放宽限制，窗口结束后复核。并行测试库清理冲突用隔离/顺序修正，最终PG通过。

首次提交177ec3c的GitHub CI在干净安装的typecheck中失败：Vue引用的客户端声明尚未生成，本机已有dist掩盖了构建顺序遗漏。已修正根typecheck先生成客户端声明，再执行各workspace检查；使用没有本机构建产物的全新Docker上下文复核。没有通过放宽类型检查或提交dist解决。

真实应用备份：27个密文版本、19current、27changelog、11operation、密钥包和8个main/thumb资产版本（32,272密文字节）。源/恢复业务快照SHA-256同为 fbe7cc392de49d3d65cb0c210206e5378236a29949aa8221c84e45b1ac8672d0。恢复库随后独立事务撤销旧会话，不改变登录密码或解密密钥；新浏览器实际解密通过。此前合成夹具仅验证备份/PG字节与错误路径，未冒充真实AEAD/图片验收。[operations.md](operations.md)记录两层证据。

虚构测试截图存 docs/screenshots，通过私有GitHub正常文件访问交付；运行配置/秘密/PG数据/下载链接/测试产物及一次性age身份均不上传。最终本机镜像ID为 sha256:95430ac6b1f5f1488fa53b83b66ae905412617928d1f2c1af6ca6154e4e687e0；这是本机构建ID，没有GHCR registry digest。

## 仍缺与限制

原两个Library视觉文件正式materialize在Windows失败，references没有可读图片；未看过参考像素。新截图正式批量上传流程在本机报告不可用，未声明保存Library；用私有GitHub文件交付，不复制私人下载链接。

真实iOS/Safari/Android触摸键盘/PWA安装/KDF延迟/存储驱逐及大规模长历史性能未验收。IndexedDB每vault快照值需在大规模前分表；前端约622kB/gzip241kB有分块警告。无独立安全审计、渗透或密码学审查。

生产VPS/架构/域名/HTTPS、独立备份目的地/每日时刻/失败通知/RPO-RTO、历史/墓碑/孤立资产政策仍待决定。未安装定时服务、GitHub secrets、SSH授权，未触发GHCR发布或生产部署。实际升级/跨版本回滚/外部灾难恢复仍需目标环境验收。跨账号改ID导入、大规模索引、批量冲突合并未实现；无依据反思草稿暂不支持。完整范围见需求对照。

自动审批曾拒绝Docker socket控制器与全文读取源环境文件，两项均未执行；分别用宿主工具与有限非秘密元数据完成安全替代，没有规避拒绝或降低安全配置。
