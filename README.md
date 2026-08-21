# Cribl Search App Framework

Shared libraries and skeleton template for building Cribl Search Apps.

See [CLAUDE.md](CLAUDE.md) for full documentation.

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
| `@criblio/cell-harness` | Generic server-side agent harness for cells: payload seam, coordinator + session DO factories, router/auth/tickets, pi-agent-core turn runner |
| `@criblio/cell-workspace` | Cell source-code workspace: lazy tarball checkout into DO SQLite + read-only code tools (worker-native) |

## Installing the packages

All packages publish to **GitHub Packages** under the `@criblio` scope
(public — any authenticated GitHub token can read them). Consumers need
an `.npmrc` routing the scope plus a token:

```
@criblio:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

with `NODE_AUTH_TOKEN` set to a token that has `read:packages` (in CI:
`${{ github.token }}`; locally a classic PAT, or try
`export NODE_AUTH_TOKEN=$(gh auth token)`).

Publishing is automatic: the publish workflow runs on every master push
and publishes any workspace package whose `version` isn't in the
registry yet — bump a package's version to release it.

## Apps built on this framework

- [Cribl APM](https://github.com/criblio/apm) — APM experience on OTel data
- [Customer Analytics](https://github.com/criblio/customer-analytics) — E-commerce analytics
