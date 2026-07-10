# 手机安装与验收手册

> 生产密钥规则：真实 Telebirr PIN 禁止拍照、上传、写入工单/聊天/文档/云端字段。PIN 只能在已登记手机本机输入。

## 1. 准备

1. 平台后台打开 **设备集群 > 添加手机**。
2. 选择地点、设备组以及商户专用/共享钱包策略。
3. 填写设备名称、设备组、型号以及两张 SIM 的完整身份。Platform Admin 增加相应字段之前，IMEI、机身序列号和准确的已批准 build 必须保存在受控资产记录中。
4. 创建设备服务器记录，生成有效期 15 分钟的文本激活码，并下载现场手册。Agent 不支持扫描激活二维码。
5. 准备两张已开通 Telebirr 的 Ethio telecom SIM，确认号码和实名。
6. 确认现场供电、网络、散热和物理安全。

## 2. 确认硬件和官方系统

试点只接受 TECNO CAMON 18 Premier CH9n、Android 12 和已批准的 HiOS 8.6 build。

1. 打开 **设置 > 我的手机**，逐项核对型号、Android、HiOS 和 build。
2. 从设置记录 IMEI1/IMEI2，禁止拍到私人短信。
3. 确认 bootloader 已锁定且没有 root。
4. 系统损坏时先隔离设备，只能由 TECNO/Carlcare 使用匹配地区的官方签名固件恢复，禁止下载第三方 ROM。
5. Device Owner 登记前执行恢复出厂设置。

## 3. 安装双 SIM 并确认卡槽

1. 关机，将第一张卡放入 SIM1，第二张放入 SIM2。
2. 开机；除非现场有可靠重启恢复流程，否则关闭 SIM 卡自身的开机 PIN。
3. 在系统中标记为 `TB-S1-尾号` 和 `TB-S2-尾号`。
4. 分别使用两个卡槽进行测试电话/短信，确认号码。
5. 在添加手机向导填写号码、ICCID、卡槽和 Telebirr 实名。卡槽归属不一致必须隔离。

## 4. AirDroid Business Device Owner

1. 在恢复出厂后的首次设置界面，用管理员提供的 AirDroid 登记方式/二维码。
2. 控制台必须显示 **Fully managed / Device Owner**。
3. 下发 `Telebirr-Pilot` 多应用 Kiosk 策略。
4. 只允许拨号、短信、Telebirr Agent、OpenClaw 和 MDM 必需组件。
5. 开启应用更新、设备健康、远程锁定/擦除和有审计的远程支持。
6. 禁止远程文件工具访问 Telebirr Agent 私有目录。
7. 测试无人值守远程查看/控制；如 TECNO 需要 Accessibility 插件，授权后必须验证它与 Telebirr 服务可同时运行。

## 5. HiOS 后台保活

对 Telebirr Agent、OpenClaw、MDM Daemon 分别执行：

1. **设置 > 应用 > 电池**：选择无限制/不优化。
2. 开启自启动和后台活动。
3. 如系统支持，在最近任务中锁定应用。
4. 关闭针对这些应用的自动清理、极致省电和深度休眠。
5. 允许前台服务通知，不要关闭 Telebirr Agent 健康通知。
6. 开启自动日期、时间和时区。
7. 按机房策略设置常亮/充电，并测试长期充电温度告警。

## 6. OpenClaw

1. 只安装后台批准的官方签名 OpenClaw Android APK。
2. 打开 **Connect**，扫描私有 Gateway 配对码。
3. 平台人员核对设备后批准 pairing。
4. 确认前台连接长期在线。
5. OpenClaw 不得获得短信、Accessibility、shell 或任何财务权限。

## 7. Telebirr Agent 激活

1. 通过 MDM 安装平台签名 APK，核对版本和签名指纹。
2. 授予本 build 实际请求的运行时权限：短信接收、电话状态/电话号码和呼叫。如 Android 或 MDM 提供通知开关，则允许通知。本 build 不请求 `READ_SMS`。
3. 在 Accessibility 中开启 **Telebirr deterministic USSD service**。
4. 关闭电池优化并允许自启动。
5. 输入已批准的 Device Gateway `https://` URL、短期激活码和准确的 MDM 客户端证书别名，然后点击 **激活**。将屏幕显示的设备 ID 与 Platform Admin 核对；本机屏幕不显示地点或设备组。
6. Agent 创建硬件密钥并领取可吊销设备证书；云端返回内容绝不能包含钱包 PIN。
7. 只有完成第 6.2 至 6.4 步且官方 OpenClaw 已明确显示在线后，才可打开 Telebirr Agent 引导页并在手机本地点击 **Confirm OpenClaw is paired**。该按钮不能代替实际配对或平台批准。
8. 确认下一次签名心跳报告 `openclaw_paired=true`。这只属于验收证据，不会激活手机或任一 SIM。

## 8. 本地设置两个钱包 PIN

对每个卡槽分别执行：

1. 核对 subscription ID、ICCID 和号码。
2. 执行验收流程规定的只读姓名/账户检查。
3. 停止远程查看。在 Telebirr Agent 的 **SIM ICCID** 中输入该钱包的 ICCID。
4. 在 **Telebirr PIN（仅保存在本机）** 中输入钱包 PIN。
5. 在 **再次输入 Telebirr PIN（仅保存在本机）** 中再次输入，然后点击 **保存本机 SIM PIN**。
6. 确认显示 **已为尾号 #### 的 SIM 保存本机 PIN**；之后不得再次显示明文。
7. 如果显示 **Telebirr PIN 与确认 PIN 不一致**，请在本机重新输入两个 PIN 字段；每次尝试后，两个 PIN 字段都会被清空。
8. 重启，确认只有合法签名任务能使用解密后的 PIN。

## 9. 双卡验收

SIM1、SIM2 必须分别完成：

1. 心跳和权限检查，包括在真实配对后由本地确认生成的签名 `openclaw_paired=true` 证据。
2. 收款短信卡槽归属和解析。
3. `*127#` 菜单语义捕获（不输入 PIN）。
4. 完整余额查询，确认 127 短信中的主余额、奖励、燃油、Pocket 分开保存。
5. 向批准的测试号码小额转账，输入 PIN 前核对收款姓名。
6. 核对转出短信的交易号、手续费、VAT 和余额。
7. 重放重复短信，确认不会重复入账。
8. 断网后恢复，确认离线队列只上传一次。
9. 重启手机，确认三个 Agent 恢复，权限保留，OpenClaw 重连，三分钟内恢复心跳。
10. 开启远程支持，确认无法看到 PIN 或 Agent 私有存储。

在 Platform Admin 中点击 **Start / resume run**，对每个必需的手机/SIM 检查使用 **Record** 和 **Persist evidence**，然后由获授权的平台人员点击 **Approve with password**。ICCID 变化、权限缺失、bootloader 解锁、APK 签名不符或卡槽归属不清均属于必须隔离的情况。

## 10. 上线和恢复

1. 下发最终多应用 Kiosk，粘贴资产标签。
2. 接入批准的供电、散热和网络。
3. 确认双卡余额新鲜、日限额时区正确。
4. 后台标记 `ACTIVE`。上线后禁止人员手工操作 Telebirr。

- **Agent 离线：** 先查电源/网络，再使用有审计的 MDM；不要立即恢复出厂。
- **权限丢失：** 隔离，恢复权限并重新验收。
- **SIM 更换：** 隔离卡槽映射，更新库存并重做双卡测试。
- **系统故障：** 排空任务、吊销证书、官方固件恢复、重新登记、本地重新输入 PIN。
- **丢失/被盗：** 隔离并吊销全部证书，远程锁定/擦除，对两个钱包对账。
- **退役：** 排空任务和余额，确认没有 active/unknown，吊销凭证，MDM 擦除并记录处置证明。

## 服务器控制的注册与批准

管理后台的“添加手机”向导必须联网使用。设备记录和一次性激活码均由平台 API 创建；操作员不得自行编造或重复使用本地激活码。重新生成激活码时，所有尚未使用的旧激活码都会立即失效。

激活后手机只能进入 `qualifying` 状态。操作员必须先完成官方 OpenClaw 配对、取得平台批准并确认在线，然后才可在 Telebirr Agent 点击 **Confirm OpenClaw is paired**。随后签名心跳可以记录权限、无障碍服务和 OpenClaw 证据，但不能激活 SIM 钱包。必须为手机及每个 SIM 卡在持久化验收记录中填写所有必选检查的证据引用。全部检查为 `passed` 后，平台管理员或操作员必须重新输入个人密码并批准最新验收记录；只有该批准操作可以把 SIM 钱包从 `pending` 改为 `active`。

如果 ICCID、卡槽、号码、注册姓名、短信归属、USSD 卡选择、余额回复或转账确认中任何一项不确定，必须拒绝验收。心跳不得重新启用已拒绝、隔离或停用的 SIM 卡。
