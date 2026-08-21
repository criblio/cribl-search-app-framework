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
  description = "celld release tag to install. v0.2.0+ splits the public listener from an internal peer/operator listener; the public listener here is loopback-only behind Caddy, so no --internal-listen is required. A fleet must never mix v0.1.0 and v0.2.0 nodes (block-format replication objects are not backward-readable) — upgrade by replacing every node, not rolling."
  type        = string
  default     = "v0.2.0"
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

variable "secret_env_keys" {
  description = "SSM SecureString names (under the prefix) pulled onto the node at boot as CELLD_VAR_<key>. Boot fails loudly on a missing parameter, so list exactly what the cell needs."
  type        = list(string)
  default     = ["UI_BEARER", "TICKET_SECRET"]
}

variable "plain_env" {
  description = "Non-secret cell env vars written verbatim as CELLD_VAR_<key>=<value> (e.g. LLM_BASE_URL, LLM_MODEL, TURN_BUDGET). Secrets belong in SSM via secret_env_keys, never here — these values land in Terraform state."
  type        = map(string)
  default     = {}
}
