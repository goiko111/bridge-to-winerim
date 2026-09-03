# Flama, O Bistro and Taberna de Elia - read-only inventory (2026-09-03)

No source request, scope activation, writer, catalog, sale, stock, cursor or
legacy mutation was performed.

| Restaurant | Connection | Own-infra control state | Mappings | Recent runtime evidence | Safe conclusion |
| --- | --- | --- | --- | --- | --- |
| Flama / TPV Valencia | `cdfd49e1-9375-4e2e-af5c-d015678b2327` | `enabled=false`, `PULL_ONLY/NONE`, catalog off, no breaker/queue/cycle | 0 | None | Inert and unprepared. A fresh authenticated source preflight is required before any catalog work; prior DNS/origin uncertainty remains unproven today. |
| O Bistro | `c0b4b35b-bce8-4927-9134-e23045cf7dcd` | `enabled=false`, `PULL_ONLY/NONE`, catalog off | 138/138 confirmed: 90 BOTTLE, 48 GLASS | Last records 2026-08-25. Catalog and some sales jobs succeeded, while intraday sales saw `503` from Agora invoices and later a writer-fence DB failure; outbound also saw unavailable Agora credentials. | Catalog identity is prepared, but there is no active writer or sales history. The client must make the TPV available for two fresh authenticated contractual reads before a new canary can be considered. |
| Taberna de Elia | `ae599bfb-d580-4250-9661-a97535d25e85` | `enabled=false`, `PULL_ONLY/NONE`, catalog off, no breaker/queue/cycle | 0 | None | Inert and unprepared. The previously reported 503/API condition needs two new authenticated `Families`/`Products`/`Invoices` reads before any recovery or SAT diagnosis can be updated. |

## Common rule

Neither an accessible administration panel nor a DNS response is evidence of
the contractual Agora API. The activation gate is authenticated `200/XML` on
the contractual master and invoices routes, twice with separation, followed by
snapshot, writer fence, single writer, and a natural sale/readback.

## Independent audit checkpoint

The parallel read-only snapshot at `2026-09-03T13:10:27.985392Z` was verified
under raw evidence SHA-256
`f7c47baf72638a2ef2ff29d2787d609d5368267054a629deefd1d72a6b4242f4`.
All three connections remain disabled with no own-infra events, line items,
claims or stock records.

- **Flama:** no own-infra master snapshot. The active documented gate is
  restoration and proof of Agora DNS plus port `8984` reachability.
- **O Bistro:** a persisted master contains 39 families, 879 products and 103
  wines, but has no current fetch timestamp or tracking evidence. Its safe
  next action is a fresh run only after the writer-fence DB dependency is
  stable.
- **Taberna de Elia:** no own-infra master snapshot. The documented source
  route has returned `404` since 2026-07-27; it needs routing restoration and
  invoice enumeration without cursor or stock changes.
