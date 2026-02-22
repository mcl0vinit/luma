import { createDecipheriv, pbkdf2Sync, createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, copyFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { SessionStore, StoredCookie } from "./store";

type ChromeProfile = {
  name: string;
  path: string;
};

type RawCookieRow = {
  hostKey: string;
  name: string;
  value: string;
  encryptedHex: string;
  path: string;
  expiresUtc: number;
  isSecure: boolean;
  isHttpOnly: boolean;
};

const CHROME_USER_DATA = join(homedir(), "Library/Application Support/Google/Chrome");

function getChromeMasterPassword(): string {
  const fromEnv = process.env.LUMA_CHROME_SAFE_STORAGE_KEY?.trim();
  if (fromEnv) return fromEnv;

  const candidates: Array<[string, string?]> = [
    ["Chrome Safe Storage", "Chrome"],
    ["Chrome Safe Storage"],
    ["Google Chrome Safe Storage", "Chrome"],
    ["Chromium Safe Storage", "Chromium"],
    ["Brave Safe Storage", "Brave"],
  ];

  for (const [service, account] of candidates) {
    try {
      const args = ["find-generic-password", "-w", "-s", service];
      if (account) args.push("-a", account);
      const value = execFileSync("security", args, { encoding: "utf8" }).trim();
      if (value) return value;
    } catch {
      continue;
    }
  }

  throw new Error(
    "Could not read Chrome Safe Storage key from Keychain. Set LUMA_CHROME_SAFE_STORAGE_KEY and retry.",
  );
}

function decryptChromiumCookie(encryptedValueHex: string, hostKey: string, chromePassword: string): string {
  const encrypted = Buffer.from(encryptedValueHex, "hex");
  if (encrypted.length === 0) return "";
  const prefix = encrypted.subarray(0, 3).toString("utf8");
  if (prefix !== "v10" && prefix !== "v11") return "";

  const payload = encrypted.subarray(3);
  const key = pbkdf2Sync(chromePassword, "saltysalt", 1003, 16, "sha1");

  let decrypted: Buffer;
  if (payload.length > 28) {
    try {
      const nonce = payload.subarray(0, 12);
      const tag = payload.subarray(payload.length - 16);
      const ciphertext = payload.subarray(12, payload.length - 16);
      const decipher = createDecipheriv("aes-128-gcm", key, nonce);
      decipher.setAuthTag(tag);
      decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      const iv = Buffer.alloc(16, 0x20);
      const decipher = createDecipheriv("aes-128-cbc", key, iv);
      decrypted = Buffer.concat([decipher.update(payload), decipher.final()]);
    }
  } else {
    const iv = Buffer.alloc(16, 0x20);
    const decipher = createDecipheriv("aes-128-cbc", key, iv);
    decrypted = Buffer.concat([decipher.update(payload), decipher.final()]);
  }

  const hostHash = createHash("sha256").update(hostKey).digest();
  if (decrypted.length > 32 && decrypted.subarray(0, 32).equals(hostHash)) {
    return decrypted.subarray(32).toString("utf8");
  }
  return decrypted.toString("utf8");
}

function parseBool(v: string) {
  return v === "1";
}

function parseCookiesFromDb(cookiesDbPath: string, chromePassword: string) {
  const tmpDir = mkdtempSync(join(homedir(), ".luma-cli-cookies-"));
  const tmpDbPath = join(tmpDir, "Cookies");
  copyFileSync(cookiesDbPath, tmpDbPath);

  try {
    const out = execFileSync(
      "sqlite3",
      [
        "-separator",
        "\t",
        tmpDbPath,
        "SELECT host_key, name, value, hex(encrypted_value), path, expires_utc, is_secure, is_httponly FROM cookies WHERE host_key LIKE '%luma.com%';",
      ],
      { encoding: "utf8" },
    );

    const rows: RawCookieRow[] = out
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("\t"))
      .map(([hostKey, name, value, encryptedHex, path, expiresUtc, isSecure, isHttpOnly]) => ({
        hostKey,
        name,
        value,
        encryptedHex,
        path,
        expiresUtc: Number(expiresUtc || 0),
        isSecure: parseBool(isSecure || "0"),
        isHttpOnly: parseBool(isHttpOnly || "0"),
      }));

    const cookies: StoredCookie[] = rows
      .map((row) => {
        const value =
          row.value && row.value.length > 0
            ? row.value
            : decryptChromiumCookie(row.encryptedHex || "", row.hostKey, chromePassword);
        return {
          name: row.name,
          value,
          domain: row.hostKey,
          path: row.path || "/",
          secure: row.isSecure,
          httpOnly: row.isHttpOnly,
          expiresUtc: row.expiresUtc || undefined,
        };
      })
      .filter((cookie) => cookie.value.length > 0);

    return cookies;
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

export function listChromeProfiles(): ChromeProfile[] {
  if (!existsSync(CHROME_USER_DATA)) return [];
  const localStatePath = join(CHROME_USER_DATA, "Local State");
  if (!existsSync(localStatePath)) return [];

  const state = JSON.parse(readFileSync(localStatePath, "utf8")) as {
    profile?: { info_cache?: Record<string, { name?: string }> };
  };

  const infoCache = state.profile?.info_cache ?? {};
  return Object.entries(infoCache)
    .map(([key, data]) => ({ name: data.name ?? key, path: join(CHROME_USER_DATA, key) }))
    .filter((entry) => existsSync(join(entry.path, "Cookies")));
}

export function importFromChrome(profileHint?: string): SessionStore {
  const profiles = listChromeProfiles();
  if (profiles.length === 0) {
    throw new Error("No Chrome profiles with cookie DB found.");
  }

  const profile =
    profiles.find((item) => item.name === profileHint) ??
    profiles.find((item) => item.path.endsWith(`/${profileHint}`)) ??
    profiles[0];

  const cookiesDbPath = join(profile.path, "Cookies");
  if (!existsSync(cookiesDbPath)) {
    throw new Error(`Cookies DB not found for profile: ${profile.name}`);
  }

  const password = getChromeMasterPassword();
  const cookies = parseCookiesFromDb(cookiesDbPath, password);
  if (cookies.length === 0) {
    throw new Error("No decryptable Luma cookies found in selected Chrome profile.");
  }

  return {
    source: {
      browser: "chrome",
      profile: profile.name,
      profilePath: profile.path,
      importedAt: new Date().toISOString(),
    },
    cookies,
  };
}
