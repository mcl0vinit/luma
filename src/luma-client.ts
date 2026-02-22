import { cookieHeaderForLuma, type SessionStore } from "./store";

type LumaEventEntry = {
  api_id: string;
  event: {
    api_id: string;
    name: string;
    url: string;
    start_at?: string;
    timezone?: string;
    geo_address_info?: { city?: string; region?: string; country?: string; full_address?: string };
  };
  calendar?: { name?: string; slug?: string };
  role?: { type?: string; approval_status?: string };
  ticket_info?: { require_approval?: boolean; is_sold_out?: boolean };
  featured_city?: { slug?: string; name?: string };
};

export type DiscoverResponse = {
  entries: LumaEventEntry[];
  has_more?: boolean;
  next_cursor?: string;
};

export type SearchResponse = {
  query?: string;
  calendars?: Array<{ api_id?: string; name?: string; slug?: string; path?: string }>;
  events?: LumaEventEntry[];
  discover_entities?: Array<{ api_id?: string; name?: string; slug?: string; type?: string; path?: string }>;
  help_pages?: Array<{ title?: string; slug?: string }>;
};

export type HomeEventsResponse = {
  entries: LumaEventEntry[];
  has_more?: boolean;
  next_cursor?: string;
};

export type RegisterRequest = {
  event_api_id: string;
  name?: string;
  email?: string;
  registration_answers?: Array<{ api_id: string; value: string | string[] }>;
  ticket_type_to_selection?: Record<string, number>;
};

async function requestJson(url: string, session?: SessionStore, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  if (session) headers.set("cookie", cookieHeaderForLuma(session));
  if (!headers.has("accept")) headers.set("accept", "application/json");
  const response = await fetch(url, { ...init, headers });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status} for ${url}: ${text.slice(0, 220)}`);
  }
  return response.json();
}

export async function whoAmI(session: SessionStore) {
  const response = await fetch("https://luma.com/home", {
    headers: { cookie: cookieHeaderForLuma(session) },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} loading /home`);
  const html = await response.text();
  const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!match) throw new Error("Could not parse __NEXT_DATA__ on /home.");
  const data = JSON.parse(match[1]) as { props?: { initialUserData?: { user?: Record<string, unknown> } } };
  const user = data.props?.initialUserData?.user;
  if (!user) throw new Error("No authenticated user found in /home payload.");
  return {
    apiId: String(user.api_id ?? ""),
    name: String(user.name ?? ""),
    email: String(user.email ?? ""),
    username: user.username ? String(user.username) : null,
    timezone: user.timezone ? String(user.timezone) : null,
  };
}

export async function searchEvents(query: string, session: SessionStore) {
  const url = `https://api2.luma.com/search/get-results?query=${encodeURIComponent(query)}`;
  return (await requestJson(url, session)) as SearchResponse;
}

export async function discoverEvents(args: {
  slug: string;
  latitude?: number;
  longitude?: number;
  paginationLimit?: number;
  session?: SessionStore;
}) {
  const params = new URLSearchParams({
    slug: args.slug,
    pagination_limit: String(args.paginationLimit ?? 20),
  });
  if (args.latitude != null) params.set("latitude", String(args.latitude));
  if (args.longitude != null) params.set("longitude", String(args.longitude));
  const url = `https://api2.luma.com/discover/get-paginated-events?${params.toString()}`;
  return (await requestJson(url, args.session)) as DiscoverResponse;
}

function parseNextData(html: string) {
  const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!match) return null;
  return JSON.parse(match[1]) as {
    props?: {
      pageProps?: {
        initialData?: {
          kind?: string;
          data?: {
            event?: { api_id?: string; url?: string; name?: string };
          };
        };
      };
    };
  };
}

export async function resolveEventApiId(input: string, session?: SessionStore) {
  if (input.startsWith("evt-")) return input;
  const slug = input
    .replace(/^https?:\/\/(www\.)?luma\.com\//, "")
    .replace(/^https?:\/\/(www\.)?lu\.ma\//, "")
    .replace(/^\/+/, "")
    .split("?")[0]
    .split("/")[0];
  if (!slug) throw new Error(`Could not parse event slug from: ${input}`);

  const headers = new Headers();
  if (session) headers.set("cookie", cookieHeaderForLuma(session));
  const res = await fetch(`https://luma.com/${slug}`, { headers });
  if (!res.ok) throw new Error(`Event page fetch failed for slug ${slug}: HTTP ${res.status}`);
  const data = parseNextData(await res.text());
  const eventApiId = data?.props?.pageProps?.initialData?.data?.event?.api_id;
  if (!eventApiId) throw new Error(`Could not resolve event_api_id from slug ${slug}`);
  return eventApiId;
}

export async function getEvent(eventApiId: string, session?: SessionStore) {
  const url = `https://api2.luma.com/event/get?event_api_id=${encodeURIComponent(eventApiId)}`;
  return requestJson(url, session);
}

export async function getMyEvents(session: SessionStore, args?: { limit?: number; cursor?: string; eventTarget?: string }) {
  const params = new URLSearchParams({
    pagination_limit: String(args?.limit ?? 20),
    event_target: args?.eventTarget ?? "go_to",
  });
  if (args?.cursor) params.set("pagination_cursor", args.cursor);
  const url = `https://api2.luma.com/home/get-events?${params.toString()}`;
  return (await requestJson(url, session)) as HomeEventsResponse;
}

export async function registerForEvent(session: SessionStore, payload: RegisterRequest) {
  const url = "https://api2.luma.com/event/register";
  return requestJson(url, session, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function cancelRegistration(session: SessionStore, payload: { event_api_id: string; decline_message?: string | null }) {
  const url = "https://api2.luma.com/event/decline-my-registration";
  return requestJson(url, session, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      event_api_id: payload.event_api_id,
      decline_message: payload.decline_message ?? null,
    }),
  });
}
