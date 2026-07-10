# Chapa 接入迁移说明

本 API 采用 Chapa 常见的 initialize、verify、transfer 术语，但不是只替换 URL 的完全兼容接口。应按“更换支付 provider adapter”实施，并保留服务端 verify。

| 原概念 | V1 映射 | 必须修改 |
|---|---|---|
| Secret/Test Key | `sk_live_<prefix>.<secret>` / `sk_test_<prefix>.<secret>` | 测试和生产分开保存，禁止放入浏览器。 |
| Initialize | `POST /v1/transaction/initialize` | ETB 使用两位小数字符串，传稳定 `customer_id`。 |
| Checkout URL | `data.checkout_url` | 展示带倒计时的手机转账说明。 |
| Verify | `GET /v1/transaction/verify/{tx_ref}` | 同时读取粗粒度 `status` 和 `p2p_status`；只有不存在才返回 404。 |
| Transfer | `POST /v1/transfers` | `bank_code=855`，电话号码放 `account_number`，传预期实名；除非其他目的号码已经平台批准，否则使用 `destination_type=registered`。 |
| Transfer verify | `/v1/transfers/verify/{reference}` | 处理 queued、committed、provider-pending、unknown、manual review。 |
| Callback/return URL | 兼容/辅助字段 | `return_url` 用于页面导航；V1 不保证直接投递 `callback_url`，必须使用签名 Webhook 和 verify。 |
| Webhook | 原始 body HMAC | 验证 `X-P2P-Timestamp` 和 `X-P2P-Signature`，按 `event_id` 去重。 |
| 商户流动性充值 | `POST /v1/topups/initialize` | 使用 initialize 结构，并通过 transaction verify 查询。 |
| 商户结算 | `POST /v1/settlements` | 独立审批生命周期；创建请求不代表已经派发。 |

所有写接口均幂等。相同 reference 但 payload 改变时返回 `409 duplicate_reference_conflict`，不会静默修改原记录。Webhook 至少投递一次且可能乱序，因此必须保存 event ID，并在每个终态事件后调用 verify。

正式切换前，完成全部确定性 test scenario；使用不转真钱的 shadow adapter 比较新旧结果；证明 `unknown` 出金不会自动补发。
