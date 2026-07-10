# DigitalOcean Frankfurt reference module

This module provisions the V1 infrastructure baseline:

- one environment-specific VPC;
- at least two API/device-gateway Droplets;
- three RabbitMQ Droplets;
- one isolated OpenClaw Gateway Droplet;
- managed PostgreSQL 16 and Valkey 8 on the private network;
- database firewalls restricted to application Droplets;
- a private, versioned Spaces evidence bucket with lifecycle cleanup;
- separate TLS load balancers for the public API and OpenClaw companion endpoint;
- role-specific tag firewalls and a DigitalOcean project.

The OpenClaw load balancer is separate because Android companion nodes must reach the Gateway while the Gateway host remains isolated from the API pool. Only load-balancer traffic can reach its service port.

## Prerequisites

1. Terraform 1.8 or later (CI qualifies Terraform 1.15.8).
2. A DigitalOcean API token scoped for the resources in this module.
3. Spaces credentials for Terraform provisioning only.
4. An operations SSH public key already registered with DigitalOcean.
5. DigitalOcean-managed certificates covering the API and OpenClaw DNS names.
6. A globally unique lowercase Spaces bucket name.
7. A VPN or bastion CIDR. Production plans fail when `admin_source_cidrs` is empty.

Use a dedicated provisioning identity. Do not reuse Terraform's Spaces secret in the application; create a separate bucket-scoped runtime key after provisioning.

## State

This reusable module intentionally does not declare a backend. Production must use an organization-controlled remote backend with encryption, locking, version history, access logging and break-glass recovery. Do not keep production state on an operator laptop: it contains sensitive managed-database credentials.

Initialize the backend before planning. `terraform init -backend=false` is for CI syntax/schema validation only.

## Plan and apply

```bash
cp terraform.tfvars.example terraform.tfvars
export TF_VAR_digitalocean_token=...
export TF_VAR_spaces_access_id=...
export TF_VAR_spaces_secret_key=...
terraform init
terraform fmt -check -recursive
terraform validate
terraform plan -out=plan.tfplan
terraform show plan.tfplan
terraform apply plan.tfplan
```

Treat the plan as a sensitive artifact. Require peer approval for production apply and never pass secrets on the command line.

Create DNS A records for `load_balancer_ip` and `openclaw_load_balancer_ip`. The certificates named in the variables must cover the corresponding hosts.

## Outputs and secrets

`postgres_gateway_connection` is a sensitive object containing the private host, application database name and default managed credentials. Move it into the deployment secret manager and restrict retrieval to the release identity. Rotate to a least-privilege application user before production; do not expose the managed default user to application operators.

Valkey's private URI is also sensitive. RabbitMQ credentials and Erlang cookies are not created by Terraform and must come from the secret manager.

## Security boundaries

- API port 3000 is reachable only from the API load balancer.
- OpenClaw port 18789 is reachable only from its dedicated load balancer.
- RabbitMQ cluster ports are reachable only from the relevant role tags. Production allows TLS AMQP 5671 only.
- SSH exists only for configured VPN/bastion CIDRs; an empty staging list disables SSH.
- PostgreSQL and Valkey accept only application Droplets.
- RabbitMQ management is not exposed. Use monitored automation or an SSH tunnel from the bastion.
- All Droplets enable DigitalOcean monitoring and bounded local Docker logs.

DigitalOcean's public load balancer terminates ordinary public TLS. It does not, by itself, satisfy end-to-end device mTLS. The Telebirr Device Agent endpoint requires a separately qualified mTLS terminator or TLS-passthrough listener before production. This is a release blocker, not an optional hardening task.

## After provisioning

Terraform bootstraps Docker but does not deploy services. The release/configuration system must:

1. Configure the three-node RabbitMQ cluster, TLS, quorum queues and monitoring.
2. Configure an mTLS-capable device ingress path and certificate revocation.
3. Install digest-pinned API/OpenClaw containers and their runtime secrets.
4. Configure centralized logs, metrics, Telegram alerts and host monitoring.
5. Verify managed PostgreSQL PITR and run a restore drill.
6. Create and test the bucket-scoped evidence key and retention jobs.
7. Run the migration and blue/green sequence in `infra/README.md`.

Do not expose RabbitMQ management, PostgreSQL, Valkey, OpenClaw's Droplet address or Docker sockets publicly.

## Destruction and recovery

The Spaces bucket cannot be destroyed while it contains evidence. This is deliberate. Export and approve evidence disposition before deleting objects or infrastructure. Production database deletion requires a current backup/PITR verification and the financial incident owner's approval.

Reference schemas are maintained in the official [DigitalOcean Terraform provider documentation](https://docs.digitalocean.com/reference/terraform/reference/) and [load balancer documentation](https://docs.digitalocean.com/reference/terraform/reference/resources/loadbalancer/).
