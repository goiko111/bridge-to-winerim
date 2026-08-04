import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { IMPORT_TABLES, buildSourceSnapshot } from "./core.mjs";
import { readSourceArtifact, writeSourceArtifact } from "./artifacts.mjs";

const CONNECTION_ID = "e465872a-bff5-43de-8e4c-fe4986f0fd4f";

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

