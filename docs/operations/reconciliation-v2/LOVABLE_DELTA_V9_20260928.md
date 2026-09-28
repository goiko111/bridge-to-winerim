# Lovable delta v9 — canonical formats and split-detail matching

Apply this delta on commit `6fe70f1545defd69000efc29da2375fd2e7c0613`.

## Narrow objective

Fix the Clinic canary mismatch without changing source ingestion or business data:

- treat the contractually equivalent format labels `BOT`/`botella` and `COPA`/`copa` as equal;
- when one closed Ágora line is represented by several Winerim detail rows, group them only if they belong to the same Winerim `saleId` and their exact timestamp, wine, canonical format, total quantity and total amount all match;
- keep duplicate candidates from different sales ambiguous and unconsumed.

## Validation already passed locally

- reconciliation tests: 85/85;
- reconciliation typecheck: PASS;
- reconciliation build: PASS.

## Single production gate

1. Verify the ZIP SHA-256 supplied in the chat.
2. Run the focused reconciliation tests, typecheck, build and Deno check for `run-daily-reconciliation`.
3. Deploy **only** `run-daily-reconciliation`.
4. Invoke Clinic (`1c5177f1-9459-4ee9-8b6e-4780f8b6b96b`) for business day `2026-09-26` exactly once with `dryRun:true`.
5. Return the state distribution for the 28 mapped Ágora wine lines and the Winerim-only rows, plus the concrete invoice ids in `HISTORY_MISSING` or `AMBIGUOUS`.

Expected direction from the live evidence: the previous 1/28 matched result must materially improve. `27991` should match via grouped details; duplicates such as wine `70743` at `13:34:17` and glass `70760` at `15:46:58` must remain ambiguous. Do not force a precise total if live data contradicts it.

## Guardrails

No migration, Publish, cron, mappings, bindings, repairs, sales import, stock mutation, backfill, `refresh-current-stock`, global verifier or evidence re-ingestion. Do not persist reconciliation results. On a failed check or a new contradiction, stop without retrying.
