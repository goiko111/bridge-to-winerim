# Casa Esteban and Clinic gates (read-only, 2026-09-03)

## Taberna del Clinic

Connection: `1c5177f1-9459-4ee9-8b6e-4780f8b6b96b`.

Clinic is already active in own-infra. Four natural BOTTLE sales on
2026-09-02 were verified end to end:

| Agora invoice | Winerim wine | Mapping | Claim | Stock receipt |
| --- | ---: | --- | --- | --- |
| 27686 | 70941 | CONFIRMED | SUCCESS | SUCCESS, 2.41 s before claim |
| 27687 | 70821 | CONFIRMED | SUCCESS | SUCCESS, 1.57 s before claim |
| 27688 | 226528 | CONFIRMED | SUCCESS | SUCCESS, 1.74 s before claim |
| 27689 | 70947 | CONFIRMED | SUCCESS | SUCCESS, 1.52 s before claim |

The stock receipt records do not retain `sales_line_item_id` for these four
events. Their matching wine, BOTTLE format, unit quantity and unique temporal
window proves the observed exact-once application, while documenting an
observability gap.

Certification remains incomplete: the 24-hour runtime cut contains 22 RETRY,
2 RUNNING and 78 TERMINAL entries. The 22 RETRY are catalogue HTTP 503
(`RUNTIME_EXECUTOR_UNAVAILABLE` or `CATALOG_APPLY_UNAVAILABLE`), and the
36 sales TERMINAL are HTTP 422 `RUNTIME_FLEET_SCOPE_REJECTED`. Neither of the
two RUNNING records has a live lease. A fresh read at 11:21Z showed breaker
closed, zero consecutive failures, zero live leases, and fresh `SUCCESS`
executions for both sales jobs, both catalogue jobs and outbound. No replay or
stock mutation was executed.

Three hours of fresh executions showed a p95 interval of 300–309 seconds for
catalogue fetch, catalogue apply, outbound, sales auto-sync, and intraday
sales sync. The historical failures are not a live queue: no new failure was
observed after 02:03Z, the breaker is closed, and no lease is active. This
certifies the observed BOTTLE path and runtime cadence, but not `OK_100`:
there is no natural GLASS sale in the available evidence and receipts still do
not directly retain `sales_line_item_id`.

### 2026-09-03 service observation

The `12:31Z` read-only receipt found four closed business-day records. They
represent invoice `200` and its compensating refund plus invoice `201` and its
compensating refund; the source sale times are on 2026-09-02. There are two
wine candidates, both mapped `BOTTLE`, and no `GLASS` line. The one new
`sales.claim` and the one stock receipt are `SUCCESS`; there is no live lease
or outbound queue, the breaker has no expiry, and both sales jobs completed
successfully. This is healthy closed-invoice processing, but it is not the
natural GLASS evidence needed for the last certification gate. Open orders are
not treated as sales by design and will remain out of the history until Agora
closes the invoice.

The later invoice `27690` contains two `GLASS` units, but they are the legacy
generic button `COPA VINO TINTO` (provider product `425`) under `VINOS A
COPAS`, at 9 EUR each. It has no Winerim mapping or tracking record and is not
a wine candidate. The runtime correctly did not infer a wine identity or
mutate stock. It is evidence that the source is alive, not the Winerim GLASS
canary; the first sale through a Winerim-owned GLASS button remains required.

## Clinic legacy visibility gate

The legacy-hiding preflight is **blocked**. Clinic is live with 504 confirmed
and verified Winerim mappings (465 BOTTLE, 27 GLASS, 12 MAGNUM), but the last
90-day source history includes unmapped legacy wine/cup candidates. Examples
include generic `COPA VINO TINTO`/`COPA VINO ROSADO` under `VINOS A COPAS` and
legacy named wines in `VINO BLANCO`. They cannot be hidden as a block without
an exact coverage decision for each product. No legacy visibility was changed.

## Casa Esteban

Connection: `5bed7bf7-f28a-4a1c-95f4-bc02ecb9298f`.

At `2026-09-03T10:47:00Z`, the connection was `enabled=false`,
`sync_mode=PULL_ONLY`, `write_mode=NONE`, and catalogue sync disabled. It had
no live lease, breaker, active scope, active credential, or active writer
fence. Six encrypted credential records exist but are retired, including the
latest observed run `casa-esteban-fleet-p1` retired at 09:00Z.

After the subsequent prepared-state readback, a fresh encrypted envelope generation
`casa-esteban-ro-20260903-a` was applied by an internal `INSERT ... SELECT`
from the latest aborted source generation. It has exactly two inactive
AES-GCM credential records (`agora`, `winerim`), an inactive `PREPARED` scope,
and the connection remains `enabled=false`, `PULL_ONLY/NONE`, with zero active
credentials, scopes, leases, or fences. No plaintext credential was read.

Result: `PREPARED_CASA_ESTEBAN_READONLY_ENVELOPE_INERT`.

### Completed read-only preflight

The bounded internal worker version `1cd46e41-0a56-4d3e-802d-20dce7d15748`
ran at `12:11:02Z` and `12:16:02Z`. Both runs were fixed-host, authenticated
GET-only, and returned the same sanitized evidence: `Families` `200` / 24,
`Products` `200` / 539, and `Invoices` `200` / 4. The master hashes matched
between both reads. During both runs, the connection remained disabled, the
scope was the sole temporary Casa scope, and no lease existed.

The scope was revoked at `12:16:46Z`; readback confirmed zero active Casa
credentials/scopes/leases and unchanged `PULL_ONLY/NONE`. The preflight proves
source connectivity only. It is not a writer or a business-sale certification.

### Fresh cutover snapshot

The subsequent cutover preflight confirms Casa still has zero active
credentials, scopes, writer-fence records and live leases. The own-infra
connection is still disabled with catalogue sync off and `PULL_ONLY/NONE`.
There are no Casa jobs in flight to drain. This is a valid preimage, but it
does not authorize fencing the current external writer: the matching fresh
grant must be present before the fence and activation can be performed as one
reversible operation.

### Canary gate remaining

The live fleet configuration already contains the Casa catalog profile. The
remaining internal prerequisite is a freshly generated, per-connection
writer-fence grant placed into the protected fleet bundle. It must be bound to
a new credential generation and activation package. No placeholder hash or
reuse of the aborted read-only scope is acceptable. Until that grant is
materialized through the normal Secret Store path, Casa remains inert and
cannot honestly be labelled `OK_100`.

Minimum safe next gate: deploy a dedicated worker that is fixed to this
connection and supports authenticated Agora `GET` for master and invoices
only. It must use the temporary envelope only during a short expiry window,
emit sanitized hashes/statuses, and be revoked before any writer canary. The
current `adopt-existing` activator remains unsuitable because it changes
`pos_connections.enabled=true`.
