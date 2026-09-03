import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const MAX_INPUT_BYTES = 4 * 1024 * 1024;
const REQUIRED_JOBS = Object.freeze(["sales.auto-sync", "sales.sync-intraday"]);
const COMPONENT_NAMES = Object.freeze(["runtime", "executor", "writerFence"]);
const COMPONENT_WORKER_NAMES = Object.freeze({
  runtime: "winerim-middleware-runtime-rescue-prod-fleet",
  executor: "winerim-middleware-runtime-executor-rescue-prod-fleet",
  writerFence: "winerim-middleware-runtime-writer-fence-rescue-prod-fleet",
});
const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "../..");

function sha256(source) {
  return createHash("sha256").update(source).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function fail(code) {
  throw new Error(`RUNTIME_SALES_DEPLOYMENT_MANIFEST_${code}`);
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`INVALID_${label}`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`INVALID_${label}_STRUCTURE`);
  }
}

function outsideRepository(path) {
  const candidate = relative(repoRoot, path);
  return candidate !== "" && (candidate.startsWith("..") || candidate.startsWith("/"));
}

function readPrivateRegularFile(path, label) {
  if (!isAbsolute(path)) fail(`${label}_PATH_MUST_BE_ABSOLUTE`);
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) fail(`${label}_MUST_BE_REGULAR_FILE`);
  if ((metadata.mode & 0o077) !== 0) fail(`${label}_MUST_BE_PRIVATE_0600`);
  if (metadata.size <= 0 || metadata.size > MAX_INPUT_BYTES) fail(`${label}_INVALID_SIZE`);
  return readFileSync(path);
}

function parseJson(source, label) {
  try {
    return JSON.parse(source.toString("utf8"));
  } catch {
    fail(`INVALID_${label}_JSON`);
  }
}

function deploymentVersion(readback, label) {
  if (
    !readback
    || typeof readback !== "object"
    || Array.isArray(readback)
    || !UUID_PATTERN.test(readback.id ?? "")
    || readback.source !== "wrangler"
    || readback.strategy !== "percentage"
    || !Number.isFinite(Date.parse(readback.created_on ?? ""))
    || !Array.isArray(readback.versions)
    || readback.versions.length !== 1
  ) {
    fail(`INVALID_${label}_DEPLOYMENT_STATUS`);
  }
  const active = readback.versions[0];
  if (
    !active
    || typeof active !== "object"
    || Array.isArray(active)
    || !UUID_PATTERN.test(active.version_id ?? "")
    || active.percentage !== 100
  ) {
    fail(`${label}_ACTIVE_VERSION_NOT_EXACTLY_100_PERCENT`);
  }
  return active.version_id.toLowerCase();
}

function workerNameFromToml(source, label) {
  const text = source.toString("utf8");
  if (text.includes("\0")) fail(`INVALID_${label}_TOML`);
  const topLevel = text.split(/^\s*\[/mu, 1)[0];
  const matches = [...topLevel.matchAll(/^\s*name\s*=\s*"([^"]+)"[ \t]*(?:#.*)?$/gmu)];
  if (matches.length !== 1) fail(`INVALID_${label}_WORKER_NAME_ASSIGNMENT`);
  return matches[0][1];
}

function deploymentIdFor(components) {
  const digest = sha256(canonicalJson({ jobs: REQUIRED_JOBS, components }));
  return `runtime-sales-${digest.slice(0, 24)}`;
}

export function validateRuntimeSalesDeploymentManifest(manifest) {
  exactKeys(
    manifest,
    ["version", "kind", "deploymentId", "jobs", "components"],
    "MANIFEST",
  );
  if (
    manifest.version !== 1
    || manifest.kind !== "runtime-sales-deployment"
    || !IDENTIFIER_PATTERN.test(manifest.deploymentId ?? "")
    || canonicalJson(manifest.jobs) !== canonicalJson(REQUIRED_JOBS)
  ) {
    fail("INVALID_MANIFEST_IDENTITY_OR_JOBS");
  }
  exactKeys(manifest.components, COMPONENT_NAMES, "COMPONENTS");
  const components = {};
  for (const componentName of COMPONENT_NAMES) {
    const component = manifest.components[componentName];
    exactKeys(component, ["workerName", "versionId", "configSha256"], `COMPONENT_${componentName}`);
    if (
      component.workerName !== COMPONENT_WORKER_NAMES[componentName]
      || !UUID_PATTERN.test(component.versionId ?? "")
      || !SHA256_PATTERN.test(component.configSha256 ?? "")
    ) {
      fail(`INVALID_COMPONENT_${componentName}`);
    }
    components[componentName] = {
      workerName: component.workerName,
      versionId: component.versionId.toLowerCase(),
      configSha256: component.configSha256,
    };
  }
  if (manifest.deploymentId !== deploymentIdFor(components)) {
    fail("DEPLOYMENT_ID_NOT_DERIVED_FROM_READBACKS");
  }
  return Object.freeze({
    version: 1,
    kind: "runtime-sales-deployment",
    deploymentId: manifest.deploymentId,
    jobs: Object.freeze([...REQUIRED_JOBS]),
    components: Object.freeze(components),
  });
}

export function buildRuntimeSalesDeploymentManifest({
  runtimeStatusSource,
  runtimeTomlSource,
  executorStatusSource,
  executorTomlSource,
  writerFenceStatusSource,
  writerFenceTomlSource,
}) {
  const sources = {
    runtime: { status: runtimeStatusSource, toml: runtimeTomlSource },
    executor: { status: executorStatusSource, toml: executorTomlSource },
    writerFence: { status: writerFenceStatusSource, toml: writerFenceTomlSource },
  };
  const components = {};
  for (const componentName of COMPONENT_NAMES) {
    const { status, toml } = sources[componentName];
    if (!Buffer.isBuffer(status) || !Buffer.isBuffer(toml) || status.length === 0 || toml.length === 0) {
      fail(`INVALID_${componentName}_SOURCES`);
    }
    const workerName = workerNameFromToml(toml, componentName);
    if (workerName !== COMPONENT_WORKER_NAMES[componentName]) {
      fail(`${componentName}_WORKER_NAME_MISMATCH`);
    }
    components[componentName] = {
      workerName,
      versionId: deploymentVersion(parseJson(status, `${componentName}_STATUS`), componentName),
      configSha256: sha256(toml),
    };
  }
  return validateRuntimeSalesDeploymentManifest({
    version: 1,
    kind: "runtime-sales-deployment",
    deploymentId: deploymentIdFor(components),
    jobs: [...REQUIRED_JOBS],
    components,
  });
}

function writePrivateAtomic(path, source) {
  if (!isAbsolute(path)) fail("OUTPUT_PATH_MUST_BE_ABSOLUTE");
  const destination = resolve(path);
  if (!outsideRepository(destination)) fail("OUTPUT_MUST_BE_OUTSIDE_REPOSITORY");
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  const realParent = realpathSync(dirname(destination));
  if (!outsideRepository(realParent)) fail("OUTPUT_MUST_BE_OUTSIDE_REPOSITORY");
  if (existsSync(destination)) {
    const metadata = lstatSync(destination);
    if (metadata.isSymbolicLink() || !metadata.isFile()) fail("OUTPUT_MUST_BE_REGULAR_FILE");
  }
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temporary, source, { mode: 0o600, flag: "wx" });
    chmodSync(temporary, 0o600);
    renameSync(temporary, destination);
    chmodSync(destination, 0o600);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  return destination;
}

export function prepareRuntimeSalesDeploymentManifest({
  runtimeStatusPath,
  runtimeTomlPath,
  executorStatusPath,
  executorTomlPath,
  writerFenceStatusPath,
  writerFenceTomlPath,
  outputPath,
}) {
  const manifest = buildRuntimeSalesDeploymentManifest({
    runtimeStatusSource: readPrivateRegularFile(runtimeStatusPath, "RUNTIME_STATUS"),
    runtimeTomlSource: readPrivateRegularFile(runtimeTomlPath, "RUNTIME_TOML"),
    executorStatusSource: readPrivateRegularFile(executorStatusPath, "EXECUTOR_STATUS"),
    executorTomlSource: readPrivateRegularFile(executorTomlPath, "EXECUTOR_TOML"),
    writerFenceStatusSource: readPrivateRegularFile(writerFenceStatusPath, "WRITER_FENCE_STATUS"),
    writerFenceTomlSource: readPrivateRegularFile(writerFenceTomlPath, "WRITER_FENCE_TOML"),
  });
  const source = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const manifestPath = writePrivateAtomic(outputPath, source);
  return Object.freeze({
    status: "RUNTIME_SALES_DEPLOYMENT_MANIFEST_READY",
    manifestPath,
    manifestSha256: sha256(source),
    deploymentId: manifest.deploymentId,
    remoteMutations: 0,
  });
}

function parseCli(argv) {
  const values = {};
  const accepted = new Map([
    ["--runtime-status=", "runtimeStatusPath"],
    ["--runtime-toml=", "runtimeTomlPath"],
    ["--executor-status=", "executorStatusPath"],
    ["--executor-toml=", "executorTomlPath"],
    ["--writer-fence-status=", "writerFenceStatusPath"],
    ["--writer-fence-toml=", "writerFenceTomlPath"],
    ["--output=", "outputPath"],
  ]);
  for (const argument of argv) {
    const entry = [...accepted].find(([prefix]) => argument.startsWith(prefix));
    if (!entry) fail("CLI_ARGUMENT_REJECTED");
    const [prefix, key] = entry;
    if (values[key]) fail("CLI_ARGUMENT_DUPLICATED");
    const value = argument.slice(prefix.length);
    if (!value) fail("CLI_ARGUMENT_EMPTY");
    values[key] = resolve(value);
  }
  if ([...accepted.values()].some((key) => !values[key])) fail("CLI_ARGUMENT_MISSING");
  return values;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === scriptPath) {
  try {
    const result = prepareRuntimeSalesDeploymentManifest(parseCli(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
