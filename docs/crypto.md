# 客户端加密、同步与恢复

实现位于 `packages/client`，通过 `VaultClient`（别名 `ClientEngine`）供 Vue 使用。此实现使用标准原语并有自动化验证，尚未经过独立密码学安全审计。业务关系、姓名、联系方式、事实、感受、交往正文、事项、标签及头像密钥封装均在客户端密文内。服务器可见账号归属、随机记录 ID、版本、记录路由、删除标记、长度及访问时序；这不是隐藏所有元数据的系统。

## 密钥与认证加密

首次创建使用 `crypto.getRandomValues` 生成 32 字节数据密钥。Web Crypto 的 AES-256-GCM 使用每次随机 12 字节 nonce 和 128 位认证标签；禁止将 nonce 从旧版本复制到新的加密操作。数据密钥作为不可导出的 `CryptoKey` 使用，另有仅会话内存中的原始字节用于重包装和历史钥匙封装。[Web Crypto](https://www.w3.org/TR/webcrypto/) 定义这些原语及实现的安全边界；[AES-GCM 参数说明](https://developer.mozilla.org/en-US/docs/Web/API/AesGcmParams) 说明 nonce 唯一性和 AAD 的认证作用。

每条记录的 AAD 由共享包唯一函数生成：`["zhijiao", vaultId, recordId, revision, formatVersion, keyVersion, lane, tombstone, variant ?? null]`。记录 ID、资料库 ID、目标版本、密钥版本、路由或删除标记被改写后认证失败。解密还核对实体 ID、ownerId、实体类型及路由，防止持有合法旧密文时跨记录或路由替换。记录版本是十进制字符串，不能经 JavaScript `Number` 转换。密文的密码学认证不证明服务器没有隐藏或重放整个旧快照；不可变历史、CAS 和单调游标承担同步一致性检查。

登录密码与资料库口令分别处理。资料库包装密钥采用 Web Crypto PBKDF2-HMAC-SHA256：新包为 600,000 次、16 字节随机 salt；读取严格允许 600,000 至 2,000,000 次，先验证边界再执行 KDF。口令长度限制为 12 至 1,024 个 JavaScript 字符。600,000 次参考 [OWASP 的 PBKDF2 工作因子](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)，这里选择浏览器原生、无需加载额外 WASM 的可部署实现；这不是对资料库密码强度的审计结论。实际手机上的延迟及是否切换经审查的 Argon2id 实现仍需测量。

密钥包 `{formatVersion,vaultId,keyVersion,kdf,passphrase,recovery,createdAt,previousKeys?}` 只含包装密文。独立恢复秘密为 32 字节随机值，显示为 `ZJ1-` 加 base64url；它直接作为 AES-256 包装密钥，与登录身份无关。两种包装的 AAD 都绑定资料库、密钥版本、格式、方式及创建时间，口令包装还绑定完整 KDF。每个包装 nonce 为 12 字节，密文为 48 字节，采用规范 base64 并严格限制输入。真实口令、恢复秘密和原始钥匙不写 IndexedDB、服务端、日志、仓库或镜像。

## 换口令与实际数据密钥轮换

`rewrap(newPassphrase)` 仅重新随机 salt、派生包装密钥和生成口令包装密文，数据密钥及独立恢复秘密不变。它通过资料库密钥包 revision 的 CAS 上传。服务端保留密钥包历史，因此旧口令仍能解开保留的旧包装；换口令不能撤回先前已获得的钥匙或备份。登录密码重置只能改变认证权限，不能解密资料库。

`rotateDataKey(newPassphrase)` 先完整同步并确认没有未解决候选，再生成新的随机数据密钥和独立恢复秘密。新密钥包以新数据密钥直接包装所有旧数据密钥，`previousKeys` 最多 1,000 项、版本唯一且严格小于当前版本，AAD 为 `["zhijiao-previous-key",vaultId,currentVersion,oldVersion,formatVersion,createdAt]`。新设备解锁一个新版包即可读取历史。包更新后，每批最多 45 个业务实体重加密为新 revision，人物及派生目录在同一 operation；技术性重加密保留业务 `updatedAt`。

返回 `{recoverySecret,keyVersion,completed}`。包安装后网络中断会返回 `completed:false` 和状态中的错误，用户仍能先保管新秘密，之后 `resumeRotation()` 继续。锁定使执行失效，取消的执行不再回填秘密；若包已安装，以已选的新口令重新打开即可恢复，再次轮换可以生成新的可保存恢复秘密。不要将一次取消误判为整个远端事务没有发生。旧设备发现新版本包会报 `KEY_ROTATED_REUNLOCK_REQUIRED`，用户用新口令重新解锁；旧 outbox 保存为 `KEY_VERSION_CONFLICT` 候选。旧操作已被服务端接受但确认丢失时，原 operationId 仍先幂等重放成功结果。

当前头像采用独立随机资产密钥。轮换只更新人物引用中的资产密钥封装，已存资产正文及其原始 AAD 不变。持有旧密钥、旧人物版本或旧备份的人仍可能读出原来的照片和历史记录；无法撤回这些已经泄漏的数据。新创建的照片使用独立新密钥和当前包装密钥。泄漏资产密钥后重新生成资产、重新编码及替换引用的流程，与本次资料库密钥轮换应区分。

## 本机保存、锁定与同步

默认 IndexedDB `zhijiao-encrypted-v1` 仅保存资料库描述和包装密文、各不可变密文版本、密文 outbox、同步游标及覆盖状态。一个 `readwrite` 事务以 `durability: "strict"` 原子保存候选与 outbox；加密在事务之前执行，事务中再次比较当前版本。错误或锁定触发事务撤销。`MemoryStore` 只供测试。[IndexedDB 事务文档](https://developer.mozilla.org/en-US/docs/Web/API/IDBDatabase/transaction) 说明原子范围和 durability；浏览器仍可能清理站点数据，IndexedDB 不能替代独立备份。

解锁实体、搜索索引、原始钥匙及头像 Blob URL 仅存会话内存。`lock()` 递增 generation、取消 AbortController、将已持有的原始钥匙字节置零、清空索引和对象引用、统一撤销 Blob URL。所有下载、保存、恢复、包装、头像及备份预览的晚到结果核对 generation，不能把明文重新放回界面或推进游标。浏览器和 JavaScript 的复制、不可导出 CryptoKey 内部存储、垃圾回收和内核缓存不受应用控制，不能保证物理擦除。界面也必须清理表单、临时图片、已解锁对象和恢复秘密。

`openCached(id)` 显式选择本机缓存并进入 `offlineMode`，可解锁和保存密文 outbox，禁止上传。`resumeOnline()` 先通过正常 Cookie 认证获取该资料库、检查归属，再恢复同步；每个远端对象路由仍由服务端检查归属。没有客户端的 ownerId 值可代替服务端授权。

同步先完整获取轻量加密人物目录，再完整获取业务记录及其历史。头像不混入强制正文下载。每个 lane 固定首次返回的 high-watermark 分页，保存十进制 BIGINT 游标，可以在页边界续传；即使 lane 没有对应变更也推进到该快照边界。目录未完整时 `searchPeople()` 返回 `complete:false`，不得把无匹配显示为全库无结果。完成后以本机 `pinyin-pro@3.27.0` 索引姓名、别名、无声调拼音及首字母，空查询显示最近使用或更新的最多 5 人。[拼音库官方说明](https://pinyin-pro.cn/en/guide/start.html) 描述浏览器与 ESM 支持。

每次写入用随机 operationId 幂等提交，`expectedRevision` CAS 及目标 revision 已在密文 AAD 中绑定；人物修改与目录更新、一次交往与其反思/多对多事件关联/事项、头像两个尺寸与人物引用都在同一批提交。409 时保留本机候选及远端版本，不自动覆盖。`discardConflict()` 是显式选择远端，会一并放弃依赖该批的后续本机操作，执行前应导出备份或保存需要的候选文本。恢复旧版本会创建当前 revision+1，不能 replay 旧密文。普通写入不能越过 tombstone 恢复对象。恢复存在已删除依赖时拒绝，用户应先恢复依赖对象；删除人物保留多人交往中的其他参与人，单人专属记录及相关事件链接保存删除版本。

## 头像

仅接受本机 JPEG、PNG、WebP，文件最大 20 MB、解码最大 50 MP。`createImageBitmap(...,{imageOrientation:"from-image"})` 处理方向，裁剪坐标以短边为一个单位，横图与竖图均按实际图片边界检查。随后 Canvas 生成 512×512 主图和 128×128 缩略图，原图不上传。[createImageBitmap 文档](https://developer.mozilla.org/en-US/docs/Web/API/Window/createImageBitmap) 描述方向参数。

重新编码 PNG 后解析结构、CRC、尺寸和编码，只保留 `IHDR`、`IDAT`、`IEND`。再次验证白名单后才允许加密上传，因此 EXIF、GPS、文本、嵌入预览、动画及其他非像素块不进入上传数据；这不删除照片像素本身包含的位置线索。[PNG 规范](https://www.w3.org/TR/png/) 定义块结构及 CRC。

两个尺寸各有随机 32 字节资产密钥，封装 AAD 绑定资料库、资产 ID、资产 revision、尺寸、包装密钥版本。封装在加密人物和目录的引用中。服务端独立存储资产密文，下载本机解密成 Blob。Ciphertext IndexedDB 缓存和有界共享会话缓存分别负责持久复用与显示；会话缓存默认 16 MB/80 个条目/最多 3 个并发请求，键为 vault/asset/revision/variant。并发合并、引用计数及 LRU 防止组件卸载后立即破坏其他引用，所有条目在锁定时统一撤销。缓存被正在显示的引用占满时明确失败，避免无限增长。

## 用户导出备份与干净设备恢复

`exportBackup()` 要求在线取得完整记录历史、全部密钥包历史及资产版本列表，并下载引用过的历史资产。备份包含各业务密文版本、墓碑、待处理 operation 候选、所有已知包装版本及全部历史引用可恢复的头像尺寸。没有任何历史引用密钥封装的孤立资产密文不进入用户备份，因为它无法被解密；它仍可保留在管理员数据库备份中，不会自动删除服务端数据。数据库备份与此浏览器备份是不同层次，部署恢复文档另述。

整个备份正文的 SHA-256 digest、生成时间及数量放入数据密钥认证加密的 manifest。预览先限制 UTF-8 输入至 200 MB、密文版本最多 100,000 条、outbox 最多 10,000、密钥包最多 1,000、KDF 参数/密文字节/路由及 revision 边界，然后解开当前及历史数据密钥，验证 manifest、每条业务认证、每个历史头像引用及 PNG。重复历史版本、跨资料库替换、漏掉资产、未知钥匙或未经验证的伪造 preview 均拒绝。

预览只返回计数及日期；确认导入通过内部 WeakMap 关联已校验的密文，不接受自行拼出的预览对象。`importBackup(preview,{confirm:true})` 仅向空的本机资料库写入；不会覆盖已有记录或 outbox，不改写 vault ID、owner ID、记录 ID 或 AAD。恢复后使用对应口令或恢复秘密解锁，正常联网同步再与相同资料库进行 CAS；若远端保留更新后的墓碑或版本，会保留冲突候选而非悄悄复活。跨账号或不同 vault 的复制导入暂未实现。

## 已验证与仍需测量

客户端源文件单测覆盖真实 Web Crypto 与 Node AES-GCM 结果一致、认证字段和密文篡改、规范 base64 与 KDF 边界、独立恢复和口令重包装、IndexedDB 撤销、目录/拼音、离线多版本及丢确认幂等、CAS 双候选/墓碑/恢复、多人删除、锁定后的晚到下载、真实随机密钥轮换和新设备历史恢复、50 人轮换中断续作、旧设备密钥冲突、备份篡改及资产缺失、两尺寸/多历史图片、孤立资产过滤、短边裁剪边界、并发缓存及锁定失效。运行命令：`npx vitest run tests/unit/client.test.ts --configLoader runner`。

真实 PostgreSQL/HTTP 集成和浏览器页面/方向校正/触摸键盘验证由整体验收记录列明；客户端单测不代表这些检查已经运行。实际 iOS/Safari、Android、PWA 冷启动、存储被系统清理、KDF 手机延迟、长历史或大规模资料库性能仍需设备验证。当前 IndexedDB 使用每资料库一个密文快照值，保证事务边界但会随历史和资产增加而产生较大的复制开销；规模变大前应迁移为分表、逐记录存储和受控索引，不降低事务一致性。业务历史不会根据 30 天管理员备份保留策略自动清空。
