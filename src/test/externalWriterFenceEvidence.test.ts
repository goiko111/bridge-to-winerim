import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { generateKeyPairSync, createHash, verify } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

// @ts-expect-error Operational ESM script is exercised directly by Vitest.
import {
  buildExternalWriterFenceEvidence,
  prepareExternalWriterFenceEvidence,
  validateExternalWriterFencePayload,
} from "../../infrastructure/runtime/prepare-external-writer-fence-evidence.mjs";
// @ts-expect-error Operational ESM script is exercised directly by Vitest.
import { validateExternalBootstrapWriterFenceEvidence } from "../../infrastructure/runtime/prepare-writer-fence-grant.mjs";

const CONNECTION_ID = "e465872a-bff5-43de-8e4c-fe4986f0fd4f";
const PROJECT_ID = "a61b5b89-4c36-44fc-aaf2-9c7c3f3cfd8d";
const REFERENCE_TIME = "2026-08-04T14:10:00.000Z";
const collectorScript = resolve(
  import.meta.dirname,
  "../../infrastructure/runtime/prepare-external-writer-fence-evidence.mjs",
);
const temporaryDirectories: string[] = [];

function temporaryDirectory(label: string) {
  const directory = mkdtempSync(join(tmpdir(), `${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

function payload() {
  return {
    evidenceType: "lovable-writer-fence",
    connectionId: CONNECTION_ID,
    source: {
      provider: "lovable-cloud",
      projectId: PROJECT_ID,
      collectorRunId: "vinatea-external-observer-20260804-b",
    },
    fenceMode: "lovable-disabled-no-agora-rotation",
    fenceAppliedAt: "2026-08-04T14:00:00.000Z",
    observedAt: "2026-08-04T14:08:00.000Z",
    lovable: {
      writerDisabled: true,
      cronDisabled: true,
      edgeMutationDisabled: true,
    },
    agoraCredential: {
      rotated: false,
      removedFromLovable: true,
    },
    readbacks: [
      {
        observedAt: "2026-08-04T14:02:10.000Z",
        status: "FENCED_HEALTHY",
        writerDisabled: true,
        cronDisabled: true,
        edgeMutationDisabled: true,
        agoraCredentialUnavailableToLovable: true,
      },
      {
        observedAt: "2026-08-04T14:08:00.000Z",
        status: "FENCED_HEALTHY",
        writerDisabled: true,
        cronDisabled: true,
        edgeMutationDisabled: true,
        agoraCredentialUnavailableToLovable: true,
      },
    ],
  };
}

function fixture() {
  const directory = temporaryDirectory("external-writer-fence");
  const keyPair = generateKeyPairSync("ed25519");
  const privateKeyPath = join(directory, "observer-private.pem");
  const readbacksPath = join(directory, "readbacks.json");
  const privateKeySource = keyPair.privateKey.export({ type: "pkcs8", format: "pem" });
  const readbacksSource = Buffer.from(`${JSON.stringify(payload(), null, 2)}\n`);
  writeFileSync(privateKeyPath, privateKeySource, { mode: 0o600 });
  writeFileSync(readbacksPath, readbacksSource, { mode: 0o600 });
  chmodSync(privateKeyPath, 0o600);
  return {
    directory,
    privateKeyPath,
    privateKeySource: Buffer.from(privateKeySource),
    readbacksPath,
    readbacksSource,
    readbacksSha256: createHash("sha256").update(readbacksSource).digest("hex"),
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("external Ed25519 writer-fence evidence", () => {
  it("writes validator-compatible private evidence and a pinned public key", () => {
    const input = fixture();
    const outputDir = join(temporaryDirectory("external-writer-fence-output"), "evidence");
    const result = prepareExternalWriterFenceEvidence({
      readbacksPath: input.readbacksPath,
      expectedReadbacksSha256: input.readbacksSha256,
      privateKeyPath: input.privateKeyPath,
      keyId: "lovable-fence-observer-v1",
      outputDir,
      referenceTime: REFERENCE_TIME,
    });

    expect(result).toMatchObject({
      status: "EXTERNAL_WRITER_FENCE_EVIDENCE_READY",
      remoteMutations: 0,
      productionWrites: 0,
      connectionId: CONNECTION_ID,
      projectId: PROJECT_ID,
      fenceMode: "lovable-disabled-no-agora-rotation",
      readbackObservedAt: [
        "2026-08-04T14:02:10.000Z",
        "2026-08-04T14:08:00.000Z",
      ],
    });
    expect(statSync(result.evidencePath).mode & 0o777).toBe(0o600);
    expect(statSync(result.publicKeyPath).mode & 0o777).toBe(0o600);

    const artifactSource = readFileSync(result.evidencePath);
    const publicKeySource = readFileSync(result.publicKeyPath);
    const envelope = JSON.parse(artifactSource.toString("utf8"));
    expect(envelope).toMatchObject({
      version: 1,
      algorithm: "Ed25519",
      keyId: "lovable-fence-observer-v1",
      payload: { connectionId: CONNECTION_ID },
      hashes: {
        readbacksSourceSha256: input.readbacksSha256,
        publicKeySha256: result.publicKeySha256,
        payloadSha256: result.payloadSha256,
        signatureSha256: result.signatureSha256,
      },
    });
    expect(envelope.publicKeyPem).toBe(publicKeySource.toString("utf8"));
    expect(verify(
      null,
      Buffer.from(JSON.stringify(envelope.payload)),
      publicKeySource,
      Buffer.from(envelope.signatureBase64, "base64"),
    )).toBe(true);
    expect(validateExternalBootstrapWriterFenceEvidence({
      artifactSource,
      artifactSha256: result.artifactSha256,
      publicKeySource,
      publicKeySha256: result.publicKeySha256,
      connectionId: CONNECTION_ID,
      referenceTime: REFERENCE_TIME,
    })).toMatchObject({
      artifactSha256: result.artifactSha256,
      payloadSha256: result.payloadSha256,
      signatureSha256: result.signatureSha256,
      fenceMode: "lovable-disabled-no-agora-rotation",
    });
  });

  it("signs JSON.stringify(payload) bytes and never returns private material", () => {
    const input = fixture();
    const prepared = buildExternalWriterFenceEvidence({
      payload: payload(),
      privateKeySource: input.privateKeySource,
      keyId: "lovable-fence-observer-v1",
      readbacksSourceSha256: input.readbacksSha256,
      referenceTime: REFERENCE_TIME,
    });
    const serialized = JSON.stringify({
      artifactSha256: prepared.artifactSha256,
      hashes: prepared.hashes,
      payload: prepared.payload,
    });
    expect(serialized).not.toContain("PRIVATE KEY");
    expect(serialized).not.toContain("signatureBase64");
  });

  it("uses current time in the CLI and keeps stdout sanitized", () => {
    const input = fixture();
    const current = Date.now();
    const cliPayload = payload();
    cliPayload.fenceAppliedAt = new Date(current - 300_000).toISOString();
    cliPayload.readbacks[0].observedAt = new Date(current - 170_000).toISOString();
    cliPayload.readbacks[1].observedAt = new Date(current - 10_000).toISOString();
    cliPayload.observedAt = cliPayload.readbacks[1].observedAt;
    const readbacksSource = Buffer.from(`${JSON.stringify(cliPayload, null, 2)}\n`);
    writeFileSync(input.readbacksPath, readbacksSource, { mode: 0o600 });
    const readbacksSha256 = createHash("sha256").update(readbacksSource).digest("hex");
    const outputDir = join(temporaryDirectory("external-writer-fence-cli"), "evidence");

    const command = spawnSync(process.execPath, [
      collectorScript,
      "--collect",
      `--readbacks=${input.readbacksPath}`,
      `--readbacks-sha256=${readbacksSha256}`,
      `--private-key=${input.privateKeyPath}`,
      "--key-id=lovable-fence-observer-v1",
      `--output=${outputDir}`,
    ], { encoding: "utf8" });

    expect(command.status, command.stderr).toBe(0);
    const summary = JSON.parse(command.stdout);
    expect(summary).toMatchObject({
      status: "EXTERNAL_WRITER_FENCE_EVIDENCE_READY",
      remoteMutations: 0,
      productionWrites: 0,
      connectionId: CONNECTION_ID,
    });
    expect(command.stdout).not.toContain("signatureBase64");
    expect(command.stdout).not.toContain("publicKeyPem");
    expect(command.stdout).not.toContain("PRIVATE KEY");
    expect(command.stdout).not.toContain("must-not-be-signed");
  });

  it("fails closed when token material is present", () => {
    const unsafe = payload() as ReturnType<typeof payload> & {
      headers?: { "Api-Token": string };
    };
    unsafe.headers = { "Api-Token": "must-not-be-signed" };
    expect(() => validateExternalWriterFencePayload(unsafe, { referenceTime: REFERENCE_TIME }))
      .toThrow("EXTERNAL_WRITER_FENCE_SECRET_OR_TOKEN_PRESENT");
  });

  it("requires exactly two healthy, separated post-drain readbacks", () => {
    const oneReadback = payload();
    oneReadback.readbacks = oneReadback.readbacks.slice(1);
    expect(() => validateExternalWriterFencePayload(oneReadback, { referenceTime: REFERENCE_TIME }))
      .toThrow("EXTERNAL_WRITER_FENCE_EXACTLY_TWO_READBACKS_REQUIRED");

    const beforeDrain = payload();
    beforeDrain.readbacks[0].observedAt = "2026-08-04T14:02:09.999Z";
    expect(() => validateExternalWriterFencePayload(beforeDrain, { referenceTime: REFERENCE_TIME }))
      .toThrow("EXTERNAL_WRITER_FENCE_READBACK_NOT_HEALTHY_AFTER_DRAIN");

    const notSeparated = payload();
    notSeparated.readbacks[0].observedAt = "2026-08-04T14:07:58.000Z";
    expect(() => validateExternalWriterFencePayload(notSeparated, { referenceTime: REFERENCE_TIME }))
      .toThrow("EXTERNAL_WRITER_FENCE_READBACK_ORDER_OR_SEPARATION_INVALID");
  });

  it("rejects stale, future and mismatched observed times", () => {
    expect(() => validateExternalWriterFencePayload(payload(), {
      referenceTime: "2026-08-04T14:23:00.001Z",
    })).toThrow("EXTERNAL_WRITER_FENCE_EVIDENCE_NOT_FRESH");

    expect(() => validateExternalWriterFencePayload(payload(), {
      referenceTime: "2026-08-04T14:07:59.999Z",
    })).toThrow("EXTERNAL_WRITER_FENCE_EVIDENCE_NOT_FRESH");

    const mismatch = payload();
    mismatch.observedAt = "2026-08-04T14:08:01.000Z";
    expect(() => validateExternalWriterFencePayload(mismatch, { referenceTime: REFERENCE_TIME }))
      .toThrow("EXTERNAL_WRITER_FENCE_READBACK_ORDER_OR_SEPARATION_INVALID");
  });

  it("requires a regular private Ed25519 key with mode 0400 or 0600", () => {
    const input = fixture();
    chmodSync(input.privateKeyPath, 0o644);
    expect(() => prepareExternalWriterFenceEvidence({
      readbacksPath: input.readbacksPath,
      expectedReadbacksSha256: input.readbacksSha256,
      privateKeyPath: input.privateKeyPath,
      keyId: "lovable-fence-observer-v1",
      outputDir: join(temporaryDirectory("external-writer-fence-mode"), "evidence"),
      referenceTime: REFERENCE_TIME,
    })).toThrow("EXTERNAL_WRITER_FENCE_PRIVATE_KEY_MUST_BE_0400_OR_0600");

    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const rsaPath = join(input.directory, "rsa-private.pem");
    writeFileSync(rsaPath, rsa.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    chmodSync(rsaPath, 0o600);
    expect(() => prepareExternalWriterFenceEvidence({
      readbacksPath: input.readbacksPath,
      expectedReadbacksSha256: input.readbacksSha256,
      privateKeyPath: rsaPath,
      keyId: "lovable-fence-observer-v1",
      outputDir: join(temporaryDirectory("external-writer-fence-rsa"), "evidence"),
      referenceTime: REFERENCE_TIME,
    })).toThrow("EXTERNAL_WRITER_FENCE_PRIVATE_KEY_MUST_BE_ED25519");
  });

  it("binds the readback source hash and rejects tampering", () => {
    const input = fixture();
    expect(() => prepareExternalWriterFenceEvidence({
      readbacksPath: input.readbacksPath,
      expectedReadbacksSha256: "0".repeat(64),
      privateKeyPath: input.privateKeyPath,
      keyId: "lovable-fence-observer-v1",
      outputDir: join(temporaryDirectory("external-writer-fence-hash"), "evidence"),
      referenceTime: REFERENCE_TIME,
    })).toThrow("EXTERNAL_WRITER_FENCE_READBACKS_SHA256_MISMATCH");
  });
});
