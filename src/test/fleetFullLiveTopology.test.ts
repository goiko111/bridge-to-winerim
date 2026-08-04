import { createHash, generateKeyPairSync } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FLEET_FULL_ACCOUNT_ID,
  FLEET_FULL_EXECUTOR_NAME,
  FLEET_FULL_LANES,
  FleetFullLiveRenderError,
  attestFleetFullLiveTopology,
  readFleetFullTemplates,
  renderFleetFullLivePreparedConfigs,
  writeFleetFullLiveAttestation,
  writeFleetFullLivePreparedPackage,
} from "../../infrastructure/runtime/fleet-full-live-render-config.mjs";
import {
  collectFleetFullCloudflareTopologyAttestation,
} from "../../infrastructure/runtime/fleet-full-topology-evidence.mjs";

const SOURCE_COMMIT = "1234567890abcdef1234567890abcdef12345678";
const COMPONENT_KEYS = ["catalog", "salesStock", "outbound", "executor", "rateLimiter"] as const;
const BASELINE_IDS = {
  catalog: "11111111-1111-4111-8111-111111111111",
  salesStock: "22222222-2222-4222-8222-222222222222",
  outbound: "33333333-3333-4333-8333-333333333333",
  executor: "44444444-4444-4444-8444-444444444444",
  rateLimiter: "55555555-5555-4555-8555-555555555555",
};
const BASELINE_VERSION_IDS = {
  catalog: "81111111-1111-4111-8111-111111111111",
  salesStock: "82222222-2222-4222-8222-222222222222",
  outbound: "83333333-3333-4333-8333-333333333333",
  executor: "84444444-4444-4444-8444-444444444444",
  rateLimiter: "85555555-5555-4555-8555-555555555555",
};
const LIVE_IDS = {
  catalog: "61111111-1111-4111-8111-111111111111",
  salesStock: "62222222-2222-4222-8222-222222222222",
  outbound: "63333333-3333-4333-8333-333333333333",
  executor: "64444444-4444-4444-8444-444444444444",
  rateLimiter: "65555555-5555-4555-8555-555555555555",
};
const LIVE_VERSION_IDS = {
  catalog: "71111111-1111-4111-8111-111111111111",
  salesStock: "72222222-2222-4222-8222-222222222222",
  outbound: "73333333-3333-4333-8333-333333333333",
  executor: "74444444-4444-4444-8444-444444444444",
  rateLimiter: "75555555-5555-4555-8555-555555555555",
};
const CAPTURED_AT = "2026-08-04T18:00:00.000Z";
const OBSERVED_AT = "2026-08-04T18:01:00.000Z";
const VERIFIED_AT = "2026-08-04T18:02:00.000Z";
const { privateKey: topologyPrivateKey, publicKey: topologyPublicKey } =
  generateKeyPairSync("ed25519");
const topologyPrivateKeySource = topologyPrivateKey.export({ type: "pkcs8", format: "pem" });
const topologyPublicKeySource = topologyPublicKey.export({ type: "spki", format: "pem" });
const topologyPublicKeySha256 = createHash("sha256")
  .update(topologyPublicKeySource)
  .digest("hex");
const topologyCollectorDirectory = mkdtempSync(
  join(tmpdir(), "winerim-topology-collector-test-"),
);
const topologyPrivateKeyPath = join(topologyCollectorDirectory, "topology-private.pem");
writeFileSync(topologyPrivateKeyPath, topologyPrivateKeySource, { mode: 0o600 });
chmodSync(topologyPrivateKeyPath, 0o600);
let topologyOutputSequence = 0;
const previousTrustedTopologyKey =
  process.env.FLEET_FULL_TOPOLOGY_TRUSTED_PUBLIC_KEY_SHA256;

beforeAll(() => {
  process.env.FLEET_FULL_TOPOLOGY_TRUSTED_PUBLIC_KEY_SHA256 = topologyPublicKeySha256;
});

afterAll(() => {
  if (previousTrustedTopologyKey === undefined) {
    delete process.env.FLEET_FULL_TOPOLOGY_TRUSTED_PUBLIC_KEY_SHA256;
  } else {
    process.env.FLEET_FULL_TOPOLOGY_TRUSTED_PUBLIC_KEY_SHA256 =
      previousTrustedTopologyKey;
  }
  rmSync(topologyCollectorDirectory, { recursive: true, force: true });
});

function errorCode(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    expect(error).toBeInstanceOf(FleetFullLiveRenderError);
    return (error as FleetFullLiveRenderError).code;
  }
}

function workerNames() {
  const templates = readFleetFullTemplates();
  return Object.fromEntries(COMPONENT_KEYS.map((key) => [
    key,
    templates[key].match(/^name = "([^"]+)"$/mu)?.[1],
  ]));
}

function baselineDeployments() {
  const names = workerNames();
  return {
    version: 1,
    capturedAt: CAPTURED_AT,
    accountId: FLEET_FULL_ACCOUNT_ID,
    components: Object.fromEntries(COMPONENT_KEYS.map((key) => [key, {
      workerName: names[key],
      deploymentId: BASELINE_IDS[key],
      versionId: BASELINE_VERSION_IDS[key],
    }])),
  };
}

function prepare() {
  return renderFleetFullLivePreparedConfigs({
    templates: readFleetFullTemplates(),
    sourceCommit: SOURCE_COMMIT,
    expectedCommit: SOURCE_COMMIT,
    sourceTreeClean: true,
    baselineDeployments: baselineDeployments(),
  });
}

function liveDeployments(prepared = prepare()) {
  return {
    version: 1,
    capturedAt: CAPTURED_AT,
    accountId: FLEET_FULL_ACCOUNT_ID,
    sourceCommit: SOURCE_COMMIT,
    components: Object.fromEntries(COMPONENT_KEYS.map((key) => [key, {
      workerName: prepared.manifest.components[key].workerName,
      deploymentId: LIVE_IDS[key],
      versionId: LIVE_VERSION_IDS[key],
      configSha256: prepared.manifest.components[key].renderedSha256,
    }])),
  };
}

async function topologyEvidence(options: {
  completedAt?: string;
  mutate?: (kind: string, envelope: Record<string, unknown>) => void;
} = {}) {
  const queueIds = {
    catalog: "a1111111111111111111111111111111",
    salesStock: "a2222222222222222222222222222222",
    outbound: "a3333333333333333333333333333333",
  };
  const completedAt = options.completedAt ?? OBSERVED_AT;
  const startedAt = new Date(Date.parse(completedAt) - 2_000).toISOString();
  const responseFor = (kind: string) => {
    let result: unknown;
    if (kind === "queue-list") {
      result = Object.entries(FLEET_FULL_LANES).map(([key, lane]) => ({
        queue_id: queueIds[key as keyof typeof queueIds],
        queue_name: lane.queue,
      }));
    } else if (kind.startsWith("queue-consumers:")) {
      const key = kind.slice("queue-consumers:".length) as keyof typeof FLEET_FULL_LANES;
      const lane = FLEET_FULL_LANES[key];
      result = [{
        consumer_id: "b" + queueIds[key].slice(1),
        type: "worker",
        queue_name: lane.queue,
        script_name: lane.workerName,
        dead_letter_queue: lane.deadLetterQueue,
        settings: {
          batch_size: 1,
          max_wait_time_ms: 5_000,
          max_retries: 3,
          max_concurrency: 1,
        },
      }];
    } else if (kind.startsWith("worker-deployments:consumer:")) {
      const key = kind.slice("worker-deployments:consumer:".length) as keyof typeof LIVE_IDS;
      result = {
        deployments: [{
          id: LIVE_IDS[key],
          versions: [{ percentage: 100, version_id: LIVE_VERSION_IDS[key] }],
        }],
      };
    } else {
      result = {
        deployments: [{
          id: LIVE_IDS.executor,
          versions: [{ percentage: 100, version_id: LIVE_VERSION_IDS.executor }],
        }],
      };
    }
    const list = Array.isArray(result) ? result : (result as { deployments: unknown[] }).deployments;
    const envelope: Record<string, unknown> = {
      success: true,
      errors: [],
      messages: [],
      result,
      result_info: {
        page: 1,
        per_page: 100,
        count: list.length,
        total_count: list.length,
      },
    };
    options.mutate?.(kind, envelope);
    return new Response(JSON.stringify(envelope), {
      status: 200,
      headers: {
        date: completedAt,
        "cf-ray": "abc123def456-MAD",
        "content-type": "application/json",
      },
    });
  };
  const fetchImpl = async (url: string) => {
    if (url.endsWith("/queues")) return responseFor("queue-list");
    for (const [key, queueId] of Object.entries(queueIds)) {
      if (url.endsWith("/queues/" + queueId + "/consumers")) {
        return responseFor("queue-consumers:" + key);
      }
    }
    for (const [key, lane] of Object.entries(FLEET_FULL_LANES)) {
      if (url.endsWith("/workers/scripts/" + lane.workerName + "/deployments")) {
        return responseFor("worker-deployments:consumer:" + key);
      }
    }
    if (url.endsWith("/deployments")) return responseFor("worker-deployments:executor");
    throw new Error("unexpected Cloudflare URL");
  };
  const times = [new Date(startedAt), new Date(completedAt)];
  const outputPath = join(
    topologyCollectorDirectory,
    "attestation-" + String(++topologyOutputSequence) + ".json",
  );
  const result = await collectFleetFullCloudflareTopologyAttestation({
    accountId: FLEET_FULL_ACCOUNT_ID,
    executorWorkerName: FLEET_FULL_EXECUTOR_NAME,
    executorDeploymentId: LIVE_IDS.executor,
    executorVersionId: LIVE_VERSION_IDS.executor,
    lanes: Object.fromEntries(Object.entries(FLEET_FULL_LANES).map(([key, lane]) => [key, {
      queue: lane.queue,
      deadLetterQueue: lane.deadLetterQueue,
      consumerWorkerName: lane.workerName,
      consumerDeploymentId: LIVE_IDS[key as keyof typeof LIVE_IDS],
      consumerVersionId: LIVE_VERSION_IDS[key as keyof typeof LIVE_VERSION_IDS],
    }])),
    apiToken: "test-cloudflare-api-token-not-a-secret",
    privateKeyPath: topologyPrivateKeyPath,
    outputPath,
    keyId: "fleet-topology-test-key",
    fetchImpl,
    now: () => times.shift() ?? new Date(completedAt),
  });
  expect(statSync(outputPath).mode & 0o777).toBe(0o600);
  return result.attestation;
}

function attest(prepared: ReturnType<typeof prepare>, evidence: unknown) {
  return attestFleetFullLiveTopology({
    preparedResult: prepared,
    templates: readFleetFullTemplates(),
    sourceCommit: SOURCE_COMMIT,
    expectedCommit: SOURCE_COMMIT,
    sourceTreeClean: true,
    baselineDeployments: baselineDeployments(),
    liveDeployments: liveDeployments(prepared),
    topologyEvidence: evidence,
    verifiedAt: VERIFIED_AT,
  });
}

describe("full fleet LIVE topology package", () => {
  it("renders three live lane workers with one bounded consumer each and a private executor", () => {
    const result = prepare();

    expect(result.manifest).toMatchObject({
      mode: "fleet-full-live-prepared",
      executionEnabled: true,
      activationAllowed: false,
      topologyGate: {
        evidenceStatus: "MISSING",
        exactManagedQueueCount: 3,
        executorConsumerCountOnManagedQueues: 0,
        laneConsumerCountOnManagedQueues: 3,
        legacyConsumerCount: 0,
        competingConsumerCount: 0,
        rejectsAnyUnlistedConsumerOnManagedQueues: true,
      },
    });
    for (const key of ["catalog", "salesStock", "outbound"] as const) {
      expect(result.rendered[key]).toContain('RUNTIME_EXECUTION_ENABLED = "true"');
      expect(result.rendered[key]).toContain(`queue = "${FLEET_FULL_LANES[key].queue}"`);
      expect(result.rendered[key].match(/\[\[queues\.consumers\]\]/gu)).toHaveLength(1);
      expect(result.rendered[key]).toContain(
        `dead_letter_queue = "${FLEET_FULL_LANES[key].deadLetterQueue}"`,
      );
      expect(result.rendered[key].match(/^max_batch_size = 1$/gmu)).toHaveLength(1);
      expect(result.rendered[key].match(/^max_concurrency = 1$/gmu)).toHaveLength(1);
    }
    expect(result.rendered.executor).not.toContain("[[queues.consumers]]");
    expect(result.rendered.rateLimiter).toContain("class_name = \"OutboundRateLimiter\"");
    expect(result.rendered.rateLimiter).not.toContain("[[queues.consumers]]");
  });

  it("requires captured rollback deployment ids and rejects dirty or drifting source", () => {
    const baseline = baselineDeployments();
    const templates = readFleetFullTemplates();
    const common = {
      templates,
      sourceCommit: SOURCE_COMMIT,
      expectedCommit: SOURCE_COMMIT,
      sourceTreeClean: true,
      baselineDeployments: baseline,
    };
    const result = renderFleetFullLivePreparedConfigs(common);
    for (const key of COMPONENT_KEYS) {
      expect(result.manifest.rollback.components[key]).toMatchObject({
        workerName: result.manifest.components[key].workerName,
        deploymentId: BASELINE_IDS[key],
        versionId: BASELINE_VERSION_IDS[key],
      });
      expect(result.manifest.rollback.components[key].command).toContain(BASELINE_VERSION_IDS[key]);
      expect(result.manifest.rollback.components[key].command).not.toContain(BASELINE_IDS[key]);
      if (key === "catalog" || key === "salesStock" || key === "outbound") {
        expect(result.manifest.rollback.components[key].removeConsumerCommand).toEqual([
          "npx",
          "wrangler",
          "queues",
          "consumer",
          "remove",
          FLEET_FULL_LANES[key].queue,
          FLEET_FULL_LANES[key].workerName,
        ]);
      } else {
        expect(result.manifest.rollback.components[key].removeConsumerCommand).toBeNull();
      }
    }

    expect(errorCode(() => renderFleetFullLivePreparedConfigs({
      ...common,
      sourceTreeClean: false,
    }))).toBe("SOURCE_TREE_DIRTY");
    expect(errorCode(() => renderFleetFullLivePreparedConfigs({
      ...common,
      expectedCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    }))).toBe("SOURCE_COMMIT_MISMATCH");
    const changed = structuredClone(baseline);
    changed.components.executor.workerName = "legacy-executor";
    expect(errorCode(() => renderFleetFullLivePreparedConfigs({
      ...common,
      baselineDeployments: changed,
    }))).toBe("BASELINE_EXECUTOR_WORKER_DRIFT");

    const reusedVersion = structuredClone(baseline);
    reusedVersion.components.executor.versionId = reusedVersion.components.executor.deploymentId;
    expect(errorCode(() => renderFleetFullLivePreparedConfigs({
      ...common,
      baselineDeployments: reusedVersion,
    }))).toBe("BASELINE_DEPLOYMENT_ID_REUSED");
  });

  it("attests activation only after fresh, complete and exclusive topology evidence", async () => {
    const result = attest(prepare(), await topologyEvidence());
    expect(result).toMatchObject({
      mode: "fleet-full-live-topology-attested",
      activationAllowed: true,
      topologyGate: { evidenceStatus: "VERIFIED" },
      queueOwnership: {
        totalConsumerCount: 3,
        legacyConsumerCount: 0,
        competingConsumerCount: 0,
        executorWorkerName: FLEET_FULL_EXECUTOR_NAME,
      },
      nextGate: "SERIAL_CONNECTION_ACTIVATION_ONLY",
    });
    for (const key of Object.keys(FLEET_FULL_LANES)) {
      expect(result.queueOwnership.queues[key]).toMatchObject({
        consumerWorkerName: FLEET_FULL_LANES[key as keyof typeof FLEET_FULL_LANES].workerName,
        consumerCount: 1,
        legacyConsumerCount: 0,
        competingConsumerCount: 0,
      });
    }
  });

  it("rejects manual input, mismatched API data, stale and incomplete evidence", async () => {
    const manualUnsigned = {
      version: 1,
      observedAt: OBSERVED_AT,
      accountId: FLEET_FULL_ACCOUNT_ID,
      inventoryCompleteForQueues: true,
      queues: {},
      inventorySha256: "a".repeat(64),
    };
    expect(errorCode(() => attest(prepare(), manualUnsigned))).toBe(
      "TOPOLOGY_ATTESTATION_STRUCTURE_DRIFT",
    );

    const tampered = structuredClone(await topologyEvidence());
    tampered.payload.topology.inventoryCompleteForQueues = false;
    expect(errorCode(() => attest(prepare(), tampered))).toBe(
      "TOPOLOGY_ATTESTATION_SIGNATURE_INVALID",
    );

    await expect(topologyEvidence({
      mutate: (kind, envelope) => {
        if (kind === "queue-consumers:salesStock") {
          const consumers = envelope.result as Array<Record<string, unknown>>;
          consumers[0].script_name = "winerim-middleware-runtime-rescue-prod-fleet";
        }
      },
    })).rejects.toMatchObject({ code: "TOPOLOGY_SALESSTOCK_CONSUMER_CONTRACT_DRIFT" });

    await expect(topologyEvidence({
      mutate: (kind, envelope) => {
        if (kind === "queue-consumers:catalog") {
          const consumers = envelope.result as Array<Record<string, unknown>>;
          const resultInfo = envelope.result_info as Record<string, number>;
          consumers.push(structuredClone(consumers[0]));
          resultInfo.count = 2;
          resultInfo.total_count = 2;
        }
      },
    })).rejects.toMatchObject({ code: "TOPOLOGY_CATALOG_CONSUMER_EXCLUSIVITY_VIOLATION" });

    await expect(topologyEvidence({
      mutate: (kind, envelope) => {
        if (kind === "queue-list") {
          const resultInfo = envelope.result_info as Record<string, number>;
          resultInfo.total_count += 1;
        }
      },
    })).rejects.toMatchObject({
      code: "TOPOLOGY_QUEUE_LIST_CLOUDFLARE_RESULT_INFO_INCOMPLETE",
    });

    await expect(topologyEvidence({
      mutate: (kind, envelope) => {
        if (kind === "worker-deployments:executor") {
          const result = envelope.result as {
            deployments: Array<{ versions: Array<{ version_id: string }> }>;
          };
          result.deployments[0].versions[0].version_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        }
      },
    })).rejects.toMatchObject({ code: "TOPOLOGY_EXECUTOR_DEPLOYMENT_DRIFT" });

    const stale = await topologyEvidence({ completedAt: "2026-08-04T17:40:00.000Z" });
    expect(errorCode(() => attest(prepare(), stale))).toBe("TOPOLOGY_EVIDENCE_STALE");
  });

  it("rejects deployment/config drift and writes private prepared and attested artifacts", async () => {
    const prepared = prepare();
    const deployments = liveDeployments(prepared);
    deployments.components.executor.configSha256 = "a".repeat(64);
    const collectedEvidence = await topologyEvidence();
    expect(errorCode(() => attestFleetFullLiveTopology({
      preparedResult: prepared,
      templates: readFleetFullTemplates(),
      sourceCommit: SOURCE_COMMIT,
      expectedCommit: SOURCE_COMMIT,
      sourceTreeClean: true,
      baselineDeployments: baselineDeployments(),
      liveDeployments: deployments,
      topologyEvidence: collectedEvidence,
      verifiedAt: VERIFIED_AT,
    }))).toBe("LIVE_DEPLOYMENT_EXECUTOR_DRIFT");

    const outputDir = resolve(tmpdir(), `winerim-fleet-full-live-${process.pid}`);
    rmSync(outputDir, { recursive: true, force: true });
    try {
      const written = writeFleetFullLivePreparedPackage({ outputDir, result: prepared });
      const manifest = JSON.parse(readFileSync(written.manifestPath, "utf8"));
      expect(manifest.activationAllowed).toBe(false);
      for (const key of COMPONENT_KEYS) {
        expect(statSync(written.outputs[key]).mode & 0o777).toBe(0o600);
        expect(manifest.operations[key].rollbackCommand).toContain(BASELINE_VERSION_IDS[key]);
        expect(manifest.operations[key].rollbackCommand).not.toContain(BASELINE_IDS[key]);
        expect(manifest.operations[key].removeConsumerCommand).toEqual(
          manifest.rollback.components[key].removeConsumerCommand,
        );
      }

      const attestationPath = writeFleetFullLiveAttestation({
        outputDir,
        attestation: attest(prepared, await topologyEvidence()),
      });
      expect(statSync(attestationPath).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(attestationPath, "utf8")).activationAllowed).toBe(true);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });
});
