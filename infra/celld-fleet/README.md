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

  secret_env_keys      = ["UI_BEARER", "TICKET_SECRET", "LLM_API_KEY", "GITHUB_TOKEN"]
  required_secret_keys = ["UI_BEARER", "TICKET_SECRET", "LLM_API_KEY"]
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

Boot reads exactly `secret_env_keys`. `plain_env` values land in state —
secrets never go there.

### Required vs optional secrets

A key missing from SSM is **skipped with a warning** unless it also
appears in `required_secret_keys`, which aborts boot. The split matters
because the two failures are not comparable:

- **Required** — the credential gates something with no working degraded
  mode. `UI_BEARER` is the canonical case: `bearerOk()` treats "unset" as
  closed rather than open, so a node without it comes up serving 401 on
  every route. Up-and-unusable is worse than not-up, so fail the boot.
- **Optional** (the default for anything not listed) — the payload
  already reports the feature as unconfigured, e.g. Kidder's `deploy_app`
  returning "Deploy is not configured on this cell" and suggesting
  `commit_push` instead. Aborting the boot to protect one such credential
  trades a degraded feature for no node at all: `set -euo pipefail` means
  nothing past the secrets loop runs, so there is no celld and no Caddy.

Skipped keys are listed one per line in `/etc/celld/missing-secrets` and
warned about in `/var/log/<cell_name>-init.log` — check both when a
feature reports itself unconfigured on a node you thought was fully
provisioned.

`required_secret_keys` must be a subset of `secret_env_keys`; a key that
is required but never fetched can't be checked, so the module rejects it
(at plan time — Terraform doesn't evaluate module-input validation during
`terraform validate`).

Note SSM **rejects an empty `SecureString`**, so "set it blank to disable
the feature" isn't available. Omit the key from `secret_env_keys`, or
just leave the parameter uncreated now that that's non-fatal.

## Adopting the module in an existing stack

A stack that predates the module (APM's `cell/infra` is the first)
migrates its state addresses with `moved` blocks — resources shift
from the root into `module.fleet.*` without being destroyed:

```hcl
moved { from = aws_s3_bucket.fleet, to = module.fleet.aws_s3_bucket.fleet }
moved { from = aws_instance.cell,   to = module.fleet.aws_instance.cell }
# …one per resource, including the `aws_iam_role_policy_attachment`
```

Two plan hazards when adopting:

- **The instance is replaced**, once, because the generalized
  `user_data` differs textually and `user_data_replace_on_change =
  true`. That is the designed path — durable state is in the bucket
  and the EIP is a separate resource, so the URL survives. Do it in
  a quiet window.
- **Cosmetic string drift must not force replacement.** A security
  group's `description` is create-time, and the group's name is
  derived from `cell_name`, so changing the description is a
  same-name destroy/create that fights the attached instance. Set
  `security_group_description` to the stack's existing value instead
  of accepting the churn. Any future cosmetic string in a create-time
  argument should grow the same kind of override rather than forcing
  consumers to rebuild attached resources.

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
