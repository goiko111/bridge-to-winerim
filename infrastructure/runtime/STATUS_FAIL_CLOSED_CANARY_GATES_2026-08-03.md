# Fail-closed canary gates - 2026-08-03

## Resultado

`FAIL_CLOSED_CANARY_GATES_RESULT=PACKAGE_READY_NOT_INTEGRATED_NOT_DEPLOYED`

## Hechos

- El paquete vive solo en archivos nuevos bajo `cloudflare/canary-failclosed/`
  e `infrastructure/runtime/`.
- No modifica `middleware-runtime-executor/src/worker.ts`, `sales.ts` ni ningún
  archivo PostgreSQL.
- No se crearon Queues, R2, Durable Objects, Workers, bindings ni secretos
  remotos.
- La cola canary se renderiza como recurso físico exclusivo derivado de un
  `runId`; las colas compartidas de staging y rescue-production se rechazan.
- Un mensaje de otra cola, conexión, lane, job o run ejecuta `retry()` y nunca
  `ack()`, permitiendo que Cloudflare lo entregue a la DLQ física dedicada.
- La DLQ solo confirma el mensaje después de archivar metadatos sanitizados en
  R2 y encolar una alarma; el consumidor de alarma deja ledger R2 y log de
  error estructurado.
- El writer requiere dos controles adicionales al kill switch: un proof secret
  exclusivo del nuevo runtime y un lease Durable Object por `connectionId`.
- El grant exige evidencia SHA-256 de que la credencial del writer anterior ya
  devuelve `401` o `403`, más referencia a una credencial rotada almacenada en
  Secrets Store.

## Decisión

No integrar ni desplegar el paquete hasta que el agente de ventas haya cerrado
su cambio. La integración posterior toca únicamente el borde Queue del runtime
público y no el ejecutor ni la composición de ventas.

## Hipótesis descartada

`RUNTIME_EXECUTION_ENABLED=false` en Lovable o Cloudflare no constituye por sí
solo un fence externo. La protección real contra doble writer exige revocar o
rotar la credencial del writer anterior y demostrar su rechazo.

## Contradicción corregida

La plantilla canary anterior consumía `winerim-staging-sales` y el runtime
reconocía mensajes fuera del scope. El paquete nuevo prohíbe ambas condiciones;
la plantilla usa una Queue física única y el guard rechaza mediante retry/DLQ.

## Validaciones

- `bash infrastructure/runtime/smoke-failclosed-canary.sh`: OK.
- Vitest del paquete: `9/9` OK.
- `npx tsc --noEmit --pretty false`: OK.
- Bundle `writerFenceWorker.ts`: OK.
- Bundle `dlqObserver.ts`: OK.
- `git diff --check`: OK.
- Grant local: modo `0600`, cero apariciones del proof secret.
- Preflight contra el runtime actual: falla como se esperaba con
  `RUNTIME_SCOPE_GUARD_NOT_INTEGRATED`.

## Pendiente exacto

1. Esperar commit limpio del agente de ventas.
2. Añadir al principio de `runRuntimeQueue` el guard de Queue/scope antes de
   abrir Hyperdrive o el executor.
3. Adquirir el lease por cada mensaje aceptado; ante cualquier fallo, retry sin
   ack ni mutación.
4. Eliminar la rama antigua que hace ack de mensajes canary fuera de scope.
5. Ejecutar el verificador con `--integration-source`, tests completos,
   TypeScript, bundles y Wrangler dry-run con Node 22+.
6. Solo después: crear recursos físicos, rotar la credencial del writer viejo,
   demostrar `401/403`, cargar grant/proof y solicitar gate de despliegue.
