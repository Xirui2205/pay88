variable "digitalocean_token" {
  type      = string
  sensitive = true
}

variable "spaces_access_id" {
  type      = string
  sensitive = true
}

variable "spaces_secret_key" {
  type      = string
  sensitive = true
}

variable "environment" {
  type        = string
  description = "Deployment boundary such as staging or production."
  default     = "staging"

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be staging or production"
  }
}

variable "region" {
  type        = string
  description = "DigitalOcean region. Frankfurt fra1 is the qualified reference region."
  default     = "fra1"

  validation {
    condition     = length(trimspace(var.region)) > 0
    error_message = "region must not be empty"
  }
}

variable "ssh_fingerprint" {
  type        = string
  description = "Fingerprint of the operations SSH key already registered in DigitalOcean."

  validation {
    condition     = length(trimspace(var.ssh_fingerprint)) >= 16
    error_message = "ssh_fingerprint must identify a registered operations key"
  }
}

variable "tls_certificate_name" {
  type        = string
  description = "DigitalOcean-managed certificate attached to the public load balancer."

  validation {
    condition     = length(trimspace(var.tls_certificate_name)) > 0
    error_message = "tls_certificate_name must not be empty"
  }
}

variable "openclaw_tls_certificate_name" {
  type        = string
  description = "Certificate for the OpenClaw companion endpoint. Empty reuses tls_certificate_name; the certificate must cover both DNS names."
  default     = ""
}

variable "admin_source_cidrs" {
  type        = list(string)
  description = "VPN/bastion source ranges allowed to reach SSH."
  default     = []

  validation {
    condition     = alltrue([for cidr in var.admin_source_cidrs : can(cidrhost(cidr, 0))])
    error_message = "every admin_source_cidrs entry must be a valid IPv4 or IPv6 CIDR"
  }
}

variable "app_count" {
  type        = number
  description = "Number of stateless API/device-gateway hosts."
  default     = 2

  validation {
    condition     = var.app_count >= 2 && floor(var.app_count) == var.app_count
    error_message = "app_count must be an integer of at least two"
  }
}

variable "app_size" {
  type    = string
  default = "s-4vcpu-8gb"
}

variable "rabbitmq_size" {
  type    = string
  default = "s-2vcpu-4gb"
}

variable "openclaw_size" {
  type    = string
  default = "s-2vcpu-4gb"
}

variable "postgres_size" {
  type    = string
  default = "db-s-4vcpu-8gb"
}

variable "postgres_nodes" {
  type    = number
  default = 2

  validation {
    condition     = var.postgres_nodes >= 2 && floor(var.postgres_nodes) == var.postgres_nodes
    error_message = "postgres_nodes must be an integer of at least two"
  }
}

variable "valkey_size" {
  type    = string
  default = "db-s-2vcpu-4gb"
}

variable "valkey_nodes" {
  type    = number
  default = 2

  validation {
    condition     = var.valkey_nodes >= 2 && floor(var.valkey_nodes) == var.valkey_nodes
    error_message = "valkey_nodes must be an integer of at least two"
  }
}

variable "evidence_bucket_name" {
  type        = string
  description = "Globally unique private Spaces bucket name for encrypted raw evidence."

  validation {
    condition = (
      length(var.evidence_bucket_name) >= 3 &&
      length(var.evidence_bucket_name) <= 63 &&
      can(regex("^[a-z0-9][a-z0-9.-]*[a-z0-9]$", var.evidence_bucket_name)) &&
      !strcontains(var.evidence_bucket_name, "..") &&
      !strcontains(var.evidence_bucket_name, ".-") &&
      !strcontains(var.evidence_bucket_name, "-.")
    )
    error_message = "evidence_bucket_name must be a globally unique, 3-63 character lowercase Spaces bucket name"
  }
}

variable "evidence_retention_days" {
  type        = number
  description = "Default retention for raw SMS/USSD evidence. Structured financial records live in PostgreSQL."
  default     = 180

  validation {
    condition     = var.evidence_retention_days >= 30 && floor(var.evidence_retention_days) == var.evidence_retention_days
    error_message = "evidence_retention_days must be an integer of at least 30"
  }
}

variable "evidence_noncurrent_retention_days" {
  type        = number
  description = "Retention for superseded object versions."
  default     = 30

  validation {
    condition     = var.evidence_noncurrent_retention_days >= 1 && floor(var.evidence_noncurrent_retention_days) == var.evidence_noncurrent_retention_days
    error_message = "evidence_noncurrent_retention_days must be a positive integer"
  }
}
