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
| `@cribl/app-utils` | Search client, OAuth, settings, CSS tokens |

## Apps built on this framework

- [Cribl APM](https://github.com/criblio/apm) — APM experience on OTel data
- [Customer Analytics](https://github.com/criblio/customer-analytics) — E-commerce analytics
