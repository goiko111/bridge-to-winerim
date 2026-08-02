# Final infrastructure gates - 2026-08-02

`FINAL_INFRA_GATES_RESULT=LOCAL_GATES_CLOSED_REMOTE_NO_GO`

## Facts

- Worktree: `/private/tmp/winerim-final-infra-gates`.
- Branch: `codex/final-infra-gates`.
- Reviewed base: `3b9d4fa`.
- Runtime readiness now requires exactly the active `AGORA` and `WINERIM`
  credential rows for the one approved, unexpired canary connection.
- Executor readiness opens the scoped connection, reads Cloudflare Secrets
  Store through `.get()` and proves that both credential rows decrypt. It does
  not call either provider and returns only sanitized readiness states.
- Existing 28-table staging can be upgraded only from the exact reviewed
  inventory. State 29 or any other partial inventory is rejected; exact 30 is
  a no-op.
- `0003..0005` are stripped of their nested transaction wrappers and applied in
  one transaction under an advisory lock.
- Before DDL, the upgrade requires an explicitly confirmed encrypted directory,
  writes mode-`0600` schema/data/ACL/policy backup artifacts, role/membership
  inventory, TOC and SHA-256 digests, then restores them into disposable local
  PostgreSQL.
- Post-upgrade requires exact 30-table inventory, empty new runtime tables,
  the expected policy/function/trigger/index contract and an unchanged
  per-table data fingerprint.
- The reviewed rollback requires empty canary/credential tables and is proven
  locally to return the database from 30 to the exact 28-table prestate.
- Project identity is immutable: `qpbmqvfnunkylvtvnyyx`, database `postgres`,
  direct host or project-scoped session pooler, port `5432`. Port `6543`, wrong
  refs and password-based identity tricks are rejected.
- Transfer manifests are described as checksummed/digest-verified, not signed.
- No remote connection, deploy, migration, secret read or production mutation
  was performed in this block.

## Decisions

- Bootstrap of an empty database and upgrade of an existing 28-table database
  are separate workflow modes.
- A GitHub variable cannot redefine the staging project identity.
- Runtime, canary and production remain fail-closed after this code change.

## Validation

- Full Vitest: `452 passed`, `3 skipped` (remote integration tests skipped).
- Focused runtime/transfer/upgrade suite: `224/224`.
- TypeScript: passed.
- Focused ESLint: passed.
- Vite production build: passed; existing chunk-size/Browserslist warnings only.
- `test-runtime-upgrade.sh`: `28 -> 30 -> 28`, exact-30 no-op, partial-29 reject,
  backup restore and unchanged data fingerprint passed.
- `test-verify-staging.sh`: passed, including a real negative missing-index case.
- Empty PostgreSQL replay: `EMPTY_REPLAY_HARDENED_OK`, 30 tables, all RLS.
- Wrangler dry-runs: API, inert runtime, inert executor, runtime canary, executor
  canary and canary-consumer removal all passed with Node 24.

## Contradictions resolved

- The live staging snapshot previously documented 28 tables while the local
  desired schema has 30. This is an unapplied, now executable upgrade, not an
  unexplained schema drift.
- SHA-256 detects accidental or unauthorised content changes under controlled
  custody; it is not a cryptographic signature without key management.

## Remaining risks and gates

1. Remote schema upgrade is `NO-GO` until an operator records the plan digest,
   configures a persistent encrypted backup directory and supplies the exact
   protected confirmations. Plan-only remains the default.
2. Canary is `NO-GO` until staging is on 30 tables, one real connection scope is
   approved/unexpired, both encrypted credential rows exist and the Cloudflare
   Secrets Store binding is provisioned.
3. Production/cutover remains `NO-GO`; this branch contains no production
   configuration or production approval.
