#!/usr/bin/env node

export const STAGING_PROJECT_REF = "qpbmqvfnunkylvtvnyyx";

const IDENTIFIER = /^[a-z0-9_-]+$/;

export function validateStagingDatabaseUrl(databaseUrl, { allowLocalDisposable = false } = {}) {
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("STAGING_DATABASE_URL_INVALID");
  }
  const hostname = parsed.hostname.toLowerCase();
  const username = decodeURIComponent(parsed.username);
  const database = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
  const port = parsed.port || "5432";
  const direct = hostname === `db.${STAGING_PROJECT_REF}.supabase.co`
    && username.length > 0;
  const usernameParts = username.split(".");
  const pooler = /^(?:[a-z0-9-]+\.)*pooler\.supabase\.com$/.test(hostname)
    && usernameParts.length >= 2
    && usernameParts.at(-1) === STAGING_PROJECT_REF
    && usernameParts.slice(0, -1).every((part) => IDENTIFIER.test(part));
  const localDisposable = allowLocalDisposable
    && ["localhost", "127.0.0.1"].includes(hostname)
    && username.length > 0
    && database === "winerim_runtime_upgrade_test"
    && Number(port) >= 1024
    && Number(port) <= 65535;

  if ((!direct && !pooler && !localDisposable) || database !== (localDisposable ? database : "postgres")) {
    throw new Error("STAGING_DATABASE_IDENTITY_MISMATCH");
  }
  if (!localDisposable && port !== "5432") {
    throw new Error("STAGING_DATABASE_PORT_REJECTED");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("STAGING_DATABASE_PROTOCOL_REJECTED");
  }
  return Object.freeze({
    projectRef: localDisposable ? "local-disposable-test" : STAGING_PROJECT_REF,
    hostname,
    username,
    database,
    port,
    mode: localDisposable ? "local-disposable" : direct ? "direct" : "pooler",
  });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    const result = validateStagingDatabaseUrl(String(process.env.STAGING_DATABASE_URL ?? ""), {
      allowLocalDisposable: process.env.WINERIM_LOCAL_DISPOSABLE_UPGRADE_TEST === "1",
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "STAGING_DATABASE_VALIDATION_FAILED"}\n`);
    process.exitCode = 1;
  }
}
