variable "cell_name" {
  description = "Name of this cell (fleet). Drives resource names (\"<name>-node\"), the default SSM prefix (\"/<name>\"), and tags. E.g. \"apm-cell\", \"kidder-cell\"."
  type        = string
}

variable "bucket_name" {
  description = "Globally-unique S3 bucket for the celld fleet (deployments + replicated cell state). One bucket = one fleet = ONE application — a second app needs its own fleet."
  type        = string
}

variable "region" {
  description = "AWS region for the cell."
  type        = string
  default     = "us-west-2"
}

variable "instance_type" {
  description = "EC2 instance type (arm64 — celld ships an aarch64 binary)."
  type        = string
  default     = "t4g.small"
}

variable "celld_version" {
  description = "celld release tag to install. v0.2.0+ splits the public listener from an internal peer/operator listener; the public listener here is loopback-only behind Caddy, so no --internal-listen is required. A fleet must never mix v0.1.0 and v0.2.0 nodes (block-format replication objects are not backward-readable) — upgrade by replacing every node, not rolling. v0.2.1→v0.3.0 CAN roll one node at a time, but do not start a v0.2.x binary on a node that has run v0.3.0 unless its shutdown log shows `node-log close: sealed epoch` — a v0.2.x binary cannot read the replicated log and the downgrade can lose acknowledged writes. See celld_durability for the v0.3.0 durability default."
  type        = string
  default     = "v0.3.0"
}

variable "celld_durability" {
  description = <<-EOT
    Write-acknowledgement posture. v0.3.0 changed the default from `bucket`
    to `fleet`: `fleet` acks a write once a follower has fsynced it and
    tiers to the object store behind (10x lower write latency, >100x fewer
    Class A S3 ops); `bucket` waits for the store on every write.

    `fleet` is SAFE for a single node and is the right default here. Per
    celld's own note, a lone node "behaves exactly like sync-to-bucket — no
    peers means no record, no shipper, and bucket-proven acks", and it
    upgrades itself the moment a peer appears. So a single-node fleet keeps
    v0.2.1's durability guarantee under the new default; there is nothing to
    special-case.

    Set `bucket` only to pin bucket-proven acks permanently — e.g. a
    multi-node fleet that must not acknowledge a write before it is in S3,
    accepting the latency and per-transaction PUT cost for it.
  EOT
  type        = string
  default     = "fleet"

  validation {
    condition     = contains(["fleet", "bucket"], var.celld_durability)
    error_message = "celld_durability must be \"fleet\" or \"bucket\"."
  }
}

variable "celld_handler_budget_s" {
  description = "Per-request JavaScript handler budget in seconds (celld default 300). Exceeding it terminates the whole celld PROCESS, not just the isolate, so every session on the node dies with it — keep in-cell work (dependency fetching, bundling) well inside this. Raise it only if a cell has a legitimately long handler and you accept a slower failure detection."
  type        = number
  default     = 300
}

variable "caddy_version" {
  description = "Caddy release version (no leading v). Installed from the official GitHub static binary — AL2023 has no caddy package."
  type        = string
  default     = "2.10.2"
}

variable "ssm_parameter_prefix" {
  description = "SSM SecureString prefix the instance reads its secrets from at boot. Empty ⇒ \"/<cell_name>\". Parameters are created OUT of Terraform (never in state)."
  type        = string
  default     = ""
}

variable "security_group_description" {
  description = "Description of the node security group. Overridable ONLY because a security group's description is create-time: changing it forces replacement, and since the group's name is derived from cell_name, the replacement is a same-name destroy/create that fights the attached instance. A pre-module stack adopting this module sets its existing description here to keep the plan clean. New stacks should leave the default."
  type        = string
  default     = "celld cell node: HTTPS in (webhooks + platform proxy), no SSH (use SSM Session Manager)."
}

variable "secret_env_keys" {
  description = "SSM SecureString names (under the prefix) pulled onto the node at boot as CELLD_VAR_<key>. A key missing from SSM is skipped with a warning (and recorded in /etc/celld/missing-secrets) unless it is also in required_secret_keys — cells degrade per feature, so one absent optional credential must not cost you the node."
  type        = list(string)
  default     = ["UI_BEARER", "TICKET_SECRET"]
}

variable "required_secret_keys" {
  description = "Subset of secret_env_keys whose absence aborts boot. Use it for credentials with no working degraded mode — UI_BEARER gates every authenticated route (bearerOk() treats \"unset\" as closed), so a node without it is up and unusable, which is worse than not being up. Leave a credential OUT of this list when the payload already reports the feature as unconfigured."
  type        = list(string)
  default     = ["UI_BEARER"]

  validation {
    # A key required but never fetched can never be checked — almost
    # always a typo, and it would read as "required" while doing nothing.
    condition     = length(setsubtract(var.required_secret_keys, var.secret_env_keys)) == 0
    error_message = "required_secret_keys must be a subset of secret_env_keys; these are not fetched at all: ${join(", ", setsubtract(var.required_secret_keys, var.secret_env_keys))}."
  }
}

variable "plain_env" {
  description = "Non-secret cell env vars written verbatim as CELLD_VAR_<key>=<value> (e.g. LLM_BASE_URL, LLM_MODEL, TURN_BUDGET). Secrets belong in SSM via secret_env_keys, never here — these values land in Terraform state."
  type        = map(string)
  default     = {}
}
