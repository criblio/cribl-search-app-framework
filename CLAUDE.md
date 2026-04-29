# Cribl Search App Framework

Shared libraries, skeleton template, and developer documentation for
building Cribl Search Apps (Vite + React + TypeScript apps that run
inside the Cribl Search sandboxed iframe).

## Repository structure

- `packages/app-utils/` — shared TypeScript utilities (search client,
  OAuth, settings, CSS tokens)
- `skeleton/` — clone-ready app template with sidebar, settings page,
  deploy scripts, and Vite config
- `docs/skill.md` — Cribl App Platform developer skill (platform
  rules, KQL caveats, sandbox constraints, patterns)

## Creating a new app

1. Copy the `skeleton/` directory to a new repo
2. Find-replace `APPNAME` with your app name in package.json
3. Run `npm install`
4. Copy `.env.example` to `.env` and fill in your Cribl Cloud credentials
5. Add your routes, pages, and sidebar items
6. `npm run dev` for local development
7. `npm run deploy` to build, package, upload, and install on staging

## Developing

Read `docs/skill.md` for:
- Cribl App Platform rules (fetch proxy, globals, KV store)
- KQL query language caveats and workarounds
- Sandboxed iframe constraints
- Scheduled search patterns
- UI patterns (non-destructive refresh, graph stability)

## Packages

### @cribl/app-utils

- `runQuery(kql, earliest, latest, limit)` — generic Cribl Search
  job client (create → poll → fetch NDJSON results)
- `getBearerToken(config)` — OAuth client credentials exchange
- `loadSettings() / saveSettings()` — KV store settings
- `loadDotEnv(path)` — .env file parser for Node scripts
- `styles/tokens.css` — Cribl Design System CSS custom properties
- `styles/base.css` — CSS reset + base element styles
