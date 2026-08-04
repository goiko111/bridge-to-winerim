import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { IMPORT_TABLES, buildSourceSnapshot } from "./core.mjs";
import { prepareAtomicResultArtifact, readSourceArtifact, writeSourceArtifact } from "./artifacts.mjs";

const CONNECTION_ID = "e465872a-bff5-43de-8e4c-fe4986f0fd4f";
const PLAN_SHA256 = "c".repeat(64);

function resultArtifactOptions(operation, faultInjector = null) {
  return {
    validateExisting(value) {
      assert.equal(value.connectionId, CONNECTION_ID);
      assert.equal(value.planSha256, PLAN_SHA256);
    },
    metadata: {
      operation,
      connectionId: CONNECTION_ID,
      planSha256: PLAN_SHA256,
      planManifestSha256: "d".repeat(64),
      targetIdentitySha256: "e".repeat(64),
    },
    faultInjector,
  };
}

function emptySnapshot() {
  const rawTables = Object.fromEntries([...IMPORT_TABLES, "outbound_tasks"].map((table) => [table, []]));
  rawTables.pos_connections = [{
    id: CONNECTION_ID,
    location_name: "Artifact Fixture",
    provider: "agora",
    sync_frequency_minutes: 5,
    backfill_days: 7,
    created_at: "2026-08-04T00:00:00.000Z",
    updated_at: "2026-08-04T00:00:00.000Z",
  }];
  return buildSourceSnapshot({
    connectionId: CONNECTION_ID,
    rawTables,
    watermark: {
      capturedAt: "2026-08-04T10:00:00.000Z",
      walLsn: "0/123",
      snapshotSha256: "a".repeat(64),
      databaseIdentitySha256: "b".repeat(64),
    },
  });
}

test("writes owner-only digest-bound artifacts and rejects tampering", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "connection-hydrator-artifact-"));
  await chmod(root, 0o700);
  const outputDir = path.join(root, "source");
  const snapshot = emptySnapshot();
  const manifest = await writeSourceArtifact(snapshot, outputDir);
  const verified = await readSourceArtifact(outputDir);
  assert.equal(verified.source.payloadSha256, snapshot.payloadSha256);
  assert.equal(verified.manifest.manifestSha256, manifest.manifestSha256);

  const filePath = path.join(outputDir, "data", "pos_connections.jsonl");
  await writeFile(filePath, `${await readFile(filePath, "utf8")} `, { mode: 0o600 });
  await chmod(filePath, 0o600);
  await assert.rejects(readSourceArtifact(outputDir), /SOURCE_FILE_SIZE_MISMATCH|SOURCE_FILE_DIGEST_MISMATCH/);
});

test("publishes a durable PREPARED journal before the result and preserves the first receipt", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "connection-hydrator-result-"));
  await chmod(root, 0o700);
  const first = await prepareAtomicResultArtifact(root, "apply-result.json", resultArtifactOptions("HYDRATE"));
  assert.equal(first.existing, null);
  const prepared = JSON.parse(await readFile(path.join(root, "apply-result.json.journal.json"), "utf8"));
  assert.equal(prepared.state, "PREPARED");
  assert.equal(prepared.operation, "HYDRATE");
  assert.equal((await stat(path.join(root, "apply-result.json.journal.json"))).mode & 0o077, 0);

  const receipt = {
    result: "INACTIVE_HYDRATION_APPLIED",
    connectionId: CONNECTION_ID,
    planSha256: PLAN_SHA256,
    idempotentReplay: false,
  };
  await first.finalize(receipt);
  const finalized = JSON.parse(await readFile(path.join(root, "apply-result.json.journal.json"), "utf8"));
  assert.equal(finalized.state, "FINALIZED");

  const replay = await prepareAtomicResultArtifact(root, "apply-result.json", resultArtifactOptions("HYDRATE"));
  assert.equal(replay.existing.idempotentReplay, false);
  const persisted = JSON.parse(await readFile(path.join(root, "apply-result.json"), "utf8"));
  assert.equal(persisted.idempotentReplay, false);
  assert.deepEqual((await readdir(root)).filter((name) => name.endsWith(".tmp")), []);
});

test("replay completes a PREPARED journal when result publication failed after publish", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "connection-hydrator-result-recovery-"));
  await chmod(root, 0o700);
  const first = await prepareAtomicResultArtifact(root, "apply-result.json", resultArtifactOptions("HYDRATE", (stage) => {
    if (stage === "result:after-link") throw new Error("INJECT_RESULT_AFTER_PUBLISH");
  }));
  const receipt = {
    result: "INACTIVE_HYDRATION_APPLIED",
    connectionId: CONNECTION_ID,
    planSha256: PLAN_SHA256,
    idempotentReplay: false,
  };
  await assert.rejects(first.finalize(receipt), /INJECT_RESULT_AFTER_PUBLISH/);
  assert.equal(JSON.parse(await readFile(path.join(root, "apply-result.json.journal.json"), "utf8")).state, "PREPARED");

  const replay = await prepareAtomicResultArtifact(root, "apply-result.json", resultArtifactOptions("HYDRATE"));
  assert.deepEqual(replay.existing, receipt);
  assert.equal(replay.resumedPrepared, true);
  assert.equal(JSON.parse(await readFile(path.join(root, "apply-result.json.journal.json"), "utf8")).state, "FINALIZED");
  assert.deepEqual((await readdir(root)).filter((name) => name.endsWith(".tmp")), []);
});

test("rejects a receipt that no longer matches its FINALIZED journal digest", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "connection-hydrator-result-digest-"));
  await chmod(root, 0o700);
  const artifact = await prepareAtomicResultArtifact(root, "apply-result.json", resultArtifactOptions("HYDRATE"));
  await artifact.finalize({
    result: "INACTIVE_HYDRATION_APPLIED",
    connectionId: CONNECTION_ID,
    planSha256: PLAN_SHA256,
    idempotentReplay: false,
  });
  await writeFile(path.join(root, "apply-result.json"), JSON.stringify({
    result: "INACTIVE_HYDRATION_APPLIED",
    connectionId: CONNECTION_ID,
    planSha256: PLAN_SHA256,
    idempotentReplay: true,
  }), { mode: 0o600 });
  await chmod(path.join(root, "apply-result.json"), 0o600);
  await assert.rejects(
    prepareAtomicResultArtifact(root, "apply-result.json", resultArtifactOptions("HYDRATE")),
    /RESULT_JOURNAL_RECEIPT_DIGEST_MISMATCH/,
  );
});

test("rejects a conflicting result before reserving a transaction artifact", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "connection-hydrator-conflict-"));
  await chmod(root, 0o700);
  await writeFile(path.join(root, "rollback-result.json"), JSON.stringify({ planSha256: "d".repeat(64) }), { mode: 0o600 });
  await assert.rejects(
    prepareAtomicResultArtifact(root, "rollback-result.json", resultArtifactOptions("ROLLBACK")),
    /Expected values to be strictly equal/,
  );
  assert.deepEqual((await readdir(root)).filter((name) => name.endsWith(".tmp")), []);
});
