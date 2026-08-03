#!/usr/bin/env node

export const RESCUE_PRODUCTION_ENVIRONMENT = "rescue-production";
export const RESCUE_PRODUCTION_PROJECT_REF = "piyvadlzagtracciquap";

const FORBIDDEN_PROJECT_REFS = new Set([
  "qpbmqvfnunkylvtvnyyx", // Existing staging project.
  "csiertktrefwewsmequr", // Lovable production source under recovery.
]);
const PROJECT_REF = /^[a-z0-9]{20}$/;
const POOLER_HOST = /^(?:[a-z0-9-]+\.)*pooler\.supabase\.com$/;

function reject(message) {
  throw new Error(message);
}

export function validateRescueProductionTarget({
  databaseUrl,
  expectedProjectRef,
  expectedEnvironment,
  allowLocalDisposable = false,
}) {
  if (expectedEnvironment !== RESCUE_PRODUCTION_ENVIRONMENT) {
    reject("RESCUE_PRODUCTION_ENVIRONMENT_REJECTED");
  }
  if (!PROJECT_REF.test(expectedProjectRef ?? "")) {
    reject("RESCUE_PRODUCTION_PROJECT_REF_INVALID");
  }
  if (FORBIDDEN_PROJECT_REFS.has(expectedProjectRef)) {
    reject("RESCUE_PRODUCTION_FORBIDDEN_PROJECT_REF");
  }
  if (expectedProjectRef !== RESCUE_PRODUCTION_PROJECT_REF) {
    reject("RESCUE_PRODUCTION_UNKNOWN_PROJECT_REF");
  }

  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    reject("RESCUE_PRODUCTION_DATABASE_URL_INVALID");
  }

  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    reject("RESCUE_PRODUCTION_DATABASE_PROTOCOL_REJECTED");
  }

  const hostname = parsed.hostname.toLowerCase();
  const username = decodeURIComponent(parsed.username);
  const database = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
  const port = parsed.port || "5432";
  const localDisposable = allowLocalDisposable
    && ["localhost", "127.0.0.1"].includes(hostname)
    && database === "winerim_rescue_production_test"
    && username.length > 0
    && Number(port) >= 1024
    && Number(port) <= 65535;

  if (localDisposable) {
    return Object.freeze({
      projectRef: expectedProjectRef,
      expectedEnvironment,
      hostname,
      database,
      port,
      mode: "local-disposable",
    });
  }

  if (database !== "postgres") {
    reject("RESCUE_PRODUCTION_DATABASE_REJECTED");
  }
  if (port !== "5432") {
    reject("RESCUE_PRODUCTION_DATABASE_PORT_REJECTED");
  }
  if (username.length === 0) {
    reject("RESCUE_PRODUCTION_DATABASE_USERNAME_REQUIRED");
  }

  const direct = hostname === `db.${expectedProjectRef}.supabase.co`;
  const usernameParts = username.split(".");
  const pooler = POOLER_HOST.test(hostname)
    && usernameParts.length >= 2
    && usernameParts.at(-1) === expectedProjectRef;

  if (!direct && !pooler) {
    reject("RESCUE_PRODUCTION_TARGET_IDENTITY_MISMATCH");
  }

  return Object.freeze({
    projectRef: expectedProjectRef,
    expectedEnvironment,
    hostname,
    database,
    port,
    mode: direct ? "direct" : "pooler",
  });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    const target = validateRescueProductionTarget({
      databaseUrl: String(process.env.RESCUE_PRODUCTION_DATABASE_URL ?? ""),
      expectedProjectRef: String(process.env.RESCUE_PRODUCTION_PROJECT_REF ?? ""),
      expectedEnvironment: String(process.env.RESCUE_PRODUCTION_EXPECTED_ENVIRONMENT ?? ""),
      allowLocalDisposable: process.env.WINERIM_RESCUE_PRODUCTION_LOCAL_TEST === "1",
    });
    process.stdout.write(`${JSON.stringify(target)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "RESCUE_PRODUCTION_TARGET_VALIDATION_FAILED"}\n`);
    process.exitCode = 1;
  }
}
