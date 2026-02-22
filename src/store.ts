import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export type StoredCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  expiresUtc?: number;
};

export type SessionStore = {
  source: {
    browser: "chrome";
    profile: string;
    profilePath: string;
    importedAt: string;
  };
  cookies: StoredCookie[];
};

const CONFIG_DIR = process.env.LUMA_CLI_HOME
  ? process.env.LUMA_CLI_HOME
  : join(process.cwd(), ".luma-cli");
const SESSION_FILE = join(CONFIG_DIR, "session.json");

export function getSessionFilePath() {
  return SESSION_FILE;
}

export function loadSession(): SessionStore | null {
  if (!existsSync(SESSION_FILE)) return null;
  try {
    return JSON.parse(readFileSync(SESSION_FILE, "utf8")) as SessionStore;
  } catch {
    return null;
  }
}

export function saveSession(session: SessionStore) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2), "utf8");
}

export function cookieHeaderForLuma(session: SessionStore) {
  return session.cookies
    .filter((cookie) => cookie.domain.endsWith("luma.com"))
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

export function sessionFromCookieHeader(cookieHeader: string, sourceLabel = "manual"): SessionStore {
  const cookies = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const eq = part.indexOf("=");
      if (eq < 1) return null;
      return {
        name: part.slice(0, eq),
        value: part.slice(eq + 1),
        domain: ".luma.com",
        path: "/",
        secure: true,
        httpOnly: false,
      } as StoredCookie;
    })
    .filter((item): item is StoredCookie => !!item);

  return {
    source: {
      browser: "chrome",
      profile: sourceLabel,
      profilePath: sourceLabel,
      importedAt: new Date().toISOString(),
    },
    cookies,
  };
}
