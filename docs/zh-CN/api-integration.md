# 商户 API 接入

契约文件：[OpenAPI 3.1](../openapi/telebirr-p2p-v1.yaml)、
[可运行示例](../examples/README.md) 和
[Postman 集合](../postman/Telebirr-P2P-V1.postman_collection.json)。

## 认证与环境

Secret Key 只能在服务端使用：

```http
Authorization: Bearer sk_test_yourprefix.yoursecret
Content-Type: application/json
Idempotency-Key: merchant-order-123
```

测试和生产的 Key、reference、余额、Webhook 和数据完全隔离。禁止把 Secret Key 放入浏览器代码。

生产默认采用所有 API 实例共享的限流：每个 API Key 每分钟 2,000 个已认证请求。超过后
返回 HTTP 429 和 `code=rate_limited`；请退避后使用同一 reference 和
`Idempotency-Key` 重试。平台可以为账户或环境发布经过评审的不同限额。

## 创建充值意图

调用 `POST /v1/transaction/initialize`，传入两位小数金额、`ETB`、唯一 `tx_ref`、商户 customer ID、用户手机号、姓名、可选回调/样式和 `metadata`。服务端返回 `data.checkout_url` 后跳转用户。

`callback_url` 仅为兼容字段并作为请求元数据保存；V1 不保证直接请求该地址。签名
Webhook 和服务端 verify 才是权威结果。

浏览器跳转不是入账凭证；必须等待签名 Webhook 或调用：

```http
GET /v1/transaction/verify/{tx_ref}
```

核对 reference、币种、请求金额、实际到账金额和最终状态。`status` 为 `pending|success|failed`，详细流程查看 `p2p_status`。

`data.checkout_url` 包含不透明的资源范围 Token。浏览器通过
`GET /v1/checkout/{tx_ref}?token=...` 获取页面状态；严禁把商户 Secret Key
放入浏览器，也不要在普通日志中记录完整 checkout URL。

## 商户流动性充值

调用 `POST /v1/topups/initialize`，请求结构与客户入金相同，但到账后增加
商户流动性。继续使用 `GET /v1/transaction/verify/{tx_ref}` 验证；生命周期
Webhook 事件类型为 `topup.updated`。

## 创建提现

```http
POST /v1/transfers

{
  "account_number": "0912345678",
  "expected_name": "Abebe Kebede",
  "amount": "500.00",
  "currency": "ETB",
  "reference": "withdrawal-456",
  "bank_code": 855,
  "customer_id": "player-42",
  "destination_type": "registered"
}
```

`destination_type` 默认为 `registered`，表示经过认证的商户声明该号码是其客户注册号码。
只有商户的“允许其他目的号码”配置经平台批准后才能传 `alternate`；否则返回 HTTP 403
`alternate_destination_disabled`。

`queued` 只表示进入队列，不表示已经转账。使用 `GET /v1/transfers/verify/{reference}` 查询。处于 `provider_pending`、`unknown` 或 `manual_review` 时禁止创建替代提现，必须等待平台对账。

响应中的 `status_url` 用于托管进度动画，`status_api_url` 用于范围受限的
轮询；二者都不能替代商户认证。同一 Token 可连接
`GET /v1/hosted/transfers/{reference}/events?token=...` 的 SSE 流。服务端先发送
一次 `transfer.status`，之后仅在状态或 provider transaction ID 变化时发送，发送终态后关闭。
SSE 的 `data` 直接是托管提现对象（不是标准 envelope），并额外包含 `merchant_name`；
浏览器 `EventSource` 不得携带商户 Secret Key。

当前提现响应还包含 `created_at`、非负 `eta_seconds`、
`estimated_completion_at`、`status_url` 和 `status_api_url`。ETA 只是估算，不是终态承诺。

`GET /v1/banks` 仅返回 Telebirr，代码为
`855`；创建提现时可传数字 `855` 或字符串 `"855"`。`GET /v1/balances`
只返回商户账本和汇总物理流动性，不公开单台手机余额。只有权威的提交后证据显示
provider fee 超出预留，或与之前的人工失败结论矛盾时，`available` 才可能为负数；
平台会明确显示该债务并创建对账事项，而不会隐藏真实的运营商出款。

## 商户 Telebirr 结算

通过以下接口提交平台审核：

```http
POST /v1/settlements
Idempotency-Key: settlement-789

{
  "reference": "settlement-789",
  "account_number": "0912345678",
  "expected_name": "Merchant Treasury",
  "amount": "25000.00",
  "currency": "ETB"
}
```

创建请求只记录 `requested`，不会立即转账。平台员工批准后才会预留商户账本和
实体流动性，并通过一个受 fencing 保护的 Telebirr 任务出款；商户承担本金、实际
provider fee/VAT 和配置的 gateway fee。使用 `GET /v1/settlements/{reference}` 或
`GET /v1/settlements` 查询。状态包括 `requested`、`approved`、`rejected`、
`dispatched`、`success`、`failed`、`unknown`、`manual_review`。`unknown` 对账完成前
禁止再次申请替代结算。Webhook 类型为 `settlement.updated`。

## 经审批的流动性 Sweep 规则

商户可使用：

- `POST /v1/sweep-rules`
- `GET /v1/sweep-rules`
- `GET /v1/sweep-rules/{id}`
- `PUT /v1/sweep-rules/{id}`
- `DELETE /v1/sweep-rules/{id}`（JSON body 必须包含 `reason`）

`group_id` 由平台在 onboarding 时提供。新建或修改后的规则为 `pending`，必须由平台
批准；修改会增加 `version` 并强制重新审批。禁用规则只阻止新执行，不会取消已经越过
commit boundary 的转账。

`target_balance` 必须低于 `high_water_balance`。每次执行还会考虑已预留余额、安全余额、
SIM 日限额余量、`max_per_run` 和 `minimum_interval_seconds`。`merchant_owned` 目的地会
离开平台托管并扣除商户本金和费用。`platform_treasury` 目的地必须匹配平台预先批准且
状态为 active 的 treasury wallet；它属于内部托管移动，仅向商户收取 provider fee，
本金则从 fleet Telebirr custody 重分类到 treasury custody，并增加 treasury wallet 的
预测余额。目的号码不能是已加入 fleet 的 SIM。批准规则只在 live 环境自动执行。商户通过
`sweep.updated` 获取 rule 和关联 transfer reference；商户接口不会公开源 SIM 身份。

## 幂等

第一次请求会固定 idempotency key 对应的 payload。相同请求重复提交返回原资源；相同
key/reference 使用不同内容返回 HTTP 409 `duplicate_reference_conflict`。

不传请求头时，入金/流动性充值使用 `tx_ref`，提现/结算使用 `reference`，Sweep 创建使用
`name`，Sweep 修改/禁用和 Webhook delivery replay 使用资源 ID；Webhook 注册根据 URL
生成稳定 key。每次有意再次修改 Sweep 规则时，应显式传一个新的 key。

## Webhook 签名

通过 `POST /v1/webhooks` 配合 `Idempotency-Key` 注册 HTTPS 地址。必须在丢弃响应前
安全保存 `data.secret`。对同一注册请求做完全相同的幂等重放时，会返回同一 endpoint 和
secret；`GET /v1/webhooks` 永远不会返回 secret。
`POST /v1/webhooks/deliveries/{deliveryId}/replay` 也支持幂等 key，用于审计后的人工重放。

使用 `PATCH /v1/webhooks/{endpointId}` 禁用或重新启用投递。每次有意轮换密钥时，必须调用
`POST /v1/webhooks/{endpointId}/rotate-secret` 并提供一个新的 `Idempotency-Key`。如果响应丢失，
使用同一个 key 重试会返回同一个一次性 secret；不得因为第一次响应超时而改用不同 key 再次轮换。

生产环境的接收地址必须使用 HTTPS，不得包含 URL 用户名、密码或片段，并且
所有 DNS 解析结果都必须是公网地址。系统会拒绝私网、环回、链路本地、运营商
NAT、组播、文档保留段及其他保留的 IPv4/IPv6 地址。每次投递都会重新校验 DNS，
并把连接固定到已校验的地址；系统不会跟随重定向，请直接登记最终接收地址。

```text
signed_payload = X-P2P-Timestamp + "." + 原始 HTTP body 字节
X-P2P-Signature = "v1=" + HMAC_SHA256(webhook_secret, signed_payload)
```

拒绝超过五分钟的时间戳，按 `event_id` 去重，快速返回 2xx 后异步处理。Webhook 至少
投递一次且不保证顺序；失败后指数退避重试最多 24 小时，之后可人工重放。事件类型包括
`deposit.updated`、`topup.updated`、`transfer.updated`、`settlement.updated`、
`sweep.updated`。真正记账前再次调用对应的 verify/read 接口。

## 测试场景

测试 Key 可在顶层 `test_scenario` 指定入金 `success`、`wrong_amount`、`late`、`duplicate`、`ambiguous`，或出金 `success`、`explicit_failure`、`delay`、`unknown`。测试模式不分配真实手机、不移动真实资金。

`delay` 会让测试提现停留在 queued，便于测试进度界面。只能使用测试 Key 完成：

```http
POST /v1/test/scenarios/transfers/{reference}/complete

{ "outcome": "success" }
```

`outcome` 可为 `success`、`failed` 或 `unknown`。首次调用时提现必须仍处于
`accepted` 或 `queued`；相同 outcome 重放返回同一终态，不同 outcome 返回 409。
live Key 会收到 HTTP 403。

自动 Sweep 执行仅用于 live 环境；test key 可测试规则 CRUD 和审批相关接口结构，但不会派发 Sweep。

Webhook 延迟、重试和重复属于投递测试工具行为，不是财务请求
`test_scenario` 的合法值。随附的签名接收器可设置
`WEBHOOK_RESPONSE_DELAY_MS` 和 `WEBHOOK_FAIL_FIRST_ATTEMPTS`；使用相同
`event_id` 重放即可验证消费端去重。详见 `tools/webhook-receiver/README.md`。

## 标准响应与错误

所有响应都包含 `status`、`message`、`code`、`data` 和 `request_id`，并在
`X-Request-Id` 响应头返回同一 ID。ETB 金额必须是两位小数的字符串。
稳定错误代码包括 `validation_error`、`unauthorized`、`forbidden`、
`not_found`、`duplicate_reference_conflict`、`active_intent_exists`、
`insufficient_merchant_balance`、`no_physical_liquidity`、
`alternate_destination_disabled`、`invalid_webhook_url`、`rate_limited`、
`invalid_state` 和 `internal_error`。
