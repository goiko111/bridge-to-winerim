import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TEMPLATE_PATH = fileURLToPath(new URL("./wrangler.toml.example", import.meta.url));
const MAIN_PATH = fileURLToPath(new URL("./src/worker.ts", import.meta.url));
const PLACEHOLDER_PATTERN = /\{\{([A-Z0-9_]+)\}\}/g;
const VALUES = Object.freeze([
  "CF_ACCESS_AUD",
  "CF_ACCESS_TEAM_DOMAIN",
  "OPERATOR_KEY_ID",
  "OPERATOR_PUBLIC_KEY_JWK",
  "RUNTIME_VAULT_KEY_VERSION",
  "CLOUDFLARE_RUNTIME_VAULT_STORE_ID",
  "CLOUDFLARE_RUNTIME_VAULT_SECRET_NAME",
  "RUNTIME_CREDENTIAL_PROVISIONER_CUSTOM_DOMAIN",
  "RUNTIME_CREDENTIAL_PROVISIONER_MAIN",
]);

function fail(code) {
  throw new Error(`RUNTIME_CREDENTIAL_PROVISIONER_CONFIG_${code}`);
}

function clean(value, name, pattern, maxLength = 256) {
  const normalized = String(value ?? "");
  if (
    !normalized
    || normalized !== normalized.trim()
    || normalized.length > maxLength
    || /[\r\n]/.test(normalized)
    || !pattern.test(normalized)
  ) fail(`${name}_INVALID`);
  return normalized;
}

function publicOperatorJwk(value) {
  let jwk;
  try {
    jwk = JSON.parse(String(value ?? ""));
  } catch {
    fail("OPERATOR_PUBLIC_KEY_JWK_INVALID");
  }
  const keys = Object.keys(jwk).sort();
  if (
    keys.join(",") !== "crv,kty,x"
    || jwk.kty !== "OKP"
    || jwk.crv !== "Ed25519"
    || !/^[A-Za-z0-9_-]{43}$/.test(String(jwk.x ?? ""))
  ) fail("OPERATOR_PUBLIC_KEY_JWK_INVALID");
  return JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x });
}

export function renderInactiveRuntimeCredentialProvisionerConfig({ template, values }) {
  if (typeof template !== "string" || !template) fail("TEMPLATE_REQUIRED");
  if (!values || typeof values !== "object" || Array.isArray(values)) fail("VALUES_REQUIRED");
  const actualKeys = Object.keys(values).sort();
  if (actualKeys.join(",") !== [...VALUES].sort().join(",")) fail("VALUES_STRUCTURE_INVALID");

  const replacements = Object.freeze({
    CF_ACCESS_AUD: clean(values.CF_ACCESS_AUD, "CF_ACCESS_AUD", /^[0-9a-f]{64}$/i, 64),
    CF_ACCESS_TEAM_DOMAIN: clean(
      values.CF_ACCESS_TEAM_DOMAIN,
      "CF_ACCESS_TEAM_DOMAIN",
      /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+cloudflareaccess\.com$/,
    ),
    OPERATOR_KEY_ID: clean(values.OPERATOR_KEY_ID, "OPERATOR_KEY_ID", /^[A-Za-z0-9._-]{1,64}$/, 64),
    OPERATOR_PUBLIC_KEY_JWK: publicOperatorJwk(values.OPERATOR_PUBLIC_KEY_JWK),
    RUNTIME_VAULT_KEY_VERSION: clean(
      values.RUNTIME_VAULT_KEY_VERSION,
      "RUNTIME_VAULT_KEY_VERSION",
      /^[A-Za-z0-9._-]{1,64}$/,
      64,
    ),
    CLOUDFLARE_RUNTIME_VAULT_STORE_ID: clean(
      values.CLOUDFLARE_RUNTIME_VAULT_STORE_ID,
      "CLOUDFLARE_RUNTIME_VAULT_STORE_ID",
      /^[0-9a-f]{32}$/i,
      32,
    ),
    CLOUDFLARE_RUNTIME_VAULT_SECRET_NAME: clean(
      values.CLOUDFLARE_RUNTIME_VAULT_SECRET_NAME,
      "CLOUDFLARE_RUNTIME_VAULT_SECRET_NAME",
      /^[A-Za-z0-9._-]{1,128}$/,
      128,
    ),
    RUNTIME_CREDENTIAL_PROVISIONER_CUSTOM_DOMAIN: clean(
      values.RUNTIME_CREDENTIAL_PROVISIONER_CUSTOM_DOMAIN,
      "RUNTIME_CREDENTIAL_PROVISIONER_CUSTOM_DOMAIN",
      /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
    ),
    RUNTIME_CREDENTIAL_PROVISIONER_MAIN: clean(
      values.RUNTIME_CREDENTIAL_PROVISIONER_MAIN,
      "RUNTIME_CREDENTIAL_PROVISIONER_MAIN",
      /^\/[A-Za-z0-9._/-]+\/worker\.ts$/,
      1024,
    ),
  });

  const seen = new Set();
  const rendered = template.replace(PLACEHOLDER_PATTERN, (_match, name) => {
    if (!(name in replacements)) fail(`PLACEHOLDER_${name}_UNKNOWN`);
    seen.add(name);
    return replacements[name];
  });
  if (seen.size !== VALUES.length || VALUES.some((name) => !seen.has(name))) {
    fail("PLACEHOLDER_SET_INVALID");
  }
  if (PLACEHOLDER_PATTERN.test(rendered)) fail("PLACEHOLDER_UNRESOLVED");
  if (!/^PROVISIONING_ENABLED = "false"$/m.test(rendered)) fail("PROVISIONING_NOT_INACTIVE");
  if (!/^workers_dev = false$/m.test(rendered) || !/^preview_urls = false$/m.test(rendered)) {
    fail("PUBLIC_PREVIEW_SURFACE_INVALID");
  }
  if (!/^custom_domain = true$/m.test(rendered)) fail("CUSTOM_DOMAIN_REQUIRED");
  if (/CF_ACCESS_CLIENT_(?:ID|SECRET)/.test(rendered)) fail("ACCESS_SERVICE_SECRET_FORBIDDEN");
  return `${rendered.trimEnd()}\n`;
}

function argument(name) {
  return process.argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
}

function main() {
  const output = argument("--output");
  if (!output) fail("OUTPUT_REQUIRED");
  const rendered = renderInactiveRuntimeCredentialProvisionerConfig({
    template: readFileSync(TEMPLATE_PATH, "utf8"),
    values: Object.fromEntries(VALUES.map((name) => [
      name,
      name === "RUNTIME_CREDENTIAL_PROVISIONER_MAIN" ? MAIN_PATH : process.env[name],
    ])),
  });
  const target = resolve(output);
  writeFileSync(target, rendered, { encoding: "utf8", mode: 0o600, flag: "wx" });
  chmodSync(target, 0o600);
  process.stdout.write(`${JSON.stringify({
    status: "RUNTIME_CREDENTIAL_PROVISIONER_INACTIVE_CONFIG_READY",
    provisioningEnabled: false,
    output: target,
  })}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "RUNTIME_CREDENTIAL_PROVISIONER_CONFIG_FAILED"}\n`);
    process.exitCode = 1;
  }
}
