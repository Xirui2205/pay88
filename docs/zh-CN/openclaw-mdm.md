# MDM、OpenClaw 与 DeepSeek 配置

## 职责隔离

AirDroid Business 负责手机管理，OpenClaw 只提供运营建议，Telebirr Agent 负责确定性的短信与 USSD 执行。三者属于不同信任域。OpenClaw 禁止获得短信权限、Accessibility 权限、钱包 PIN、设备任务签名密钥或任何支付接口凭证。

## 试点 MDM 策略

1. 在 AirDroid 创建 Device Owner 策略 `Telebirr-Pilot`，并为有审计的远程支持创建独立角色。
2. 多应用 kiosk 只允许拨号、短信、Telebirr Agent、OpenClaw companion 和 AirDroid 组件。
3. 通过私有应用组分发已签名的 Telebirr Agent；固定签名证书，升级到生产前必须经平台批准。
4. 对三个后台应用开启不受限电池、自动启动；禁止 MDM 读取应用私有目录。
5. 本地输入 PIN 和授权远程会话期间开启屏幕隐私，并记录人员、原因、起止时间和设备 ID。
6. 连续 72 小时验证 AirDroid 无人值守控制和 Telebirr Accessibility 服务可以共存；任一服务被停用时自动隔离设备。
7. 如果 HiOS 兼容测试失败，恢复出厂后改用 ManageEngine MDM Plus Cloud 与 Universal Add-on。禁止 root 或非官方 ROM。

## 私有 OpenClaw Gateway

1. Gateway 部署在隔离 VM，只允许访问内部 API，不允许直连数据库。
2. 配对官方 Android companion，并人工批准准确设备请求。此配对只用于运营监控，不等于支付设备身份。
3. 确认 companion 在线。只有此时才能在 Telebirr Agent 引导页本地点击 **Confirm OpenClaw is paired**，并确认下一次签名心跳报告 `openclaw_paired=true`；之后仍必须完成平台验收审批。
4. 构建 `integrations/openclaw-telebirr`，安装后只启用 `openclaw.plugin.json` 声明的工具。
5. 设置独立 `OPENCLAW_TOOL_TOKEN`，且只允许访问 `/internal/ai/*`。它可读取脱敏摘要、创建审批建议，但不能批准建议。
6. 在 Telebirr workspace 禁止 shell、文件写入、浏览器自动化、设备控制和不受限 HTTP 工具。
7. 所有短信、USSD、商户和客户文本都视为不可信数据，只通过类型化字段传入，禁止拼接到系统指令。
8. 为隔离 Gateway 和姓名检查 dispatcher 设置完全不同的 `OPENCLAW_GATEWAY_TOKEN`。该令牌可访问 Gateway `/v1/responses` operator 接口，权限范围更大；严禁提供给 plugin tool、Android companion、公网入口或支付 API 客户端。

## DeepSeek

通过官方 [OpenClaw DeepSeek provider](https://docs.openclaw.ai/providers/deepseek)
配置 DeepSeek。日常摘要和姓名检查使用 `deepseek-v4-flash`；复杂调查只有平台批准后
才可使用 `deepseek-v4-pro`。姓名检查只接收两个规范化姓名和关联 ID，返回
`likely_match`、`uncertain` 或 `mismatch`。结果仅供参考：确定性高置信结果可继续，
不确定结果必须由员工批准后创建新的提交前尝试。

## 故障与轮换测试

- 吊销 `OPENCLAW_TOOL_TOKEN`，确认入金、出金和设备任务不受影响；然后单独测试 `OPENCLAW_GATEWAY_TOKEN`。
- 阻断 DeepSeek 外网，确认不确定姓名进入人工审核，确定性匹配继续运行。
- 分别吊销 Android pairing 和 Telebirr 设备证书，验证两者互不替代。
- 分别轮换 DeepSeek、`OPENCLAW_TOOL_TOKEN` 和 `OPENCLAW_GATEWAY_TOKEN`，确认旧值失效且日志中没有 Secret。
- 导出 MDM 远程会话审计，并与平台审计页面核对。
