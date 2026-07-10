# 备份、恢复与灾难恢复

## 恢复目标与职责

生产目标为 RPO 不超过 5 分钟、RTO 不超过 1 小时。事件负责人授权切换；数据库人员恢复 PostgreSQL；支付负责人在恢复流量前验证账本、未知出金和实体钱包差异。Android PIN 不进入云备份，因此不能从云端恢复。

## 备份集合

- 托管 PostgreSQL 连续 WAL/PITR，以及加密的每日和每月快照。
- 对象存储开启版本、加密，用于证据和审计导出。
- Terraform state 存放在独立加密、带锁和历史版本的后端。
- 单独加密保存公钥证书、Webhook 配置和已签名 USSD profile。
- 备份 Secret Manager 元数据与轮换流程，不在归档中保存明文 Secret。

RabbitMQ 和 Redis 属于可重建的传输/缓存系统。应从 PostgreSQL 恢复权威记录与 outbox，再重建队列，由幂等 consumer 重放。

## 每季度恢复演练

1. 选定生产恢复时间点，在隔离 VPC 中创建恢复环境。
2. PostgreSQL 恢复到该时间点，并恢复匹配版本的对象存储。
3. 部署同一不可变 release；只有 release 文档要求时才执行 migration。
4. 抽样验证 journal 总和为零，并与预先记录的控制总额核对。
5. 重建 RabbitMQ quorum queue，重放未发布 outbox，验证 inbox 去重。
6. 验证期间关闭设备下行和商户 Webhook，检查已提交、pending、unknown 尝试。
7. 轮换恢复环境凭证、吊销测试设备证书，签署证据后销毁恢复环境。

## 区域故障切换

1. 停止公共写入或进入维护模式；主数据库状态不确定时禁止接受新出金。
2. 确认最新恢复点，确保只有一个 PostgreSQL primary。
3. 在恢复区域部署 API/设备网关、RabbitMQ、Redis 和对象存储路由。
4. 切换 DNS/负载均衡和内部 endpoint；设备通过出站连接重新认证。
5. 所有达到 `PIN_SUBMITTED` 的任务必须先对账，禁止直接补发；不明确的标记为 `unknown`。
6. 完成账本、Webhook backlog、SIM 余额新鲜度和 fencing 检查后，先恢复入金，再恢复出金。

## 凭证泄露

优先吊销最小范围凭证：商户 Key、Webhook Secret、设备证书、profile 签名密钥、
`OPENCLAW_TOOL_TOKEN` 或单独授权的 `OPENCLAW_GATEWAY_TOKEN`。设备任务签名密钥泄露时，
暂停新任务，轮换密钥，通过已签名应用/profile 分发新公钥，并使所有未完成任务失效。
不得为了达到 RTO 而绕过设备隔离。
