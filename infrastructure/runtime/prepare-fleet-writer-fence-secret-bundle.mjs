import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RUN_PATTERN = /^[a-z0-9][a-z0-9-]{2,31}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function outsideRepository(path) {
  const rel = relative(repoRoot, path);
  return rel !== "" && (rel.startsWith("..") || rel.startsWith("/"));
}

function parseJsonFile(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`${label}_INVALID_JSON`);
  }
}

function parseBaseBundle(path) {
  if (!path) return { version: 1, entries: [] };
  const value = parseJsonFile(path, "FLEET_FENCE_BASE_BUNDLE");
  if (value?.version !== 1 || !Array.isArray(value.entries)) {
    throw new Error("FLEET_FENCE_BASE_BUNDLE_INVALID");
  }
  return value;
}

function validateExistingEntry(entry) {
  return entry
    && typeof entry === "object"
    && UUID_PATTERN.test(String(entry.connectionId ?? ""))
    && RUN_PATTERN.test(String(entry.runId ?? ""))
    && SHA256_PATTERN.test(String(entry.generationSha256 ?? "").toLowerCase())
    && typeof entry.rawGrant === "string"
    && entry.rawGrant.length > 0
    && typeof entry.proof === "string"
    && entry.proof.length >= 32;
}

export function prepareFleetWriterFenceSecretBundle(input) {
  const connectionId = String(input.connectionId ?? "").trim().toLowerCase();
  const runId = String(input.runId ?? "").trim();
  const generationSha256 = String(input.generationSha256 ?? "").trim().toLowerCase();
  if (!UUID_PATTERN.test(connectionId)) throw new Error("FLEET_FENCE_CONNECTION_ID_INVALID");
  if (!RUN_PATTERN.test(runId)) throw new Error("FLEET_FENCE_RUN_ID_INVALID");
  if (!SHA256_PATTERN.test(generationSha256)) throw new Error("FLEET_FENCE_GENERATION_INVALID");
  if (input.confirmConnection !== connectionId) throw new Error("FLEET_FENCE_CONFIRMATION_MISMATCH");

  const rawGrant = readFileSync(input.grantPath, "utf8");
  const proof = readFileSync(input.proofPath, "utf8").trim();
  const grant = JSON.parse(rawGrant);
  if (
    grant?.version !== 3
    || String(grant.connectionId ?? "").toLowerCase() !== connectionId
    || grant.runId !== runId
    || grant.credentialBundle?.generationSha256 !== generationSha256
  ) throw new Error("FLEET_FENCE_GRANT_SCOPE_MISMATCH");
  if (proof.length < 32) throw new Error("FLEET_FENCE_PROOF_INVALID");

  const grantSha256 = sha256(rawGrant);
  const proofSha256 = sha256(proof);
  if (input.expectedGrantSha256 && input.expectedGrantSha256 !== grantSha256) {
    throw new Error("FLEET_FENCE_GRANT_HASH_MISMATCH");
  }
  if (input.expectedProofSha256 && input.expectedProofSha256 !== proofSha256) {
    throw new Error("FLEET_FENCE_PROOF_HASH_MISMATCH");
  }

  const base = parseBaseBundle(input.baseBundlePath);
  if (base.entries.some((entry) => !validateExistingEntry(entry))) {
    throw new Error("FLEET_FENCE_BASE_BUNDLE_ENTRY_INVALID");
  }
  const previousForConnection = base.entries.filter((entry) => entry.connectionId === connectionId);
  if (previousForConnection.length > 0 && input.replaceConnection !== true) {
    throw new Error("FLEET_FENCE_CONNECTION_ALREADY_PRESENT");
  }
  const entries = base.entries
    .filter((entry) => entry.connectionId !== connectionId)
    .concat([{ connectionId, runId, generationSha256, rawGrant, proof }])
    .sort((left, right) => `${left.connectionId}:${left.runId}`.localeCompare(`${right.connectionId}:${right.runId}`));
  const identities = entries.map((entry) => `${entry.connectionId}:${entry.runId}:${entry.generationSha256}`);
  if (new Set(identities).size !== identities.length) throw new Error("FLEET_FENCE_BUNDLE_DUPLICATE");

  const source = JSON.stringify({ version: 1, entries });
  return {
    source,
    sourceSha256: sha256(source),
    manifest: {
      version: 1,
      kind: "RUNTIME_FLEET_WRITER_FENCE_SECRET_BUNDLE",
      entryCount: entries.length,
      sourceSha256: sha256(source),
      entries: entries.map((entry) => ({
        connectionId: entry.connectionId,
        runId: entry.runId,
        generationSha256: entry.generationSha256,
        grantSha256: sha256(entry.rawGrant),
        proofSha256: sha256(entry.proof),
      })),
      replacedRuns: previousForConnection.map((entry) => entry.runId).sort(),
    },
  };
}

function parseArgs(argv) {
  return Object.fromEntries(argv.map((arg) => {
    const match = /^--([^=]+)=(.*)$/.exec(arg);
    if (!match) throw new Error(`FLEET_FENCE_ARGUMENT_INVALID:${arg}`);
    return [match[1], match[2]];
  }));
}

export function writeFleetWriterFenceSecretBundle(input) {
  const output = resolve(input.output);
  if (!outsideRepository(output)) throw new Error("FLEET_FENCE_OUTPUT_MUST_BE_OUTSIDE_REPOSITORY");
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  if (!outsideRepository(realpathSync(dirname(output)))) {
    throw new Error("FLEET_FENCE_OUTPUT_MUST_BE_OUTSIDE_REPOSITORY");
  }
  const prepared = prepareFleetWriterFenceSecretBundle(input);
  const manifestPath = `${output}.manifest.json`;
  writeFileSync(output, prepared.source, { encoding: "utf8", mode: 0o600, flag: "wx" });
  writeFileSync(manifestPath, `${JSON.stringify(prepared.manifest, null, 2)}\n`, {
    encoding: "utf8", mode: 0o600, flag: "wx",
  });
  chmodSync(output, 0o600);
  chmodSync(manifestPath, 0o600);
  return { output, manifestPath, ...prepared.manifest };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  const result = writeFleetWriterFenceSecretBundle({
    connectionId: args["connection-id"],
    confirmConnection: args["confirm-connection"],
    runId: args["run-id"],
    generationSha256: args["generation-sha256"],
    grantPath: args.grant,
    proofPath: args.proof,
    output: args.output,
    ...(args["base-bundle"] ? { baseBundlePath: args["base-bundle"] } : {}),
    replaceConnection: args["replace-connection"] === "true",
    ...(args["expected-grant-sha256"] ? { expectedGrantSha256: args["expected-grant-sha256"] } : {}),
    ...(args["expected-proof-sha256"] ? { expectedProofSha256: args["expected-proof-sha256"] } : {}),
  });
  process.stdout.write(`${JSON.stringify({
    status: "RUNTIME_FLEET_WRITER_FENCE_SECRET_BUNDLE_READY",
    output: result.output,
    manifestPath: result.manifestPath,
    entryCount: result.entryCount,
    sourceSha256: result.sourceSha256,
  }, null, 2)}\n`);
}
