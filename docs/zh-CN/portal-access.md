# 门户访问与人员身份验证

商户门户和平台管理门户必须使用个人账号。商户 API 密钥、设备证书、Webhook 密钥和门户会话令牌是相互独立的凭据，不能混用。

## 初始管理员

只允许在全新受控环境第一次运行生产 seed 之前设置 `BOOTSTRAP_PLATFORM_ADMIN_EMAIL`、`BOOTSTRAP_PLATFORM_ADMIN_NAME` 和非占位、至少 20 个字符的 `BOOTSTRAP_PLATFORM_ADMIN_PASSWORD`。生产 bootstrap 只能创建一次；只要已经存在任何平台员工账号就会拒绝执行，绝不会重置或重新启用已有账号。创建后立即从部署环境中删除该密码；后续恢复必须使用单独审计的 break-glass 流程。

调用 `POST /v1/admin/merchants` 创建商户时必须提供 `owner_email`。响应只显示一次所有者邀请令牌。请通过经批准的私密渠道发送；所有者调用 `POST /v1/portal/auth/invitations/accept` 接受邀请，并设置至少 12 个字符的密码。

## 会话和角色

- 商户角色：`owner`、`admin`、`support`。所有者和管理员可以管理集成密钥；只有所有者可以邀请其他所有者。
- 平台角色：`admin`、`operator`、`support`、`auditor`。平台支持和审计角色对管理功能只有只读权限。
- 人员会话有效期为 12 小时，并可立即撤销。浏览器只把不透明会话令牌保存在 session storage 中，关闭标签页后即被清除。
- 登录尝试按照规范化邮箱和来源地址限流；生产环境使用 Redis 共享计数器。

## 敏感平台操作

执行敏感覆盖操作之前，使用员工密码调用 `POST /v1/admin/auth/reauthenticate`。将返回的五分钟、一次性令牌作为 `X-Reauth-Token` 放在且仅放在一个敏感请求中。

`ADMIN_API_TOKEN` 不是员工登录凭据，只用于服务自动化和紧急破玻璃操作。使用该令牌执行敏感请求时，必须提供至少 10 个字符的 `X-Break-Glass-Reason`；请求会写入不可变审计日志。紧急使用后必须轮换令牌。

## 版本化设置与审批

Settings 不是只读功能。商户 owner/admin 可通过
`POST /v1/portal/settings/changes` 提交 merchant 范围的配置提案，并通过
`GET /v1/portal/settings/changes` 查看历史。Settings UI 通过
`GET /v1/portal/settings/current` 获取当前已批准或基线策略；merchant support 不能提交。
请求必须包含完整 `proposed` 对象和用于审计的 `reason`。支持的商户设置包括其他提现号码、入金最小/最大值、
错金额容差、provider/gateway fee 预留、倒计时/延迟宽限期和托管页技术故障提示。

平台人员使用以下审批接口：

- `GET /v1/admin/configuration/changes?status=pending|approved|rejected`
- `POST /v1/admin/configuration/changes`，提交 platform-default、merchant 或
  device-group 提案
- `POST /v1/admin/configuration/changes/{changeId}/approve`
- `POST /v1/admin/configuration/changes/{changeId}/reject`

提案、批准和拒绝都必须填写 reason；平台写操作需要相应写角色，提案/审核还需要密码
重新验证。批准会原子地激活新版本。运行时的余额过期时间、容量安全系数、默认入金时间、
钱包上限、日限额和安全余量只读取已批准策略；pending/rejected 值绝不影响调度或资金移动。

## Treasury wallet 与告警

平台专用接口为 `GET/POST /v1/admin/treasury-wallets` 和
`POST /v1/admin/treasury-wallets/{walletId}/balance-evidence`。创建或更新预批准目的钱包、
记录确认余额证据都需要密码重新验证和审计 reason。Treasury 号码不能同时是 fleet SIM。
余额证据操作会同时更新 confirmed 与 predicted balance；它属于有证据的对账，不是无记录调账。

`GET /v1/admin/alerts` 返回持久化运营告警及其 Telegram 投递尝试。
`POST /v1/admin/alerts/configuration` 在密码重新验证后保存 chat destination 和启用类型；
空的 `enabled_types` 数组会禁用全部 Telegram 路由。
`TELEGRAM_BOT_TOKEN` 始终是部署 Secret，不会返回或写入该设置。员工可通过相应
`/v1/admin/alerts/...` 操作测试路由、确认和解决告警；解决操作需要密码重新验证。

## 商户支持工单

所有已登录商户用户都可以通过 `/v1/portal/support/cases` 创建并跟进严格限定在本商户
范围内的工单。工单记录 `test` 或 `live` 环境、类别、主题、可选交易引用、沟通记录、
受控证据引用和可选匹配建议。类别包括交易匹配、提现结果、流动性充值、结算、
Webhook、API 和其他。工单关闭后，平台人员重新打开之前，商户不能继续留言。

所有平台角色都可以通过 `GET /v1/admin/support/cases` 跨商户搜索。只有平台 admin 和
operator 可以回复，并将沟通流程状态变更为 `open`、`investigating`、
`awaiting_merchant`、`resolved` 或 `closed`。状态变更必须说明原因并遵守允许的状态迁移；
support 和 auditor 角色保持只读。OpenAPI 契约分别说明商户会话和平台会话的认证方式及响应。

证据和匹配建议仅供人工参考。创建建议、回复或将工单标记为已解决，都不会生成账本
分录、匹配收款、解决对账事项或重试提现。因此响应固定返回
`financial_resolution_performed: false`；任何财务处理都必须使用独立授权、密码重新验证
且完整审计的对账流程。

这些人员会话和平台控制接口与外部 merchant-secret OpenAPI 契约有意分离。

部署门户时设置 `VITE_DEMO_MODE=false`。只有明确设置为 `true` 才会加载演示数据。
