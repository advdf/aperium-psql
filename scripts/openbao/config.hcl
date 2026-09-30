// OpenBao config for the persistent dev sidecar shipped with aperium.
// Storage and unseal keys live in a Docker volume — see scripts/openbao/init.sh
// for the init/unseal automation and docs/kms.md for the production migration
// path (raft + transit unseal + AppRole etc.).

// Integrated (raft) storage, single node. The legacy "file" backend was
// removed in OpenBao v2.7.0.
storage "raft" {
  path    = "/openbao/data"
  node_id = "aperium-openbao"
}

listener "tcp" {
  address     = "0.0.0.0:8200"
  tls_disable = true
}

ui              = true
api_addr        = "http://openbao:8200"
cluster_addr    = "http://openbao:8201"
default_lease_ttl = "768h"
max_lease_ttl     = "768h"
