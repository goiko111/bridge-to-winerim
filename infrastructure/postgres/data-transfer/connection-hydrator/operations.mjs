function setTransactionOutcome(error, outcome) {
  if (error && typeof error === "object") error.transactionOutcome = outcome;
  return error;
}

export async function executeWriteTransaction(database, operation) {
  await database.beginWrite();
  let phase = "ACTIVE";
  try {
    const value = await operation();
    phase = "COMMITTING";
    await database.commit();
    phase = "COMMITTED";
    return value;
  } catch (error) {
    if (phase === "ACTIVE") {
      let rollbackError = null;
      try {
        await database.rollback();
      } catch (caught) {
        rollbackError = caught;
      }
      if (rollbackError) {
        const failure = new AggregateError(
          [error, rollbackError],
          `TRANSACTION_ROLLBACK_OUTCOME_UNKNOWN:${error?.message || error}`,
        );
        failure.transactionOutcome = "UNKNOWN";
        throw failure;
      }
      throw setTransactionOutcome(error, "ROLLED_BACK");
    }
    throw setTransactionOutcome(error, phase === "COMMITTED" ? "COMMITTED" : "UNKNOWN");
  }
}

export async function runJournaledMutation({
  artifact,
  executeCommittedMutation,
  buildReceipt,
  afterCommit = null,
}) {
  if (artifact.existing) {
    return {
      receipt: artifact.existing,
      reusedExisting: true,
      mutationExecuted: false,
    };
  }

  const mutation = await executeCommittedMutation();
  if (afterCommit) await afterCommit();
  const proposedReceipt = buildReceipt(mutation, {
    journalId: artifact.journal.journalId,
    recoveredFromPreparedJournal: artifact.resumedPrepared,
  });
  const finalized = await artifact.finalize(proposedReceipt);
  return {
    receipt: finalized.value,
    reusedExisting: finalized.reusedExisting,
    mutationExecuted: true,
  };
}
