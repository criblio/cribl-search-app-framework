# Cribl Search App Framework

Shared libraries and skeleton template for building Cribl Search Apps.

See [CLAUDE.md](CLAUDE.md) for full documentation.

For metric queries, result types and response compatibility, see
[Metrics queries in apps](docs/metrics.md).

## Quick start

```bash
# Clone the skeleton to start a new app
cp -r skeleton/ ~/local/src/my-new-app/
cd ~/local/src/my-new-app/
# Replace APPNAME in package.json
npm install
cp .env.example .env
# Edit .env with your Cribl Cloud credentials
npm run dev
```

## Packages

| Package | Description |
|---------|-------------|
| `@criblio/app-utils` | Search jobs, KQL safety, OAuth, settings, containment, CSS tokens |
| `@criblio/app-tooling` | Deterministic packaging, inspection, deployment, release evidence, security gates |
| `@criblio/agent-protocol` | Wire protocol between a cell (server-side agent harness on celld) and its app UI — loop events, server frames, session statuses. No runtime deps. |
| `@criblio/cell-workspace` | Cell source-code workspace: lazy tarball checkout into DO SQLite + read-only code tools (worker-native) |

## Installing the packages

All packages publish to **npmjs** under the public `@criblio` scope, so
consumers need nothing — no `.npmrc`, no token, no scope routing:

```
npm install @criblio/app-utils
```

They used to publish to GitHub Packages, which required a token even for
public reads. The reason for moving is not convenience: **GoatTown's
`build_app` has no install step at all.** It rewrites every bare import
into an `https://esm.sh/<name>@<range>` URL inside a workerd isolate that
has no filesystem and no npm, and esm.sh mirrors npmjs *only* — so a
package on GitHub Packages simply does not exist to a generated app. That
made the framework's own client unreachable from apps the framework
scaffolds, silently: nothing in the skeleton imports `src/api/cribl.ts`,
so tree-shaking dropped it and the build went green while the agent wrote
its own Cribl client by hand.

Versions already on GitHub Packages stay there permanently (npm does not
unpublish), so existing consumers keep resolving. New versions go to npmjs.

Publishing is automatic: the publish workflow runs on every master push
and publishes any workspace package whose `version` isn't on npmjs yet —
bump a package's version to release it. Releases carry npm
[provenance](https://docs.npmjs.com/generating-provenance-statements),
which this repo can attest because it is public and publishes from CI.

## Apps built on this framework

- [Cribl APM](https://github.com/criblio/apm) — APM experience on OTel data
- [Customer Analytics](https://github.com/criblio/customer-analytics) — E-commerce analytics
