import {
  createHash,
  createPrivateKey,
  sign,
} from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { validateEncryptedCredentialArtifact } from "./prepare-runtime-credential-provisioning.mjs";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RUN_PATTERN = /^[a-z0-9][a-z0-9-]{2,31}$/;
const KEY_VERSION_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const ACCESS_CLIENT_ID_PATTERN = /^[0-9a-f]{32}\.access$/i;
const MAX_INPUT_BYTES = 20 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_ACCESS_SECRET_BYTES = 4 * 1024;
const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "../..");

function required(environment, name) {
  const value = String(environment[name] ?? "").trim();
  if (!value) throw new Error(`REMOTE_CREDENTIAL_PROVISION_MISSING_${name}`);
  return value;
}

function optionalAccessSecret(environment, name) {
  const source = environment[name];
  if (source === undefined || source === null || source === "") return "";
  const value = String(source);
  if (
    value !== value.trim()
    || /[\r\n]/.test(value)
    || Buffer.byteLength(value, "utf8") > MAX_ACCESS_SECRET_BYTES
  ) throw new Error(`REMOTE_CREDENTIAL_PROVISION_INVALID_${name}`);
  return value;
}

export function runtimeCredentialProvisioningAccess(environment = process.env) {
  const jwt = optionalAccessSecret(environment, "CF_ACCESS_JWT");
  const clientId = optionalAccessSecret(environment, "CF_ACCESS_CLIENT_ID");
  const clientSecret = optionalAccessSecret(environment, "CF_ACCESS_CLIENT_SECRET");

  if (jwt) {
    return {
      mode: "jwt",
      headers: { "CF-Access-Jwt-Assertion": jwt },
      disclosureSentinels: [jwt, clientId, clientSecret].filter(Boolean),
    };
  }
  if (!clientId && !clientSecret) {
    throw new Error("REMOTE_CREDENTIAL_PROVISION_ACCESS_IDENTITY_REQUIRED");
  }
  if (!clientId || !clientSecret) {
    throw new Error("REMOTE_CREDENTIAL_PROVISION_ACCESS_SERVICE_TOKEN_INCOMPLETE");
  }
  if (!ACCESS_CLIENT_ID_PATTERN.test(clientId)) {
    throw new Error("REMOTE_CREDENTIAL_PROVISION_INVALID_CF_ACCESS_CLIENT_ID");
  }
  if (Buffer.byteLength(clientSecret, "utf8") < 32) {
    throw new Error("REMOTE_CREDENTIAL_PROVISION_INVALID_CF_ACCESS_CLIENT_SECRET");
  }
  return {
    mode: "service-token",
    headers: {
      "CF-Access-Client-Id": clientId,
      "CF-Access-Client-Secret": clientSecret,
    },
    disclosureSentinels: [clientId, clientSecret],
  };
}
function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`REMOTE_CREDENTIAL_PROVISION_INVALID_${label}`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`REMOTE_CREDENTIAL_PROVISION_INVALID_${label}_STRUCTURE`);
  }
}

function privateExternalFile(path, label, maxBytes) {
  const target = resolve(path);
  const relativeTarget = relative(repoRoot, target);
  if (relativeTarget === "" || (!relativeTarget.startsWith("..") && !relativeTarget.startsWith("/"))) {
    throw new Error(`REMOTE_CREDENTIAL_PROVISION_${label}_MUST_BE_OUTSIDE_REPOSITORY`);
  }
  const metadata = lstatSync(target);
  if (
    !metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.size === 0
    || metadata.size > maxBytes
    || (metadata.mode & 0o077) !== 0
  ) throw new Error(`REMOTE_CREDENTIAL_PROVISION_${label}_MUST_BE_PRIVATE_0600`);
  const realTarget = realpathSync(target);
  const realRelative = relative(repoRoot, realTarget);
  if (realRelative === "" || (!realRelative.startsWith("..") && !realRelative.startsWith("/"))) {
    throw new Error(`REMOTE_CREDENTIAL_PROVISION_${label}_MUST_BE_OUTSIDE_REPOSITORY`);
  }
  return realTarget;
}

function privateExternalOutput(path) {
  const target = resolve(path);
  const relativeTarget = relative(repoRoot, target);
  if (relativeTarget === "" || (!relativeTarget.startsWith("..") && !relativeTarget.startsWith("/"))) {
    throw new Error("REMOTE_CREDENTIAL_PROVISION_OUTPUT_MUST_BE_OUTSIDE_REPOSITORY");
  }
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const realParent = realpathSync(dirname(target));
  const realRelative = relative(repoRoot, realParent);
  if (realRelative === "" || (!realRelative.startsWith("..") && !realRelative.startsWith("/"))) {
    throw new Error("REMOTE_CREDENTIAL_PROVISION_OUTPUT_MUST_BE_OUTSIDE_REPOSITORY");
  }
  return target;
}

function parseInput(source) {
  let input;
  try {
    input = JSON.parse(source.toString("utf8"));
  } catch {
    throw new Error("REMOTE_CREDENTIAL_PROVISION_INVALID_INPUT_JSON");
  }
  exactKeys(input, ["version", "connectionId", "runId", "keyVersion", "credentials"], "INPUT");
  exactKeys(input.credentials, ["agora", "winerim"], "INPUT_CREDENTIALS");
  if (
    input.version !== 1
    || !UUID_PATTERN.test(input.connectionId)
    || !RUN_PATTERN.test(input.runId)
    || !KEY_VERSION_PATTERN.test(input.keyVersion)
  ) throw new Error("REMOTE_CREDENTIAL_PROVISION_INVALID_INPUT_SCOPE");
  for (const value of Object.values(input.credentials)) {
    if (
      typeof value !== "string"
      || Buffer.byteLength(value, "utf8") === 0
      || Buffer.byteLength(value, "utf8") > 8 * 1024
      || value !== value.trim()
      || /[\r\n]/.test(value)
    ) throw new Error("REMOTE_CREDENTIAL_PROVISION_INVALID_INPUT_CREDENTIAL");
  }
  return input;
}

function normalizedBaseUrl(value) {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:"
      || url.username
      || url.password
      || url.search
      || url.hash
      || (url.pathname !== "/" && url.pathname !== "")
    ) throw new Error("invalid");
    return url.origin;
  } catch {
    throw new Error("REMOTE_CREDENTIAL_PROVISION_INVALID_URL");
  }
}

async function jsonResponse(response, label) {
  if (!response.ok) throw new Error(`REMOTE_CREDENTIAL_PROVISION_${label}_HTTP_${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_RESPONSE_BYTES) {
    throw new Error(`REMOTE_CREDENTIAL_PROVISION_${label}_RESPONSE_REJECTED`);
  }
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`REMOTE_CREDENTIAL_PROVISION_${label}_RESPONSE_REJECTED`);
  }
}

function challengeMatches(challenge, input) {
  exactKeys(challenge, [
    "version",
    "challengeId",
    "challengeNonce",
    "expiresAt",
    "connectionId",
    "runId",
    "keyVersion",
  ], "CHALLENGE");
  if (
    challenge.version !== 1
    || challenge.connectionId !== input.connectionId
    || challenge.runId !== input.runId
    || challenge.keyVersion !== input.keyVersion
    || !/^[0-9a-f-]{36}$/i.test(challenge.challengeId)
    || !/^[A-Za-z0-9_-]{43}$/.test(challenge.challengeNonce)
    || Date.parse(challenge.expiresAt) <= Date.now()
  ) throw new Error("REMOTE_CREDENTIAL_PROVISION_CHALLENGE_SCOPE_MISMATCH");
  return challenge;
}

function loadOperatorKey(path) {
  const source = readFileSync(privateExternalFile(path, "OPERATOR_KEY", 16 * 1024));
  try {
    const key = createPrivateKey(source);
    if (key.asymmetricKeyType !== "ed25519") {
      throw new Error("REMOTE_CREDENTIAL_PROVISION_OPERATOR_KEY_MUST_BE_ED25519");
    }
    return key;
  } finally {
    source.fill(0);
  }
}

export function remoteCredentialProvisioningPlan() {
  return {
    status: "REMOTE_CREDENTIAL_PROVISION_PLAN_ONLY",
    remoteMutations: 0,
    plaintextWritten: false,
    vaultKeyReadLocally: false,
    requirements: [
      "RUNTIME_CREDENTIAL_PROVISIONER_URL",
      "CF_ACCESS_JWT or both CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET",
      "RUNTIME_CREDENTIAL_OPERATOR_KEY_ID",
      "private 0600 input JSON outside repository",
      "private 0600 Ed25519 PKCS8 key outside repository",
    ],
    output: "private encrypted artifact with nonceHex, ciphertextHex and attestationSha256 only",
  };
}

export async function provisionRuntimeCredentialsViaWorker({
  environment = process.env,
  inputPath,
  outputPath,
  operatorKeyPath,
  fetcher = fetch,
}) {
  const baseUrl = normalizedBaseUrl(required(environment, "RUNTIME_CREDENTIAL_PROVISIONER_URL"));
  const access = runtimeCredentialProvisioningAccess(environment);
  const operatorKeyId = required(environment, "RUNTIME_CREDENTIAL_OPERATOR_KEY_ID");
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(operatorKeyId)) {
    throw new Error("REMOTE_CREDENTIAL_PROVISION_INVALID_OPERATOR_KEY_ID");
  }
  const inputSource = readFileSync(privateExternalFile(inputPath, "INPUT", MAX_INPUT_BYTES));
  let input;
  try {
    input = parseInput(inputSource);
  } finally {
    inputSource.fill(0);
  }
  const commonHeaders = {
    "content-type": "application/json",
    ...access.headers,
    "x-operator-key-id": operatorKeyId,
  };
  const challengeBody = JSON.stringify({
    version: 1,
    connectionId: input.connectionId,
    runId: input.runId,
    keyVersion: input.keyVersion,
  });
  const challenge = challengeMatches(await jsonResponse(await fetcher(`${baseUrl}/v1/challenges`, {
    method: "POST",
    headers: commonHeaders,
    body: challengeBody,
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  }), "CHALLENGE"), input);

  const provisionSource = Buffer.from(JSON.stringify({
    version: 1,
    challengeId: challenge.challengeId,
    challengeNonce: challenge.challengeNonce,
    expiresAt: challenge.expiresAt,
    connectionId: input.connectionId,
    runId: input.runId,
    keyVersion: input.keyVersion,
    credentials: input.credentials,
  }));
  const operatorKey = loadOperatorKey(operatorKeyPath);
  const signature = sign(null, provisionSource, operatorKey).toString("base64url");
  let responseArtifact;
  try {
    responseArtifact = await jsonResponse(await fetcher(`${baseUrl}/v1/provision`, {
      method: "POST",
      headers: { ...commonHeaders, "x-operator-signature": signature },
      body: provisionSource,
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    }), "PROVISION");
  } finally {
    provisionSource.fill(0);
  }
  const serializedResponse = JSON.stringify(responseArtifact);
  if (
    serializedResponse.includes(input.credentials.agora)
    || serializedResponse.includes(input.credentials.winerim)
    || access.disclosureSentinels.some((secret) => serializedResponse.includes(secret))
  ) throw new Error("REMOTE_CREDENTIAL_PROVISION_RESPONSE_DISCLOSED_SECRET");
  const normalizedArtifact = {
    version: responseArtifact.version,
    schema: responseArtifact.schema,
    connectionId: responseArtifact.connectionId,
    runId: responseArtifact.runId,
    keyVersion: responseArtifact.keyVersion,
    credentials: responseArtifact.credentials,
  };
  const artifactSource = Buffer.from(`${JSON.stringify(normalizedArtifact, null, 2)}\n`);
  validateEncryptedCredentialArtifact({
    source: artifactSource,
    connectionId: input.connectionId,
    runId: input.runId,
    keyVersion: input.keyVersion,
  });
  const output = privateExternalOutput(outputPath);
  writeFileSync(output, artifactSource, { mode: 0o600, flag: "wx" });
  chmodSync(output, 0o600);
  return {
    status: "REMOTE_CREDENTIAL_PROVISION_ARTIFACT_READY",
    remoteMutations: 1,
    plaintextWritten: false,
    vaultKeyReadLocally: false,
    connectionId: input.connectionId,
    runId: input.runId,
    keyVersion: input.keyVersion,
    output,
    artifactSha256: createHash("sha256").update(artifactSource).digest("hex"),
    credentialAttestations: Object.fromEntries(
      normalizedArtifact.credentials.map(({ kind, attestationSha256 }) => [kind, attestationSha256]),
    ),
  };
}

function argument(name) {
  return process.argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
}

async function main() {
  if (!process.argv.includes("--provision")) {
    process.stdout.write(`${JSON.stringify(remoteCredentialProvisioningPlan(), null, 2)}\n`);
    return;
  }
  const inputPath = argument("--input");
  const outputPath = argument("--output");
  const operatorKeyPath = argument("--operator-key");
  if (!inputPath || !outputPath || !operatorKeyPath) {
    throw new Error("REMOTE_CREDENTIAL_PROVISION_PATHS_REQUIRED");
  }
  const result = await provisionRuntimeCredentialsViaWorker({ inputPath, outputPath, operatorKeyPath });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "REMOTE_CREDENTIAL_PROVISION_FAILED"}\n`);
    process.exitCode = 1;
  });
}
