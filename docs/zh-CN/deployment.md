# 云端部署与升级手册

## 环境

`test`、`staging`、`production` 必须隔离。参考生产环境为 DigitalOcean Frankfurt；应用使用标准 PostgreSQL、Redis、AMQP、S3 和容器接口，后续可迁移到阿里云。

## 创建顺序

1. 创建私有 VPC、受限管理网络、负载均衡和 DNS。
2. 创建加密、自动故障转移、支持 PITR 的托管 PostgreSQL。
3. 创建托管 Redis，只用于缓存/限流，绝不能作为账本事实来源。
4. 创建三节点 RabbitMQ，使用 quorum queue 和 TLS。
5. 创建启用版本和保留策略的加密对象存储。
6. 在不同故障域创建至少两台 API/设备网关 VM。
7. OpenClaw 使用独立 VM/系统用户，只开放私网入口。
8. 所有 Secret 放入云 Secret Manager；设备任务/Webhook 密钥离线或通过 KMS 生成。
9. 数据库迁移只执行一次，然后部署带健康检查的不可变容器。
10. 配置 TLS；公网只开放公共 API/checkout，内部、后台和设备路由按各自安全边界开放。

## 生产必需依赖

生产环境必须能够连接 PostgreSQL、Redis 和 RabbitMQ。必须设置 `REDIS_URL` 和
`RABBITMQ_URL`；进程内缓存和事件只允许用于开发。`/health/ready` 会实际执行数据库
查询、Redis `PING` 和 RabbitMQ exchange 检查，任一失败就返回未就绪。公网负载均衡
只有在该检查成功后才能把流量路由到实例。

商户 API 使用 Redis 固定分钟计数器，所有 API 实例共享。环境变量
`MERCHANT_API_RATE_LIMIT_PER_MINUTE` 默认设置为每个 API Key 每分钟 `2000` 个请求；
修改前必须评审并完成压测。Redis 故障时实例应退出就绪状态，严禁静默退化成各进程独立限流。

## 设备 mTLS 入口

设备 WebSocket 使用独立 TLS 通道，与公网 HTTPS 入口分离：

1. DigitalOcean 负载均衡以 TCP 方式将 `:8443` 原样转发到应用主机 HAProxy
   `:3443`。设置 `DEVICE_GATEWAY_URL=wss://<api-host>:8443/v1/device/connect`。
2. 部署时用高强度 `DEVICE_MTLS_PROXY_SECRET` 渲染
   `infra/haproxy/device-mtls.cfg.tmpl`。渲染后的文件只能由 root 读取；服务端证书和私钥
   挂载到 `/run/secrets/device-ingress.pem`，受信任设备客户端 CA 挂载到
   `/run/secrets/device-client-ca.pem`。
3. 相同 proxy secret 只提供给 HAProxy 和 API 容器。严禁写入镜像、Terraform state、
   日志、公网负载均衡或普通公网 HTTP 入口。
4. HAProxy 强制验证客户端证书、拒绝非设备路径，先删除客户端传入的
   `x-client-cert-verified`、`x-client-cert-sha256`、`x-device-ingress-secret`，再根据已验证
   TLS 会话设置这些 Header，并且只转发到本机 API 监听地址。
5. 公网路由不得开放 `/v1/device/*`；普通公网入口也必须删除上述三个 Header，绝不能设置
   它们或取得 proxy secret。API 还会验证入口 Secret 和证书指纹；激活时把证书固定到
   已登记设备。Proxy secret 只是纵深防御通道凭证，不能代替 mTLS。

## 蓝绿升级

1. 构建签名镜像和 SBOM。
2. 完成单元、集成、迁移和 API contract 测试。
3. 部署未激活环境，使用测试 Key 做 smoke test。
4. 升级 USSD 流程时必须发布新的数字 profile 版本，并等待所有已通过资格认证的手机上报安装成功。严禁在同一个 ID/版本下替换已经签名的内容。
5. 先把旧版本中已领取租约/已开始的任务处理到终态或 `unknown`。调度器只能升级从未下发的 `queued` 任务，而且必须分配新的 fencing token；重新开放提现前要核对相应审计记录。
6. 按顺序 drain 公共请求、Webhook Worker 和设备连接；已提交任务状态必须持久化，禁止直接终止。
7. 切换负载均衡，监控错误、队列、账本指标，保留旧环境用于回滚。
8. 删除旧版本前，数据库变更必须同时兼容新旧应用。

## 备份恢复

- PostgreSQL PITR RPO 目标 5 分钟，每季度做完整恢复演练。
- 每日加密数据库备份保留 30 天；月备份保留 12 个月。
- 结构化财务/审计默认保留 7 年。
- 原始加密短信/USSD 默认保留 180 天，之后保留解析和脱敏字段。
- Webhook 配置、流程签名密钥和公钥证书单独备份。
- Android 钱包 PIN 严禁进入备份。

## OpenClaw

在隔离主机安装官方 Gateway 和 DeepSeek provider。安装本项目 advisory plugin，只开启
声明的 Telebirr 读取工具，禁止 exec、node、gateway 和文件写入。必须使用两个完全不同的凭证：

- `OPENCLAW_TOOL_TOKEN` 只供本平台 `/internal/ai/*` 读取/建议接口使用，不能访问商户、
  平台管理、设备或支付接口。
- `OPENCLAW_GATEWAY_TOKEN` 只用于隔离 Gateway 的 `/v1/responses` 接口。OpenClaw 当前文档
  将该 Bearer 视为完整 operator scope，因此只允许支付核心 Worker 和隔离 Gateway 保存，
  严格限制网络访问，并且绝不能复用为 tool token。

两个凭证必须分别轮换，并验证旧值已经失效。

## 上线前检查

完成 migration、账本平衡探针、RabbitMQ/Redis 实际就绪、对象存储加密、Webhook 签名、
独立设备 mTLS 通道、证书吊销、Telegram 告警和备份恢复后才能接生产流量。
