# Prompt final para Lovable

Aplica este ZIP completo de **Winerim Reconciliation v3** al proyecto Supabase `csiertktrefwewsmequr` siguiendo exactamente `docs/operations/reconciliation-v2/DEPLOYMENT_HANDOFF_LOVABLE.md`.

No rediseñes la solución ni reutilices el paquete parcial anterior. Mantén todo en `AUDIT_ONLY`: no añadas importaciones de ventas, cambios de stock, reparaciones, mutaciones de cola, backfills ni cambios en el writer o scheduler operativo de Ágora.

Orden obligatorio:

1. Revisa `CONTRACT_GAPS.md`, `QA_REPORT.md` y los nombres del esquema existente.
2. Ejecuta primero la sección pre-migración de `PREDEPLOY_CHECKS.sql`; la identidad estable excluida debe devolver exactamente una coincidencia. Adapta únicamente nombres realmente distintos; no dupliques tablas operativas.
3. Aplica una sola vez `supabase/migrations/20260928000100_reconciliation_v2.sql`.
4. Configura los secretos por nombre, sin exponerlos: `WINERIM_FLEET_READ_TOKEN`, `EDGE_ALLOWED_ORIGINS` y las variables estándar de Supabase. Mantén `WINERIM_STOCK_CONTRACT_ACK` sin definir.
5. Despliega exactamente las siete Edge Functions documentadas.
6. Integra `src/features/daily-reconciliation` y los cambios ya incluidos en los verdaderos `src/App.tsx` y `src/components/Layout.tsx`. No uses ni crees `src/middleware-main.tsx`.
7. Fusiona únicamente los tres scripts de `package.reconciliation.merge.json`; no reemplaces `package.json`, no borres scripts de Cloudflare/Wrangler y no sustituyas el lockfile.
8. Ejecuta build completo, tests y solo los dry-runs del runbook. Verifica aislamiento entre restaurantes y que las tablas raw no puedan consultarse desde el navegador.
9. La conexión cerrada debe seguir excluida mediante su UUID persistido; los seis casos DETAIL/copas siguen bloqueados; el lote externo debe ser exactamente 19 o responder `CARDINALITY_CONFLICT`.
10. Comprueba dos ciclos manuales completos en días de negocio cerrados distintos. No actives todavía el scheduler; entrégame primero los resultados.

Entrega final: hashes de los archivos aplicados, migración aplicada, siete funciones desplegadas, build/tests, URL de la pantalla, resultados de los dos ciclos y confirmación explícita de que el writer operativo, ventas, stock, cola y mappings no fueron modificados.
