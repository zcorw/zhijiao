# v1 统一接口与集成契约

所有 URL 以 /api 开头，同源 Cookie。修改操作要求匹配 APP_ORIGIN 的 Origin 和 x-csrf-token，登录前 GET /auth/csrf 获取令牌。登录 POST /auth/login {login,password}，返回 {account,csrfToken}；GET /auth/me 返回 {account,csrfToken}；POST /auth/logout；GET /auth/sessions；DELETE /auth/sessions/:id；POST /auth/sessions/revoke-others。没有公开注册。

GET /vaults 返回 VaultDescriptor[]。POST /vaults {id,keyBundle} 首次创建；GET /vaults/:id；GET /vaults/:id/key-bundles 返回不可变包装历史；PUT /vaults/:id/key-bundle {expectedRevision,keyBundle} 原子 CAS。密钥包仅含包装密文、盐与受限 KDF 参数；绝不接受原始密钥。

重包装保留 keyVersion；数据密钥轮换只能前进一个版本，并包含读取现有历史所需的 previousKeys 封装。普通写入必须使用当前 keyVersion，否则 409 KEY_VERSION_CONFLICT，返回 keyVersion/keyBundleRevision；已成功 operationId 的同载荷重试仍先返回原结果。客户端检测到包轮换时要求重新解锁，旧密钥 outbox 保留为候选。换口令不能使已取得旧包装、密钥或备份的人失去读取旧数据的能力。

POST /vaults/:id/operations 接收共享包 Operation。整批记录、目录、资产可在同一事务提交。expectedRevision 是当前版本，envelope.revision 必须是 expectedRevision+1；无记录是 0。服务器不可改 AAD 字段。每条逻辑记录独立认证加密，业务类型和关系仅位于密文。lane 是必需同步路由信息。

成功返回 OperationResult。相同 operationId + 相同载荷重试返回原结果；不同载荷 409 OPERATION_MISMATCH。CAS 冲突 409 {code:'REVISION_CONFLICT',current:CipherEnvelope[]}，整个批次回滚，客户端保留本地候选。不因墓碑而自动复活。

GET /vaults/:id/changes?lane=directory|records&after=0&until=<highWatermark>&limit=100 返回 ChangePage。首次 until 省略取得事务 highWatermark，后续固定该值。通过锁 vault 行分配提交有序 BIGINT 游标，字符串传输。分页读取不可变历史 envelope，绝不读取后来可变 current 替代旧快照。目录先完成，再 records 全历史。after/highWatermark 是资料库全局游标，即使 lane 过滤也推进到快照边界。assets 不进入正文全量；GET /vaults/:id/assets/:recordId?revision=1 按需读取不可变版本；GET /vaults/:id/assets 清单供完整备份。

GET /vaults/:id/records/:recordId/history 返回 CipherEnvelope[]；恢复客户端解密旧版并加密为当前版本+1，再正常 CAS 提交。每个路由校验当前 account 对 vault 的归属，record/asset 不可越库访问。

客户端 @zhijiao/client 实现 create/unlock/lock、密钥重包装、加密恢复预览、IndexedDB 原子 outbox 与同步；前端不把明文写到持久存储。锁定以 generation 防止迟到解密和异步请求重新显示明文。
