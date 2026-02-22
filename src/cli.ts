import { importFromChrome, listChromeProfiles } from "./chrome-auth";
import { discoverEvents, getEvent, resolveEventApiId, searchEvents, whoAmI } from "./luma-client";
import { getSessionFilePath, loadSession, saveSession, sessionFromCookieHeader } from "./store";

function printJson(value: unknown) {
  console.log(JSON.stringify(value, null, 2));
}

function requireSession() {
  const session = loadSession();
  if (!session) {
    throw new Error(
      `No saved auth session. Run: luma auth import-chrome --profile "Default"\nSession path: ${getSessionFilePath()}`,
    );
  }
  return session;
}

function hasFlag(args: string[], flag: string) {
  return args.includes(flag);
}

function readFlagValue(args: string[], ...names: string[]) {
  for (const name of names) {
    const idx = args.indexOf(name);
    if (idx >= 0) return args[idx + 1];
  }
  return undefined;
}

function eventRow(item: {
  event?: { name?: string; api_id?: string; url?: string; start_at?: string };
  calendar?: { name?: string };
  featured_city?: { name?: string };
  role?: { approval_status?: string };
}) {
  return {
    name: item.event?.name ?? "",
    event_api_id: item.event?.api_id ?? "",
    url: item.event?.url ? `https://luma.com/${item.event.url}` : "",
    start_at: item.event?.start_at ?? "",
    calendar: item.calendar?.name ?? "",
    city: item.featured_city?.name ?? "",
    approval_status: item.role?.approval_status ?? "",
  };
}

function usage() {
  console.log(`luma commands:
  auth list-profiles
  auth import-chrome [--profile "Default"]
  auth import-cookie-header "<cookie header>"
  llm [--json]
  whoami [--json]
  search "<query>" [--limit 20] [--json]
  discover --slug <slug> [--limit 20] [--lat N --lng N] [--json]
  event <url|slug|event_api_id> [--json]`);
}

function llmGuideText() {
  return `Luma CLI LLM Guide

Purpose
- This CLI is optimized for automation agents and scripts that need reliable, structured access to Luma discovery and event metadata.
- Prefer --json in programmatic contexts.

Auth Model
- Session is cookie-based.
- Session file: ${getSessionFilePath()}
- Auth flows:
  1) luma auth list-profiles
  2) luma auth import-chrome --profile "Default"
  3) luma whoami --json
- Fallback if keychain import is unavailable:
  - luma auth import-cookie-header "luma.auth-session-key=...; luma.did=..."

Command Contract
- luma whoami --json
  - Returns authenticated user identity from luma.com/home __NEXT_DATA__.
- luma search "<query>" --limit N --json
  - Auth required. Uses /search/get-results and returns event rows.
- luma discover --slug <slug> --limit N [--lat X --lng Y] --json
  - Uses /discover/get-paginated-events. Works with category or place slugs (ai, miami, sf, etc).
- luma event <url|slug|event_api_id> --json
  - Resolves slug/url to event_api_id via page __NEXT_DATA__, then fetches /event/get.

Ergonomic Agent Workflow
1) Ensure auth
   - run: luma whoami --json
   - if not authenticated, run auth import command, then retry.
2) Candidate generation
   - run one or more discover/search commands with --json.
3) Deduplicate by event_api_id
4) Enrichment
   - run luma event <id> --json for top candidates.
5) Scoring/ranking
   - score on title/location/time/calendar/approval fields.
6) Output
   - persist your selected events in your own system/repo.

Examples
- luma whoami --json
- luma discover --slug ai --limit 30 --json
- luma search "ai miami founder" --limit 30 --json
- luma event https://luma.com/dtpe78ne --json

Reliability Notes
- Use event_api_id as your stable key.
- Slugs may change; IDs are safer for downstream references.
- If discover/search fails due to auth/session expiry, re-import auth and retry.
`;
}

function llmGuideJson() {
  return {
    title: "Luma CLI LLM Guide",
    purpose: [
      "This CLI is optimized for automation agents and scripts that need reliable, structured access to Luma discovery and event metadata.",
      "Prefer --json in programmatic contexts.",
    ],
    auth_model: {
      type: "cookie_session",
      session_file: getSessionFilePath(),
      primary_flow: [
        "luma auth list-profiles",
        'luma auth import-chrome --profile "Default"',
        "luma whoami --json",
      ],
      fallback_flow: ['luma auth import-cookie-header "luma.auth-session-key=...; luma.did=..."'],
    },
    command_contract: {
      "luma whoami --json": "Returns authenticated user identity from luma.com/home __NEXT_DATA__.",
      'luma search "<query>" --limit N --json':
        "Auth required. Uses /search/get-results and returns event rows.",
      "luma discover --slug <slug> --limit N [--lat X --lng Y] --json":
        "Uses /discover/get-paginated-events for category/place slugs (ai, miami, sf, etc).",
      "luma event <url|slug|event_api_id> --json":
        "Resolves slug/url to event_api_id via page __NEXT_DATA__, then fetches /event/get.",
    },
    ergonomic_agent_workflow: [
      "Ensure auth via luma whoami --json; import auth and retry if needed.",
      "Generate candidates via discover/search with --json.",
      "Deduplicate by event_api_id.",
      "Enrich top candidates via luma event <id> --json.",
      "Score/rank using title/location/time/calendar/approval fields.",
      "Persist selected events in downstream system/repo.",
    ],
    examples: [
      "luma whoami --json",
      "luma discover --slug ai --limit 30 --json",
      'luma search "ai miami founder" --limit 30 --json',
      "luma event https://luma.com/dtpe78ne --json",
    ],
    reliability_notes: [
      "Use event_api_id as stable key.",
      "Slugs may change; IDs are safer for downstream references.",
      "If discover/search fails due to auth/session expiry, re-import auth and retry.",
    ],
  };
}

export async function runCli(argv: string[]) {
  const args = argv.slice(2);
  if (args.length === 0 || hasFlag(args, "--help") || hasFlag(args, "-h")) {
    usage();
    return;
  }

  const [cmd, subcmd] = args;

  if (cmd === "auth" && subcmd === "list-profiles") {
    printJson(listChromeProfiles());
    return;
  }

  if (cmd === "llm") {
    if (hasFlag(args, "--json")) {
      printJson(llmGuideJson());
      return;
    }
    console.log(llmGuideText());
    return;
  }

  if (cmd === "auth" && subcmd === "import-chrome") {
    const profile = readFlagValue(args, "--profile", "-p");
    const session = importFromChrome(profile);
    saveSession(session);
    printJson({
      ok: true,
      session_file: getSessionFilePath(),
      source: session.source,
      cookie_count: session.cookies.length,
    });
    return;
  }

  if (cmd === "auth" && subcmd === "import-cookie-header") {
    const cookieHeader = args[2];
    if (!cookieHeader) throw new Error('Missing cookie header. Example: luma auth import-cookie-header "a=1; b=2"');
    const session = sessionFromCookieHeader(cookieHeader, "manual-cookie-header");
    saveSession(session);
    printJson({
      ok: true,
      session_file: getSessionFilePath(),
      source: session.source,
      cookie_count: session.cookies.length,
    });
    return;
  }

  if (cmd === "whoami") {
    const session = requireSession();
    const me = await whoAmI(session);
    const payload = { auth_status: "authenticated", source: session.source, user: me };
    if (hasFlag(args, "--json")) {
      printJson(payload);
      return;
    }
    console.log(`${me.name} <${me.email}>`);
    console.log(`api_id: ${me.apiId}`);
    console.log(`profile: ${session.source.profile}`);
    return;
  }

  if (cmd === "search") {
    const query = args[1];
    if (!query) throw new Error('Missing query. Example: luma search "ai miami"');
    const limit = Number(readFlagValue(args, "--limit", "-l") ?? "20");
    const session = requireSession();
    const events = (await searchEvents(query, session)).slice(0, limit).map(eventRow);
    if (hasFlag(args, "--json")) {
      printJson(events);
      return;
    }
    console.table(events);
    return;
  }

  if (cmd === "discover") {
    const slug = readFlagValue(args, "--slug");
    if (!slug) throw new Error("Missing --slug (e.g. --slug ai)");
    const session = loadSession() ?? undefined;
    const response = await discoverEvents({
      slug,
      paginationLimit: Number(readFlagValue(args, "--limit", "-l") ?? "20"),
      latitude: readFlagValue(args, "--lat") ? Number(readFlagValue(args, "--lat")) : undefined,
      longitude: readFlagValue(args, "--lng") ? Number(readFlagValue(args, "--lng")) : undefined,
      session,
    });
    const entries = response.entries.map(eventRow);
    if (hasFlag(args, "--json")) {
      printJson({ slug, has_more: !!response.has_more, entries });
      return;
    }
    console.table(entries);
    return;
  }

  if (cmd === "event") {
    const input = args[1];
    if (!input) throw new Error("Missing event input (url, slug, or evt-...)");
    const session = loadSession() ?? undefined;
    const eventApiId = await resolveEventApiId(input, session);
    const event = await getEvent(eventApiId, session);
    if (hasFlag(args, "--json")) {
      printJson(event);
      return;
    }
    printJson({
      event_api_id: eventApiId,
      name: event.event?.name ?? "",
      url: event.event?.url ? `https://luma.com/${event.event.url}` : "",
      start_at: event.event?.start_at ?? "",
      timezone: event.event?.timezone ?? "",
      location: event.event?.geo_address_info?.full_address ?? "",
      waitlist_active: event.waitlist_active ?? false,
    });
    return;
  }

  usage();
}
