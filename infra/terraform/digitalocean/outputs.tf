output "load_balancer_ip" {
  value = digitalocean_loadbalancer.public.ip
}

output "openclaw_load_balancer_ip" {
  value = digitalocean_loadbalancer.openclaw.ip
}

output "postgres_gateway_connection" {
  description = "Private connection components for the application database. Store them in the deployment secret manager."
  value = {
    host     = digitalocean_database_cluster.postgres.private_host
    port     = digitalocean_database_cluster.postgres.port
    database = digitalocean_database_db.gateway.name
    user     = digitalocean_database_cluster.postgres.user
    password = digitalocean_database_cluster.postgres.password
    sslmode  = "require"
  }
  sensitive = true
}

output "valkey_private_uri" {
  value     = digitalocean_database_cluster.valkey.private_uri
  sensitive = true
}

output "rabbitmq_private_ips" {
  value = digitalocean_droplet.rabbitmq[*].ipv4_address_private
}

output "openclaw_private_ip" {
  value = digitalocean_droplet.openclaw.ipv4_address_private
}

output "evidence_bucket" {
  value = digitalocean_spaces_bucket.evidence.name
}

output "evidence_bucket_endpoint" {
  value = digitalocean_spaces_bucket.evidence.endpoint
}

output "vpc_id" {
  value = digitalocean_vpc.main.id
}
