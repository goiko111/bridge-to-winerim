# Contract gaps and deployment gates

## Blocking before production

### `/api/v2/stock` contract parity

`API_TOKEN_V2_DOCUMENTATION.html` documents `GET /api/v2/stock`, including `restaurantId`, `page`, `limit`, pagination and stock rows. The stored canonical OpenAPI snapshot does not contain that route. Therefore `refresh-current-stock` refuses to run unless Lovable deliberately sets:

`WINERIM_STOCK_CONTRACT_ACK=api-v2-stock-v1`

Do not set it until development confirms the same path, query and response schema in the canonical OpenAPI or in a signed contract note. Movements and sales may be deployed independently while current stock remains disabled.

### Ágora source identity

The reconciler only accepts provider identities and exact timestamps present in `sales_events.raw_json`. A local Supabase UUID is evidence storage, not a TPV identity. Rows lacking `externalOrderId`, `sourceLineId`, `effectiveAt` or a mapped Winerim wine id remain `SOURCE_INCOMPLETE`.

### Existing schema names

Before applying the migration, verify these existing relations and columns in project `csiertktrefwewsmequr`:

- `public.pos_connections(id)`
- `public.user_roles(user_id, role, connection_id)`
- `public.can_access_connection(uuid)` and `public.is_platform_admin()`
- `public.sales_events(id, connection_id, provider_doc_id, business_day, doc_type, raw_json)`
- `public.sales_line_items(sales_event_id, connection_id, provider_product_id, format, quantity, total_amount, winerim_product_id, mapped, is_wine_candidate, family, name)`
- `public.agora_reversal_audit(id, connection_id, case_fingerprint, identity_scope, evidence_classification, keep_sale_ids, candidate_targets, bottles_overdeducted)`

If a name differs, adapt only the corresponding query or FK before applying; do not create a duplicate operational table.

## Frozen contract provenance

- `openapi-sales-stock-v2.json` — SHA-256 `bddab432d08b6d9b864a822cbc752baa317d67bc674976a1e9b9e35b8e60175d`, contract v2.0.0. Authoritative here for `/api/v2/restaurants`, `/api/v2/sales/records` and `/api/v2/stock/movements`; it does **not** document `/api/v2/stock`.
- `API_TOKEN_V2_DOCUMENTATION.html` — SHA-256 `90051ed256a21a37f088999c47f7929fb186dcdb234ea47a14ef8261c0478f11`. It additionally documents `GET /api/v2/stock`, hence the separate deployment gate.

## Non-blocking limitations

- Cost/margin remains `null` when complete source costs are unavailable. Revenue is never presented as margin.
- Products outside explicit category rules stay `UNCLASSIFIED`. No text heuristic silently turns them into wine, drink or food.
- No repair endpoint exists. Any future repair workflow requires a separate reviewed project and authority.
- This checkout is an intentionally sparse overlay and its baseline `index.html` points to an absent `src/main.tsx`; therefore the existing full-app `npm run build` is not a valid acceptance check here. The supplied `reconciliation-preview.html` and `vite.reconciliation.config.ts` compile the actual dashboard and API module with `npm run build:reconciliation-overlay`. Lovable must still run its normal full-project build after applying the overlay.
- Analytics only accepts definitive invoice/refund documents, collapses exact repeated representations by provider identity and marks coverage incomplete when identity or amount evidence is absent. It never uses `is_wine_candidate` as proof of wine.
- Raw Winerim sales, lines, movements, snapshots, checkpoints and locks are service-role only. The browser can only use `read-reconciliation-results`; that Edge function authenticates the user, validates `can_access_connection` (or platform-admin fleet access), then reads the scoped data server-side.
