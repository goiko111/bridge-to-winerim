import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  prepareFleetWriterFenceSecretBundle,
  writeFleetWriterFenceSecretBundle,
} from "./prepare-fleet-writer-fence-secret-bundle.mjs";

const CONNECTION = "8466c229-773d-4ad9-a747-9bb862d7ae6b";
const GENERATION = "3".repeat(64);

function fixture(directory, runId = "donquijote-20260804-c") {
  const grant = join(directory, "grant.json");
  const proof = join(directory, "proof.txt");
  writeFileSync(grant, JSON.stringify({
    version: 3,
    connectionId: CONNECTION,
    runId,
    credentialBundle: { generationSha256: GENERATION },
  }));
  writeFileSync(proof, "p".repeat(64));
  return { grant, proof, runId };
}

test("renders the exact fleet writer-fence entry without exposing it in the manifest", () => {
  const directory = mkdtempSync(join(tmpdir(), "fleet-fence-bundle-"));
  const value = fixture(directory);
  const prepared = prepareFleetWriterFenceSecretBundle({
    connectionId: CONNECTION,
    confirmConnection: CONNECTION,
    runId: value.runId,
    generationSha256: GENERATION,
    grantPath: value.grant,
    proofPath: value.proof,
  });
  const parsed = JSON.parse(prepared.source);
  assert.equal(parsed.entries[0].runId, value.runId);
  assert.equal(prepared.manifest.entryCount, 1);
  assert.equal(JSON.stringify(prepared.manifest).includes("p".repeat(32)), false);
  assert.equal(Object.hasOwn(prepared.manifest.entries[0], "rawGrant"), false);
});

test("fails closed on scope drift and an implicit connection replacement", () => {
  const directory = mkdtempSync(join(tmpdir(), "fleet-fence-bundle-"));
  const value = fixture(directory);
  assert.throws(() => prepareFleetWriterFenceSecretBundle({
    connectionId: CONNECTION,
    confirmConnection: CONNECTION,
    runId: "another-run",
    generationSha256: GENERATION,
    grantPath: value.grant,
    proofPath: value.proof,
  }), /GRANT_SCOPE_MISMATCH/);

  const base = join(directory, "base.json");
  writeFileSync(base, JSON.stringify({ version: 1, entries: [{
    connectionId: CONNECTION,
    runId: value.runId,
    generationSha256: GENERATION,
    rawGrant: readFileSync(value.grant, "utf8"),
    proof: "p".repeat(64),
  }] }));
  assert.throws(() => prepareFleetWriterFenceSecretBundle({
    connectionId: CONNECTION,
    confirmConnection: CONNECTION,
    runId: value.runId,
    generationSha256: GENERATION,
    grantPath: value.grant,
    proofPath: value.proof,
    baseBundlePath: base,
  }), /CONNECTION_ALREADY_PRESENT/);
});

test("writes private bundle and manifest outside the repository", () => {
  const directory = mkdtempSync(join(tmpdir(), "fleet-fence-bundle-"));
  const value = fixture(directory);
  const output = join(directory, "bundle.private.json");
  const result = writeFleetWriterFenceSecretBundle({
    connectionId: CONNECTION,
    confirmConnection: CONNECTION,
    runId: value.runId,
    generationSha256: GENERATION,
    grantPath: value.grant,
    proofPath: value.proof,
    output,
  });
  assert.equal(result.entryCount, 1);
  assert.equal(JSON.parse(readFileSync(output, "utf8")).entries.length, 1);
  assert.equal(JSON.parse(readFileSync(result.manifestPath, "utf8")).entries.length, 1);
});
