import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u;
const CLOUDFLARE_RESOURCE_ID_PATTERN = /^[a-f0-9]{32}$/u;
const CF_RAY_PATTERN = /^[A-Za-z0-9-]{8,128}$/u;
const MAX_TOPOLOGY_AGE_MS = 15 * 60 * 1_000;
const MAX_CAPTURE_DURATION_MS = 2 * 60 * 1_000;
const CLOUDFLARE_API_BASE_URL = "https://api.cloudflare.com/client/v4";
const MAX_PRIVATE_KEY_BYTES = 64 * 1024;
const DEFAULT_FLEET_FULL_LANES = Object.freeze({
  catalog: Object.freeze({
    queue: "winerim-rescue-prod-catalog",
    deadLetterQueue: "winerim-rescue-prod-catalog-dead-letter",
  }),
  salesStock: Object.freeze({
    queue: "winerim-rescue-prod-sales",
    deadLetterQueue: "winerim-rescue-prod-sales-dead-letter",
  }),
  outbound: Object.freeze({
    queue: "winerim-rescue-prod-outbound",
    deadLetterQueue: "winerim-rescue-prod-outbound-dead-letter",
  }),
});

export class FleetFullTopologyEvidenceError extends Error {
  constructor(code) {
    super(code);
    this.name = "FleetFullTopologyEvidenceError";
    this.code = code;
  }
}

function fail(code) {
  throw new FleetFullTopologyEvidenceError(code);
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

export function canonicalFleetFullTopologyJson(value) {
  return canonicalJson(value);
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label}_REQUIRED`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label}_STRUCTURE_DRIFT`);
  }
}

function timestamp(value, label) {
  const milliseconds = Date.parse(String(value ?? ""));
  if (!Number.isFinite(milliseconds)) fail(`${label}_INVALID`);
  return Object.freeze({ milliseconds, iso: new Date(milliseconds).toISOString() });
}

function deploymentId(value, label) {
  if (!UUID_PATTERN.test(String(value ?? ""))) fail(`${label}_INVALID`);
  return String(value).toLowerCase();
}

export function fleetFullTopologyInventorySha256(evidenceWithoutSha) {
  return createHash("sha256").update(canonicalJson(evidenceWithoutSha), "utf8").digest("hex");
}

function sha256(source) {
  return createHash("sha256").update(source).digest("hex");
}

function trustedPublicKeySha256(explicitValue) {
  const value = String(
    explicitValue ?? process.env.FLEET_FULL_TOPOLOGY_TRUSTED_PUBLIC_KEY_SHA256 ?? "",
  ).trim().toLowerCase();
  if (!SHA256_PATTERN.test(value)) fail("TOPOLOGY_TRUSTED_PUBLIC_KEY_SHA256_REQUIRED");
  return value;
}

function validateDirectCapture({ capture, topology, accountId, lanes }) {
  exactKeys(
    capture,
    ["provider", "mode", "apiBaseUrl", "accountId", "startedAt", "completedAt", "requests"],
    "TOPOLOGY_CAPTURE",
  );
  if (
    capture.provider !== "cloudflare"
    || capture.mode !== "api-v4-direct"
    || capture.apiBaseUrl !== CLOUDFLARE_API_BASE_URL
    || capture.accountId !== accountId
    || !Array.isArray(capture.requests)
  ) fail("TOPOLOGY_CAPTURE_PROVENANCE_INVALID");

  const startedAt = timestamp(capture.startedAt, "TOPOLOGY_CAPTURE_STARTED_AT");
  const completedAt = timestamp(capture.completedAt, "TOPOLOGY_CAPTURE_COMPLETED_AT");
  if (
    completedAt.milliseconds < startedAt.milliseconds
    || completedAt.milliseconds - startedAt.milliseconds > MAX_CAPTURE_DURATION_MS
    || completedAt.iso !== topology.observedAt
  ) fail("TOPOLOGY_CAPTURE_WINDOW_INVALID");

  const requiredRequests = new Map([
    ["queue-list", CLOUDFLARE_API_BASE_URL + "/accounts/" + accountId + "/queues"],
    [
      "worker-deployments:executor",
      CLOUDFLARE_API_BASE_URL + "/accounts/" + accountId
        + "/workers/scripts/" + encodeURIComponent(topology.executorWorkerName) + "/deployments",
    ],
    ...Object.entries(lanes).map(([key]) => [
      "queue-consumers:" + key,
      CLOUDFLARE_API_BASE_URL + "/accounts/" + accountId + "/queues/"
        + topology.queues[key].queueId + "/consumers",
    ]),
  ]);
  if (capture.requests.length !== requiredRequests.size) {
    fail("TOPOLOGY_CAPTURE_REQUEST_SET_INCOMPLETE");
  }
  const seen = new Set();
  for (const request of capture.requests) {
    exactKeys(
      request,
      ["kind", "method", "url", "httpStatus", "cfRay", "responseDate", "responseSha256"],
      "TOPOLOGY_CAPTURE_REQUEST",
    );
    const expectedUrl = requiredRequests.get(request.kind);
    const responseDate = timestamp(request.responseDate, "TOPOLOGY_CAPTURE_RESPONSE_DATE");
    if (
      !expectedUrl
      || seen.has(request.kind)
      || request.method !== "GET"
      || request.url !== expectedUrl
      || request.httpStatus !== 200
      || !CF_RAY_PATTERN.test(String(request.cfRay ?? ""))
      || !SHA256_PATTERN.test(String(request.responseSha256 ?? ""))
      || responseDate.milliseconds < startedAt.milliseconds - 60_000
      || responseDate.milliseconds > completedAt.milliseconds + 60_000
    ) fail("TOPOLOGY_CAPTURE_REQUEST_INVALID");
    seen.add(request.kind);
  }
  if (seen.size !== requiredRequests.size) fail("TOPOLOGY_CAPTURE_REQUEST_SET_INCOMPLETE");
  return Object.freeze({
    provider: "cloudflare",
    mode: "api-v4-direct",
    apiBaseUrl: CLOUDFLARE_API_BASE_URL,
    accountId,
    startedAt: startedAt.iso,
    completedAt: completedAt.iso,
    requests: Object.freeze(capture.requests.map((request) => Object.freeze({ ...request }))),
  });
}

function signDerivedFleetFullTopologyAttestation({
  payload,
  privateKeySource,
  publicKeySource,
  keyId,
}) {
  if (!IDENTIFIER_PATTERN.test(String(keyId ?? ""))) {
    fail("TOPOLOGY_ATTESTATION_KEY_ID_INVALID");
  }
  let privateKey;
  let publicKey;
  try {
    privateKey = createPrivateKey(privateKeySource);
    publicKey = createPublicKey(publicKeySource);
  } catch {
    fail("TOPOLOGY_ATTESTATION_KEY_INVALID");
  }
  if (privateKey.asymmetricKeyType !== "ed25519" || publicKey.asymmetricKeyType !== "ed25519") {
    fail("TOPOLOGY_ATTESTATION_KEY_MUST_BE_ED25519");
  }
  const payloadSource = Buffer.from(canonicalJson(payload), "utf8");
  const signature = sign(null, payloadSource, privateKey);
  if (!verify(null, payloadSource, publicKey, signature)) {
    fail("TOPOLOGY_ATTESTATION_KEYPAIR_MISMATCH");
  }
  const publicKeyPem = Buffer.from(publicKeySource).toString("utf8");
  return Object.freeze({
    version: 1,
    algorithm: "Ed25519",
    keyId,
    publicKeyPem,
    payload,
    hashes: Object.freeze({
      publicKeySha256: sha256(Buffer.from(publicKeyPem, "utf8")),
      payloadSha256: sha256(payloadSource),
      signatureSha256: sha256(signature),
    }),
    signatureBase64: signature.toString("base64"),
  });
}

function readPrivateSigningKey(path) {
  if (!isAbsolute(path)) fail("TOPOLOGY_PRIVATE_KEY_PATH_MUST_BE_ABSOLUTE");
  const metadata = lstatSync(path);
  if (
    metadata.isSymbolicLink()
    || !metadata.isFile()
    || (metadata.mode & 0o077) !== 0
    || metadata.size <= 0
    || metadata.size > MAX_PRIVATE_KEY_BYTES
  ) fail("TOPOLOGY_PRIVATE_KEY_MUST_BE_PRIVATE_0600");
  return readFileSync(path);
}

function completeResultList(envelope, label, selectResult) {
  if (
    envelope?.success !== true
    || !Array.isArray(envelope?.errors)
    || envelope.errors.length !== 0
    || !envelope?.result_info
  ) fail(label + "_CLOUDFLARE_RESPONSE_INCOMPLETE");
  const list = selectResult(envelope.result);
  const info = envelope.result_info;
  if (
    !Array.isArray(list)
    || info.page !== 1
    || !Number.isSafeInteger(info.count)
    || !Number.isSafeInteger(info.total_count)
    || !Number.isSafeInteger(info.per_page)
    || info.count !== list.length
    || info.total_count !== list.length
    || info.per_page < info.total_count
  ) fail(label + "_CLOUDFLARE_RESULT_INFO_INCOMPLETE");
  return list;
}

async function cloudflareGet({ fetchImpl, apiToken, url, kind }) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: {
        authorization: "Bearer " + apiToken,
        accept: "application/json",
      },
      redirect: "error",
    });
  } catch {
    fail("TOPOLOGY_CLOUDFLARE_FETCH_FAILED");
  }
  const body = await response.text();
  const request = {
    kind,
    method: "GET",
    url,
    httpStatus: response.status,
    cfRay: response.headers.get("cf-ray") ?? "",
    responseDate: response.headers.get("date") ?? "",
    responseSha256: sha256(Buffer.from(body, "utf8")),
  };
  let envelope;
  try {
    envelope = JSON.parse(body);
  } catch {
    fail("TOPOLOGY_CLOUDFLARE_RESPONSE_INVALID_JSON");
  }
  if (
    response.status !== 200
    || !CF_RAY_PATTERN.test(request.cfRay)
    || !Number.isFinite(Date.parse(request.responseDate))
  ) fail("TOPOLOGY_CLOUDFLARE_RESPONSE_UNTRUSTED");
  return Object.freeze({ request: Object.freeze(request), envelope });
}

function activeExecutorVersion(deployments, executorDeploymentId, executorVersionId) {
  if (deployments.length < 1) fail("TOPOLOGY_EXECUTOR_DEPLOYMENT_MISSING");
  const active = deployments[0];
  if (
    deploymentId(active?.id, "TOPOLOGY_EXECUTOR_DEPLOYMENT_ID") !== executorDeploymentId
    || !Array.isArray(active?.versions)
    || active.versions.length !== 1
    || active.versions[0]?.percentage !== 100
    || deploymentId(active.versions[0]?.version_id, "TOPOLOGY_EXECUTOR_VERSION_ID")
      !== executorVersionId
  ) fail("TOPOLOGY_EXECUTOR_DEPLOYMENT_DRIFT");
  return Object.freeze({ deploymentId: executorDeploymentId, versionId: executorVersionId });
}

export async function collectFleetFullCloudflareTopologyAttestation(options) {
  const allowedKeys = [
    "accountId",
    "executorWorkerName",
    "executorDeploymentId",
    "executorVersionId",
    "apiToken",
    "privateKeyPath",
    "outputPath",
    "keyId",
    ...(Object.prototype.hasOwnProperty.call(options ?? {}, "lanes") ? ["lanes"] : []),
    ...(Object.prototype.hasOwnProperty.call(options ?? {}, "fetchImpl") ? ["fetchImpl"] : []),
    ...(Object.prototype.hasOwnProperty.call(options ?? {}, "now") ? ["now"] : []),
  ];
  exactKeys(options, allowedKeys, "TOPOLOGY_COLLECTOR_INPUT");
  const {
    accountId,
    executorWorkerName,
    executorDeploymentId,
    executorVersionId,
    lanes = DEFAULT_FLEET_FULL_LANES,
    apiToken,
    privateKeyPath,
    outputPath,
    keyId,
    fetchImpl = globalThis.fetch,
    now = () => new Date(),
  } = options;
  if (
    !CLOUDFLARE_RESOURCE_ID_PATTERN.test(String(accountId ?? ""))
    || !IDENTIFIER_PATTERN.test(String(executorWorkerName ?? ""))
    || !UUID_PATTERN.test(String(executorDeploymentId ?? ""))
    || !UUID_PATTERN.test(String(executorVersionId ?? ""))
    || !IDENTIFIER_PATTERN.test(String(keyId ?? ""))
    || typeof fetchImpl !== "function"
    || String(apiToken ?? "").trim().length < 20
    || !isAbsolute(String(outputPath ?? ""))
  ) fail("TOPOLOGY_COLLECTOR_INPUT_INVALID");
  exactKeys(lanes, ["catalog", "salesStock", "outbound"], "TOPOLOGY_COLLECTOR_LANES");
  const privateKeySource = readPrivateSigningKey(privateKeyPath);
  let privateKey;
  let publicKey;
  try {
    privateKey = createPrivateKey(privateKeySource);
    publicKey = createPublicKey(privateKey);
  } catch {
    fail("TOPOLOGY_ATTESTATION_KEY_INVALID");
  }
  if (privateKey.asymmetricKeyType !== "ed25519" || publicKey.asymmetricKeyType !== "ed25519") {
    fail("TOPOLOGY_ATTESTATION_KEY_MUST_BE_ED25519");
  }
  const publicKeySource = publicKey.export({ type: "spki", format: "pem" });
  const startedAt = timestamp(now().toISOString(), "TOPOLOGY_CAPTURE_STARTED_AT");
  const accountBase = CLOUDFLARE_API_BASE_URL + "/accounts/" + accountId;
  const queueListResponse = await cloudflareGet({
    fetchImpl,
    apiToken,
    url: accountBase + "/queues",
    kind: "queue-list",
  });
  const queueList = completeResultList(
    queueListResponse.envelope,
    "TOPOLOGY_QUEUE_LIST",
    (result) => result,
  );
  const requests = [queueListResponse.request];
  const queues = {};
  for (const [laneKey, lane] of Object.entries(lanes)) {
    exactKeys(lane, ["queue", "deadLetterQueue"], "TOPOLOGY_COLLECTOR_LANE");
    const matches = queueList.filter((queue) => queue?.queue_name === lane.queue);
    if (
      matches.length !== 1
      || !CLOUDFLARE_RESOURCE_ID_PATTERN.test(String(matches[0]?.queue_id ?? ""))
    ) fail("TOPOLOGY_" + laneKey.toUpperCase() + "_QUEUE_INVENTORY_MISMATCH");
    const queueId = String(matches[0].queue_id);
    const consumerResponse = await cloudflareGet({
      fetchImpl,
      apiToken,
      url: accountBase + "/queues/" + queueId + "/consumers",
      kind: "queue-consumers:" + laneKey,
    });
    requests.push(consumerResponse.request);
    const consumers = completeResultList(
      consumerResponse.envelope,
      "TOPOLOGY_" + laneKey.toUpperCase() + "_CONSUMERS",
      (result) => result,
    );
    if (consumers.length !== 1) {
      fail("TOPOLOGY_" + laneKey.toUpperCase() + "_CONSUMER_EXCLUSIVITY_VIOLATION");
    }
    const consumer = consumers[0];
    if (
      consumer?.type !== "worker"
      || consumer?.script_name !== executorWorkerName
      || consumer?.queue_name !== lane.queue
      || consumer?.dead_letter_queue !== lane.deadLetterQueue
      || consumer?.settings?.batch_size !== 1
      || consumer?.settings?.max_wait_time_ms !== 5_000
      || consumer?.settings?.max_retries !== 3
      || consumer?.settings?.max_concurrency !== 1
    ) fail("TOPOLOGY_" + laneKey.toUpperCase() + "_CONSUMER_CONTRACT_DRIFT");
    queues[laneKey] = {
      queueId,
      queueName: lane.queue,
      consumers: [{
        workerName: consumer.script_name,
        deploymentId: executorDeploymentId,
        versionId: executorVersionId,
        maxBatchSize: consumer.settings.batch_size,
        maxBatchTimeout: consumer.settings.max_wait_time_ms / 1_000,
        maxRetries: consumer.settings.max_retries,
        maxConcurrency: consumer.settings.max_concurrency,
        deadLetterQueue: consumer.dead_letter_queue,
      }],
    };
  }
  const deploymentsResponse = await cloudflareGet({
    fetchImpl,
    apiToken,
    url: accountBase + "/workers/scripts/" + encodeURIComponent(executorWorkerName) + "/deployments",
    kind: "worker-deployments:executor",
  });
  requests.push(deploymentsResponse.request);
  const deployments = completeResultList(
    deploymentsResponse.envelope,
    "TOPOLOGY_EXECUTOR_DEPLOYMENTS",
    (result) => result?.deployments,
  );
  activeExecutorVersion(deployments, executorDeploymentId, executorVersionId);
  const completedAt = timestamp(now().toISOString(), "TOPOLOGY_CAPTURE_COMPLETED_AT");
  if (
    completedAt.milliseconds < startedAt.milliseconds
    || completedAt.milliseconds - startedAt.milliseconds > MAX_CAPTURE_DURATION_MS
  ) fail("TOPOLOGY_CAPTURE_WINDOW_INVALID");
  const topologyWithoutHash = {
    version: 1,
    observedAt: completedAt.iso,
    accountId,
    inventoryCompleteForQueues: true,
    executorWorkerName,
    executorDeploymentId: executorDeploymentId.toLowerCase(),
    executorVersionId: executorVersionId.toLowerCase(),
    queues,
  };
  const payload = {
    version: 1,
    evidenceType: "cloudflare-live-queue-topology",
    capture: {
      provider: "cloudflare",
      mode: "api-v4-direct",
      apiBaseUrl: CLOUDFLARE_API_BASE_URL,
      accountId,
      startedAt: startedAt.iso,
      completedAt: completedAt.iso,
      requests,
    },
    topology: {
      ...topologyWithoutHash,
      inventorySha256: fleetFullTopologyInventorySha256(topologyWithoutHash),
    },
  };
  const attestation = signDerivedFleetFullTopologyAttestation({
    payload,
    privateKeySource,
    publicKeySource,
    keyId,
  });
  mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
  const source = JSON.stringify(attestation, null, 2) + "\n";
  writeFileSync(outputPath, source, { encoding: "utf8", mode: 0o600, flag: "wx" });
  chmodSync(outputPath, 0o600);
  return Object.freeze({
    status: "FLEET_FULL_CLOUDFLARE_TOPOLOGY_ATTESTATION_READY",
    outputPath,
    outputSha256: sha256(Buffer.from(source, "utf8")),
    publicKeySha256: attestation.hashes.publicKeySha256,
    payloadSha256: attestation.hashes.payloadSha256,
    attestation,
  });
}

function validateTopologyAttestation(evidence, explicitTrustedPublicKeySha256) {
  exactKeys(
    evidence,
    ["version", "algorithm", "keyId", "publicKeyPem", "payload", "hashes", "signatureBase64"],
    "TOPOLOGY_ATTESTATION",
  );
  exactKeys(
    evidence.hashes,
    ["publicKeySha256", "payloadSha256", "signatureSha256"],
    "TOPOLOGY_ATTESTATION_HASHES",
  );
  const trustedSha256 = trustedPublicKeySha256(explicitTrustedPublicKeySha256);
  const publicKeySource = Buffer.from(String(evidence.publicKeyPem ?? ""), "utf8");
  const payloadSource = Buffer.from(canonicalJson(evidence.payload), "utf8");
  let signature;
  let publicKey;
  try {
    signature = Buffer.from(String(evidence.signatureBase64 ?? ""), "base64");
    publicKey = createPublicKey(publicKeySource);
  } catch {
    fail("TOPOLOGY_ATTESTATION_SIGNATURE_INVALID");
  }
  if (
    evidence.version !== 1
    || evidence.algorithm !== "Ed25519"
    || !IDENTIFIER_PATTERN.test(String(evidence.keyId ?? ""))
    || publicKey.asymmetricKeyType !== "ed25519"
    || evidence.hashes.publicKeySha256 !== trustedSha256
    || evidence.hashes.publicKeySha256 !== sha256(publicKeySource)
    || evidence.hashes.payloadSha256 !== sha256(payloadSource)
    || evidence.hashes.signatureSha256 !== sha256(signature)
    || !verify(null, payloadSource, publicKey, signature)
  ) fail("TOPOLOGY_ATTESTATION_SIGNATURE_INVALID");
  exactKeys(evidence.payload, ["version", "evidenceType", "capture", "topology"], "TOPOLOGY_PAYLOAD");
  if (
    evidence.payload.version !== 1
    || evidence.payload.evidenceType !== "cloudflare-live-queue-topology"
  ) fail("TOPOLOGY_ATTESTATION_SCOPE_INVALID");
  return Object.freeze({
    version: 1,
    algorithm: "Ed25519",
    keyId: evidence.keyId,
    publicKeyPem: evidence.publicKeyPem,
    payload: evidence.payload,
    hashes: Object.freeze({
      publicKeySha256: trustedSha256,
      payloadSha256: evidence.hashes.payloadSha256,
      signatureSha256: evidence.hashes.signatureSha256,
    }),
    signatureBase64: evidence.signatureBase64,
  });
}

export function validateFleetFullBaselineDeployments({ evidence, accountId, components }) {
  exactKeys(evidence, ["version", "capturedAt", "accountId", "components"], "BASELINE_EVIDENCE");
  if (evidence.version !== 1 || evidence.accountId !== accountId) {
    fail("BASELINE_EVIDENCE_IDENTITY_DRIFT");
  }
  const capturedAt = timestamp(evidence.capturedAt, "BASELINE_CAPTURED_AT");
  exactKeys(evidence.components, Object.keys(components), "BASELINE_COMPONENTS");
  const normalized = {};
  const seen = new Set();
  for (const [key, component] of Object.entries(components)) {
    const observed = evidence.components[key];
    exactKeys(
      observed,
      ["workerName", "deploymentId", "versionId"],
      `BASELINE_${key.toUpperCase()}`,
    );
    if (observed.workerName !== component.workerName) fail(`BASELINE_${key.toUpperCase()}_WORKER_DRIFT`);
    const id = deploymentId(observed.deploymentId, `BASELINE_${key.toUpperCase()}_DEPLOYMENT_ID`);
    const versionId = deploymentId(observed.versionId, `BASELINE_${key.toUpperCase()}_VERSION_ID`);
    if (id === versionId || seen.has(id) || seen.has(versionId)) {
      fail("BASELINE_DEPLOYMENT_ID_REUSED");
    }
    seen.add(id);
    seen.add(versionId);
    normalized[key] = Object.freeze({
      workerName: component.workerName,
      deploymentId: id,
      versionId,
    });
  }
  return Object.freeze({
    version: 1,
    capturedAt: capturedAt.iso,
    accountId,
    components: Object.freeze(normalized),
  });
}

export function validateFleetFullLiveDeployments({ evidence, accountId, components }) {
  exactKeys(
    evidence,
    ["version", "capturedAt", "accountId", "sourceCommit", "components"],
    "LIVE_DEPLOYMENT_EVIDENCE",
  );
  if (evidence.version !== 1 || evidence.accountId !== accountId) {
    fail("LIVE_DEPLOYMENT_EVIDENCE_IDENTITY_DRIFT");
  }
  const capturedAt = timestamp(evidence.capturedAt, "LIVE_DEPLOYMENTS_CAPTURED_AT");
  exactKeys(evidence.components, Object.keys(components), "LIVE_DEPLOYMENT_COMPONENTS");
  const normalized = {};
  const seen = new Set();
  for (const [key, component] of Object.entries(components)) {
    const observed = evidence.components[key];
    exactKeys(
      observed,
      ["workerName", "deploymentId", "versionId", "configSha256"],
      `LIVE_DEPLOYMENT_${key.toUpperCase()}`,
    );
    if (
      observed.workerName !== component.workerName
      || observed.configSha256 !== component.renderedSha256
    ) fail(`LIVE_DEPLOYMENT_${key.toUpperCase()}_DRIFT`);
    const id = deploymentId(observed.deploymentId, `LIVE_${key.toUpperCase()}_DEPLOYMENT_ID`);
    const versionId = deploymentId(observed.versionId, `LIVE_${key.toUpperCase()}_VERSION_ID`);
    if (seen.has(id) || seen.has(versionId)) fail("LIVE_DEPLOYMENT_ID_REUSED");
    seen.add(id);
    seen.add(versionId);
    normalized[key] = Object.freeze({
      workerName: component.workerName,
      deploymentId: id,
      versionId,
      configSha256: component.renderedSha256,
    });
  }
  return Object.freeze({
    version: 1,
    capturedAt: capturedAt.iso,
    accountId,
    sourceCommit: evidence.sourceCommit,
    components: Object.freeze(normalized),
  });
}

export function validateFleetFullConsumerTopology({
  evidence,
  verifiedAt,
  accountId,
  executorWorkerName,
  executorDeploymentId,
  executorVersionId,
  lanes,
  trustedPublicKeySha256: explicitTrustedPublicKeySha256,
}) {
  const attestation = validateTopologyAttestation(evidence, explicitTrustedPublicKeySha256);
  const capture = attestation.payload.capture;
  const topology = attestation.payload.topology;
  exactKeys(
    topology,
    [
      "version",
      "observedAt",
      "accountId",
      "inventoryCompleteForQueues",
      "executorWorkerName",
      "executorDeploymentId",
      "executorVersionId",
      "queues",
      "inventorySha256",
    ],
    "TOPOLOGY_EVIDENCE",
  );
  if (
    topology.version !== 1
    || topology.accountId !== accountId
    || topology.inventoryCompleteForQueues !== true
    || topology.executorWorkerName !== executorWorkerName
    || deploymentId(topology.executorDeploymentId, "TOPOLOGY_EXECUTOR_DEPLOYMENT_ID")
      !== executorDeploymentId
    || deploymentId(topology.executorVersionId, "TOPOLOGY_EXECUTOR_VERSION_ID")
      !== executorVersionId
  ) fail("TOPOLOGY_EVIDENCE_INCOMPLETE");

  const observedAt = timestamp(topology.observedAt, "TOPOLOGY_OBSERVED_AT");
  const verified = timestamp(verifiedAt, "TOPOLOGY_VERIFIED_AT");
  if (
    observedAt.milliseconds > verified.milliseconds
    || verified.milliseconds - observedAt.milliseconds > MAX_TOPOLOGY_AGE_MS
  ) fail("TOPOLOGY_EVIDENCE_STALE");

  if (!SHA256_PATTERN.test(String(topology.inventorySha256 ?? ""))) {
    fail("TOPOLOGY_INVENTORY_SHA256_INVALID");
  }
  const hashPayload = {
    version: topology.version,
    observedAt: topology.observedAt,
    accountId: topology.accountId,
    inventoryCompleteForQueues: topology.inventoryCompleteForQueues,
    executorWorkerName: topology.executorWorkerName,
    executorDeploymentId: topology.executorDeploymentId,
    executorVersionId: topology.executorVersionId,
    queues: topology.queues,
  };
  if (fleetFullTopologyInventorySha256(hashPayload) !== topology.inventorySha256) {
    fail("TOPOLOGY_INVENTORY_SHA256_MISMATCH");
  }
  const validatedCapture = validateDirectCapture({ capture, topology, accountId, lanes });

  exactKeys(topology.queues, Object.keys(lanes), "TOPOLOGY_QUEUES");
  const queues = {};
  let consumerCount = 0;
  for (const [key, lane] of Object.entries(lanes)) {
    const queueEvidence = topology.queues[key];
    exactKeys(queueEvidence, ["queueId", "queueName", "consumers"], `TOPOLOGY_${key.toUpperCase()}`);
    if (
      !CLOUDFLARE_RESOURCE_ID_PATTERN.test(String(queueEvidence.queueId ?? ""))
      || queueEvidence.queueName !== lane.queue
      || !Array.isArray(queueEvidence.consumers)
    ) {
      fail(`TOPOLOGY_${key.toUpperCase()}_QUEUE_DRIFT`);
    }
    if (queueEvidence.consumers.length !== 1) {
      fail(`TOPOLOGY_${key.toUpperCase()}_CONSUMER_EXCLUSIVITY_VIOLATION`);
    }
    const consumer = queueEvidence.consumers[0];
    exactKeys(
      consumer,
      [
        "workerName",
        "deploymentId",
        "versionId",
        "maxBatchSize",
        "maxBatchTimeout",
        "maxRetries",
        "maxConcurrency",
        "deadLetterQueue",
      ],
      `TOPOLOGY_${key.toUpperCase()}_CONSUMER`,
    );
    if (
      consumer.workerName !== executorWorkerName
      || deploymentId(consumer.deploymentId, `TOPOLOGY_${key.toUpperCase()}_DEPLOYMENT_ID`)
        !== executorDeploymentId
      || deploymentId(consumer.versionId, `TOPOLOGY_${key.toUpperCase()}_VERSION_ID`)
        !== executorVersionId
      || consumer.maxBatchSize !== 1
      || consumer.maxBatchTimeout !== 5
      || consumer.maxRetries !== 3
      || consumer.maxConcurrency !== 1
      || consumer.deadLetterQueue !== lane.deadLetterQueue
    ) fail(`TOPOLOGY_${key.toUpperCase()}_CONSUMER_CONTRACT_DRIFT`);
    consumerCount += 1;
    queues[key] = Object.freeze({
      queueId: queueEvidence.queueId,
      queueName: lane.queue,
      consumerWorkerName: executorWorkerName,
      consumerDeploymentId: executorDeploymentId,
      consumerVersionId: executorVersionId,
      consumerCount: 1,
      legacyConsumerCount: 0,
      competingConsumerCount: 0,
      maxBatchSize: 1,
      maxBatchTimeout: 5,
      maxRetries: 3,
      maxConcurrency: 1,
      deadLetterQueue: lane.deadLetterQueue,
    });
  }
  if (consumerCount !== 3) fail("TOPOLOGY_TOTAL_CONSUMER_COUNT_DRIFT");

  return Object.freeze({
    version: 2,
    observedAt: observedAt.iso,
    verifiedAt: verified.iso,
    inventorySha256: topology.inventorySha256,
    accountId,
    executorWorkerName,
    executorDeploymentId,
    executorVersionId,
    capture: validatedCapture,
    attestation: Object.freeze(attestation),
    totalConsumerCount: 3,
    legacyConsumerCount: 0,
    competingConsumerCount: 0,
    queues: Object.freeze(queues),
  });
}

function requiredEnvironment(name) {
  const value = String(process.env[name] ?? "").trim();
  if (!value) fail("TOPOLOGY_COLLECTOR_MISSING_" + name);
  return value;
}

async function main() {
  const result = await collectFleetFullCloudflareTopologyAttestation({
    accountId: requiredEnvironment("CLOUDFLARE_ACCOUNT_ID"),
    executorWorkerName: requiredEnvironment("FLEET_FULL_EXECUTOR_WORKER_NAME"),
    executorDeploymentId: requiredEnvironment("FLEET_FULL_EXECUTOR_DEPLOYMENT_ID"),
    executorVersionId: requiredEnvironment("FLEET_FULL_EXECUTOR_VERSION_ID"),
    apiToken: requiredEnvironment("CLOUDFLARE_API_TOKEN"),
    privateKeyPath: resolve(requiredEnvironment("FLEET_FULL_TOPOLOGY_PRIVATE_KEY_PATH")),
    outputPath: resolve(requiredEnvironment("FLEET_FULL_TOPOLOGY_OUTPUT_PATH")),
    keyId: requiredEnvironment("FLEET_FULL_TOPOLOGY_KEY_ID"),
  });
  process.stdout.write(JSON.stringify({
    status: result.status,
    outputPath: result.outputPath,
    outputSha256: result.outputSha256,
    publicKeySha256: result.publicKeySha256,
    payloadSha256: result.payloadSha256,
  }, null, 2) + "\n");
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
    process.exitCode = 1;
  });
}
