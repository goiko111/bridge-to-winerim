import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { prepareAtomicResultArtifact } from "./artifacts.mjs";
import { executeWriteTransaction, runJournaledMutation } from "./operations.mjs";

const CONNECTION_ID = "e465872a-bff5-43de-8e4c-fe4986f0fd4f";
const PLAN_SHA256 = "c".repeat(64);

class FakeDatabase {
  constructor(initialState, { failCommitAcknowledgementOnce = false } = {}) {
    this.durableState = initialState;
    this.pendingState = null;
    this.failCommitAcknowledgementOnce = failCommitAcknowledgementOnce;
    this.mutationCount = 0;
    this.commitCount = 0;
    this.rollbackCount = 0;
  }

  async beginWrite() {
    assert.equal(this.pendingState, null);
    this.pendingState = this.durableState;
  }

  readState() {
    return this.pendingState;
  }

  mutate(nextState) {
    this.pendingState = nextState;
    this.mutationCount += 1;
  }

  async commit() {
    this.durableState = this.pendingState;
    this.pendingState = null;
    this.commitCount += 1;
    if (this.failCommitAcknowledgementOnce) {
      this.failCommitAcknowledgementOnce = false;
      throw new Error("INJECT_COMMIT_ACK_LOST");
    }
  }

  async rollback() {
    this.pendingState = null;
    this.rollbackCount += 1;
  }
}

function artifactOptions(operation, resultName, faultInjector = null) {
  return {
    validateExisting(value) {
      assert.equal(value.result, resultName);
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

function scenario(operation) {
  const apply = operation === "HYDRATE";
  return {
    operation,
    filename: apply ? "apply-result.json" : "rollback-result.json",
    resultName: apply ? "INACTIVE_HYDRATION_APPLIED" : "INACTIVE_HYDRATION_ROLLED_BACK",
    initialState: apply ? "PREIMAGE" : "POSTIMAGE",
    committedState: apply ? "POSTIMAGE" : "PREIMAGE",
    countField: apply ? "inserted" : "deleted",
  };
}

async function runAttempt({ root, database, settings, faultInjector = null }) {
  const artifact = await prepareAtomicResultArtifact(
    root,
    settings.filename,
    artifactOptions(settings.operation, settings.resultName, faultInjector),
  );
  return runJournaledMutation({
    artifact,
    executeCommittedMutation: () => executeWriteTransaction(database, async () => {
      if (database.readState() === settings.committedState) {
        return { count: 0, idempotentReplay: true };
      }
      assert.equal(database.readState(), settings.initialState);
      database.mutate(settings.committedState);
      return { count: 1, idempotentReplay: false };
    }),
    buildReceipt: (mutation, journal) => ({
      result: settings.resultName,
      connectionId: CONNECTION_ID,
      planSha256: PLAN_SHA256,
      databaseCommitState: "CONFIRMED",
      journalId: journal.journalId,
      recoveredFromPreparedJournal: journal.recoveredFromPreparedJournal,
      [settings.countField]: mutation.count,
      idempotentReplay: mutation.idempotentReplay,
    }),
  });
}

for (const operation of ["HYDRATE", "ROLLBACK"]) {
  test(`${operation} recovers post-commit receipt publication failures without repeating the database mutation`, async (t) => {
    for (const failureStage of [
      "result:after-temp-chmod",
      "result:before-directory-fsync",
      "journal-finalized:before-rename",
      "journal-finalized:after-chmod",
    ]) {
      await t.test(failureStage, async () => {
        const settings = scenario(operation);
        const root = await mkdtemp(path.join(os.tmpdir(), `connection-hydrator-${operation.toLowerCase()}-`));
        await chmod(root, 0o700);
        const database = new FakeDatabase(settings.initialState);

        await assert.rejects(runAttempt({
          root,
          database,
          settings,
          faultInjector(stage) {
            if (stage === failureStage) throw new Error(`INJECT:${stage}`);
          },
        }), new RegExp(`INJECT:${failureStage}`));

        assert.equal(database.durableState, settings.committedState);
        assert.equal(database.mutationCount, 1);
        assert.equal(database.rollbackCount, 0);

        const replay = await runAttempt({ root, database, settings });
        assert.equal(replay.receipt.result, settings.resultName);
        assert.equal(replay.receipt.databaseCommitState, "CONFIRMED");
        assert.equal(database.mutationCount, 1);
        assert.equal(database.rollbackCount, 0);
        assert.equal(JSON.parse(await readFile(path.join(root, `${settings.filename}.journal.json`), "utf8")).state, "FINALIZED");
        assert.deepEqual((await readdir(root)).filter((name) => name.endsWith(".tmp")), []);
      });
    }
  });

  test(`${operation} resolves a lost COMMIT acknowledgement by replay readback and never reports rollback`, async () => {
    const settings = scenario(operation);
    const root = await mkdtemp(path.join(os.tmpdir(), `connection-hydrator-${operation.toLowerCase()}-commit-`));
    await chmod(root, 0o700);
    const database = new FakeDatabase(settings.initialState, { failCommitAcknowledgementOnce: true });

    await assert.rejects(
      runAttempt({ root, database, settings }),
      (error) => error.message === "INJECT_COMMIT_ACK_LOST" && error.transactionOutcome === "UNKNOWN",
    );
    assert.equal(database.durableState, settings.committedState);
    assert.equal(database.mutationCount, 1);
    assert.equal(database.rollbackCount, 0);
    assert.equal(JSON.parse(await readFile(path.join(root, `${settings.filename}.journal.json`), "utf8")).state, "PREPARED");

    const replay = await runAttempt({ root, database, settings });
    assert.equal(replay.receipt.idempotentReplay, true);
    assert.equal(replay.receipt.recoveredFromPreparedJournal, true);
    assert.equal(database.mutationCount, 1);
    assert.equal(database.rollbackCount, 0);
  });
}

test("pre-commit failures perform a real rollback and retain PREPARED intent for a safe retry", async () => {
  const database = new FakeDatabase("PREIMAGE");
  const failure = await executeWriteTransaction(database, async () => {
    throw new Error("INJECT_PRECOMMIT");
  }).catch((error) => error);
  assert.equal(failure.transactionOutcome, "ROLLED_BACK");
  assert.equal(database.durableState, "PREIMAGE");
  assert.equal(database.rollbackCount, 1);
});

test("a failed rollback is reported as UNKNOWN rather than a false rollback", async () => {
  const database = new FakeDatabase("PREIMAGE");
  database.rollback = async () => {
    throw new Error("INJECT_ROLLBACK_ACK_LOST");
  };
  const failure = await executeWriteTransaction(database, async () => {
    throw new Error("INJECT_PRECOMMIT");
  }).catch((error) => error);
  assert.equal(failure.transactionOutcome, "UNKNOWN");
  assert.match(failure.message, /TRANSACTION_ROLLBACK_OUTCOME_UNKNOWN/);
  assert.equal(database.durableState, "PREIMAGE");
});
