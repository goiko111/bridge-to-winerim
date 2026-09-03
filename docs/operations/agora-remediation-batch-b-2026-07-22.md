# Agora remediation batch B - 2026-07-22

## Scope

Production remediation limited to:

- Sa Vida
- De la O
- El Bejeque

The work used existing per-connection scripts and runtime actions. No Edge Function,
migration, shared-code, frontend, or session-document changes were made.

Safety sequence used throughout:

1. Fresh read-only audit.
2. Configuration and catalog snapshot.
3. Dry-run or read-only diagnosis.
4. Differential write only where deterministic.
5. Immediate fresh verification.
6. Rollback or operational stop when a safety gate failed.

## Evidence and rollback material

- `outputs/AGORA_REMEDIATION_BATCH_B_CONFIG_ROLLBACK_REFRESHED_2026-07-22.json`
- `outputs/AGORA_REMEDIATION_BATCH_B_CONFIG_APPLIED_2026-07-22.json`
- `outputs/AGORA_REMEDIATION_BATCH_B_POLICY_APPLIED_2026-07-22.json`
- `outputs/AGORA_REMEDIATION_BATCH_B_FINAL_VERIFY_2026-07-22.json`
- `docs/operations/agora-catalog-reconciliation-2026-07-22T10-15-50-753Z/sa-vida.json`

The refreshed configuration snapshot is the source for restoring the previous
`provider_config` and `auto_push_verified_ready` values. No rollback was needed for
De la O or El Bejeque because no historical records were written. Sa Vida's unsafe
initial readiness activation was rolled back during the run; a later deterministic
tracking repair and clean canary allowed the flag to be enabled safely.

## Sa Vida

### Initial facts

- Expected Agora formats: 1,541.
- Exact formats before remediation: 1,532.
- Missing formats: 4.
- Different formats: 5.
- Unowned formats: 0.
- Active outbound queue: 0.
- `auto_push_verified_ready`: disabled.

The nine catalog discrepancies affected the following wines/formats:

- Dominio de Es, bottle: price.
- Ester Canale Langhe Nebbiolo, bottle: missing.
- Giovanni Rosso Barolo, bottle: price.
- Giovanni Rosso Barolo Vigna Rionda Ester Canale, bottle: missing.
- Marta Mate, glass: name, button, family, saleability, and price.
- Pairal, bottle: price.
- Primordium, glass: saleability and price.
- Tavel Posterite de Clary, bottle: missing.
- Tavel Posterite de Clary, glass: missing.

### Applied remediation

The existing catalog reconciliation script applied only the nine expected format
changes in three small batches. Each batch passed immediate inline verification:

- Bottle batch: 5/5 exact.
- Glass batch: 2/2 exact.
- Bottle and glass batch: 2/2 exact.

The connection was also changed to the safe live-sales policy:

- Open tickets: observation enabled.
- Open-ticket stock/history writes: disabled.
- Closed invoices: definitive source for Winerim stock and sales history.

### Verified-ready safety result

The catalog and ownership checks were exact, so `auto_push_verified_ready` was
briefly enabled to test the real readiness gate. The detector immediately exposed
tracking debt that the catalog comparison alone did not show:

- 31 automatic create tasks were generated from stale tracking state.
- 7 tasks had already started and completed successfully.
- 24 queued tasks were stopped as `BLOCKED` with reason `READINESS_ROLLBACK`.
- `auto_push_verified_ready` was restored to disabled.
- Active queue after rollback: 0.

This was the result of the first readiness probe. It has been superseded by the
dedicated tracking reconciliation described below; the original rollback remains
part of the audit trail.

The tracking audit found 561 expected formats without a current `VERIFIED` or
`PUSHED` tracking state. A separate product verification found seven retired glass
formats absent from Agora and already marked hidden. Those seven absences are
consistent with their retired state; they do not invalidate the fresh catalog.

Evidence:

- `outputs/AGORA_REMEDIATION_BATCH_B_SA_VIDA_READINESS_ROLLBACK_2026-07-22.json`
- `outputs/AGORA_REMEDIATION_BATCH_B_SA_VIDA_GENERATED_TASKS_2026-07-22.json`
- `outputs/AGORA_REMEDIATION_BATCH_B_SA_VIDA_TRACKING_SAFETY_2026-07-22.json`
- `outputs/AGORA_REMEDIATION_BATCH_B_SA_VIDA_VERIFY_PRODUCTS_2026-07-22.json`

### Fresh verification and status

- Connection test: PASS.
- Catalog: 1,541/1,541 exact.
- Missing: 0.
- Different: 0.
- Unowned: 0.
- Active queue: 0.
- Open-ticket provisional writes: neutralized.
- `auto_push_verified_ready`: enabled after the dedicated tracking repair and
  canary described below.
- Open alert: one outbound-queue alert caused by the 24 intentionally blocked
  readiness-probe tasks from the initial failed probe. It does not represent an
  active queue.

Status: **CATALOG_FIXED / VERIFIED_READY_ENABLED**.

The operational catalog incident and the eligible-format tracking debt are
corrected. The blocked-task alert is retained as production evidence of the first
probe; it should only be resolved when alerting can distinguish historical blocked
tasks from an active queue.

### Dedicated tracking reconciliation

The initially reported debt of 561 formats was recalculated before writing. The
first read used pagination without a stable order on a tracking result larger than
the 1,000-row REST page size. Rows moved between pages and 301 valid tracking rows
were incorrectly classified as absent.

The stable read used `order=id.asc` and established the real debt:

- Initial reported debt: 561.
- Actual debt: 260.
- Existing rows in `FAILED`: 195.
- Missing tracking rows: 65.
- Exact ownership proof: 260/260.
- Unsafe or ambiguous rows: 0.

Ownership was accepted only when every format passed all of these checks:

1. Fresh Agora audit status `MATCH` and `ownedByWinerim=true`.
2. Deterministic product ID for its Winerim wine and format.
3. Product present in the latest fresh Agora master.
4. Exact name after XML entity decoding and exact family ID.
5. Exactly one `CONFIRMED` mapping for the same product, wine, and format.
6. No product-ID or wine-format mapping conflict.
7. Existing tracking, when present, compatible with the same product and source.

Six names initially failed a raw text comparison only because the fresh master
stored `&amp;` while the audit exposed the decoded `&`. They passed after applying
the same XML entity decoding used by the runtime. No fuzzy or canonical-name-only
ownership was accepted.

The reversible repair changed tracking only:

- 195 existing rows updated to `VERIFIED` and cleared of stale retirement errors.
- 65 missing rows inserted as `WINERIM/VERIFIED`.
- Product mappings changed: 0.
- Agora products changed: 0.
- Winerim historical sales changed: 0.
- Catalog after repair: 1,541/1,541 exact.
- Eligible formats without `VERIFIED` or `PUSHED`: 0.
- Active queue after repair: 0.

There are 248 tracking rows outside the current eligible catalog: 134 `HIDDEN`,
107 `NOT_PUSHED`, 2 `VERIFIED`, and 5 `FAILED`. A fresh product check found zero
extra `VERIFIED`/`PUSHED` rows that remain saleable, so they do not block readiness.

Two safety rollbacks were exercised during the repair:

- A mixed-shape REST batch was rejected atomically with HTTP 400 before any row
  was written.
- A subsequent verification still used unstable pagination, reported 301 false
  unresolved rows, and triggered rollback: 65 inserted rows were deleted and 195
  existing rows restored. A stable read confirmed the original 195 `FAILED` plus
  65 missing state before the final repair.

### Verified-ready canary

The first long-running canary process ended without a success artifact. The flag was
therefore closed immediately; the fail-closed check found zero active or newly
created tasks.

The final monitorable canary then enabled `auto_push_verified_ready` and exercised
the 232 wines represented by the repaired formats in 24 small batches:

- Forced CREATE dry-run: 0 queued, 0 would-queue, 0 hide tasks.
- Actual CREATE idempotency path: 0 queued, 0 would-queue, 0 hide tasks.
- Actual UPDATE differential path: 0 queued, 0 would-queue, 0 hide tasks.
- Fresh catalog after canary: 1,541/1,541 exact.
- Active queue after canary: 0.
- Expected tracking missing: 0.
- Observation after 6.19 minutes: flag still enabled, catalog exact, active queue 0.

The direct status queries also found zero `QUEUED`, `RUNNING`, `FAILED`, or
`BLOCKED` tasks created since activation. The broad `SUCCESS` history query exceeded
the database statement timeout; this does not affect the canary result because all
three invoked paths returned `queued=0` and no active task appeared during or after
the observation window.

Additional evidence:

- `outputs/AGORA_REMEDIATION_BATCH_B_SA_VIDA_TRACKING_REPAIR_DRY_RUN_V3_STABLE_2026-07-22.json`
- `outputs/AGORA_REMEDIATION_BATCH_B_SA_VIDA_TRACKING_REPAIR_PRE_APPLY_SNAPSHOT_V3_2026-07-22.json`
- `outputs/AGORA_REMEDIATION_BATCH_B_SA_VIDA_TRACKING_REPAIR_APPLIED_V3_2026-07-22.json`
- `outputs/AGORA_REMEDIATION_BATCH_B_SA_VIDA_TRACKING_REPAIR_RETIRED_SAFETY_2026-07-22.json`
- `outputs/AGORA_REMEDIATION_BATCH_B_SA_VIDA_VERIFIED_READY_SNAPSHOT_V2_2026-07-22.json`
- `outputs/AGORA_REMEDIATION_BATCH_B_SA_VIDA_VERIFIED_READY_CANARY_V2_2026-07-22.json`
- `outputs/AGORA_REMEDIATION_BATCH_B_SA_VIDA_VERIFIED_READY_FINAL_VERIFY_2026-07-22.json`
- `outputs/AGORA_REMEDIATION_BATCH_B_SA_VIDA_VERIFIED_READY_TASKS_BY_STATUS_2026-07-22.json`

Tracking rollback is fully defined by the V3 snapshot: delete the 65 rows whose
keys were previously absent and restore the 195 original rows by ID. Flag rollback
is a single connection-scoped change back to `auto_push_verified_ready=false` using
the V2 flag snapshot.

### Catalog rollback note

No catalog rollback was executed because all nine desired changes passed fresh
verification. The four newly created formats can be reversibly hidden if a rollback
is requested. Restoring the five previously incorrect values would require a
client-approved prior-value source; the snapshot identifies each difference but is
not a complete prior XML backup. Reapplying the current Winerim catalog remains the
safe recovery path.

## De la O

### Applied remediation

The provisional-write path was neutralized per connection:

- Open tickets remain available for observation.
- Open-ticket stock/history writes are disabled.
- Closed invoices and refunds are the definitive source.
- Legacy is preserved unless an official replacement is confirmed.

Two consecutive runtime probes after the policy change produced no stock or sales
write. No active queue remains.

### External-ID diagnosis

#### Camarolos

- Legacy Agora product: external ID 1116, `CAMAROLOS botella`.
- Official Winerim-owned product: external ID 620749, `B Camarolos`.
- Confirmed mapping: Agora 620749 to Winerim 120749, bottle.
- Two closed invoice lines exist on 2026-07-16, each with quantity 1.
- One definitive Winerim operation records target quantity 2.

The two invoice lines have deterministic Agora history IDs in dry-run, but the
existing Winerim card cannot be safely bound to one of them with a reversible
operation. No history was imported or rewritten.

#### Vina Mein

- Legacy Agora product: external ID 2735, `MEIN botella`.
- Official Winerim-owned product: external ID 766218,
  `B Vina Mein Val Do Avia`.
- Confirmed mapping: Agora 766218 to Winerim 266218, bottle.
- Definitive source contains two invoices and one refund on 2026-07-17.
- Definitive net quantity should therefore be 1.
- Existing Winerim records reflect quantity 2 and cannot be safely reduced through
  a documented reversible sales endpoint.

No historical correction was attempted. This follows the explicit rule not to
rewrite history when the relationship is not deterministic and reversible.

Evidence:

- `outputs/AGORA_REMEDIATION_BATCH_B_DE_LA_O_EXTERNAL_ID_DIAGNOSIS_2026-07-22.json`
- `outputs/AGORA_REMEDIATION_BATCH_B_DE_LA_O_2026-07-16_DRY_RUN.json`
- `outputs/AGORA_REMEDIATION_BATCH_B_DE_LA_O_CLOSED_SOURCE_VERIFY_2026-07-22.json`

### Fresh verification and status

- Connection test: PASS.
- Catalog: 119/119 exact.
- Missing/different/unowned: 0/0/0.
- Active queue: 0.
- Open alerts: 0.
- Future provisional duplication path: neutralized.
- Historical Camarolos/Vina Mein records: preserved and documented.

Status: **FUTURE_FLOW_FIXED / HISTORY_PRESERVED**.

## El Bejeque

### Verification

The connection already had the required definitive-source policy:

- Open tickets: read-only observation.
- Open-ticket stock/history writes: disabled.
- Closed invoices: unique definitive source.

Two consecutive open-ticket probes returned no saved events, no saved lines, and no
stock synchronization. Since provisional writes were disabled, the audit found:

- 0 new provisional stock logs.
- 0 open-ticket source writes.
- 0 exact duplicate keys.
- 0 active tasks.

Catalog fresh verification:

- Expected: 94.
- Exact: 94.
- Missing/different/unowned: 0/0/0.

No history was rewritten.

Evidence:

- `outputs/AGORA_REMEDIATION_BATCH_B_BEJEQUE_CLOSED_SOURCE_VERIFY_2026-07-22.json`

Status: **PASS_CURRENT_FLOW / HISTORY_PRESERVED**.

## Final matrix

| Connection | Connectivity | Catalog | Definitive sales source | Active queue | Result |
|---|---|---:|---|---:|---|
| Sa Vida | PASS | 1,541/1,541 | Closed invoices | 0 | Catalog and tracking fixed; verified-ready enabled |
| De la O | PASS | 119/119 | Closed invoices/refunds | 0 | Future flow fixed; history preserved |
| El Bejeque | PASS | 94/94 | Closed invoices | 0 | PASS; no new duplication |

## Remaining production actions

1. Sa Vida: observe at least 24 hours of automatic catalog cycles and confirm that
   no new task or catalog discrepancy appears.
2. Sa Vida: keep the historical readiness rollback alert visible until monitoring
   can separate intentionally blocked historical tasks from an active queue; do not
   relabel blocked tasks as successful.
3. De la O: leave the two historical discrepancies unchanged unless Winerim exposes
   a documented idempotent cancellation/correction operation or the client approves
   a deterministic compensating workflow.
4. El Bejeque: continue observing closed-invoice-only operation; no remediation is
   currently required.

## Change boundary confirmation

- Edge Functions edited: no.
- Migrations edited or applied: no.
- Shared code edited: no.
- Frontend edited: no.
- Session documents edited: no.
- Historical Winerim sales rewritten: no.
