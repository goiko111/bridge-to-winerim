# Reconciliation v3 — changes from v2

- Defines the Winerim API as base `https://app.winerim.com/api/v2` plus the relative sales resource `/sales/records`; the effective request remains `/api/v2/sales/records`.
- Integrates the dashboard in the real `src/App.tsx` route `/audit/reconciliation` and `src/components/Layout.tsx` navigation. `src/middleware-main.tsx` is not part of the package.
- Replaces the distributable `package.json` with `package.reconciliation.merge.json`, containing only three scripts to merge without deleting existing project scripts or dependencies.
- Adds the 25 adapted tests from the earlier partial package. They use the current signatures and require causal movement identity; temporal proximity is never accepted as proof.
- Persists the closed-client exclusion inside the single reversible migration, keyed by stable connection UUID. The migration fails if the identity is absent/non-unique, and fleet discovery cannot reactivate it.
- Keeps `/stock` contract-gated by `WINERIM_STOCK_CONTRACT_ACK`, all execution `AUDIT_ONLY`, the queue empty/inert, six DETAIL cases blocked and the exact 19 SALE fixture unchanged.

## Exact UI merge

1. Add `DailyReconciliationDashboard` import to `src/App.tsx`.
2. Add `<Route path="/audit/reconciliation" element={<DailyReconciliationDashboard />} />` next to the audit routes.
3. Add the `ChartNoAxesCombined` icon and `{ to: "/audit/reconciliation", icon: ChartNoAxesCombined, label: "Reconciliation" }` to `src/components/Layout.tsx`.
4. Do not create another React entrypoint.

## Exact package merge

Merge the three `scripts` keys from `package.reconciliation.merge.json` into the existing project `package.json`. Keep every existing script, dependency and lockfile; regenerate the lockfile only through the project's normal package-manager workflow if the destination needs it.
