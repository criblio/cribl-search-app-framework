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
| `@cribl/app-utils` | Search jobs, KQL safety, OAuth, settings, containment, CSS tokens |
| `@cribl/app-tooling` | Deterministic packaging, inspection, deployment, release evidence, security gates |
| `@criblio/agent-protocol` | Wire protocol between a cell (server-side agent harness on celld) and its app UI — loop events, server frames, session statuses. No runtime deps. (New packages use the `@criblio` scope — the GitHub Packages publishing target.) |

## Apps built on this framework

- [Cribl APM](https://github.com/criblio/apm) — APM experience on OTel data
- [Customer Analytics](https://github.com/criblio/customer-analytics) — E-commerce analytics
