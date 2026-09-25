# APPNAME

One-paragraph description of what this app does. This file is the
**customer-facing Marketplace overview** — `apps package` copies it into
the archive root, and the Marketplace renders it as the app's description.

Write it in Markdown; raw HTML is ignored.

## What it does

- Something useful
- Something else useful

## Setup

Anything an administrator has to do before the app works: a dataset to
point at, a credential to connect, a configuration revision to activate.

## Development

```bash
npm install
npm run dev        # local dev server
npm run package    # build + archive for upload
npm run deploy     # build, verify, upload, install on Cribl Cloud
```

See `CLAUDE.md` for conventions and `AGENTS.md` for the Cribl App Platform
reference.
