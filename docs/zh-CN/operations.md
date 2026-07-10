# 运营与对账手册

## 提现结果 unknown

1. 冻结提现和相关 SIM 预留，严禁重试。
2. 确认任务是否到达 `PIN_SUBMITTED`，保存签名步骤日志。
3. 搜索对应 SIM 的短信，包括多段短信和离线期间收到的短信。
4. USSD 会话结束后才能排低优先级余额查询。
5. 对比预测余额、查询主余额、本金、预期手续费/VAT 和之后交易。
6. 找到转出交易号后，附证据，通过审计化流程标记成功并完成分录。
7. 有明确失败证据时标记失败并释放商户预留。
8. 证据仍不清楚时继续 manual review，禁止补发。

## 未匹配充值

1. 按 Telebirr 交易号去重，只把资金一次性记入 suspense。
2. 先按收款 SIM、金额和时间搜索，再检查发送方尾号和标准化姓名。
3. 只有唯一候选满足策略才能自动匹配。
4. 商户客服可以提交建议；平台人员核验后批准。
5. 从 suspense 到商户/用户只生成一次平衡分录，并发送新的唯一 Webhook 事件。

## 设备离线

- 90 秒无心跳：停止新任务分配。若资金任务已经下发或租约已经被手机领取，则租约到期后必须进入 `unknown`，并继续冻结所有资金预留，因为本地可能已经输入 PIN，而云端尚未收到下一条状态事件。
- 3 分钟：标记离线并通过后台/Telegram 告警。
- 先检查供电、网络、MDM，再远程处理。
- 只有从未下发到手机的排队任务，或有签名设备证据明确证明在输入 PIN 之前失败的任务，才可以使用更高的 fencing token 重新排队。任何已经下发/领取租约的资金任务在租约丢失后都必须进入 `unknown`；在对账确认结果前，严禁重试或改派。已提交任务仍绑定原设备。
- 恢复后上传本地短信/任务队列，核对 SIM 身份，完成新余额查询后才能继续提现。

## SIM 更换或卡槽不确定

立即隔离 SIM 和手机、停止 USSD、记录两个 ICCID/subscription ID、对账、经平台批准后更新库存，并重新执行全部双卡验收。

### 审计恢复、凭据轮换与退役

1. 先让两个 SIM 上的所有入金分配到期或完成处理，并对所有 pending/unknown 提现完成对账。存在未结财务任务时，系统必须禁止恢复或退役。
2. 在 Fleet 中选择 **Recover / re-enroll**，重新验证密码，输入每个实体 SIM 的完整 ICCID、Telebirr 号码和登记姓名，并填写审计原因。
3. 恢复操作必须原子地吊销旧设备 token 和证书、作废旧激活码、把余额标记为过期、创建新的资格认证流程，并且只显示一次短期激活码。
4. 激活已签名 Agent，核对两个 subscription 映射，执行新的余额查询，重新完成重启、权限、短信、USSD 和转账检查，然后由平台人员重新批准。心跳不能自行解除隔离。
5. 永久停用时选择 **Retire**。退役会禁用设备凭据和 SIM 分配。若要把这些 SIM 安装到替换手机，必须在同一库存记录上使用审计恢复流程并勾选 **replacement handset**；严禁创建重复库存或直接修改数据库。

## 流动性

- 超过高水位时排低优先级 sweep，保留目标余额和最大手续费。
- 提现流动性不足时返回 `no_physical_liquidity`，禁止只依据商户账本透支。
- Sweep/settlement 占用 SIM 日限额，并遵守与提现相同的提交点/unknown 规则。
- `platform_treasury` Sweep 必须匹配状态为 active 且预先批准的 treasury wallet。确认成功后增加其预测余额，并把本金从 fleet custody 重分类到 treasury custody。
- 人工确认 treasury wallet 余额必须重新验证密码、填写原因并关联证据；fleet、treasury 和 total custody drift 必须分别调查。

## 人工财务操作

必须具备平台角色、重新输入密码、填写原因、关联证据并生成不可变审计。历史 journal 禁止修改/删除，只能做冲正分录。

对账界面必须读取关联后的 case、transfer、attempt、device、SIM 和 receipt 数据，并且只提供状态安全的操作：

- 只有 `accepted`、`queued` 或 `device_assigned` 且任务尚未被手机租用的转账可以取消。
- 收款姓名检查在提交点之前取消后，操作员必须输入运营商界面显示的完整准确姓名，重新验证密码，然后才能创建一次新的 fencing attempt。
- Unknown 成功必须提供运营商交易号、服务费和 VAT 证据。
- 提交点后的 Unknown 失败必须提供结论性的运营商失败证据引用。

每次操作都会消耗一个一次性重新认证令牌，并从服务器重新载入 case。不得根据界面倒计时推断成功或失败。

## 配置激活

配置变更是不可变提案，状态为 `pending`、`approved` 或 `rejected`。批准前必须核对 scope、完整 proposed 值、version、提交人和 reason。平台默认使用 `scope_id=platform`；merchant 和 device-group 提案必须引用现有 UUID。调度器、余额过期检查和容量计算只读取已批准的平台/分组限额。禁止直接修改数据库，也不得把 pending 提案当作已生效配置。

## 持久化告警与 Telegram 投递

运营告警持久化保存，生命周期为 `open -> acknowledged -> resolved`，每个动作写入不可变审计。Telegram 投递是独立持久化记录，状态为 `pending|processing|delivered|failed`，使用 30 秒 fencing lease；对过去 24 小时内创建的投递按指数退避重试（15 秒起，最长一小时）。相同类型和相同脱敏 metadata 的重复告警会在配置窗口内去重。

数据库只保存 Telegram `chat_id`、启用告警类型和 version；`TELEGRAM_BOT_TOKEN` 必须留在部署 Secret 环境中。投递失败时通过 `GET /v1/admin/alerts` 检查已保存的 attempt/error，禁止把 bot token 写入 reason、metadata 或界面。Acknowledge 表示有人负责正在处理的事件；只有根因及相关财务对账完成后才能 resolve。
