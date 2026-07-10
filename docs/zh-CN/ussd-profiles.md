# Telebirr V1 USSD 与短信样本

流程按菜单文字语义选择，下面的数字只是当前观察样本，不能作为长期硬编码。

## 转账

| 状态 | 期望文字/含义 | 回复 |
|---|---|---|
| 主菜单 | `2. Send Money` | 语义 `SEND_MONEY`（当前为 `2`） |
| 转账菜单 | `1. Send Money` | 语义 `SEND_MONEY`（当前为 `1`） |
| 收款号码 | `Please Enter the receiver mobile number` | 标准化号码 |
| 姓名确认 | `To <number> <name> / 1. OK / 0. Cancel` | 比较姓名后执行 `CONFIRM` |
| 金额 | `Enter Amount` | 两位小数 ETB |
| 备注 | `Enter comment to Customer` | 默认留空 |
| 最终确认 | `You are sending: ETB <amount> for <number> <name>` | 精确核对后 `CONFIRM` |
| PIN | `Enter PIN` | 仅本地解密；提交时进入不可逆 commit |
| 结束 | 等待来自 127 的确认短信 | 关闭 USSD 并等待对应 SIM 短信 |

转出短信必须解析本金、收款姓名/掩码号码、Telebirr 交易号、手续费、VAT、主余额和可选回执链接。Telebirr 交易号用于去重和对账。

## 查询余额

| 状态 | 含义 | 回复 |
|---|---|---|
| 主菜单 | `99. Next` | `NEXT` |
| 第二页 | `5. My Account` | `MY_ACCOUNT` |
| 账户 | `2. Query Balance` | `QUERY_BALANCE` |
| PIN | `Enter PIN` | 本地解密 PIN |
| 结束 | 等待 127 短信 | 关闭会话并保留查询租约 |

余额短信分别解析奖励、主 E-Money（可用）、燃油和 PocketMoney。缺少短信时保留旧值并标记 stale，绝不写成 0。

## 收款短信

收款确认包含收款人称呼、到账金额、发送方姓名/掩码号码、Telebirr 交易号、时间和主余额。解析器允许换行、标点和空格变化，但缺少交易号时不得自动入账。

## Fail closed

- 找不到唯一语义选项：输入 PIN 前终止并上传脱敏 capture。
- 最终确认中的号码、姓名或金额不一致：取消并创建 case。
- PIN 前超时：安全的 pre-commit 失败。
- 提交 PIN 后任何歧义：标记 `unknown`，禁止自动重试。
- 新流程必须通过 replay fixture 和平台签名批准后才能上线。
