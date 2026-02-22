import { readFileSync } from "node:fs";
import { importFromChrome, listChromeProfiles } from "./chrome-auth";
import {
  cancelRegistration,
  discoverEvents,
  getEvent,
  getMyEvents,
  registerForEvent,
  resolveEventApiId,
  searchEvents,
  whoAmI,
} from "./luma-client";
import { getSessionFilePath, loadSession, saveSession, sessionFromCookieHeader } from "./store";

type OutputFormat = "table" | "json" | "ndjson";
type SearchRowType = "event" | "discover" | "calendar" | "help";
type GenericRow = Record<string, string | number | boolean | null | undefined>;

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

function readFlagList(args: string[], ...names: string[]) {
  const value = readFlagValue(args, ...names);
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function readFormat(args: string[]): OutputFormat {
  if (hasFlag(args, "--json")) return "json";
  const format = readFlagValue(args, "--format");
  if (format === "json" || format === "ndjson" || format === "table") return format;
  return "table";
}

function truncate(value: string, max: number) {
  if (max < 4) return value.slice(0, max);
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function renderRows(rows: GenericRow[], opts?: { columns?: string[] }) {
  if (rows.length === 0) {
    console.log("(no results)");
    return;
  }

  const preferred = opts?.columns?.length ? opts.columns : Object.keys(rows[0]);
  const columns = preferred.filter((column) => rows.some((row) => row[column] != null && String(row[column]).length > 0));
  if (columns.length === 0) {
    console.log("(no results)");
    return;
  }

  const termWidth = process.stdout.columns || 120;
  const maxPerColumn = 48;
  const minPerColumn = 8;

  const widths: Record<string, number> = {};
  for (const column of columns) {
    const header = column.toUpperCase();
    const longestCell = Math.max(...rows.map((row) => String(row[column] ?? "").length), header.length);
    widths[column] = Math.max(minPerColumn, Math.min(maxPerColumn, longestCell));
  }

  const separatorBudget = columns.length - 1;
  let total = Object.values(widths).reduce((sum, width) => sum + width, 0) + separatorBudget;
  if (total > termWidth) {
    const shrinkable = columns.filter((column) => widths[column] > minPerColumn);
    let idx = 0;
    while (total > termWidth && shrinkable.length > 0) {
      const column = shrinkable[idx % shrinkable.length];
      if (widths[column] > minPerColumn) {
        widths[column] -= 1;
        total -= 1;
      }
      idx += 1;
      if (idx > 10000) break;
    }
  }

  const renderLine = (row: GenericRow, header = false) =>
    columns
      .map((column) => {
        const raw = header ? column.toUpperCase() : String(row[column] ?? "");
        return truncate(raw, widths[column]).padEnd(widths[column], " ");
      })
      .join(" ");

  console.log(renderLine({}, true));
  console.log(columns.map((column) => "-".repeat(widths[column])).join(" "));
  for (const row of rows) console.log(renderLine(row));
}

function outputRows(rows: GenericRow[], format: OutputFormat, opts?: { columns?: string[] }) {
  if (format === "json") {
    printJson(rows);
    return;
  }
  if (format === "ndjson") {
    for (const row of rows) console.log(JSON.stringify(row));
    return;
  }
  renderRows(rows, opts);
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
  search "<query>" [--limit 20] [--type event,discover,calendar,help] [--format table|json|ndjson] [--columns col1,col2]
  discover --slug <slug> [--limit 20] [--lat N --lng N] [--format table|json|ndjson] [--columns col1,col2]
  mine [--limit 20] [--cursor token] [--format table|json|ndjson] [--columns col1,col2]
  register <url|slug|event_api_id> [--name "Name"] [--email "me@x.com"] [--answers-file ./answers.json] [--dry-run]
  cancel <url|slug|event_api_id> [--message "optional"] [--dry-run]
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
  - Auth required. Uses /search/get-results and returns mixed rows (event/discover/calendar/help).
- luma discover --slug <slug> --limit N [--lat X --lng Y] --json
  - Uses /discover/get-paginated-events. Works with category or place slugs (ai, miami, sf, etc).
- luma event <url|slug|event_api_id> --json
  - Resolves slug/url to event_api_id via page __NEXT_DATA__, then fetches /event/get.
- luma mine --json
  - Returns your home events feed via /home/get-events.
- luma register <url|slug|event_api_id>
  - Registers for an event via /event/register.
- luma cancel <url|slug|event_api_id>
  - Cancels your registration via /event/decline-my-registration.

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
        "Auth required. Uses /search/get-results and returns mixed rows (event/discover/calendar/help).",
      "luma discover --slug <slug> --limit N [--lat X --lng Y] --json":
        "Uses /discover/get-paginated-events for category/place slugs (ai, miami, sf, etc).",
      "luma event <url|slug|event_api_id> --json":
        "Resolves slug/url to event_api_id via page __NEXT_DATA__, then fetches /event/get.",
      "luma mine --json": "Returns your home events feed via /home/get-events.",
      "luma register <url|slug|event_api_id>": "Registers for an event via /event/register.",
      "luma cancel <url|slug|event_api_id>": "Cancels your registration via /event/decline-my-registration.",
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
    const outputFormat = readFormat(args);
    const columns = readFlagList(args, "--columns");
    const typeFlags = readFlagList(args, "--type");
    const selectedTypes = new Set(
      (typeFlags.length ? typeFlags : ["event", "discover", "calendar", "help"])
        .map((item) => item.toLowerCase())
        .filter((item): item is SearchRowType => ["event", "discover", "calendar", "help"].includes(item)),
    );
    const session = requireSession();
    const result = await searchEvents(query, session);
    const rows = [
      ...(result.events ?? []).map((item) => ({ type: "event", ...eventRow(item) })),
      ...(result.discover_entities ?? []).map((item) => ({
        type: "discover",
        name: item.name ?? "",
        event_api_id: item.api_id ?? "",
        url: item.path ? `https://luma.com${item.path}` : item.slug ? `https://luma.com/${item.slug}` : "",
        start_at: "",
        calendar: "",
        city: "",
        approval_status: "",
      })),
      ...(result.calendars ?? []).map((item) => ({
        type: "calendar",
        name: item.name ?? "",
        event_api_id: item.api_id ?? "",
        url: item.path ? `https://luma.com${item.path}` : item.slug ? `https://luma.com/${item.slug}?k=c` : "",
        start_at: "",
        calendar: "",
        city: "",
        approval_status: "",
      })),
      ...(result.help_pages ?? []).map((item) => ({
        type: "help",
        name: item.title ?? "",
        event_api_id: item.slug ?? "",
        url: item.slug ? `https://help.luma.com/p/${item.slug}` : "",
        start_at: "",
        calendar: "",
        city: "",
        approval_status: "",
      })),
    ]
      .filter((row) => selectedTypes.has(row.type as SearchRowType))
      .slice(0, limit);
    outputRows(rows, outputFormat, { columns });
    return;
  }

  if (cmd === "discover") {
    const slug = readFlagValue(args, "--slug");
    if (!slug) throw new Error("Missing --slug (e.g. --slug ai)");
    const outputFormat = readFormat(args);
    const columns = readFlagList(args, "--columns");
    const session = loadSession() ?? undefined;
    const response = await discoverEvents({
      slug,
      paginationLimit: Number(readFlagValue(args, "--limit", "-l") ?? "20"),
      latitude: readFlagValue(args, "--lat") ? Number(readFlagValue(args, "--lat")) : undefined,
      longitude: readFlagValue(args, "--lng") ? Number(readFlagValue(args, "--lng")) : undefined,
      session,
    });
    const entries = response.entries.map((entry) => ({ type: "event", ...eventRow(entry) }));
    if (outputFormat === "json") {
      printJson({ slug, has_more: !!response.has_more, entries });
      return;
    }
    outputRows(entries, outputFormat, { columns });
    return;
  }

  if (cmd === "mine") {
    const outputFormat = readFormat(args);
    const columns = readFlagList(args, "--columns");
    const session = requireSession();
    const response = await getMyEvents(session, {
      limit: Number(readFlagValue(args, "--limit", "-l") ?? "20"),
      cursor: readFlagValue(args, "--cursor"),
    });
    const entries = response.entries.map((entry) => ({ type: "event", ...eventRow(entry) }));
    if (outputFormat === "json") {
      printJson({ has_more: !!response.has_more, next_cursor: response.next_cursor ?? null, entries });
      return;
    }
    outputRows(entries, outputFormat, { columns });
    return;
  }

  if (cmd === "register") {
    const input = args[1];
    if (!input) throw new Error("Missing event input (url, slug, or evt-...)");
    const session = requireSession();
    const eventApiId = await resolveEventApiId(input, session);
    const event = await getEvent(eventApiId, session);

    const name = readFlagValue(args, "--name");
    const email = readFlagValue(args, "--email");
    const answersFile = readFlagValue(args, "--answers-file");
    const dryRun = hasFlag(args, "--dry-run");

    let registrationAnswers: Array<{ api_id: string; value: string | string[] }> = [];
    if (answersFile) {
      const parsed = JSON.parse(readFileSync(answersFile, "utf8")) as Array<{ api_id: string; value: string | string[] }>;
      if (!Array.isArray(parsed)) throw new Error("--answers-file must be a JSON array");
      registrationAnswers = parsed;
    }

    const firstTicketTypeId: string | undefined = event.ticket_types?.[0]?.api_id;
    const ticket_type_to_selection = firstTicketTypeId ? { [firstTicketTypeId]: 1 } : undefined;

    const payload = {
      event_api_id: eventApiId,
      name,
      email,
      registration_answers: registrationAnswers,
      ticket_type_to_selection,
    };

    if (dryRun) {
      printJson({ dry_run: true, payload });
      return;
    }

    const response = await registerForEvent(session, payload);
    printJson({ ok: true, event_api_id: eventApiId, response });
    return;
  }

  if (cmd === "cancel") {
    const input = args[1];
    if (!input) throw new Error("Missing event input (url, slug, or evt-...)");
    const session = requireSession();
    const eventApiId = await resolveEventApiId(input, session);
    const message = readFlagValue(args, "--message");
    const dryRun = hasFlag(args, "--dry-run");
    const payload = { event_api_id: eventApiId, decline_message: message ?? null };

    if (dryRun) {
      printJson({ dry_run: true, payload });
      return;
    }

    const response = await cancelRegistration(session, payload);
    printJson({ ok: true, event_api_id: eventApiId, response });
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
