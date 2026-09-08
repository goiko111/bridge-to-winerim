# REST baseline per connection

`REST_BASELINE_RESULT=TOOLING_READY_OBSERVATIONAL_ONLY`

This path reads the Lovable PostgREST source sequentially and creates one
private `agora-shadow-v1` artifact per connection and pass. It never calls an
Edge Function or a provider and never writes remotely.

## Safe during service

- One connection at a time, one concurrent `GET`, default `500 ms` between
  requests and bounded retries that honor `Retry-After`.
- A maximum business-day window of 31 days. Split older history into monthly
  artifacts instead of increasing the request burst.
- Exact allowlisted columns only. Connection credentials and raw sales JSON
  are never requested or persisted.
- Keyset pagination by `id`, exact counts, private directories `0700` and
  files `0600`.
- One pass for low-impact observation; two passes when a drift estimate is
  useful. Both remain observational while Lovable can write.

Plan only, with no network or local writes:

```sh
npm run data:rest-baseline -- \
  --output-dir /encrypted/winerim-transfer/rest-YYYYMMDD/CONNECTION_ID \
  --connection-id CONNECTION_ID \
  --from-business-day YYYY-MM-DD \
  --through-business-day YYYY-MM-DD \
  --passes 2 \
  --page-size 500 \
  --min-interval-ms 500
```

Observed capture during service. Supply credentials only through a secure
environment; do not put them in arguments, Markdown, Git or shell history:

```sh
export LOVABLE_REST_URL='[secure source URL]'
export LOVABLE_REST_KEY='[secure read credential]'
npm run data:rest-baseline -- \
  --output-dir /encrypted/winerim-transfer/rest-YYYYMMDD/CONNECTION_ID \
  --connection-id CONNECTION_ID \
  --from-business-day YYYY-MM-DD \
  --through-business-day YYYY-MM-DD \
  --passes 2 \
  --page-size 500 \
  --min-interval-ms 500 \
  --confirm-source lovable-production \
  --apply
unset LOVABLE_REST_URL LOVABLE_REST_KEY
```

The output is:

```text
CONNECTION_ID/
  manifest.json
  connections/CONNECTION_ID/pass-1.json
  connections/CONNECTION_ID/pass-2.json
```

The manifest records request/row counts, rate-limit retries, source-marker
stability and semantic hashes. It always writes `mergeEligible=false` and
`REST_NON_TRANSACTIONAL_AND_WRITER_NOT_FENCED`.

## Reconciliation

Compare one Lovable pass with the equivalent own-infra pass. The report hashes
business identities and never prints document/order/product identities:

```sh
node scripts/agora-shadow-reconcile.mjs \
  --lovable /encrypted/.../lovable/connections/CONNECTION_ID/pass-2.json \
  --own /encrypted/.../own/connections/CONNECTION_ID/pass-2.json \
  --connection-id CONNECTION_ID \
  --dry-run
```

`RECONCILED_EXACT` is useful evidence, but is not by itself a cutover gate.

## Blocked by consistency

PostgREST pages and tables do not share the `REPEATABLE READ` snapshot used by
the official PostgreSQL export. During service, inserts or updates can occur
between `sales_events`, lines, receipts and cursor reads. Therefore a REST
artifact must not be used to:

- restore or merge rows;
- advance a cursor;
- mark historical/stock coverage complete;
- activate a writer or retire Lovable;
- replace the official PostgreSQL backup as the baseline.

An authoritative per-connection delta requires all of these gates:

1. Import/reconcile the official backup into a quiescent staging target.
2. Obtain signed external evidence that Lovable's writer for that connection
   is fenced, then wait at least `130 s`.
3. Capture two REST passes with stable before/after markers and identical
   semantic SHA-256 values.
4. Capture own-infra with the same window and reconcile exact events, lines,
   receipts and cursor.
5. Keep the writer disabled until the import/merge plan, rollback and readback
   are independently approved.

If any marker/hash/count differs, widen or repeat the read-only observation;
never retry a merge or cursor change from that artifact.
