# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Compile TypeScript once
npm run compile

# Watch mode (recompile on save)
npm run watch

# Package as .vsix for installation/publishing
npm run package
```

There are no tests in this project. To manually test, install the compiled extension in VS Code via the `.vsix` file or by running the Extension Development Host (`F5` in VS Code with this folder open).

## Architecture

This is a single-file VS Code extension (`src/extension.ts`) that displays Claude Code rate-limit usage in the status bar — with **zero additional API calls**.

**Two data sources run in parallel:**

1. **HTTP intercept via `diagnostics_channel`** — subscribes to `http.client.request.start`. When a matching request to `anthropic.com/api/oauth/usage` is detected, `req.once("response", tapBody)` is attached directly on the request object so the body is captured before `response.finish`. A single channel subscription is used (no `http.client.response.finish` channel, no `pendingRequests` WeakSet).

2. **File watcher fallback** — watches `~/.claude/usage-bar-data.json` via `fs.watch()` for updates from terminal Claude sessions (where the HTTP intercept wouldn't capture traffic).

**Data flow:**
- `parseUsageResponse()` / `readDataFile()` → update `cached: UsageData` → `updateBar()` renders status bar text
- `cached` is persisted to VS Code's `globalState` so the last known values survive restarts
- A 30-second `setInterval` calls `resetExpired()` to clear limits whose `resetsAt` timestamp has passed

**Status bar color logic:**
- ≥90% utilization → error (red) background
- ≥70% utilization → warning (yellow) background
- Otherwise → default background

**Key invariants:**
- The extension must never throw or cause errors that interrupt other extensions — all handlers are wrapped in try/catch that silently swallow errors
- `MAX_BODY = 1MB` caps how much response body is buffered to prevent memory issues
- The `diagnostics_channel` subscription stores its handler in `dcRequestHandler` so it can be properly unsubscribed on deactivation; no second channel (`response.finish`) is needed
- Host detection tries `getHeader("host")`, `.host`, and `._host` fallbacks to cope with different Node.js/VS Code versions
- `normalizeUtil()` handles the API returning utilization as either 0–1 or 0–100

**Build output:** TypeScript compiles to `out/extension.js` (CommonJS, ES2020 target).
