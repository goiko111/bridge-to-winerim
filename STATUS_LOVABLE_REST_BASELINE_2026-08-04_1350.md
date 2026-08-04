# Lovable REST baseline - 2026-08-04 13:50 CEST

`LOVABLE_REST_BASELINE_RESULT=TOOLING_READY_LIVE_SMOKE_OK_CONSISTENCY_FENCE_PENDING`

## Hechos

- Nuevo productor `scripts/export-lovable-rest-baseline.mjs`:
  - solo `GET` PostgREST y columnas allowlisted;
  - una peticion simultanea, `Retry-After`, backoff y presupuestos de requests
    y filas;
  - keyset pagination por `id` y deteccion de caps/orden inestable;
  - ventana maxima de 31 dias y artefacto independiente por conexion/pasada;
  - directorios `0700`, archivos atomicos `0600`, hashes semanticos y manifest.
- Se integra con `scripts/agora-shadow-reconcile.mjs`; ningun informe imprime
  claves de documentos, pedidos, productos ni credenciales.
- Validacion local: `13/13` tests, ESLint, TypeScript, `node --check` y
  `git diff --check` OK.
- Smoke Lovable real read-only, Sa Pedrera, solo `2026-08-04`, a `1 GET/s`:
  `9` requests, `0` retries, `0` respuestas 429, `966` filas leidas,
  marcador before/after estable y artefacto `0600`.
- El corte no contenia eventos/lineas/recibos del dia para Sa Pedrera y si
  `964` mappings. Self-reconcile: `RECONCILED_EXACT`, writes `false`.
- Cero writes remotos, Edge Functions, Agora, Winerim, stock, historico,
  cursores, colas, breakers o configuracion.

## Decision

- El baseline REST es `OBSERVATIONAL_READ_ONLY` y puede ejecutarse durante
  servicio, una conexion cada vez.
- Siempre queda `mergeEligible=false`: dos pasadas iguales no sustituyen una
  transaccion mientras Lovable pueda escribir.

## Hipotesis

- Ventanas diarias o semanales deberian mantenerse dentro de los presupuestos
  actuales. Historicos mayores se dividiran por mes; no se incrementara la
  tasa para terminarlos antes.

## Contradiccion cerrada

- Ya existia el reconciliador fail-closed, pero no habia productor REST que
  generase su contrato `agora-shadow-v1`. Esa pieza queda implementada.

## Puede ejecutarse durante servicio

1. Plan sin red (`npm run data:rest-baseline` sin `--apply`).
2. Captura GET por una conexion y ventana <=31 dias, preferiblemente `1-2
   GET/s`.
3. Dos pasadas para medir drift, hashes y marcadores.
4. Reconcile dry-run contra otro artefacto privado.

## Bloqueado por consistencia

- Restore, merge, cursor, declaracion de cobertura, activacion de writer y
  retirada de Lovable.
- Gate exacto: export oficial reconciliado en staging + writer Lovable cercado
  con evidencia externa + drain `>=130 s` + dos pasadas REST semanticamente
  identicas + reconcile exacto contra own-infra.

## Artefactos

- `scripts/export-lovable-rest-baseline.mjs`
- `src/test/lovableRestBaseline.test.ts`
- `infrastructure/postgres/REST_BASELINE_RUNBOOK.md`
- `scripts/agora-shadow-reconcile.mjs`
- `src/test/agoraShadowReconcile.test.ts`
