# Fleet sale-routing readiness - staging checkpoint (2026-09-03)

## Scope and safety boundary

This checkpoint is local/staging only, based on Git commit `729f640`. It does
not deploy a Worker, activate a connection, create a writer scope, read or
write production configuration, process sales, modify stock, advance cursors,
or enqueue any work.

## Implemented fail-closed audit

`cloudflare/workers/middleware-runtime/src/handlers/catalog/sale-routing-readiness.ts`
adds a pure, deterministic audit for Winerim-managed active `BOTTLE` and
`GLASS` products. For every selected SaleCenter it requires:

- an existing, non-deleted SaleCenter;
- an effective, active price list, resolving `CurrentPriceListId` before the
  fallback `PriceListId`;
- a non-empty family, normal saleability, and no direct-sale flag;
- a complete preparation type plus preparation-order pair whose two master
  records are active; and
- a positive price for the effective SaleCenter price list.

The result is `READY` only when every selected center covers every expected
bottle and glass product. It returns deterministic issue codes and per-center
coverage for an operator-facing readiness receipt. Legacy products and formats
outside bottle/glass are deliberately out of scope for this gate.

## Evidence

- Focused auditor suite: 6/6 tests passed.
- Full Fleet Runtime suite: 31/31 tests passed across 6 files.
- Direct TypeScript check for the new module and tests passed.
- `git diff --check` passed.

The tests cover two centers, effective price-list precedence, absent master
records, empty center selection, incomplete or unknown preparation routing,
saleability flags, non-positive prices, and immutable input.

## Remaining gate

`sale-routing-readiness-collector.ts` now provides the local harness for that
next step. It receives an injected authenticated read-only Agora client and,
for one connection only, requests `SaleCenters`, `PriceLists`,
`PreparationTypes`, `PreparationOrders`, and `Products`. It returns only
filter, HTTP status, content type, and record count; it never returns a master
payload, host, or credential.

The caller must supply the exact tracked Winerim ProductIds and their
bottle/glass formats. A product absent from the live master blocks the report;
the collector does not infer ownership or format by name. Any missing or non-
successful master read raises a sanitized collection error and stops the gate.

No authenticated connection has been selected or contacted in this checkpoint.
The next authorized operation is one read-only snapshot for one connection,
using the existing secret boundary. A `READY` result means the API
configuration is complete; it cannot by itself prove physical printer output.
That final evidence needs a controlled real order or an operator/SAT
confirmation after a separately authorized canary.

## Updated evidence

- Collector plus auditor suite: 10/10 tests passed.
- Full Fleet Runtime suite after the collector: 35/35 tests passed across 7
  files.
- Direct TypeScript check and `git diff --check` passed.
