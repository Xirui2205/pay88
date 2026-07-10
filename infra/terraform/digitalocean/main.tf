locals {
  prefix                    = "telebirr-${var.environment}"
  app_tag                   = "${local.prefix}-app"
  rabbitmq_tag              = "${local.prefix}-rabbitmq"
  openclaw_tag              = "${local.prefix}-openclaw"
  data_tag                  = "${local.prefix}-data"
  openclaw_certificate_name = trimspace(var.openclaw_tls_certificate_name) != "" ? var.openclaw_tls_certificate_name : var.tls_certificate_name
}

resource "digitalocean_vpc" "main" {
  name     = "${local.prefix}-vpc"
  region   = var.region
  ip_range = var.environment == "production" ? "10.50.0.0/20" : "10.60.0.0/20"

  lifecycle {
    precondition {
      condition     = var.environment != "production" || length(var.admin_source_cidrs) > 0
      error_message = "production requires at least one VPN/bastion CIDR in admin_source_cidrs"
    }
    precondition {
      condition     = var.evidence_noncurrent_retention_days < var.evidence_retention_days
      error_message = "non-current evidence versions must expire before current evidence"
    }
  }
}

resource "digitalocean_project" "main" {
  name        = local.prefix
  description = "Telebirr P2P ${var.environment}"
  purpose     = "Service or API"
  environment = var.environment == "production" ? "Production" : "Staging"
}

resource "digitalocean_tag" "app" {
  name = local.app_tag
}

resource "digitalocean_tag" "rabbitmq" {
  name = local.rabbitmq_tag
}

resource "digitalocean_tag" "openclaw" {
  name = local.openclaw_tag
}

resource "digitalocean_tag" "data" {
  name = local.data_tag
}

resource "digitalocean_droplet" "app" {
  count             = var.app_count
  name              = "${local.prefix}-app-${count.index + 1}"
  region            = var.region
  size              = var.app_size
  image             = "ubuntu-24-04-x64"
  vpc_uuid          = digitalocean_vpc.main.id
  ssh_keys          = [var.ssh_fingerprint]
  tags              = [digitalocean_tag.app.id]
  monitoring        = true
  graceful_shutdown = true
  user_data = templatefile("${path.module}/cloud-init.yaml.tftpl", {
    role = "app"
  })
}

resource "digitalocean_droplet" "rabbitmq" {
  count             = 3
  name              = "${local.prefix}-rabbitmq-${count.index + 1}"
  region            = var.region
  size              = var.rabbitmq_size
  image             = "ubuntu-24-04-x64"
  vpc_uuid          = digitalocean_vpc.main.id
  ssh_keys          = [var.ssh_fingerprint]
  tags              = [digitalocean_tag.rabbitmq.id]
  monitoring        = true
  graceful_shutdown = true
  user_data = templatefile("${path.module}/cloud-init.yaml.tftpl", {
    role = "rabbitmq"
  })
}

resource "digitalocean_droplet" "openclaw" {
  name              = "${local.prefix}-openclaw"
  region            = var.region
  size              = var.openclaw_size
  image             = "ubuntu-24-04-x64"
  vpc_uuid          = digitalocean_vpc.main.id
  ssh_keys          = [var.ssh_fingerprint]
  tags              = [digitalocean_tag.openclaw.id]
  monitoring        = true
  graceful_shutdown = true
  user_data = templatefile("${path.module}/cloud-init.yaml.tftpl", {
    role = "openclaw"
  })
}

resource "digitalocean_database_cluster" "postgres" {
  name                 = "${local.prefix}-postgres"
  engine               = "pg"
  version              = "16"
  size                 = var.postgres_size
  region               = var.region
  node_count           = var.postgres_nodes
  private_network_uuid = digitalocean_vpc.main.id
  project_id           = digitalocean_project.main.id
  tags                 = [digitalocean_tag.data.id]
}

resource "digitalocean_database_db" "gateway" {
  cluster_id = digitalocean_database_cluster.postgres.id
  name       = "telebirr"
}

resource "digitalocean_database_cluster" "valkey" {
  name                 = "${local.prefix}-valkey"
  engine               = "valkey"
  version              = "8"
  size                 = var.valkey_size
  region               = var.region
  node_count           = var.valkey_nodes
  private_network_uuid = digitalocean_vpc.main.id
  project_id           = digitalocean_project.main.id
  eviction_policy      = "noeviction"
  tags                 = [digitalocean_tag.data.id]
}

resource "digitalocean_database_firewall" "postgres" {
  cluster_id = digitalocean_database_cluster.postgres.id

  rule {
    type  = "tag"
    value = digitalocean_tag.app.id
  }
}

resource "digitalocean_database_firewall" "valkey" {
  cluster_id = digitalocean_database_cluster.valkey.id

  rule {
    type  = "tag"
    value = digitalocean_tag.app.id
  }
}

resource "digitalocean_spaces_bucket" "evidence" {
  name   = var.evidence_bucket_name
  region = var.region
  acl    = "private"

  versioning {
    enabled = true
  }

  lifecycle_rule {
    id                                     = "expire-raw-evidence"
    enabled                                = true
    abort_incomplete_multipart_upload_days = 7

    expiration {
      days = var.evidence_retention_days
    }

    noncurrent_version_expiration {
      days = var.evidence_noncurrent_retention_days
    }
  }
}

resource "digitalocean_loadbalancer" "public" {
  name                     = "${local.prefix}-public"
  region                   = var.region
  vpc_uuid                 = digitalocean_vpc.main.id
  redirect_http_to_https   = true
  enable_backend_keepalive = true
  tls_cipher_policy        = "STRONG"

  forwarding_rule {
    entry_protocol  = "http"
    entry_port      = 80
    target_protocol = "http"
    target_port     = 3000
  }

  # Device traffic uses TLS passthrough to the HAProxy mTLS listener. The
  # ordinary HTTPS listener must never synthesize device-certificate headers.
  forwarding_rule {
    entry_protocol  = "tcp"
    entry_port      = 8443
    target_protocol = "tcp"
    target_port     = 3443
  }

  forwarding_rule {
    entry_protocol   = "https"
    entry_port       = 443
    target_protocol  = "http"
    target_port      = 3000
    certificate_name = var.tls_certificate_name
    tls_passthrough  = false
  }

  healthcheck {
    protocol                 = "http"
    port                     = 3000
    path                     = "/health/ready"
    check_interval_seconds   = 10
    response_timeout_seconds = 5
    healthy_threshold        = 3
    unhealthy_threshold      = 3
  }

  droplet_ids = digitalocean_droplet.app[*].id
}

# The Android OpenClaw companion must reach its private Gateway from outside
# the VPC. A dedicated load balancer preserves host isolation and avoids
# exposing the Gateway droplet's public interface directly.
resource "digitalocean_loadbalancer" "openclaw" {
  name                     = "${local.prefix}-openclaw"
  region                   = var.region
  vpc_uuid                 = digitalocean_vpc.main.id
  enable_backend_keepalive = true
  tls_cipher_policy        = "STRONG"

  forwarding_rule {
    entry_protocol   = "https"
    entry_port       = 443
    target_protocol  = "http"
    target_port      = 18789
    certificate_name = local.openclaw_certificate_name
    tls_passthrough  = false
  }

  healthcheck {
    protocol                 = "tcp"
    port                     = 18789
    check_interval_seconds   = 10
    response_timeout_seconds = 5
    healthy_threshold        = 3
    unhealthy_threshold      = 3
  }

  droplet_ids = [digitalocean_droplet.openclaw.id]
}

resource "digitalocean_firewall" "app" {
  name = "${local.prefix}-app"
  tags = [digitalocean_tag.app.id]

  dynamic "inbound_rule" {
    for_each = length(var.admin_source_cidrs) == 0 ? [] : [true]
    content {
      protocol         = "tcp"
      port_range       = "22"
      source_addresses = var.admin_source_cidrs
    }
  }

  inbound_rule {
    protocol                  = "tcp"
    port_range                = "3000"
    source_load_balancer_uids = [digitalocean_loadbalancer.public.id]
  }


  inbound_rule {
    protocol                  = "tcp"
    port_range                = "3443"
    source_load_balancer_uids = [digitalocean_loadbalancer.public.id]
  }

  outbound_rule {
    protocol              = "tcp"
    port_range            = "1-65535"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }

  outbound_rule {
    protocol              = "udp"
    port_range            = "53"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }

  outbound_rule {
    protocol              = "udp"
    port_range            = "123"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }

  outbound_rule {
    protocol              = "icmp"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
}

resource "digitalocean_firewall" "rabbitmq" {
  name = "${local.prefix}-rabbitmq"
  tags = [digitalocean_tag.rabbitmq.id]

  dynamic "inbound_rule" {
    for_each = length(var.admin_source_cidrs) == 0 ? [] : [true]
    content {
      protocol         = "tcp"
      port_range       = "22"
      source_addresses = var.admin_source_cidrs
    }
  }

  inbound_rule {
    protocol    = "tcp"
    port_range  = var.environment == "production" ? "5671" : "5671-5672"
    source_tags = [digitalocean_tag.app.id, digitalocean_tag.rabbitmq.id]
  }

  inbound_rule {
    protocol    = "tcp"
    port_range  = "4369"
    source_tags = [digitalocean_tag.rabbitmq.id]
  }

  inbound_rule {
    protocol    = "tcp"
    port_range  = "25672"
    source_tags = [digitalocean_tag.rabbitmq.id]
  }

  outbound_rule {
    protocol              = "tcp"
    port_range            = "1-65535"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }

  outbound_rule {
    protocol              = "udp"
    port_range            = "53"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }

  outbound_rule {
    protocol              = "udp"
    port_range            = "123"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }

  outbound_rule {
    protocol              = "icmp"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
}

resource "digitalocean_firewall" "openclaw" {
  name = "${local.prefix}-openclaw"
  tags = [digitalocean_tag.openclaw.id]

  dynamic "inbound_rule" {
    for_each = length(var.admin_source_cidrs) == 0 ? [] : [true]
    content {
      protocol         = "tcp"
      port_range       = "22"
      source_addresses = var.admin_source_cidrs
    }
  }

  inbound_rule {
    protocol                  = "tcp"
    port_range                = "18789"
    source_load_balancer_uids = [digitalocean_loadbalancer.openclaw.id]
  }

  outbound_rule {
    protocol              = "tcp"
    port_range            = "1-65535"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }

  outbound_rule {
    protocol              = "udp"
    port_range            = "53"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }

  outbound_rule {
    protocol              = "udp"
    port_range            = "123"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }

  outbound_rule {
    protocol              = "icmp"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
}

resource "digitalocean_project_resources" "main" {
  project = digitalocean_project.main.id
  resources = concat(
    [
      digitalocean_loadbalancer.public.urn,
      digitalocean_loadbalancer.openclaw.urn,
      digitalocean_spaces_bucket.evidence.urn,
    ],
    digitalocean_droplet.app[*].urn,
    digitalocean_droplet.rabbitmq[*].urn,
    [digitalocean_droplet.openclaw.urn],
  )
}
