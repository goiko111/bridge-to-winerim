import {
  createCipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY_VERSION_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_PLAINTEXT_BYTES = 8 * 1024;
const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "../..");

function required(environment, name) {
  const value = String(environment[name] ?? "").trim();
  if (!value) throw new Error(`RUNTIME_CREDENTIAL_PROVISION_MISSING_${name}`);
  return value;
}

function decodeMasterKey(value) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new Error("RUNTIME_CREDENTIAL_PROVISION_INVALID_MASTER_KEY_BASE64");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== 32 || decoded.toString("base64") !== value) {
    throw new Error("RUNTIME_CREDENTIAL_PROVISION_MASTER_KEY_MUST_BE_32_BYTES");
  }
  return decoded;
}

export function runtimeCredentialAad({ connectionId, kind, keyVersion }) {
  return [
    "winerim-runtime-credential",
    "1",
    connectionId,
    "agora",
    kind,
    keyVersion,
  ].join("|");
}

export function encryptRuntimeCredential({
  connectionId,
  kind,
  keyVersion,
  plaintext,
  masterKey,
  nonce = randomBytes(12),
}) {
  if (!UUID_PATTERN.test(connectionId)) {
    throw new Error("RUNTIME_CREDENTIAL_PROVISION_INVALID_CONNECTION_ID");
  }
  if (!KEY_VERSION_PATTERN.test(keyVersion)) {
    throw new Error("RUNTIME_CREDENTIAL_PROVISION_INVALID_KEY_VERSION");
  }
  if (!new Set(["agora", "winerim"]).has(kind)) {
    throw new Error("RUNTIME_CREDENTIAL_PROVISION_INVALID_KIND");
  }
  const plaintextBytes = Buffer.byteLength(plaintext, "utf8");
  if (
    plaintextBytes === 0
    || plaintextBytes > MAX_PLAINTEXT_BYTES
    || plaintext !== plaintext.trim()
    || /[\r\n]/.test(plaintext)
  ) {
    throw new Error("RUNTIME_CREDENTIAL_PROVISION_INVALID_PLAINTEXT_LENGTH");
  }
  if (!Buffer.isBuffer(masterKey) || masterKey.length !== 32) {
    throw new Error("RUNTIME_CREDENTIAL_PROVISION_MASTER_KEY_MUST_BE_32_BYTES");
  }
  if (!Buffer.isBuffer(nonce) || nonce.length !== 12) {
    throw new Error("RUNTIME_CREDENTIAL_PROVISION_NONCE_MUST_BE_12_BYTES");
  }

  const cipher = createCipheriv("aes-256-gcm", masterKey, nonce);
  cipher.setAAD(Buffer.from(runtimeCredentialAad({ connectionId, kind, keyVersion }), "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const reference = `runtime-vault://postgres/${connectionId}/agora/${kind}`;
  return {
    kind,
    nonceHex: nonce.toString("hex"),
    ciphertextHex: ciphertext.toString("hex"),
    attestationSha256: createHash("sha256").update([
      "winerim-runtime-credential-attestation",
      "1",
      reference,
      keyVersion,
      "1",
      nonce.toString("base64"),
      ciphertext.toString("base64"),
    ].join("|")).digest("hex"),
  };
}

export function renderCredentialProvisioningSql({ connectionId, keyVersion, credentials }) {
  if (!UUID_PATTERN.test(connectionId)) {
    throw new Error("RUNTIME_CREDENTIAL_PROVISION_INVALID_CONNECTION_ID");
  }
  if (!KEY_VERSION_PATTERN.test(keyVersion)) {
    throw new Error("RUNTIME_CREDENTIAL_PROVISION_INVALID_KEY_VERSION");
  }
  if (credentials.length !== 2 || credentials.map(({ kind }) => kind).sort().join(",") !== "agora,winerim") {
    throw new Error("RUNTIME_CREDENTIAL_PROVISION_REQUIRES_AGORA_AND_WINERIM");
  }
  for (const credential of credentials) {
    if (!/^[a-f0-9]{24}$/.test(credential.nonceHex)) {
      throw new Error("RUNTIME_CREDENTIAL_PROVISION_INVALID_NONCE_HEX");
    }
    if (!/^[a-f0-9]{34,32768}$/.test(credential.ciphertextHex)) {
      throw new Error("RUNTIME_CREDENTIAL_PROVISION_INVALID_CIPHERTEXT_HEX");
    }
  }

  const values = [...credentials]
    .sort((left, right) => left.kind.localeCompare(right.kind))
    .map((credential) => `(
    '${connectionId}'::uuid,
    'agora',
    '${credential.kind}',
    'AES-256-GCM',
    '${keyVersion}',
    1,
    decode('${credential.ciphertextHex}', 'hex'),
    decode('${credential.nonceHex}', 'hex'),
    false
  )`).join(",\n  ");

  return `\\set ON_ERROR_STOP on

BEGIN;

DO $provision_runtime_credentials$
DECLARE
  candidate_count integer;
  existing_credentials integer;
  active_scopes integer;
  active_credentials integer;
  operational_rows integer;
BEGIN
  SELECT count(*) INTO candidate_count
  FROM public.pos_connections
  WHERE id = '${connectionId}'::uuid
    AND provider = 'agora'
    AND enabled = false
    AND catalog_sync_enabled = false
    AND sync_mode = 'PULL_ONLY'
    AND write_mode = 'NONE'
    AND backfill_days = 0;
  IF candidate_count <> 1 THEN
    RAISE EXCEPTION 'credential candidate is missing or not inert';
  END IF;

  SELECT count(*) INTO existing_credentials
  FROM public.runtime_connection_credentials
  WHERE connection_id = '${connectionId}'::uuid;
  IF existing_credentials <> 0 THEN
    RAISE EXCEPTION 'credential vault is not empty; use a reviewed rotation procedure';
  END IF;

  SELECT count(*) INTO active_scopes
  FROM public.runtime_canary_connections
  WHERE active = true;
  SELECT count(*) INTO active_credentials
  FROM public.runtime_connection_credentials
  WHERE active = true;
  IF active_scopes <> 0 OR active_credentials <> 0 THEN
    RAISE EXCEPTION 'runtime canary or credential is already active';
  END IF;

  SELECT
    (SELECT count(*) FROM public.sales_events WHERE connection_id = '${connectionId}'::uuid)
    + (SELECT count(*) FROM public.sales_line_items WHERE connection_id = '${connectionId}'::uuid)
    + (SELECT count(*) FROM public.stock_sync_log WHERE connection_id = '${connectionId}'::uuid)
    + (SELECT count(*) FROM public.outbound_tasks WHERE connection_id = '${connectionId}'::uuid)
    + (SELECT count(*) FROM public.runtime_execution_log WHERE connection_id = '${connectionId}'::uuid)
    + (SELECT count(*) FROM public.runtime_idempotency WHERE connection_id = '${connectionId}'::uuid)
  INTO operational_rows;
  IF operational_rows <> 0 THEN
    RAISE EXCEPTION 'credential candidate has operational rows';
  END IF;
END;
$provision_runtime_credentials$;

INSERT INTO public.runtime_connection_credentials (
  connection_id,
  provider,
  credential_kind,
  algorithm,
  key_version,
  aad_version,
  ciphertext,
  nonce,
  active
) VALUES
  ${values};

DO $verify_runtime_credentials$
BEGIN
  IF (
    SELECT count(*)
    FROM public.runtime_connection_credentials
    WHERE connection_id = '${connectionId}'::uuid
      AND active = false
      AND key_version = '${keyVersion}'
      AND credential_kind IN ('agora', 'winerim')
  ) <> 2 THEN
    RAISE EXCEPTION 'inactive credential readback failed';
  END IF;
END;
$verify_runtime_credentials$;

COMMIT;
`;
}

export function credentialProvisioningPlan() {
  return {
    status: "RUNTIME_CREDENTIAL_PROVISION_PLAN_ONLY",
    remoteMutations: 0,
    writesPlaintext: false,
    insertsActiveCredentials: false,
    requiredEnvironment: [
      "CANARY_CONNECTION_ID",
      "RUNTIME_VAULT_KEY_VERSION",
      "RUNTIME_VAULT_MASTER_KEY",
      "RUNTIME_AGORA_CREDENTIAL",
      "RUNTIME_WINERIM_CREDENTIAL",
    ],
    renderGate: "--render --confirm-connection=<UUID> --output=/secure/path/credentials.sql",
  };
}

export function prepareCredentialProvisioning({ environment = process.env, output }) {
  const connectionId = required(environment, "CANARY_CONNECTION_ID");
  const keyVersion = required(environment, "RUNTIME_VAULT_KEY_VERSION");
  if (!UUID_PATTERN.test(connectionId)) throw new Error("RUNTIME_CREDENTIAL_PROVISION_INVALID_CONNECTION_ID");
  if (!KEY_VERSION_PATTERN.test(keyVersion)) throw new Error("RUNTIME_CREDENTIAL_PROVISION_INVALID_KEY_VERSION");
  const masterKey = decodeMasterKey(required(environment, "RUNTIME_VAULT_MASTER_KEY"));
  let credentials;
  try {
    credentials = [
      encryptRuntimeCredential({
        connectionId,
        kind: "agora",
        keyVersion,
        plaintext: required(environment, "RUNTIME_AGORA_CREDENTIAL"),
        masterKey,
      }),
      encryptRuntimeCredential({
        connectionId,
        kind: "winerim",
        keyVersion,
        plaintext: required(environment, "RUNTIME_WINERIM_CREDENTIAL"),
        masterKey,
      }),
    ];
  } finally {
    masterKey.fill(0);
  }

  const target = resolve(output);
  const relativeTarget = relative(repoRoot, target);
  if (relativeTarget === "" || (!relativeTarget.startsWith("..") && !relativeTarget.startsWith("/"))) {
    throw new Error("RUNTIME_CREDENTIAL_PROVISION_OUTPUT_MUST_BE_OUTSIDE_REPOSITORY");
  }
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const realParent = realpathSync(dirname(target));
  const realRelativeParent = relative(repoRoot, realParent);
  if (
    realRelativeParent === ""
    || (!realRelativeParent.startsWith("..") && !realRelativeParent.startsWith("/"))
  ) {
    throw new Error("RUNTIME_CREDENTIAL_PROVISION_OUTPUT_MUST_BE_OUTSIDE_REPOSITORY");
  }
  const sql = renderCredentialProvisioningSql({ connectionId, keyVersion, credentials });
  writeFileSync(target, sql, { encoding: "utf8", mode: 0o600, flag: "wx" });
  chmodSync(target, 0o600);
  return {
    status: "RUNTIME_CREDENTIAL_PROVISION_ARTIFACT_READY",
    remoteMutations: 0,
    connectionId,
    keyVersion,
    active: false,
    output: target,
    artifactSha256: createHash("sha256").update(sql).digest("hex"),
    credentialAttestations: Object.fromEntries(
      credentials.map(({ kind, attestationSha256 }) => [kind, attestationSha256]),
    ),
  };
}

function argument(name) {
  return process.argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
}

function main() {
  if (!process.argv.includes("--render")) {
    process.stdout.write(`${JSON.stringify(credentialProvisioningPlan(), null, 2)}\n`);
    return;
  }
  const connectionId = required(process.env, "CANARY_CONNECTION_ID");
  if (argument("--confirm-connection") !== connectionId) {
    throw new Error("RUNTIME_CREDENTIAL_PROVISION_CONNECTION_CONFIRMATION_REQUIRED");
  }
  const output = argument("--output");
  if (!output) throw new Error("RUNTIME_CREDENTIAL_PROVISION_OUTPUT_REQUIRED");
  const result = prepareCredentialProvisioning({ output });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
