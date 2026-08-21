# celld-fleet — Terraform module for a cell's fleet

One celld node + one S3 fleet bucket, parameterized per cell.
Extracted from the APM investigator's infra (criblio/apm
`cell/infra`, PRs #129/#130/#132) so every cell-harness app deploys
the same pattern under its own names, with its own state.

**Why per-app fleets:** celld's model is *one bucket = one fleet =
one application* — `deploy/current.json` is a single pointer to a
single worker bundle, so two apps can never share a fleet. What apps
share is this module.

## Consuming it

Each app repo keeps a thin root (see `criblio/kidder` `cell/infra`
for the reference consumer):

```hcl
module "fleet" {
  # Sibling checkout during development; pin a git ref for CI:
  # source = "git::git@github.com:criblio/cribl-search-app-framework.git//infra/celld-fleet?ref=<tag>"
  source = "../../../cribl-search-app-framework/infra/celld-fleet"

  cell_name   = "my-cell"                  # names + default SSM prefix /my-cell
  bucket_name = "my-globally-unique-bucket"

  secret_env_keys = ["UI_BEARER", "TICKET_SECRET", "LLM_API_KEY"]
  plain_env = {
    LLM_BASE_URL = "https://openrouter.ai/api/v1"
    LLM_MODEL    = "some/model"
  }
}
```

The root supplies the `aws` provider and an S3 `backend` — by
convention the fleet bucket itself (chicken-and-egg on a from-scratch
apply: apply once with the backend commented out, then
`terraform init -migrate-state`).

Secrets are **SSM SecureStrings** under the prefix, created
out-of-band (never in Terraform state):

```bash
aws ssm put-parameter --name /my-cell/UI_BEARER --type SecureString --value "…"
```

Boot reads exactly `secret_env_keys` and fails loudly on a missing
parameter. `plain_env` values land in state — secrets never go there.

## Shipping cell code

`terraform apply` provisions the node but does **not** ship code;
celld crash-loops on an empty bucket (`read s3://…/deploy/current.json:
no such key`, Caddy answers 502) until the first deploy:

```bash
celld deploy <cell-dir> --bucket s3://<bucket_name>
```

(`celld deploy` bundles with an `esbuild` binary from PATH or
`CELLD_ESBUILD`.)

## Operational notes (inherited from the APM node)

- Graceful shutdown matters: replication drains on SIGTERM; the unit
  sets `TimeoutStopSec=90`. Never SIGKILL a node you care about.
- Never mix celld versions in one fleet — replace all nodes together.
- No SSH: `aws ssm start-session --target <instance_id>`.
- The URL is `https://<eip-with-dashes>.sslip.io` (Caddy + ACME).
