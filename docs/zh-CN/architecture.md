# Telebirr P2P 网关 V1 架构

## 目标

平台向商户提供熟悉的异步支付 API，实际资金由受控的私人 Telebirr 钱包手机集群完成。PostgreSQL 的不可变会计分录是财务事实来源；手机钱包余额是持续对账的外部证据。API 可以吸收突发请求，而 USSD 按每台手机串行执行。

## 信任边界

| 边界 | 允许 | 严禁 |
|---|---|---|
| 商户 API | 创建、查询本商户交易；查看汇总余额 | 手机/SIM 身份、原始短信、PIN、其他商户数据 |
| 支付核心 | 预留和记账、选择钱包、签发设备任务 | 读取 PIN 或直接操作 Android UI |
| Telebirr Agent | 读取带 SIM 归属的短信、确定性 USSD、本地输入 PIN | 商户认证、人工改账、AI 决策 |
| OpenClaw/DeepSeek | 脱敏汇总、姓名建议、创建待审批建议 | 发起 USSD、创建/重试付款、PIN、记账 |
| 平台人员 | 按角色操作和审计化人工处理 | 修改历史分录或绕过提交点规则 |

手机只建立出站连接。设备证书、API Key、Webhook Secret、OpenClaw 读取/建议 tool token
以及权限更大的 Gateway operator token 必须分别签发、轮换和吊销。设备流量只能进入独立
mTLS TCP 入口；代理必须删除客户端伪造的证书 Header，再根据已验证 TLS 会话重新生成。

## 财务不变量

1. 每个会计 Journal 借贷平衡且只能追加；更正必须使用冲正分录。
2. 同一个 Telebirr 交易号最多生成一条收款记录和一次商户入账。
3. 每笔提现最多存在一次已提交尝试；`PIN_SUBMITTED` 是不可逆提交点。
4. 已提交、等待运营商结果或 `unknown` 的任务禁止自动重试。
5. 余额过期、已被预留或接近日限额的 SIM 不得用于提现。
6. 商户可用余额不足时拒绝新预留。权威的运营商手续费超额或与人工失败结论矛盾的
   延迟成功可能形成可见负余额；系统必须创建对账事项，并在补足或处理前阻止新的资金请求。
7. 金额在数据库使用 `numeric`，API 使用两位小数字符串，禁止浮点数。
8. 浏览器跳转和 callback 不是付款凭证；查询接口和签名 Webhook 才是权威结果。

## 核心组件

- **公共 API：** 接近 Chapa 的入金、流动性充值、提现、运营商列表、汇总余额、商户结算、
  经审批的 Sweep 规则管理和签名 Webhook 管理接口。
- **支付核心：** 充值/提现状态机、幂等、商户策略和复式记账。
- **匹配服务：** 短信标准化解析、交易号去重和确定性意图匹配。
- **集群调度：** 钱包资格、物理余额预留、手机级 USSD 互斥锁、租约和 fencing token。
- **设备网关：** 独立 mTLS/WebSocket 入口、证书固定激活、任务、心跳和离线队列确认。
- **Webhook Worker：** 基于 outbox 的 HMAC 事件、至少一次投递和人工重放。
- **配置控制：** 持久化、版本化的 platform/merchant/group 提案，只有已批准值驱动运行策略。
- **告警引擎：** 持久化去重事件和带 fencing 的 Telegram 重试；bot token 不进入数据库。
- **管理界面：** Element Plus 平台后台、商户后台和托管收银台。
- **Android Agent：** 确定性短信/USSD、Android Keystore PIN、签名流程配置。
- **AI 辅助：** 隔离的 OpenClaw + DeepSeek，仅提供读取和建议工具。

## 充值状态机

```text
awaiting_payment
  -> detected -> matching -> success
  -> late_grace -> detected -> matching -> success
  -> manual_review -> success | failed
  -> expired
```

- 用户页面有效 10 分钟。
- 之后 30 分钟内，唯一且强匹配的到账仍可自动入账。
- 冲突、超时或策略例外进入 suspense/manual review。
- `status` 只返回 `pending|success|failed`；`p2p_status` 返回精确状态。

自动强匹配必须同时满足：收款 SIM、唯一 Telebirr 交易号、可接受金额和时间、且只有一个候选意图。发送方尾号和姓名用于加强判断和避免冲突，但评分不能覆盖歧义。

## 提现状态机

```text
accepted -> queued -> device_assigned -> device_started
-> pin_submitted -> provider_pending
-> success | failed | unknown | manual_review
```

明确发生在提交点之前的技术失败可以释放设备并重新排队。提交 PIN 后未收到明确短信必须标记为 `unknown`，禁止自动重试，必须人工对账。单笔提现只使用一个 SIM，禁止拆单。

## 余额和限额

每个 SIM 钱包分别保存查询余额和预测余额：主 E-Money（可用）、奖励/燃油/Pocket（受限）、当日转出本金、手续费/VAT、活动预留、钱包上限、日限额和安全余量。

交易短信立即更新预测余额。低优先级余额任务执行 `*127# -> NEXT -> MY_ACCOUNT -> QUERY_BALANCE`，结果通过 127 短信异步返回。余额过期时停止提现并触发刷新，保留旧值，绝不写成 0。

经批准的 platform-treasury Sweep 不会退出平台托管。本金从 fleet Telebirr custody
转入 active 且预先批准的 treasury wallet，并通过 `telebirr_custody` 到
`treasury_custody` 的分录重分类；商户只承担 provider fee。平台后台分别比较 fleet
custody、treasury custody、total custody 与已确认物理余额，并单独显示 drift。

## 交付保证与容量

- 公共写请求：商户 reference + 可选 `Idempotency-Key`。
- 数据库到消息队列：transactional outbox；消费者使用 inbox 去重。
- 设备任务：租约、过期时间、attempt 和单调 fencing token。
- 短信：至少一次上传、多段合并、原文哈希去重。
- Webhook：唯一 `event_id`、时间戳 HMAC、重试和后台重放。

API 目标为每分钟 1,000 个充值意图加 1,000 个提现请求，压测使用 5 倍。实际提现速度受每台手机一个 USSD 会话限制：

```text
安全每分钟笔数 = 在线合格手机数 * 60 / 实测 p95 秒数 * 安全系数
```
