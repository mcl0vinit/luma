# Luma CLI

CLI for authenticated Luma event discovery and event detail retrieval.

## Features

- Imports auth from local Chrome cookies.
- Shows active account (`whoami`).
- Searches across events, discover entities, calendars, and help content.
- Discovers events by city/category slug.
- Lists your upcoming events feed (`mine`).
- Resolves event URL/slug to `event_api_id` and fetches full event details.
- Registers for events (`register`) and cancels registrations (`cancel`).
- Provides an automation-oriented command guide (`luma llm`).

## Install

Global install from GitHub:

```bash
bun add -g github:mcl0vinit/luma
```

Global install from a local checkout:

```bash
bun add -g "file:$PWD"
```

## Authenticate from Chrome

```bash
luma auth list-profiles
luma auth import-chrome --profile "Default"
```

If keychain lookup fails:

```bash
export LUMA_CHROME_SAFE_STORAGE_KEY="..."
luma auth import-chrome --profile "Default"
```

## Verify account

```bash
luma whoami
luma whoami --json
```

## Automation guide

```bash
luma llm
luma llm --json
```

This prints a verbose command contract and JSON-first workflow notes.

## Common commands

```bash
luma search "ai miami" --limit 20
luma search "ai miami" --limit 20 --json
luma search "ai miami" --type event,discover --format table
luma search "ai miami" --format ndjson
luma search "ai miami" --columns type,name,url
luma discover --slug ai --limit 20
luma discover --slug miami --limit 30 --json
luma discover --slug miami --format table --columns name,start_at,url
luma mine --limit 20
luma mine --json
luma register https://luma.com/dtpe78ne --dry-run
luma cancel https://luma.com/dtpe78ne --dry-run
luma event https://luma.com/dtpe78ne
luma event evt-<event_api_id> --json
```
