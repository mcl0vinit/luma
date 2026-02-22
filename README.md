# Luma CLI (Bun + TypeScript)

CLI for authenticated Luma exploration and event data retrieval, designed for both humans and automation/LLM agents.

## What it does

- Imports auth from Chrome cookies (Option B).
- Verifies current logged-in user (`whoami`).
- Searches across events + discover entities + calendars + help (`search`).
- Discovers events by city/category slug (`discover`).
- Resolves event URL/slug to `event_api_id` and fetches full event payload (`event`).
- Provides a verbose agent-focused usage spec (`llm`).

## Install as CLI

From GitHub:

```bash
bun add -g github:mcl0vinit/luma
```

From a local checkout:

```bash
bun add -g "file:$PWD"
```

## Auth from Chrome (Option B)

```bash
luma auth list-profiles
luma auth import-chrome --profile "Default"
```

If keychain lookup fails, set a local env var before importing:

```bash
export LUMA_CHROME_SAFE_STORAGE_KEY="..."
```

Do not commit or share auth material.

## Verify account/auth

```bash
luma whoami
luma whoami --json
```

## LLM/automation guide

```bash
luma llm
luma llm --json
```

This prints an ergonomic, verbose contract for agents:
- auth lifecycle
- command semantics
- JSON-first workflow
- reliability notes (e.g., use `event_api_id` as stable key)

## Common commands

```bash
luma search "ai miami" --limit 20
luma search "ai miami" --limit 20 --json
luma discover --slug ai --limit 20
luma discover --slug miami --limit 30 --json
luma event https://luma.com/dtpe78ne
luma event evt-<event_api_id> --json
```
