# NEXT_STEPS

## P0 - Baseline REST por conexion - 2026-08-04 13:50 CEST

- [x] Implementar productor GET secuencial, rate-limit/backoff y artefactos
  privados por conexion.
- [x] Validar con 13 tests y smoke live de una conexion a 1 req/s.
- [ ] Guardar capturas reales en volumen cifrado durable, no `/private/tmp`.
- [ ] Tras importar el export oficial: fence firmado por conexion, drain
  `>=130 s`, dos capturas identicas y reconcile exacto antes de cualquier merge.

## P0 - Import oficial preparado; gate schema staging - 2026-08-04 13:31 CEST

- [x] Descargar y hashear `bridge-to-winerim_260804.backup` en local privado.
- [x] Restaurar con PostgreSQL 17 y generar artefacto sanitizado schema `2`.
- [x] Reconciliar offline y validar target `31`/reemplazo `30` sin writes.
- [ ] Copiar fuente/artefacto/backup target a volumen cifrado durable.
- [ ] Obtener DSN directa/Session Pooler de staging por canal seguro.
- [ ] Aplicar/readback `0014_runtime_catalog_source_scope.sql` (`30 -> 31`).
- [ ] Ejecutar import quiescente, reconciliar y conservar rollback antes de
  provisionar credenciales o activar runtime.

## P0 - Import Lovable y cutover serial - 2026-08-04 13:05 CEST

- [x] Cerrar contrato `20 -> 31`, restore real y fence de concurrencia.
- [x] Exigir evidencia externa Ed25519 del writer Lovable cercado.
- [x] Descargar/hashear el export oficial y probar restore descartable.
- [ ] Completar `0014` y reconciliar staging con rollback; no importar con
  runtime activo.
- [ ] Cortar una conexion piloto con drain `>=130 s`, dos lecturas y canary.

## P0 - Albariza runtime tras catalogo live - 2026-08-04 11:42 CEST

- [x] Publicar siete familias y `748/748` variantes con canary/readback.
- [x] Excluir `20` sin precio y ocultar tres stale con XML inverso.
- [ ] Provision cifrado inactivo y readback exacto de la fila/conexion.
- [ ] Writer fence, shadow read-only y activacion serial sin backfill.
- [ ] Primera venta real B+C y SLA alta/precio `<5 min`, con rollback.

## P0 - El Bejeque: unico gate operativo restante - 2026-08-03 23:00 CEST

- [x] Cerrar hashes manifest/grant/proof, aborto append-only y lectura DB.
- [x] Aplicar/verificar migracion rescue con run A retirado y B preparado.
- [x] Publicar `2bb7c00`, validar `579` tests, executor, Workerd, PG17 y build.
- [x] Observar 20 veces Agora real: HTTP 200, 0 facturas y 0 tickets.
- [ ] Primera venta real de copa mapeada: capturar IDs exactos y snapshot.
- [ ] Regenerar manifest/grant, desplegar B serialmente, readiness doble,
  mensaje unico, replay idempotente, readback de historial+stock y retirada.

> Tareas pendientes priorizadas. Al retomar: leer este archivo + `CURRENT_STATE.md`.

## P0 - Release remoto y canaries separados

- [x] Publicar `a80c9eb`, congelar archive `0600` y actualizar inventario.
- [x] Repetir runtime/executor/tooling/fail-closed/TypeScript/build/Workerd.
- [ ] Introducir Agora El Bejeque por canal seguro; no aceptar plaintext en
  argumentos, logs, Git ni Markdown.
- [ ] Obtener `401/403` anterior o evidencia backend equivalente aprobada.
- [ ] Desplegar fence/executor/observer antes del consumer y guardar readiness
  pre/post activacion.
- [ ] Ejecutar shadow read-only, retirarlo y crear otro run para live.
- [ ] Albariza: provision apagado + 7 familias + canary `855797/1055797`;
  venta real en gate de stock separado.

## P0 - Fence El Bejeque y preview Albariza

- [x] Modo Agora `shared-read-only`, scope exacto y bundles inmutables.
- [x] Token Winerim nuevo validado en dos GET oficiales.
- [x] Preview fresco Albariza: `762` publicables, cero colisiones/diffs.
- [x] Generar bundles con Wrangler y arrancar consumer/executor en Workerd.
- [ ] Obtener `401/403` antiguo o evidencia backend equivalente aprobada.
- [ ] Introducir Agora El Bejeque por canal seguro y provisionar inactivo.
- [ ] Corregir/excluir la copa Albariza sin precio y ejecutar canary B/C antes
  de publicacion completa.

## P0 - El Bejeque activation gate versionado

- [x] Añadir `run_id`, estados terminales, evidencias SHA-256 e inmutabilidad.
- [x] Implementar provisioning, activacion y retiro transaccionales con
  manifests privados y rotacion versionada.
- [x] Validar dos generaciones PG17, RLS, pre-canary, runtime, executor,
  fail-closed, suite root, TypeScript, build y Wrangler dry-run.
- [x] Cerrar drain programatico, orden de retirada y binding exacto de
  credenciales/RLS/readiness/vault al `run_id` activo.
- [x] Revalidar backup, crear snapshot logico fresco y aplicar `0013` solo con
  control plane vacio.
- [x] Rotar login runtime/Hyperdrive, activar vault key rescue y crear cuatro
  Queues exclusivas inertes para `bejeque-20260803-a`.
- [x] Usuario autorizo R2 Standard; suscripcion activa, bucket exclusivo WEUR
  creado y healthcheck remoto cerrado con `0` objetos.
- [x] Congelar `9e4ebce`, inventario Cloudflare privado y repetir validacion
  exacta de tests, PG17, TypeScript, build y Wrangler dry-runs.
- [ ] Rotar tokens Agora/Winerim, guardar `401/403`, esperar `>=130 s` y
  obtener dos probes read-only correctos.
- [ ] Provisionar inactivo, renderizar manifests, desplegar recursos dedicados
  sin consumer, activar/verificar run exacto y ejecutar shadow.
- [ ] Ejecutar solo una operacion controlada tras cerrar todos los gates.

## P0 - El Bejeque rescue pre-canary

- [x] Aplicar `72 -> 95` mappings con backup, readback y rollback.
- [x] Endurecer sales para stockId exacto y sales-only inactivo fail-closed.
- [x] Validar suites, verifier, paquete fence y backup restaurable.
- [x] Implementar provisionador cifrado de dos credenciales sin exponerlas;
  genera solo artefacto privado inactivo y fail-closed.
- [x] Implementar retirada/cleanup del canary rescue y scope expirado sin
  borrar evidencias; validado en PostgreSQL 17 local.
- [ ] Rotar credenciales Agora/Winerim y obtener evidencia `401/403` antes del
  grant.
- [ ] Dos probes read-only, shadow y una sola venta legitima; mantener todo el
  resto apagado.

## P0 - Corte operativo al cerrar 2026-07-22

- [x] Publicar en `main` el hardening de ventas/cursor/monitor:
  `7001cfed3f6ef93812051c935faf42639ec5469e`.
- [x] Redesplegar en Lovable Cloud `agora-proxy` y
  `connection-health-monitor` desde ese hash, sin tocar configuración ni
  procesar colas.
- [x] Ejecutar monitor manual postdeploy en `dryRun=true`: `23` conexiones
  activas comprobadas, sin escrituras ni notificaciones.
- [ ] Observar un ciclo cron real posterior al deploy y comprobar ausencia de
  regresiones de cursor, cola y alertas falsas.
- [ ] Publicar el frontend con `dryRun=true` solo después de definir la ruta de
  cierre de los cinco findings críticos preexistentes de RLS/Storage.
- [ ] Migrar por fases el acceso directo del frontend a Edge Functions/BFF,
  activar autenticación y cerrar policies públicas con prueba y rollback por
  tabla siguiendo
  `docs/operations/security-rls-publish-gate-2026-07-22.md`. No ejecutar un
  `REVOKE` masivo en producción.
- [ ] Mantener abiertas las alertas de Abadía, Finca e Higuerón hasta resolver
  el backlog legacy real; no cerrarlas manualmente por apariencia.

## P0 - Desbloquear cursores definitivos sin perder legacy

- [x] Tomar snapshot fresh de Abadia Yuste, El Higueron y Finca Eslava.
- [x] Confirmar que Agora devuelve facturas cerradas y que no hay escritura
  provisional, breaker ni cola activa causante del bloqueo.
- [x] Demostrar que el primer dia pendiente de las tres contiene vino legacy
  sin mapping y que tickets huerfanos fijan el techo.
- [x] Abadia: crear 16 mappings exactos/univocos de botella con snapshot
  `0600`, hash revisado y verificacion fresh; no procesar ventas.
- [ ] Abadia: resolver los 30 IDs restantes solo con confirmacion humana,
  fijar fecha de go-live o escanear `2025-03-17..2026-06-06`, y resolver el
  fallo Winerim `142911`.
- [x] Higueron: revisar los IDs legacy vendidos desde `2026-07-15`; identificar
  `24` matches exactos/univocos y rechazar genéricos, licores y falsos
  positivos. Los mappings se revirtieron al detectar consumo automático del
  cron; evidencia en
  `docs/operations/agora-higueron-exact-mapping-2026-07-22.md`.
- [ ] Higueron: conciliar en ERP los `19` efectos automáticos previos al
  rollback (`15` grupos con stock activo y `4` sales-only); no compensar por
  nombre ni restaurar stock globalmente.
- [x] Completar y documentar la prueba del maintenance lock fail-closed por
  conexión usando el lease `sales-stock`: ownership, insert atómico, doble
  verificación, release explícito y observación posterior sin nuevos writes.
- [x] Higuerón: reaplicar bajo lease los `24` matches exactos; estado final
  `316` mappings, lote `24`, cursor `2026-07-14`, cola `0` y cero claves
  idempotentes duplicadas. `C. CANECO` copa sigue sin aplicarse.
- [ ] Higuerón: resolver las líneas legacy ambiguas restantes y conciliar los
  `19` efectos de la carrera inicial antes de procesar el primer día completo.
- [ ] Finca: obtener equivalencia humana de `COPA TINTO`, `COPA BLANCO`,
  `COPA FRIZANTE`, `COPA MALAGA VIRGEN`, `COPA NPU`, `COPA ROSADO` y `COPA
  TIO PEPE`; no mapear genericos por fuzzy.
- [x] Finca: ejecutar lectura fresh y dry-run de codigo/SKU o nombre+variante
  exactos para `2026-07-19..2026-07-21`; resultado `0` mappings autorizables,
  catalogo `123/123`, cola cero y breaker cerrado.
- [ ] Cuando el primer dia quede completo: snapshot nuevo, desactivar la
  observacion de tickets huerfanos, procesar dia a dia y verificar Winerim tras
  cada factura antes de avanzar.
- [ ] Resolver alertas solo cuando los cursores hayan avanzado de verdad.
- [ ] Usar `docs/operations/agora-remediation-cursors-2026-07-22.md` como
  evidencia y runbook.
- [ ] Para Abadia, continuar desde
  `docs/operations/agora-abadia-exact-mapping-2026-07-22.md`; no repetir los 16
  mappings ya confirmados ni usar fuzzy para los 30 descartados.

## P0 - Casa Nene · restaurar botellas internas sin publicar la carta

- [x] Confirmar fresh que las `31/31` copas estan vendibles y que las `26`
  botellas asociadas estan `HIDDEN`.
- [x] Separar `24` botellas con mapping confirmado, `2` mappings rechazados,
  `Valdamor` sin precio de botella y cuatro fichas sin datos recuperables.
- [x] Preparar patch opt-in por referencia en
  `codex/casa-nene-hidden-pos-variants`.
- [x] Validar parse TypeScript, `node --check`, `git diff --check` y `11/11`
  aserciones de politica.
- [x] Revisar y desplegar unicamente `agora-proxy` desde
  `079ba700ea18b071df27141cb40e79fc68a54d32`.
- [x] Guardar snapshot y anadir `publish_bottle=true` + precio explicito solo
  a las `24` referencias con mapping confirmado.
- [x] Ejecutar dry-run, publicar en lotes de cinco y exigir auditoria fresh,
  mappings/tracking y cola limpios.
- [ ] Cliente: probar una botella y una copa y verificar historial `TPV`, hora,
  variante, stock e idempotencia.
- [ ] Validar aparte `Balbas Barrica 5` y `Antidoto`; no incluirlos en el
  rollout mientras sus mappings sigan rechazados.

## P0 - Demostrar SLA de cinco minutos por conexion

- [x] Separar evidencia de configuracion en las `30` conexiones.
- [x] Confirmar ambos sentidos en Casa Nene, El Higueron, Kava, PurOsushi,
  Cienvinos Ecija, Sa Pedrera y Taberna de Elia.
- [x] Confirmar solo ventas en Chiquilla, De la O, Don Quijote Marbella, El
  Porton de Sorni, Finca Eslava, Katsu Izakaya, Jardi, Qtomas, Sa Vida y
  Vinatea.
- [ ] Ejecutar por cada conexion activa una venta real y un alta o cambio de
  precio real, con timestamps y lectura fresh dentro de siete minutos.
- [ ] Observar 24 horas sin duplicados, errores de cursor ni colas bloqueadas
  antes de promover a `100%_SIGNED_OFF`.

## P0 - Legacy Agora · retirar solo sustitutos confirmados

- [x] Auditar las `30` conexiones sin escrituras y separar `23` activas de
  `7` desactivadas.
- [x] Cruzar master data actual, ownership Winerim y catalogo fresh de las
  conexiones activas.
- [x] Documentar la diferencia entre familia oculta, producto buscable,
  legacy completamente oculto, contenedor reutilizado y politica de
  preservacion en `docs/operations/agora-legacy-audit-2026-07-21.md`.
- [ ] El Porton de Sorni: confirmar sustituto de los `18` legacy vendibles,
  ejecutar canary y preparar dry-run reversible.
- [ ] Don Quijote Marbella: ocultar solo duplicados con mapping exacto tras el
  canary del boton oficial.
- [ ] Finca Eslava: separar copas nominales de copas genericas; no ocultar las
  genericas por inferencia.
- [ ] Vinatea: usar los `110` mappings exactos para un dry-run, pero no aplicar
  hasta resolver `sales/import` y completar la venta real.
- [ ] Abadia Yuste y De la O: validar con el cliente los subconjuntos nominales
  antes de cualquier ocultacion.
- [ ] El Higueron: corregir las `10` diferencias fresh antes de plantear la
  retirada de productos legacy buscables.
- [ ] Luruna: completar matching dentro de la familia mixta `BEBIDAS`; no
  ocultar por familia.
- [ ] Alinear `legacy_policy` de El Bejeque con el estado fresh ya oculto, sin
  cambiar flags operativos.
- [ ] Clasificar residuos sin ownership de Kava, Cienvinos y Jardi.

## P0 - Kava · confirmar Pampaneando en comandera

- [x] Auditar catalogo fresh y confirmar `228/228 MATCH`, sin cola ni
  diferencias.
- [x] Localizar botella `747191 B Pampaneando` en `TINTOS WINERIM` y copa
  `947191 C Pampaneando` en `COPAS WINERIM`, ambas vendibles.
- [x] Confirmar que `C. PAMPANEANDO TINTO` es el boton legacy oculto y que no
  debe reactivarse.
- [ ] Cliente: refrescar la comandera y buscar `Pampaneando`, sin exigir la
  palabra `Tinto` que no forma parte del nombre canonico Winerim.
- [ ] Si el cliente quiere la palabra `Tinto`, renombrar primero en Winerim y
  medir la propagacion automatica; no editar el producto Agora a mano.

## P0 - Cerrar la auditoria de flota Agora del 21/07

- [x] Revisar las `30` conexiones y separar `23` habilitadas de `7` no activas.
- [x] Publicar el corte conservador en
  `docs/operations/agora-fleet-checklist-2026-07-21.md`.
- [x] Evitar falsos positivos: ninguna conexion se marca
  `100%_SIGNED_OFF` solo por catalogo exacto, cola cero o breaker cerrado.
- [x] Desplegar de forma controlada el hardening de `agora-proxy` desde
  `7001cfed`; la verificación fresh posterior conserva catálogo y cola limpios
  sin replay operativo.
- [x] Desactivar la escritura provisional de tickets abiertos en las `23`
  conexiones activas, conservando su lectura para observabilidad.
- [x] Clasificar Sa Pedrera (`Albenc 296315 / 404`) como referencia retirada:
  mapping rechazado, tracking oculto, producto no vendible y log reciente
  `SKIPPED`, sin fingir un descuento correcto.
- [ ] Resolver Cienvinos (venta `503`, alerta de stock y cursor) antes de
  reprocesar.
- [ ] Resolver la adopcion/mapping de Luruna: actualmente `0/2850` lineas
  recientes llegan mapeadas.
- [ ] Corregir solo las diferencias fresh documentadas de PurOsushi,
  El Higueron y Sa Vida, con relectura exacta y sin sincronizacion masiva.
- [ ] Reconciliar en ERP los ciclos provisional/definitivo detectados antes de
  corregir tarjetas o stock históricos.
- [ ] Completar canaries reales por conexion y observar 24 horas antes de
  promoverla a `100%_SIGNED_OFF`.

## P1 - Onboarding de conexiones Agora no activas

- [ ] Casa Esteban: cargar catalogo Winerim, master data y mappings antes del
  primer piloto.
- [ ] Don Bernardo Ponzano y Santander: refrescar caches, decidir estructura y
  preparar mappings; no confundir histórico analítico con operación activa.
- [ ] O Bistro: obtener URL externa/VPN alcanzable; la IP privada no sirve
  desde Lovable Cloud.
- [x] Tintorera: piloto reversible completado sobre `313` formatos estandar;
  catalogo exacto, ownership completo, cola limpia y legacy intacto.
- [ ] Saddle: integrar primero tSpoonLab y versionar composición de
  menús/armonías.
- [ ] Baco Getafe y La Candela de Triana: conservar rollback/desactivación hasta
  una instrucción explícita del cliente.

## P0 - Tickets abiertos e historial Winerim

- [x] Medir alcance durable: `18` casos de riesgo en `8` conexiones desde el
  `10/07`.
- [x] Confirmar que la API v2 documentada no ofrece anulacion de venta y que
  `/sales/import` solo acepta cantidades positivas.
- [ ] Decidir y ejecutar una desactivacion controlada de escritura provisional
  (`open_tickets_stock_sync_enabled`) manteniendo lectura de tickets.
- [ ] Pedir a Winerim un endpoint idempotente de anulacion de venta o ajuste de
  stock sin historial.
- [ ] Auditar y corregir por snapshot los duplicados funcionales confirmados;
  nunca compensarlos con otro `PUT /stock`.
- [ ] Validar ticket cerrado, reducido y cancelado antes de reactivar writes.

## P0 - Kava · cerrar diferencias de historial

- [x] Confirmar catalogo `228/228 MATCH`, cola `0` y breaker cerrado.
- [x] Identificar tres copas definitivas de Pampaneando omitidas por metadata
  antigua de candidato.
- [x] Preparar localmente precedencia del mapping definitivo y validar bundle.
- [ ] Desplegar solo `agora-proxy`.
- [ ] Reprocesar `17/07` y `18/07` y comprobar exactamente tres copas nuevas.
- [ ] Corregir Chavost Paradoxe solo despues de snapshot y definir anulaciones.
- [ ] Observar 24 horas sin nuevas diferencias.

## P0 - Finca Eslava · abandonar botones legacy ambiguos y cerrar canaries

- [x] Confirmar conexión, breaker y ciclo de cinco minutos sanos.
- [x] Revalidar catálogo fresh `123/123 MATCH` y cola activa cero.
- [x] Comparar Agora con `/erp/1108/sales` y confirmar idempotencia.
- [x] Corregir el stock de la venta anulada de Emilio Moro mediante `No, solo
  ajuste`, sin fabricar otra venta.
- [x] Detectar uso vivo de copas legacy genéricas: `13` el `19/07` y `16` el
  `20/07`, además de `2` botellas legacy de `JUAN GIL 12 MESES` el `20/07`.
- [ ] Cliente: marcar una botella y una copa desde botones Winerim y no
  anularlas.
- [ ] Verificar ambas en ERP en menos de cinco minutos, con hora, variante,
  stock activo/inactivo e idempotencia correctos.
- [ ] Acordar sustitutos exactos de legacy; no mapear `COPA TINTO`, `COPA
  BLANCO` o `COPA FRIZANTE` a una referencia concreta.
- [ ] Ocultar de forma reversible solo el legacy con sustituto confirmado.
- [ ] Mantener `LIVE_PENDING_SALE_CANARY` hasta completar botella y copa.

## P0 - Ocean Club · sustituir navegación por familias por categorías

- [x] Confirmar fresh que las ocho familias Winerim están
  `ShowInPos=false`; no se necesita otra ocultación.
- [x] Confirmar catálogo `113/113 MATCH`, cola cero y productos intactos.
- [x] Identificar grupos activos `1 - BAR & LOUNGE` y
  `3 - POOL & RESTAURANTE`; excluir `2 - Comanderas`, eliminado.
- [x] Verificar que la API HTTP estándar rechaza la exportación de
  `Categories` y que la guía no documenta su importación.
- [ ] Cliente/SAT: confirmar qué categorías se muestran en cada grupo activo.
- [ ] SAT: indicar el mecanismo oficial soportado para crear categorías y
  asociarlas dinámicamente a familias o productos.
- [ ] Crear un piloto reversible con categoría padre `VINOS` y una única hija.
- [ ] Verificar visualmente la categoría en ambos grupos, orden y ausencia de
  familias Winerim en la raíz.
- [ ] Confirmar que un nuevo vino entra automáticamente en la categoría
  adecuada; no aceptar una solución que requiera reasignación manual diaria.
- [ ] Hacer una venta real desde categoría y verificar ERP, variante, hora,
  stock/idempotencia antes de `100%_SIGNED_OFF`.
- [ ] Usar `docs/operations/ocean-club-category-navigation-2026-07-21.md` como
  evidencia y rollback.

## P0 - Don Quijote Marbella · canary final con el botón oficial

- [x] Confirmar catálogo fresh `114/114`, sin ausentes, diferencias, productos
  sin ownership ni cola activa.
- [x] Confirmar que Winerim publicó `C Arzuaga Crianza` a `10 EUR` en
  `COPAS WINERIM`.
- [x] Detectar que José vendió desde el duplicado manual
  `COPA DE ARZUAGA CRIANZA`, que no tenía mapping.
- [x] Mapear de forma exacta y reversible el duplicado manual a
  `232976 / GLASS`, sin transferir ownership.
- [x] Recuperar `4` copas del `2026-07-19` y `1` copa del `2026-07-20` como
  ventas TPV sin modificar stock inactivo.
- [x] Repetir el replay y confirmar `0` nuevas importaciones y `0` duplicados.
- [x] Ocultar únicamente el duplicado manual; mantener visible el producto
  oficial.
- [ ] Cliente: refrescar Agora y vender una copa desde
  `COPAS WINERIM > C Arzuaga Crianza`.
- [ ] Confirmar en menos de cinco minutos la tarjeta TPV, la variante copa, la
  hora del proveedor y la idempotencia.
- [ ] Winerim: corregir o aclarar la cabecera `Botella` y la fecha de
  importación que muestra el ERP para las ventas históricas de copa.
- [ ] Promover a `LIVE` / `100%_SIGNED_OFF` solo después del canary oficial.
- [ ] Usar `docs/operations/don-quijote-arzuaga-2026-07-21.md` para evidencia
  y rollback.

## P0 - Casa Esteban · recuperar túnel y completar activación

- [x] Validar token Winerim: `261` vinos accesibles.
- [x] Crear conexión desactivada en staging, sin escrituras ni auto-push.
- [x] Confirmar el bloqueo externo: HTTP `404 tunnel_not_found` de ConnectManager.
- [ ] Cliente/SAT: levantar el servidor/túnel y confirmar que la URL pública vuelve a responder.
- [ ] Leer master data fresh y fijar centros, listas, IVA, almacén y preparación.
- [ ] Guardar snapshot reversible de familias y productos legacy.
- [ ] Publicar y verificar familias/productos Winerim con cola final cero.
- [ ] Ocultar legacy a nivel familia y producto sin borrarlo.
- [ ] Activar ventas y catálogo cada cinco minutos.
- [ ] Validar botella y copa reales en el ERP Winerim antes de `100%_SIGNED_OFF`.

## P0 - Katsu Izakaya · cierre automático de ventas tardías

- [x] Comparar Agora y ERP Winerim para el `2026-07-16`.
- [x] Detectar que faltaban las `2` copas de Sarmentero vendidas a las `22:38`.
- [x] Ejecutar replay dirigido e idempotente: `1` venta aplicada, `1` ya existente omitida y `0` fallos.
- [x] Confirmar conciliación final: `3` copas, `17,92 EUR`, horas `15:45` y `22:38`, origen `TPV`, sin duplicados.
- [ ] Vigilar Katsu durante `24` horas y confirmar que una venta tardía entra sin intervención manual.
- [ ] Revisar el último ciclo intradía y el catch-up D-1 para que cualquier venta posterior al último pase se recupere automáticamente.
- [ ] Extender la comprobación de cierre tardío al resto de conexiones Agora activas.

## P0 - Cierre de las nueve activaciones Agora del 2026-07-16

- [x] De la O: `87/87`, ocho familias, flags automáticos, cola cero, legacy visible.
- [x] El Portón de Sorní: `174` elegibles, tracking histórico extra no vendible, cola cero, legacy visible.
- [x] Ocean Club: conexión creada, `113/113`, centros `1,2,4,5,6,7`, listas especiales excluidas.
- [x] Finca Eslava: `123/123`, falsos `NAME_MISMATCH` cerrados.
- [x] Vinatea: `132/132`, ruta `8/1 BARRA/BEBIDAS`.
- [x] Don Quijote Marbella: `114/114`, falso `NAME_MISMATCH` cerrado.
- [x] Abadía Yuste: `281/281`, auditoría final por bloques.
- [x] El Higuerón: `291/291`; detalle fallido de vino inactivo documentado.
- [x] Qtomas: detener crecimiento de cola; `59` tareas bloqueadas y auto-push pausado.
- [ ] Redesplegar únicamente `agora-proxy` desde el `main` actual y confirmar que el canary con tabulador ya no produce `NAME_MISMATCH`.
- [ ] Qtomas: recuperar puerto/DDNS/router, exigir tres probes sanos y ejecutar master/auditoría fresh.
- [ ] Qtomas: reencolar solo `MISSING/DIFFERENT` con ownership Winerim y reactivar auto-push.
- [ ] En cada una de las ocho activas, pedir una venta real de botella y copa desde botones Winerim.
- [ ] Verificar en ERP Winerim hora, variante, origen TPV, stock activo/inactivo e idempotencia.
- [ ] Confirmar visualmente en terminal las ocho familias y que el legacy sigue visible.
- [ ] Observar 24 horas con `QUEUED/RUNNING=0`, sin nuevas tareas `FAILED` ni alertas de ventas.
- [ ] Promover cada conexión de `LIVE_PENDING_SALE_CANARY` a `LIVE` solo con evidencia real.
- [ ] Usar `docs/operations/agora-nine-live-ready-2026-07-16.md` como rollback y evidencia.

## P0 — El Bejeque · cerrar protección antiduplicado

- [x] Conciliar Agora y ERP Winerim para `2026-07-15`.
- [x] Identificar la cascada de `stock_sync_log` como causa de repetición cada cinco minutos.
- [x] Anular `27` tarjetas duplicadas y verificar stocks finales.
- [x] Importar histórico `2026-04-15` a `2026-07-14` sin modificar stock.
- [x] Validar idempotencia y matching manual seguro.
- [x] Mantener temporalmente desactivados open tickets e intradía.
- [x] Redesplegar `agora-proxy` con la corrección XML incluida.
- [x] Repetir la auditoría fresh de El Portón: `173/173` coincidentes, `0` ausentes y `0` diferencias.
- [x] Confirmar en runtime la decodificación `decodeXmlAttribute -> normalizeAgoraTextAttribute`.
- [ ] Confirmar en base viva que la migración de FK `ON DELETE SET NULL` está aplicada.
- [ ] Confirmar en runtime `replaceSalesEventLinesPreservingStockClaims`.
- [ ] Revisar la activación concurrente de los tres flags intradía de El Bejeque; devolverlos a `false` si el canary no se ejecuta inmediatamente.
- [ ] Ejecutar canary doble sobre el mismo snapshot y confirmar cero duplicados.
- [ ] Reactivar open tickets/intradía solo después del `PASS`.
- [ ] Winerim: decidir cómo importar ventas de un vino inactivo como Cloe sin reactivarlo.
- [ ] Definir política para cantidades Agora fraccionarias (`0,5` magnum).
- [ ] Cliente/Winerim: validar si `ABAD DOM BUENO GODELLO` corresponde realmente a `Abad Dom Bueno Esencia`.

## P0 — De la O · cerrar piloto

- [x] Actualizar accesos manteniendo la conexión desactivada.
- [x] Validar Agora, tickets abiertos, invoices y master data.
- [x] Enriquecer `86` vinos Winerim y resolver `87` variantes.
- [x] Guardar snapshot completo y auditar el legacy antes de escribir.
- [x] Configurar IVA, BODEGA, preparación y centros SALA/TERRAZA.
- [x] Crear ocho familias Winerim manteniendo el legacy visible.
- [x] Publicar y verificar `87/87` variantes con cola final `0`.
- [x] Comparar `86` familias y `1.758` productos legacy: `0` diferencias.
- [ ] Cliente: refrescar terminales y confirmar visualmente familias/botones.
- [ ] Marcar una botella Winerim y comprobar historial, hora e idempotencia.
- [ ] Marcar una copa de `Rodríguez y Sanzo Palo Norte` y comprobar la variante `glass`.
- [ ] Confirmar comportamiento con stock activo y stock inactivo.
- [x] Habilitar conexión, catálogo y auto-push cada `5` minutos; queda pendiente la prueba real.

## P0 — El Portón de Sorní · cerrar piloto

- [x] Crear conexión en modo seguro y validar Agora, master data, tickets abiertos e invoices.
- [x] Leer y enriquecer `157` vinos Winerim.
- [x] Configurar IVA, almacén, preparación, centros de venta y scope de precios.
- [x] Crear ocho familias Winerim manteniendo el legacy visible.
- [x] Publicar y verificar `173/173` variantes con cola final `0`.
- [ ] Cliente: refrescar terminales y confirmar familias/botones visibles.
- [ ] Marcar una botella Winerim y comprobar historial, hora, variante e idempotencia.
- [ ] Marcar una copa Winerim y comprobar historial, hora, variante e idempotencia.
- [ ] Probar una variante con stock activo y otra con stock inactivo.
- [x] Habilitar conexión, catálogo cada `5` minutos y auto-push; queda pendiente la prueba real.

## P0 — Flota Agora · correcciones prioritarias 2026-07-16

- [ ] `Sa Vida`: resolver `sales_stale`, auditar el catálogo divergente y no declararla sana hasta reconciliar flags, familias y precios.
- [ ] `Taberna de Elia`: reparar el producto ausente y resolver tres tareas `BLOCKED` HTTP `404`.
- [ ] `Chiquilla`: reconciliar `16` diferencias de IVA/`SaleableAsAddin`.
- [ ] `Kava`: corregir una diferencia de precio y una de familia; resolver la alerta y archivar fallos de red cuando la sonda siga estable.
- [ ] `Luruna`: reconciliar los dos vinos con precios distintos en listas.
- [ ] `PurOsushi`: reconciliar dos precios y completar venta real botella/copa manteniendo legacy visible.
- [ ] `Cienvinos`: reconciliar diez precios de lista `1` y completar observación de 24 horas.
- [ ] `Qtomas`: recuperar conectividad, releer master fresh y reconciliar las `59` tareas ahora `BLOCKED`; no procesar la cola antigua directamente.
- [ ] `Restaurante Triana`: corregir `PrintWhenPriceIsZero` y confirmar historial sales-only.
- [ ] `Sa Pedrera`: reconciliar cinco precios y separar/archivar las `979` tareas históricas truncadas sin reintentarlas en masa.
- [ ] `Katsu`: tras el redeploy de `agora-proxy` desde `main` `5906a93`, reevaluar las cinco tareas y resolver la alerta sin duplicar productos.
- [ ] `El Bejeque`: revisar y cerrar dos tareas `BLOCKED` antiguas por XML truncado.
- [ ] `Jardi` y `Kava`: limpiar metadatos de breaker caducados solo después de otra sonda estable.

## P0 — Agora · bloqueos de conectividad

- [ ] `O Bistro`: obtener URL pública/DDNS o túnel; no sirve la IP privada desde el backend.
- [ ] `Saddle`: SAT debe revisar NAT/firewall/DDNS y puerto `8984`.
- [x] `Tintorera`: NAT/puerto recuperados; API y tickets responden HTTP `200`
  desde Lovable Cloud y la conexion esta activa.

## P1 — Agora · siguientes altas

- [x] Preparar `Abadía Yuste`, `Don Quijote Marbella`, `Finca Eslava` y `Vinatea` con el runbook de El Portón; quedaron `LIVE_PENDING_SALE_CANARY` con legacy visible.
- [ ] Decidir si se reanuda `Baco Getafe` o se conserva en rollback.
- [ ] Confirmar destino de `La Candela de Triana`; actualmente sigue desactivada.
- [x] Completar onboarding Winerim de `De la O`; queda `LIVE_PENDING_SALE_CANARY`.
- [x] Crear y auditar `Ocean Club`; queda `LIVE_PENDING_SALE_CANARY` con legacy visible.

## P0 — Cienvinos · observación posterior a canaries 2026-07-14

- [x] Probar cambio de precio real `14,00 -> 14,01 -> 14,00` desde Winerim y confirmar una tarea automática por cambio, sin duplicados.
- [x] Probar reactivación reversible de un vino inactivo y restaurarlo a `is_active=false` / tracking `HIDDEN`.
- [x] Simular indisponibilidad con breaker solo en Cienvinos; confirmar tarea en espera con `attempts=0`, recuperación `SUCCESS` en un intento y evaluaciones posteriores sin cola.
- [x] Validar conciliación real `OpenTicket -> BasicInvoice` con una sola deducción para dos copas.
- [x] Registrar confirmación del usuario de que el terminal está `OK`.
- [ ] A las 24 horas, comprobar cola, breaker, alertas, `last_open_tickets_sync`, duplicados de catálogo y duplicados de venta; cerrar el punto 5 solo con lectura fresh.
- [ ] Cuando restaurante/equipo pueda coordinarla, cancelar una venta real de vino de prueba y confirmar una única compensación idempotente específica de Cienvinos.

## P0 — Yurest V2 · Blasco

- [x] Validar login V2 con Bearer + `X-Provider-Token`.
- [x] Identificar local y almacenes: `store_id=2054`, almacén activo `8394`.
- [x] Auditar catálogo, costes, proveedores, stock, movimientos, inventarios, albaranes y facturas.
- [x] Implementar cliente y proxy Yurest read-only con aislamiento multi-centro y secretos externos.
- [x] Añadir pruebas de auth, re-login, paginación/filtro por local y rechazo cross-store.
- [x] Documentar readiness en `docs/integrations/YUREST_BLASCO_READINESS_2026-07-14.md`.
- [ ] Yurest: habilitar permisos/scopes de `stores`, `storage`, `delivery-notes` y `bills`.
- [ ] Yurest: resolver HTTP 500 de stock actual, movimientos y facturas.
- [ ] Yurest: confirmar endpoint paginado para listar pedidos de compra existentes.
- [ ] Confirmar que únicamente se integra `store_id=2054`.
- [ ] Acordar matching Yurest ↔ Winerim por ID externo, SKU/EAN o pairing Agora.
- [x] Configurar secretos en Lovable Cloud y crear conexión Yurest desactivada en `PULL_ONLY` / `write_mode=NONE`.
- [x] Desplegar `yurest-proxy` y validar en runtime costes e inventarios sin escrituras.
- [ ] Completar dry-run de compras cuando Yurest habilite albaranes/facturas y confirme el listado de pedidos.
- [ ] Activar sincronización solo tras canary idempotente y reconciliación manual.

## P0 — PurOsushi · restaurar legacy visible

- [x] Detectar que el legacy estaba oculto de forma reversible y localizar el snapshot de rollback.
- [x] Ampliar `set-product-visibility` para restaurar los dos flags Agora exactos sin romper llamadas existentes.
- [x] Validar `31/31` tests, TypeScript/bundle y desplegar `agora-proxy`.
- [x] Restaurar `ShowInPos` de las 13 familias y los flags exactos de los 402 productos del snapshot.
- [x] Ejecutar `sync-master-data`: `0` diferencias de familia y `0` diferencias de producto; legacy y Winerim coexisten.
- [x] Actualizar `provider_config.legacy_visibility_policy=VISIBLE_DURING_PILOT` conservando ambos snapshots.
- [x] Confirmar en Agora las ocho familias Winerim visibles con `337/337` productos vendibles, manteniendo a la vez las `11` familias legacy visibles del snapshot.
- [x] Completar una vuelta de catálogo Winerim (`330` vinos), sin cambios reales y con cola final `0`.
- [x] Corregir y desplegar `winerim-proxy` para no ocultar errores al persistir `last_catalog_sync_at` (`645b3d8`).
- [ ] Pedir confirmacion visual al cliente tras refrescar los terminales Agora.

## P0 — tSpoonLab stock/pedidos + ventas Holded

- [x] Fijar responsabilidades: Agora -> Holded para ventas cerradas; tSpoonLab -> middleware para stock/pedidos.
- [x] Preparar requisitos de cliente en `docs/integrations/TSPOONLAB_HOLDED_CLIENT_REQUIREMENTS.md`.
- [ ] Obtener usuario tecnico, password, centro de coste y almacenes tSpoonLab.
- [ ] Acordar stock teorico, ultimo inventario o ambos; confirmar estados de pedidos y fecha inicial.
- [ ] Obtener API Token Holded v2 con ventas read/write y permisos de lectura auxiliares, sin Inventory write.
- [ ] Acordar recibo diario o documento por factura, IVA, pagos, cliente generico, canal y estado borrador/aprobado.
- [ ] Ampliar proxy tSpoonLab con lectura paginada de pedidos de compra, albaranes, almacenes e inventarios.
- [ ] Implementar `dry-run` Holded y persistencia idempotente antes de `POST /sales-receipts`.
- [ ] Canary de un dia cerrado en borrador; comprobar reintento y anulacion compensatoria.

## P0 — Tintorera · recuperar acceso y activar sin ocultar legacy

- [x] Confirmar que la conexion existe en Lovable Cloud en modo seguro y sin escrituras.
- [x] Validar token y reconstruir catalogo Winerim: `300` vinos actuales y
  `313` formatos estandar con precio tras el enriquecimiento completo.
- [x] Repetir sonda local y desde Lovable Cloud/backend: `tintorera.dyndns.org:8984` termina en timeout.
- [x] Repetir comprobacion fresh el 20/07: timeout directo, timeout de 120
  segundos desde Lovable Cloud y auditoria `NO_MASTER_DATA`.
- [x] Documentar diagnostico, checklist SAT, activacion y rollback en `docs/integrations/TINTORERA_AGORA_READINESS_2026-07-14.md`.
- [x] Confirmar acceso recuperado desde Lovable Cloud: API, maestros y tickets
  abiertos HTTP `200`.
- [x] SAT: confirmar servidor Agora encendido, modulo/API HTTP activos y servicio escuchando en `8984`.
- [x] SAT: confirmar Modulo de Servicios de Integracion, API HTTP y
  `/api/import/` activos.
- [x] Leer `/api/`, Families, Products, IVA, listas, preparacion, almacenes,
  centros, tickets e Invoices.
- [x] Guardar snapshot previo y clasificar los `1027` productos legacy.
- [x] Crear las ocho familias Winerim y publicar `313` formatos estandar,
  manteniendo legacy intacto.
- [x] Verificar fresh `313/313 MATCH`, mappings/tracking `313`, cola cero,
  tarifa/centros correctos y breaker cerrado.
- [x] Corregir la comparacion diferencial de vinos homonimos por anada
  (`aff6e6f`) y reprocesar los cinco bloqueos como `5/5 SUCCESS`.
- [x] Activar auto-push, catalogo, intradia y captura de tickets cada cinco
  minutos; mantener escritura provisional de tickets apagada.
- [ ] Acordar mapeo de botella pequena, media botella y botella tienda.
- [ ] Cliente: probar una botella y una copa desde botones Winerim.
- [ ] Verificar en ERP ambas ventas, hora real, stock activo/inactivo e
  idempotencia.
- [ ] Probar alta, cambio de precio, sin precio e inactivacion con ventana maxima de 5 minutos.
- [ ] Observar red, ventas y alertas 24 horas antes de promover desde
  `LIVE_PENDING_SALE_CANARY`.

## P0 — Piloto tSpoonLab + Holded

- [x] Revisar documentación oficial actual de tSpoonLab y Holded API v2.
- [x] Implementar clientes y proxies de solo lectura.
- [x] Añadir tests de autenticación, contexto y paginación.
- [x] Documentar arquitectura, responsabilidades, idempotencia y reversión.
- [x] Generar PDF `Winerim_Agora_brief_partner_v6_2026-07-14.pdf` y verificar render.
- [ ] Obtener usuario técnico/password tSpoonLab.
- [ ] Seleccionar `order_center_id` y `recipe_center_id` del restaurante piloto.
- [ ] Obtener API Token Holded v2 con permisos mínimos de lectura.
- [ ] Ejecutar `test`, inventario de centros/menús/recetas y catálogo contable en modo lectura.
- [ ] Confirmar con Agora identificadores estables, código padre/modificador y modelo de cancelaciones.
- [ ] Diseñar migración con claves idempotentes únicas para consumo de componentes, documentos Holded y reversiones.
- [ ] Implementar `dry-run` sin escrituras y comparar un caso real de Saddle.
- [ ] Activar un canary solo después de decidir stock de vino, serie fiscal, impuestos y rollback.

## P0 — 8 Agora prioritarios · cerrar altas y cambios de precio 2026-07-13
- [x] Confirmar que los cambios que faltaban no estaban en GitHub antes del deploy manual.
- [x] Subir a GitHub `main` el commit `5b5fcdb` con:
  - hora real de venta por línea (`provider_sold_at`);
  - `sales/import` cuando `stockActive=false`;
  - guard diferencial `update_skipped:no_agora_changes` para `AUTO_UPDATE`;
  - migración `20260713073627_add_agora_provider_sold_at_to_sales_lines.sql`.
- [x] Aplicar en Lovable Cloud la migración `20260713073627_add_agora_provider_sold_at_to_sales_lines.sql`.
- [x] Redeploy de `agora-proxy` desde GitHub `main` commit `5b5fcdb`.
- [x] Verificar schema vivo:
  - `sales_line_items.provider_sold_at` existe;
  - `sales_line_items.provider_sold_at_source` existe.
- [x] Verificar runtime vivo con una sonda real controlada:
  - conexión recomendada: `El Bejeque`;
  - acción: `evaluate-auto-push` `eventType=UPDATE` sobre producto ya verificado;
  - esperado: `queued=0` y `update_skipped:no_agora_changes`.
- [x] Solo después de esa sonda, drenar/revisar la cola `AUTO_UPDATE` que reapareció en `Katsu Izakaya`.
- [x] Revisar 8 conexiones prioritarias:
  - El Bejeque;
  - Katsu Izakaya;
  - Restaurante Cienvinos Ecija;
  - Casa Nene;
  - Kava;
  - Restaurante Jardi;
  - Luruna;
  - Sa Pedrera.
- [x] Drenar colas vivas de `AUTO_UPDATE`/XML en conexiones alcanzables:
  - El Bejeque: `0` activas;
  - Katsu: `0` activas tras procesar tanda repetida;
  - Cienvinos: `0` activas;
  - Casa Nene: `0` activas;
  - Kava: `0` activas;
  - Luruna: `0` activas;
  - Sa Pedrera: `0` activas.
- [x] Corregir mappings que provocaban `404` contra Winerim en Casa Nene, Kava y Luruna.
- [x] Implementar localmente guard diferencial de `AUTO_UPDATE` en `agora-proxy`:
  - compara atributos de producto;
  - compara precios por lista efectiva;
  - si Agora ya coincide con Winerim devuelve `update_skipped:no_agora_changes`.
- [x] Validar localmente:
  - `npx tsc --noEmit --pretty false`;
  - bundle esbuild de `agora-proxy`;
  - `git diff --check`.
- [x] Confirmar que Lovable Cloud ejecuta `agora-proxy` con el guard diferencial del commit `5b5fcdb`.
- [x] Tras deploy, repetir sonda viva:
  - `evaluate-auto-push` `UPDATE` sobre vino ya verificado;
  - resultado esperado: `queued=0` y `update_skipped:no_agora_changes`.
- [x] Repetir `fetch-catalog` controlado por conexión después del deploy:
  - si hay vino nuevo Winerim con precio, debe crear `AGORA_XML_UPSERT_PRODUCT`;
  - si hay cambio real de precio, debe crear `AUTO_UPDATE`;
  - si no hay cambio real, no debe crear cola.
- [x] Procesar colas reales posteriores al `fetch-catalog` controlado:
  - `Katsu Izakaya`: `3/3` OK, cola `0`;
  - `Restaurante Cienvinos Ecija`: `1/1` OK, cola `0`.
- [ ] Jardí: pedir a SAT/cliente resolver `NETWORK_UNREACHABLE / No route to host` contra DDNS/puerto `8984` antes de validarlo al 100%.
- [ ] Tras la validación, preparar estado final de los 8 con:
  - catálogo Winerim esperado vs Agora verificado;
  - cambios de precio verificados;
  - cola `0`;
  - ventas/historial sin fallos recientes.
- [ ] `Sa Vida`: decidir activación controlada de `auto_push_verified_ready`; no activarla sin canary porque hay muchos `NOT_PUSHED`.
- [ ] `Taberna de Elia`: decidir estructura destino antes de publicar Winerim (`familias Winerim` sin ocultar legacy vs matching sobre legacy).
- [x] `El Higuerón`: credencial literal terminada en `ROn` validada; Agora responde HTTP `200` y la conexión está activa.
- [ ] `O Bistro`: pedir URL pública/DDNS/túnel; la IP privada no responde desde Lovable Cloud/backend.
- [x] `Tintorera`: conectividad externa recuperada y validada desde Lovable Cloud.
- [ ] `Saddle`: revisar conectividad externa porque la sonda corta acaba en timeout.
- [x] `Restaurante Qtomas`: detener reintentos; `59` tareas quedaron `BLOCKED` y auto-push de catálogo pausado.
- [ ] `Restaurante Qtomas`: revisar conectividad/DDNS/puerto antes de cualquier auditoría o reencolado.

## P0 — Agora open tickets / Sa Pedrera copas 2026-07-11
- [x] Sa Pedrera: resolver caso `E510-Izar-Leku`:
  - venta ficticia en `OpenTicket` antiguo `2026-07-11` descontada el `2026-07-13`;
  - el cliente confirmó cancelación;
  - stock Winerim de botella `9902 / stockId 10529` repuesto a `1`;
  - compensación `stock_sync_log.quantity=-1` registrada como `open_ticket_cancellation_restore`;
  - evento antiguo marcado como cancelado/no elegible.
- [x] Sa Pedrera: implementar localmente protección del piloto de tickets abiertos para no descontar stock desde `OpenTicket` con `BusinessDay` anterior al día operativo actual sin reconciliación/cancelación confirmada.
- [x] Desplegar `agora-proxy` en Lovable Cloud con:
  - `open_tickets_stock_current_day_only`;
  - `open_tickets_restore_stale_previous_days_enabled`;
  - restauración idempotente `open_ticket_cancellation_restore`.
- [x] Post-deploy Sa Pedrera: ejecutar `sync-open-tickets` y confirmar que no vuelve a tocar `E510` por idempotencia.
- [x] Post-deploy Sa Pedrera: confirmar restauración de tickets stale sin errores:
  - `checkedEvents=3`;
  - `disabledEvents=2`;
  - `restored=2`;
  - `failed=0`.
- [ ] Sa Pedrera: validar durante servicio real una venta abierta del día actual y una cancelación controlada para confirmar que:
  - el día actual descuenta correctamente tras edad mínima;
  - una cancelación/ticket stale restaura sin duplicar;
  - `Invoices` sigue reconciliando definitivamente.
- [ ] Reintentar status global vivo de conexiones cuando Lovable Cloud/backend deje de devolver HTTP `522`:
  - `pos_connections`;
  - `sales_events`;
  - `stock_sync_log`;
  - `outbound_tasks`;
  - `winerim_push_tracking`;
  - `connection_alerts`.
- [ ] Cruzar la auditoría ERP visible del `2026-07-13` con logs del middleware:
  - confirmar si las ventas sin etiqueta `TPV` en Winerim son manuales o importadas sin fuente visible;
  - revisar especialmente `El Bejeque`, `Katsu`, `Kava`, `Chiquilla`, `Cienvinos`, `Luruna`, `Sa Vida`, `O Bistro`, `Qtomas` y `El Higuerón`.
- [ ] `El Bejeque`: investigar por qué el ERP solo muestra TPV hasta `11 Julio 2026 02:00` pese a tener catálogo Winerim correcto; validar si el cron/open tickets no está corriendo, si no hay ventas nuevas o si no se está importando historial.
- [ ] `Katsu Izakaya`: usar `menuId=1019` como carta activa para historial; investigar por qué la última venta TPV visible es `09 Julio 2026 00:00` y no hay evidencia intradía reciente.
- [x] Confirmar causa del `Unknown action`: los cambios estaban en una copia local no trackeada y no en el repo GitHub desplegable.
- [x] Implementar en el repo oficial:
  - `probe-open-tickets`;
  - `sync-open-tickets`;
  - dispatch por `provider_config.open_tickets_sync_enabled`;
  - regla `GLASS` basada en `glass_sale_price>0`.
- [x] Añadir test estatico `src/test/agoraOpenTicketsStatic.test.ts`.
- [x] Validar localmente:
  - `npm ci`;
  - `npm test` (`5` archivos, `22` tests);
  - `npx tsc --noEmit`;
  - bundle esbuild de `agora-proxy`;
  - bundle esbuild de `agora-cron-dispatcher`;
  - `git diff --check`.
- [x] Crear commit local `a932bdb` (`Add Agora open tickets pilot`).
- [x] Subir commits a GitHub `main` hasta `97eadf5`.
- [ ] Pedir redeploy en Lovable Cloud de:
  - `agora-proxy`;
  - `agora-cron-dispatcher`.
- [ ] Post-redeploy: confirmar que `probe-open-tickets` ya no devuelve `Unknown action`.
- [ ] Sa Pedrera: ejecutar `probe-open-tickets` y guardar resultado de endpoint:
  - si devuelve tickets JSON con lineas y `ProductId`, activar piloto de captura;
  - si devuelve 500/HTML/vacio, no activar stock y documentar que esa instalacion sigue dependiendo de cierre/Invoices.
- [ ] Sa Pedrera: activar primero `provider_config.open_tickets_sync_enabled=true` con `open_tickets_stock_sync_enabled=false` y confirmar que se guardan `OpenTicket` sin descontar.
- [ ] Sa Pedrera: activar `open_tickets_stock_sync_enabled=true` solo tras validar mapeo y retardo de lineas (`open_tickets_min_line_age_minutes`).
- [ ] Sa Pedrera: probar un vino con precio de copa en Winerim y confirmar que `evaluate-auto-push` ya no devuelve `glass_skipped:serve_by_glass_not_enabled`.
- [ ] Sa Pedrera: procesar cola y verificar visualmente que las copas aparecen donde espera el cliente.

## P0 — Cienvinos / historial Winerim con stock 0 2026-06-26
- [x] Confirmar que Cienvinos tiene ventas mapeadas y `stock_sync_log.SUCCESS` recientes.
- [x] Confirmar patron del fallo reportado: ventas con `previousStock=0` y `newStock=0`, aceptadas por Winerim pero sin bajada real.
- [x] Implementar fallback `POST /api/v2/sales/import` solo cuando el stock no se mueve.
- [x] Cubrir el calculo con test unitario.
- [x] Validar localmente:
  - `npm test -- --run` OK (`19` tests);
  - `npm run build` OK;
  - bundle/parse de `agora-proxy` OK.
- [x] Ejecutar backfill Cienvinos de ventas ya marcadas `SUCCESS` con `previousStock=0/newStock=0`:
  - `34` lineas;
  - `40` unidades;
  - business day `2026-06-24`;
  - respuesta Winerim `imported=34`, `failed=0`.
- [x] Verificar idempotencia del backfill: segunda ejecucion devuelve `imported=0`, `skipped=34`, `failed=0`.
- [x] Anotar logs originales con `winerim_response.salesImportBackfill`.
- [ ] Desplegar `agora-proxy` en Lovable Cloud.
- [ ] Probar con Cienvinos una venta nueva de una variante con stock `0` y confirmar que:
  - `stock_sync_log.SUCCESS` incluye `winerim_response.salesImport`;
  - Winerim muestra historial de venta;
  - el stock permanece en `0`.
- [x] Confirmar visualmente en Winerim admin/editor que las ventas importadas aparecen en `ERP > Historial`:
  - `40` unidades;
  - `236,50 €`;
  - fecha visible `24 Junio 2026`;
  - ejemplos: `Cordon Rouge Brut`, `Ermita del Monte`, `Ramon Bilbao`, `Convento San Francisco Primer Año`.
- [ ] Confirmar con el cliente/equipo Winerim si tambien lo ven desde su propia sesion.

## P0 — Monitorizacion conexiones + emails 2026-06-25
- [x] Crear migracion `20260625044943_connection_health_monitor.sql` con `connection_health_checks`, `connection_alerts` y `connection_notification_contacts`.
- [x] Crear Edge Function `connection-health-monitor` en modo observacional.
- [x] Integrar `/alerts` con incidencias persistentes, historico de checks, boton manual `Run Monitor` y fallback legacy.
- [x] Actualizar badge lateral para contar alertas persistentes abiertas.
- [x] Validar localmente:
  - bundle/parse de Edge Function OK;
  - `npm run build` OK;
  - `npm test` OK (`18` tests).
- [x] Subir commit `f4f90f2` a GitHub `main`.
- [x] Sondar funcion post-push: `connection-health-monitor` aun devuelve `404 NOT_FOUND`.
- [x] Aplicar migracion en Lovable Cloud.
- [x] Desplegar Edge Function `connection-health-monitor` en Lovable Cloud.
- [x] Verificar post-despliegue:
  - `connection_alerts` HTTP 200;
  - `connection_health_checks` HTTP 200;
  - `connection_notification_contacts` HTTP 200;
  - `connection-health-monitor` HTTP 200 en `dryRun=true`.
- [x] Ejecutar prueba real segura con `sendEmails=false` y `notifyClients=false`: `9` checks insertados, `6` alertas abiertas, `0` emails enviados.
- [ ] Configurar secretos email:
  - `RESEND_API_KEY`;
  - `ALERT_EMAIL_FROM`;
  - `ALERT_INTERNAL_EMAILS`.
- [x] Preparar credencial segura de invocacion recurrente en codigo:
  - `MONITOR_CRON_SECRET`;
  - header `X-Monitor-Secret`;
  - helper SQL `invoke_connection_health_monitor_secure(...)`.
- [x] Desplegar el hardening del monitor en Lovable Cloud:
  - migracion `20260625072756_secure_connection_health_monitor_cron.sql`;
  - Edge Function `connection-health-monitor`;
  - frontend `/alerts` con `Run Monitor` sin emails.
- [ ] Configurar secreto `MONITOR_CRON_SECRET` en Lovable Cloud.
- [ ] Decidir y configurar umbrales definitivos:
  - interno recomendado: `ALERT_INTERNAL_AFTER_OCCURRENCES=2`;
  - cliente recomendado: `ALERT_CLIENT_AFTER_OCCURRENCES=3`;
  - cliente recomendado: `ALERT_CLIENT_AFTER_MINUTES=30`.
- [ ] Crear contactos cliente/SAT en `connection_notification_contacts` para Casa Nene, Jardi, Sa Vida y el resto de conexiones que deban recibir aviso directo.
- [x] Ejecutar prueba negativa: `sendEmails=true` sin `X-Monitor-Secret` devuelve 403 `MONITOR_SECRET_REQUIRED`.
- [x] Ejecutar prueba externa dry-run sin emails: devuelve HTTP 200 y revisa `9` conexiones.
- [ ] Ejecutar prueba real con email interno cuando existan secretos Resend, destinatarios internos y `MONITOR_CRON_SECRET`.
- [ ] Activar cron cada `10` minutos usando `public.invoke_connection_health_monitor_secure(fn_url, anon_key, monitor_secret, true)`.
- [ ] Confirmar en `/alerts` que aparecen:
  - check historico;
  - alertas abiertas iniciales (`Sa Vida`, `Sa Pedrera`, `Cienvinos`, `Katsu`);
  - error de email solo si falta configuracion;
  - resolucion automatica al recuperar una conexion.

## P0 — Flota Agora · checklist auditoria 2026-06-25
- [ ] Crear un checklist individual por cada integracion Agora activa o nueva usando `AGORA_INTEGRATION_CHECKLIST.md`.
- [x] Casa Nene: checklist individual creado en `AGORA_CHECKLIST_CASA_NENE_2026-06-25.md`; estado `PAUSED`.
- [x] Ejecutar auditoria viva 2026-06-26 y documentar `AGORA_FLEET_AUDIT_2026-06-26.md`.
- [x] Ejecutar reauditoria viva 2026-06-26 12:38 y documentar `AGORA_FLEET_AUDIT_2026-06-26_1238.md`.
- [x] Aplicar backfill Winerim `sales/import` para ventas Agora ya `SUCCESS` con stock `0->0`:
  - Casa Nene: `10` filas anotadas;
  - Katsu: `1` fila historica anotada;
  - Kava: `29` filas anotadas;
  - Jardi: `9` filas anotadas;
  - Sa Pedrera: `69/90` `SUCCESS` con `salesImportBackfill`, quedan `19` filas no forzadas por variante/404.
- [ ] Desplegar `agora-proxy` con el guard de `buildSalesResolutionMap()` para no resolver ventas por mappings de productos con tracking `HIDDEN`.
- [ ] Tras deploy, confirmar que ventas nuevas de productos/formats ocultos no generan nuevos `stock_sync_log.FAILED`.
- [ ] Para cada cliente, no marcar `LIVE_AUTOMATIC` hasta tener venta real mapeada y `stock_sync_log.SUCCESS` por cada formato aplicable.
- [x] Casa Nene: conectividad recuperada en auditoria 2026-06-26; sonda OK, ventas hasta `2026-06-25`, `84` stock `SUCCESS`.
- [ ] Casa Nene: validar en runtime el parche de idempotencia intradia por total diario con `force=true` y confirmar que no descuenta de nuevo ventas ya aplicadas.
- [ ] Casa Nene: si el test da `synced=0` y stock sin cambios, reactivar `intraday_sales_sync_enabled=true` solo para esta conexion.
- [x] Jardi: conectividad recuperada en auditoria 2026-06-26; sonda OK, ventas hasta `2026-06-25`, `22` stock `SUCCESS`.
- [ ] Jardi: revisar `3 FAILED` y los `7` formatos de copa faltantes (`173/180` verificados).
- [ ] Sa Vida: corregir credencial/API token o cabecera Agora; sonda viva actual devuelve `401`.
- [ ] Sa Vida: no reintentar deuda outbound/stock hasta que la sonda vuelva a `success=true`.
- [x] Sa Pedrera: identificar causa de `C B310- Albenc [copa]`: `serve_by_glass=false`, tracking `GLASS=HIDDEN`, mapping `CONFIRMED`.
- [ ] Sa Pedrera: tras deploy del guard, confirmar que `C B310- Albenc [copa]` deja de generar nuevos fallos; decidir si se rechaza mapping historico o se corrige `serve_by_glass`/variante en Winerim.
- [ ] Sa Pedrera: resolver los `19` `SUCCESS 0->0` que no se pudieron importar a historial:
  - copas donde Winerim solo expone botella actual (`B345`, `T33`, `B310`, `T1`, `T45`);
  - IDs Winerim con `GET /stock/wine/{id}=404` (`T75`, `T39`);
  - botella cuyo stock actual expone copa (`E522`).
- [ ] Sa Pedrera: clasificar deuda outbound masiva antes de cualquier retry; no procesar en bloque.
- [ ] Sa Pedrera: validar por venta real que una botella y una copa Winerim descuentan stock y aparecen en historial Winerim.
- [x] Katsu Izakaya: revisar tareas abiertas; verificacion viva 2026-06-25 17:04 CEST confirma `0 QUEUED / 0 RUNNING / 0 FAILED / 0 BLOCKED`.
- [x] Katsu Izakaya: probar `auto_push_on_update=true`, ejecutar `fetch-catalog`, encolar `68` updates y drenar cola final a `0 QUEUED / 0 RUNNING / 0 FAILED / 0 BLOCKED`.
- [x] Katsu Izakaya: pausar de nuevo `auto_push_on_update=false` al confirmar que el cron reencola tandas repetidas `AUTO_UPDATE`; mantener altas e intradia activas.
- [x] Katsu Izakaya: activar `provider_config.intraday_sales_sync_enabled=true` y validar dispatcher `sales-stock` con `auto-sync-sales` + `sync-intraday-sales` OK.
- [x] Katsu Izakaya: confirmar estructura visual viva: raiz `VINOS` con familias Winerim por tipo y raiz `Copas de Vino` con `COPAS WINERIM`.
- [x] Katsu Izakaya: prueba real ya observada el 2026-06-26; hay copas Winerim con `stock_sync_log.SUCCESS`.
- [ ] Katsu Izakaya: revisar `C Saiaz Rosado` (`272890`): Winerim lo devuelve 404 / cache `is_active=false`, tracking `HIDDEN`, mapping aun confirmado. Tras deploy del guard, confirmar que no vuelva a descontar.
- [ ] Katsu Izakaya: corregir clasificador `isWineCandidate()` para respetar reglas `wine_family_rules` y no marcar comida/bebida de `CARTA`/`KATSU LIQUIDO` como candidato operativo.
- [ ] Katsu Izakaya: corregir idempotencia de `auto_push_on_update` antes de reactivarlo; debe devolver `no_catalog_changes_detected` tras una tanda ya aplicada.
- [ ] La Candela de Triana: resolver por que hay ventas hasta `2026-06-25` pero `mappedCount=0` y `stock_sync_log=0`; prioridad a mappings/venta desde botones Winerim.
- [ ] Luruna: resolver falta de stock reciente desde `2026-06-08`; revisar `winerim_push_tracking.QUEUED=5` y deuda outbound `10 FAILED / 58 BLOCKED`.
- [ ] Kava: clasificar deuda historica `7 FAILED / 9 BLOCKED` outbound y `13 FAILED / 26 BLOCKED` stock; no hay errores recientes.
- [ ] Cienvinos: revisar deuda outbound `3 FAILED / 7 BLOCKED`; ventas y stock recientes ya funcionan (`34 SUCCESS`).
- [ ] Don Bernardo Ponzano/Santander: mantener read-only; preparar CSV de no-match y confirmar estructura destino antes de activar catalogo/stock.
- [ ] Baco Getafe: mantener apagado/revertido a legacy salvo nueva autorizacion expresa.

## P0 — Sa Pedrera / `[INACTIVO]` en tickets de cliente 2026-06-23
- [x] Transcribir audios del cliente y confirmar alcance: el vino se cobra, pero el nombre aparece con prefijo `[INACTIVO]` en factura/proforma.
- [x] Localizar causa en `AGORA_HIDE_PRODUCT`: el hide automático renombraba el producto como `[INACTIVO] ${wineName}`.
- [x] Cambiar `AGORA_HIDE_PRODUCT`: ocultar preservando el producto completo de Agora y solo apagar `UseAsDirectSale`/`SaleableAsMain`; limpiar prefijo si ya existe.
- [x] Validar bundle/parse local de `agora-proxy`.
- [x] Publicar commit `5871e02` en `main`.
- [x] Ejecutar limpieza controlada en Sa Pedrera: `37` productos prefijados limpiados; verificación live y snapshot backend con `prefixedCount=0`.
- [ ] Confirmar redeploy de Lovable Cloud con el commit del hotfix.
- [ ] Hacer prueba de regresión en Sa Pedrera:
  - vender vino activo en una mesa;
  - inactivarlo en Winerim durante el servicio;
  - confirmar que ya no se puede pedir de nuevo;
  - imprimir factura y verificar que no aparece `[INACTIVO]`.
- [ ] Revisar si otras conexiones Agora tienen productos ya prefijados `[INACTIVO]` y aplicar la misma limpieza si procede.

## P0 — Don Bernardo Ponzano/Santander Agora read-only 2026-06-23
- [x] Crear conexiones Don Bernardo Ponzano y Don Bernardo Santander sin documentar tokens.
- [x] Dejar ambas conexiones en read-only:
  - `enabled=false`;
  - `catalog_sync_enabled=false`;
  - `write_mode=NONE`;
  - auto-push apagado;
  - `provider_config.read_only_onboarding=true`;
  - `provider_config.stock_sync_start_date=2026-06-23`.
- [x] Validar conectividad Agora e `Invoices`:
  - Ponzano: OK, `342` facturas en 14 dias;
  - Santander: OK, `1.158` facturas en 14 dias.
- [x] Refrescar master data Agora sin escritura POS.
- [x] Refrescar catalogo Winerim sin auto-push.
- [x] Importar historico `2026-03-23` a `2026-06-23` como analitica no descontable:
  - Ponzano: `3.400` facturas / `11.797` lineas / `0` errores;
  - Santander: `6.883` facturas / `22.351` lineas / `0` errores.
- [x] Verificar que el historico no descuenta stock:
  - `stock_sync_log=0`;
  - `mapped=true` muestra vacia;
  - `raw_json._stock_sync_eligible=false`.
- [x] Detectar y corregir live `write_mode` tras `sync-master-data`: ambas conexiones reseteadas a `NONE`.
- [x] Subir commit `d9aae7f` con `backfill-sales-analytics`, guard `stock_sync_start_date` y proteccion read-only de `sync-master-data`.
- [x] Documentar informe `DON_BERNARDO_READONLY_AUDIT_2026-06-23.md`.
- [ ] Confirmar redeploy de Lovable Cloud con `d9aae7f`; ultima sonda seguia en runtime antiguo (`Unknown action` para `backfill-sales-analytics`).
- [ ] Cuando el runtime nuevo este desplegado, validar:
  - `backfill-sales-analytics` dry-run 1 dia;
  - `sync-master-data` con `read_only_onboarding=true` no cambia `write_mode`.
- [ ] Enviar/ajustar emails de Ponzano y Santander desde `DON_BERNARDO_READONLY_AUDIT_2026-06-23.md`.
- [ ] Preparar CSV/Excel de no-match para revision:
  - Ponzano: `37` sin match claro;
  - Santander: `105` sin match claro.
- [ ] Preguntar al cliente/SAT:
  - si se conserva estructura Agora;
  - donde entran vinos nuevos Winerim;
  - uso real de `Vinos Barra`;
  - si `BEBIDAS > BOTELLAS...` sigue operativo o es residual.
- [ ] No activar stock, catalogo automatico ni ocultacion legacy hasta aprobar mappings/familias.

## P0 — Estudio Resto / La Refineria API
- [x] Revisar documentacion recibida `Api Resto` v1 sin versionar credenciales.
- [x] Documentar precheck: `ESTUDIO_RESTO_API_PRECHECK_2026-06-22.md`.
- [ ] Responder al SAT: la API actual sirve para leer menu/stock, pero falta ventas cerradas y escritura de productos/precios para integracion completa.
- [ ] Pedir endpoint de ventas cerradas por fecha de negocio con documentos y lineas idempotentes.
- [ ] Pedir endpoint de crear/actualizar productos/precios/activo/categoria si el cliente quiere Winerim -> POS.
- [ ] Confirmar respuesta real de `POST /api/token`: formato del token, expiracion, refresh y errores.
- [ ] Resolver conectividad: API privada/local `192.168.x.x` no es accesible desde backend sin tunel/VPN/IP publica/conector local.
- [ ] Confirmar si hay certificado TLS valido o si el HTTPS local usa certificado autofirmado.
- [ ] Confirmar multi-restaurante: uso de `restaurantId`, filtro por token o parametro.

## P0 — Katsu Izakaya definitivo y monitorizacion Agora 2026-06-19
- [x] Refrescar master data Agora y catalogo Winerim de Katsu antes de escribir.
- [x] Importar Katsu por XML separado por formato: botellas, copas y magnums.
- [x] Verificar Katsu: `131/131` formatos Winerim presentes, vendibles y sin botones raiz.
- [x] Activar Katsu en modo automatico: `auto_push_on_create/update/verified_ready=true`, copas activas y `WINERIM_DEDICATED_FAMILIES`.
- [x] Ocultar legacy Katsu de forma reversible y guardar snapshot:
  - `KATSU_LEGACY_HIDE_SNAPSHOT_2026-06-19.json`;
  - `KATSU_LEGACY_HIDE_APPLIED_2026-06-19.json`.
- [x] Ejecutar `fetch-catalog` post-activacion Katsu y drenar cola XML hasta `0 QUEUED / 0 RUNNING / 0 FAILED / 0 BLOCKED`.
- [x] Documentar Katsu:
  - `KATSU_DEFINITIVE_ACTIVATION_2026-06-19.md`;
  - `KATSU_ACTIVATION_VERIFY_2026-06-19.json`;
  - `KATSU_FETCH_CATALOG_POST_ACTIVATION_2026-06-19.json`;
  - `KATSU_PROCESS_QUEUE_DRAIN_FINAL_2026-06-19.json`.
- [ ] Katsu cliente: pedir que recarguen/cierren sesion en tablets y validen familias Winerim y orden visual.
- [ ] Katsu prueba real: vender una botella y una copa Winerim, cerrar jornada y validar `sales_line_items.mapped=true` + `stock_sync_log.SUCCESS`.
- [ ] Katsu monitor: revisar el siguiente ciclo automatico de catalogo; no debe dejar cola abierta ni generar import masivo salvo cambios reales de Winerim.
- [ ] Katsu deuda: clasificar el fallo historico de stock del 2026-05-20 solo si reaparece o bloquea metricas.

## P0 — Flota Agora tras auditoria 2026-06-19
- [x] Auditar estado vivo de todas las conexiones Agora y documentar `AGORA_FLEET_STATUS_2026-06-19.md`.
- [ ] Casa Nene: recuperar conectividad Agora publica/DDNS/puerto antes de refrescar ventas posteriores; el `2026-06-25` `fetch-day` devolvio `NETWORK_UNREACHABLE / No route to host`.
- [ ] Casa Nene: inspeccionar `1 FAILED` sin reintentar en bloque; no reactivar intradia ni hacer retries hasta validar conectividad y parche de idempotencia total-diario.
- [ ] Kava: clasificar `7 FAILED / 9 BLOCKED` y `23 BLOCKED` de stock; no hay cola viva.
- [ ] La Candela: validar primera venta Winerim con stock, porque la cola esta limpia pero no hay stock reciente en la muestra.
- [ ] Luruna: clasificar `10 FAILED / 58 BLOCKED` y confirmar con cliente que no reaparece saturacion.
- [ ] Sa Pedrera: clasificar deuda historica grande (`FAILED/BLOCKED`) y los `13 FAILED` de stock recientes antes de cualquier retry masivo.
- [ ] Jardi: recuperar ruta/firewall/DDNS (`502 No route`) antes de procesar `1 QUEUED / 3 FAILED`.
- [ ] Cienvinos: revisar conectividad/timeout antes de procesar `131 QUEUED / 4 BLOCKED`.
- [ ] Sa Vida: no reintentar hasta que Agora deje de devolver `501` en endpoints esperados.
- [ ] Baco Getafe: sigue apagado/revertido a legacy; no tratar como automatico Winerim sin nueva autorizacion.

## P0 — Nuevas integraciones Agora · El Bejeque y Taberna de Elia
- [x] Auditar El Bejeque en modo read-only antes de crear conexión o subir Winerim.
- [x] Auditar Taberna de Elia en modo read-only antes de crear conexión o subir Winerim.
- [x] Documentar informe: `AGORA_PRE_ONBOARDING_AUDIT_2026-06-17.md`.
- [x] Parsear Excel Winerim de El Bejeque y cruzar contra Agora.
- [x] Parsear Excel Winerim de Taberna de Elia y cruzar contra Agora.
- [x] Documentar pre-match: `WINERIM_AGORA_MATCH_PRECHECK_2026-06-17.md`.
- [x] El Bejeque: ocultar legacy visible de vino y dejar productos legacy no vendibles, sin borrar nada.
- [ ] El Bejeque: cuando Lovable Cloud/backend responda, ejecutar `sync-master-data` para refrescar `agora_master_data` después de la ocultación aplicada por API directa.
- [ ] El Bejeque: pedir validación visual al cliente y venta real desde botón Winerim para confirmar historial/stock.
- [ ] El Bejeque: revisar `9` no-match y `9` review antes de aprobar mappings automáticos; match seguro actual `54/72` operativos (`75.0%`).
- [ ] Taberna de Elia: confirmar si desean conservar la estructura visible `Bodega` por regiones/denominaciones y hacer matching legacy, o crear familias Winerim dedicadas en paralelo.
- [ ] Taberna de Elia: revisar producto directo genérico `Botella de Vino` y decidir si debe bloquearse, mapearse manualmente o sustituirse por vinos concretos.
- [ ] Taberna de Elia: revisar `62` matches duplicados/ambiguos, `96` review y `101` no-match; match seguro actual `176/373` operativos (`47.2%`).
- [ ] Preparar Excel de revisión Winerim vs Agora con estado `MATCH`/`REVIEW`/`NO_MATCH` si el usuario quiere avanzar a validación manual.
- [ ] Para ambos: validar Winerim en lectura y cruzar catálogo Winerim vs Agora antes de cualquier escritura.
- [ ] Para ambos: si se crea conexión, empezar con `write_mode=NONE`/read-only, ejecutar `sync-master-data`, revisar mappings y solo después planificar XML import.

## P0 — Firesoft / BDP nuevos contactos
- [ ] Enviar correo a Pascual/Firesoft pidiendo documentación técnica, API/export, autenticación, modelo de datos de artículos/ventas/stock y entorno de pruebas.
- [ ] Confirmar viabilidad Firesoft: API REST, export programable, acceso base datos, ficheros programados o conector oficial.
- [ ] Enviar correo a BDP explicando flujo Winerim y solicitando Weblink REST API, URL/puerto, usuario/clave, código de plantilla de exportación y alcance de escritura de artículos/precios.
- [ ] Cuando BDP responda, comparar con checklist BDP existente: acceso Weblink, mapping, precios/formatos, cierre diario.

## P0 — Migración controlada a Cloudflare / `middleware.winerim.wine`
- [x] Documentar estrategia inicial, rollback y riesgos en `CLOUDFLARE_MIDDLEWARE_MIGRATION_2026-06-12.md`.
- [x] Crear utilidad pura de onboarding comercial en `src/lib/middlewareOnboarding.ts`.
- [x] Crear resolver de API frontend en `src/lib/middlewareApiUrl.ts` para env/hostname/fallback local.
- [x] Crear utilidad de payload sanitizado para solicitudes en `src/lib/onboardingRequest.ts`.
- [x] Crear Worker inicial no destructivo en `cloudflare/workers/middleware-api/src/index.ts`.
- [x] Crear configuración Wrangler en `wrangler.middleware.toml`.
- [x] Crear pantalla comercial `/onboarding` con POS, restaurante, URL POS, token POS, token Winerim y semáforos.
- [x] Ajustar `/onboarding` para REVO: tenant, access token, client-token y webhook secret opcional.
- [x] Añadir tests unitarios de normalización/validación/gates para onboarding.
- [x] Añadir tests del Worker: health, validación sin llamadas externas y REVO sin eco de secretos.
- [x] Añadir tests del resolver de URL API frontend.
- [x] Añadir tests de payload sanitizado de solicitud onboarding.
- [x] Validar bundle del Worker con `esbuild` en copia original.
- [x] Validar transpile de página/utilidad/test de onboarding con `esbuild` en copia original.
- [x] Validar Worker compilado con `fetch` simulado para REVO: endpoint `paymentMethods`, headers oficiales y respuesta sin secretos.
- [x] Documentar Cloudflare Pages en `cloudflare/pages/README.md`.
- [x] Añadir `cloudflare/pages/env.example` sin secretos.
- [x] Documentar DNS/Access staging en `cloudflare/dns-access/README.md`.
- [x] Añadir fallback SPA de Cloudflare Pages (`public/_redirects`) para rutas directas como `/onboarding`.
- [x] Añadir cabeceras defensivas basicas de Pages (`public/_headers`) sin CSP estricta.
- [x] Reconciliar cambios sobre copia limpia del `main` oficial sin pisar documentos vivos de Agora/Sa Pedrera.
- [x] Ejecutar validación limpia: `npm ci`, test dirigido, TypeScript, `npm run build`, bundle Worker.
- [x] Validar visualmente `/onboarding` en Vite limpio; al seleccionar REVO aparecen los campos específicos.
- [x] Resolver bloqueo Wrangler en rama limpia usando `npx --yes wrangler`.
- [x] Ejecutar `wrangler deploy --env staging --dry-run`.
- [x] Desplegar Worker staging `winerim-middleware-api-staging` sin tocar producción.
- [x] Validar `GET /health` en `https://winerim-middleware-api-staging.gugocreative.workers.dev`.
- [x] Validar `POST /api/onboarding/test` con payload incompleto: responde errores de campos sin escrituras.
- [x] Ajustar `compatibility_date` para que `wrangler dev` arranque localmente con la versión instalada.
- [x] Levantar Vite local en `http://127.0.0.1:8084/onboarding` y Worker local en `http://127.0.0.1:8787`.
- [x] Validar CORS local y preflight `OPTIONS` desde `127.0.0.1:8084`.
- [x] Preparar CORS/credenciales para Cloudflare Access:
  - frontend `credentials: "include"`;
  - Worker `ALLOWED_ORIGINS`, `Access-Control-Allow-Credentials`, `Vary: Origin` y cabeceras `CF-Access-*`.
- [x] Redeploy staging tras ajuste de compatibilidad: Version ID `9de8b8ce-97b7-49cf-967e-4edc2969138e`.
- [x] Subir rama `codex/cloudflare-middleware-onboarding` a GitHub sin tocar `main`.
- [x] Abrir PR draft `#1` para revisión: `https://github.com/goiko111/bridge-to-winerim/pull/1`.
- [ ] Crear DNS proxied/custom domain para que `https://api-staging.middleware.winerim.wine/health` resuelva.
- [ ] Configurar Cloudflare Access antes de desplegar `staging.middleware.winerim.wine`.
- [x] Redeploy Worker staging con CORS/credenciales Access-ready y validar `OPTIONS` + `POST /api/onboarding/test`.
- [ ] Investigar por qué en la copia original `vite` escucha puerto pero no responde a HTTP; en la rama limpia ya funciona.
- [ ] Crear entorno Cloudflare staging:
  - `staging.middleware.winerim.wine`;
  - `api-staging.middleware.winerim.wine` (DNS pendiente);
  - Cloudflare Access para equipo interno.
- [ ] Configurar secrets/variables por entorno sin exponer tokens en logs ni frontend.
- [x] Definir tabla inicial `onboarding_requests` para Postgres gestionado sin D1 ni tokens en claro.
- [x] Implementar `POST /api/onboarding/requests` apagado por defecto, con payload sanitizado, redaccion de secretos conocidos, identidad Access y sin conversion a `pos_connections`.
- [x] Añadir boton `Enviar a revisión` en `/onboarding`; si storage esta apagado, informa sin tocar POS/Winerim.
- [x] Implementar revision tecnica de solicitudes: `GET /api/onboarding/requests`, `PATCH /api/onboarding/requests/:id` y pantalla `/onboarding/requests`, sin conversion automatica a conexiones.
- [x] Desplegar Worker staging version `cc726f8e-1047-4888-a8f0-0760a9290f57` con `ONBOARDING_REQUESTS_ENABLED=false`.
- [x] Añadir smoke test `npm run cf:api:verify:staging` y validarlo contra `workers.dev`.
- [x] Preparar validacion JWT de Cloudflare Access en Worker (`CF_ACCESS_AUD` + `CF_ACCESS_TEAM_DOMAIN`) para rutas privadas.
- [x] Redeploy Worker staging version `f980c8ec-6cc7-4355-9f3c-38f3affa4aad` con JWT preparado y storage apagado.
- [x] Añadir maquina de estados segura para `onboarding_requests` y bloquear transiciones inseguras.
- [x] Redeploy Worker staging version `bdcb9972-4631-4249-9887-57da3cb39dc0` con transiciones seguras y storage apagado.
- [x] Extraer maquina de estados a `src/lib/onboardingRequest.ts` para que UI y Worker compartan transiciones.
- [x] Corregir CORS del Worker para permitir `PATCH` y validar preflight de cambios de estado.
- [x] Añadir `npm run cf:readiness:staging` para diferenciar Worker OK de DNS/Pages/Access pendientes.
- [x] Documentar control plane Cloudflare en `README.md`, `cloudflare/README.md`, `cloudflare/access/README.md` y `cloudflare/secrets/README.md`.
- [x] Redeploy Worker staging version `6af1c6ed-fc3a-4d29-aa55-84cb81fbe915` con CORS `PATCH`, transiciones compartidas y storage apagado.
- [x] Validar staging real con `npm run cf:api:verify:staging`: health OK, REVO incompleto OK, CORS `POST/PATCH` OK, storage disabled.
- [x] Validar readiness staging con `0` fallos y `3` pendientes esperados: DNS API custom, CORS por custom domain y Pages.
- [ ] Auditar CSP completa antes de endurecer `public/_headers` con `Content-Security-Policy`.
- [ ] Aplicar migracion `20260615073500_onboarding_requests.sql` solo en Postgres staging, no en produccion.
- [ ] Elegir secret storage real para tokens antes de activar `POST /api/onboarding/requests`:
  - Cloudflare Secrets Store aparece disponible en Wrangler como `open beta`;
  - alternativa: gestor externo o cifrado de aplicacion con clave fuera de la base.
- [ ] Configurar `LOVABLE_CLOUD_REST_URL` y `LOVABLE_CLOUD_SERVICE_KEY` como var/secret solo en staging.
- [ ] Crear app Cloudflare Access para `api-staging.middleware.winerim.wine` y configurar `CF_ACCESS_AUD` + `CF_ACCESS_TEAM_DOMAIN` en staging.
- [ ] Activar temporalmente `ONBOARDING_REQUESTS_ENABLED=true` solo en staging tras Cloudflare Access, probar `Enviar a revisión` y volver a apagar si falla.
- [ ] Cuando el storage de solicitudes este activo, probar `PATCH` de estados desde `/onboarding/requests` y confirmar que no crea `pos_connections`.
- [ ] Conectar `/onboarding` con staging real y probar con una instalación Agora de pruebas.
- [ ] Probar `/onboarding` REVO con tenant/access token/client-token reales antes de usarlo con clientes.
- [ ] REVO Tigre / Grupo Costeño: confirmar si Winerim ya tiene `client-token` partner vigente; si lo tiene, pedir `tenant` + access token de cuenta al cliente/SAT; si no lo tiene o REVO exige registro, usar API Request form desde correo controlado por Winerim y comunicar ese correo al SAT.
- [ ] Añadir modo `dryRun`/revisión técnica antes de crear cualquier `pos_connection`.
- [ ] Portar primer flujo Agora en Cloudflare solo lectura:
  - health/readiness;
  - master data;
  - ventas post-cierre;
  - sin XML import ni ocultación legacy.
- [ ] Hacer canary con una conexión no crítica antes de mover cualquier cliente productivo.
- [ ] Documentar rollback operativo: DNS vuelve a Lovable Cloud o se desactiva Cloudflare sin tocar datos.

## P0 — Auditoria Agora 2026-06-09
- [x] Auditar todas las conexiones Agora salvo Sa Vida contra Lovable Cloud.
- [x] Ejecutar pruebas vivas: Baco/Casa Nene/Katsu/Kava/La Candela/Sa Pedrera OK; Luruna `No route to host`; Cienvinos timeout.
- [x] Drenar cola nueva Casa Nene con dispatcher limitado a conexion: `20/20 SUCCESS`, quedan `0` abiertas.
- [x] Documentar estado por conexion en `AGORA_FLEET_AUDIT_2026-06-09.md`.
- [x] Katsu: revisar por que `605` lineas candidatas de vino en 7 dias quedan `0` mapeadas; validar mappings reales antes de prometer stock. Resultado 2026-06-15: el monitor esta inflado por clasificacion y el corte real de familias vino muestra `299` lineas sin resolver, `218` recuperables por `20` productos seguros.
- [ ] Katsu: corregir `isWineCandidate()` para respetar reglas explicitas de familias no-vino y no contar `NEEDS_REVIEW` como candidato operativo de stock salvo regla explicita.
- [x] Katsu: revisar/bloquear mapping desalineado `972845` queda superado por activacion definitiva Winerim y ocultacion reversible del legacy; no se aplican nuevos mappings legacy.
- [x] Katsu: fase `LEGACY_SAFE_MATCH` descartada/superada; se decide no sincronizar stock historico legacy y validar solo ventas futuras desde botones Winerim.
- [x] Katsu: `resolve-sales` sobre historico legacy descartado; el criterio vigente es ventas futuras Winerim.
- [ ] Katsu: despues de activacion definitiva, venta real de prueba de copa y botella; validar `sales_line_items.mapped=true` y `stock_sync_log.SUCCESS`.
- [x] Katsu 2026-06-15: refresco actual confirmado (`190` legacy reales en familias vino, `95` vinos Winerim cacheados, `58 CONFIRMED`, `27 REJECTED`, `28` matches auto-confirmables y `20` productos seguros que cubririan `218/299` lineas reales de vino).
- [x] Katsu 2026-06-15: exportar estructura Agora por familias: `42` familias raiz, sin subfamilias reales; reporte `KATSU_AGORA_FAMILY_STRUCTURE_2026-06-15.md`.
- [x] Katsu 2026-06-17: auditoría solo lectura Winerim vs Agora sin escrituras:
  - informe `KATSU_READONLY_AGORA_WINERIM_AUDIT_2026-06-17.md`;
  - `66` formatos Winerim esperados por política actual (`64` botellas + `2` magnums);
  - `52` visibles/vendibles, `3` en familia legacy oculta, `11` faltantes;
  - `8` familias Winerim visibles y `0` productos Winerim como botón raíz;
  - legacy vino oculto visualmente (`0` legacy visible+vendible), no borrado;
  - desde `2026-06-01`, `283` documentos / `2.554` líneas, pero `0` líneas mapeadas y `0` `stock_sync_log`.
- [x] Katsu: publicar faltantes detectados el 2026-06-17 queda completado por import XML por formato del 2026-06-19:
  - `277094`, `277100`, `277148`, `275753`, `277143`, `277144`, `277146`, `277149`, `277151`, `277153`, `277154`;
  - verificado `131/131` formatos Winerim presentes/vendibles y cola final limpia.
- [x] Katsu: mover/republicar los `3` Winerim que existian en `VINOS` oculta queda superado por import XML completo en familias Winerim:
  - `272870` `Dulas Rosé`;
  - `272890` `Saiaz Rosado`;
  - `272845` `Abad Dom Bueno Godello Esencia`.
- [x] Katsu: politica de copas decidida el 2026-06-19: activar `auto_push_glass=true` y `write_glass=true`; quedan `65` copas Winerim verificadas.
- [x] Katsu: `auto_push_verified_ready=true` activado tras import XML por formato, `fetch-catalog` diferencial y cola final limpia.
- [ ] La Candela: revisar por que `546` lineas candidatas de vino en 7 dias quedan `0` mapeadas; priorizar ejemplos `Carraovejas Pago` y `Edulis Copa`.
- [ ] Luruna: recuperar conectividad publica Agora (`No route to host`) antes de reintentar cola o prometer automatico.
- [ ] Cienvinos: recuperar conectividad publica Agora (timeout) y luego drenar `68 QUEUED` + revisar `4 BLOCKED`.
- [ ] Kava: clasificar deuda antigua `7 FAILED` / `9 BLOCKED` sin tocar legacy restaurado.
- [x] Sa Pedrera: dejar cola operativa actual en `0 QUEUED / 0 RUNNING` tras aplicar familias Winerim dedicadas.
- [ ] Sa Pedrera: clasificar deuda historica `FAILED/BLOCKED` antes de limpiar o reintentar en bloque.

## P0 — Sa Pedrera familias Winerim dedicadas
- [x] Añadir modo configurable de orden comercial Agora `COMMERCIAL_CODE_NUMERIC`.
- [x] Añadir action `reorder-products-by-commercial-code` que solo modifica `Order` y devuelve `rollbackXml`.
- [x] Conectar la cola `process-xml-outbound-queue` para reordenar automáticamente familias afectadas tras imports correctos si el modo está activo.
- [x] Validar sintaxis de `agora-proxy` en clon limpio con `esbuild`.
- [ ] Confirmar deploy de Lovable Cloud con `reorder-products-by-commercial-code`, `AUTO_PRICE_REMOVED` y breaker residual. Última sonda tras push: `Unknown action`.
- [x] Activar en Sa Pedrera:
  - `provider_config.agora_product_sort_mode="COMMERCIAL_CODE_NUMERIC"`;
  - `provider_config.agora_product_sort_prefix_order=["T","B","R","E","D","G","MAGNUM"]`;
  - `provider_config.agora_product_sort_prefix_order_by_family={"904289":["MAGNUM","T","B","R","E","D","G"]}`;
  - `provider_config.agora_product_sort_family_ids=["900157","904241","903516","908875","908182","904289","901954","903925"]`.
- [x] Ejecutar dry-run Sa Pedrera por XML directo y revisar resumen por familia antes de aplicar.
- [x] Aplicar reordenación Sa Pedrera por `Product.Order` y guardar `rollbackXml`:
  - `SA_PEDRERA_COMMERCIAL_CODE_REORDER_2026-06-17.md`;
  - `SA_PEDRERA_COMMERCIAL_CODE_REORDER_DRY_RUN_2026-06-17.json`;
  - `SA_PEDRERA_COMMERCIAL_CODE_REORDER_APPLIED_2026-06-17.json`;
  - verificación viva `438/438` OK.
- [ ] Validar visualmente con cliente: `TINTOS WINERIM`, `BLANCOS WINERIM`, `ESPUMOSOS WINERIM`, `DULCES WINERIM`, `COPAS WINERIM` y `MAGNUM WINERIM`.
- [ ] Probar caso controlado futuro: crear/activar un vino con código anterior (`T499`) y confirmar que tras el ciclo automático queda antes de `T501`.
- [x] Definir regla global Agora: un vino/formato sin precio en Winerim no debe aparecer operativo en Agora.
- [x] Confirmar comportamiento existente: formatos nuevos sin precio ya no pasan validación ni se crean.
- [x] Añadir en código ocultación automática para formatos ya publicados que pierden precio (`AUTO_PRICE_REMOVED`).
- [ ] Validar en copia limpia/CI el cambio de `agora-proxy`; la copia temporal actual no permite `tsc`/Git fiable por metadata incompleta.
- [ ] Confirmar redeploy de `agora-proxy` en Lovable Cloud con la regla `AUTO_PRICE_REMOVED`.
- [ ] Probar caso controlado: quitar precio a un vino publicado debe ocultarlo en Agora; restaurar precio debe volver a publicarlo.
- [x] Cambiar routing vivo a `WINERIM_DEDICATED_FAMILIES` con reglas hacia familias Winerim.
- [x] Aplicar import controlado completo sin ocultar legacy regional.
- [x] Verificar API Agora: `badCount=0` para `TINTOS`, `BLANCOS`, `ROSADOS`, `ESPUMOSOS`, `FORTIFICADOS`, `MAGNUM` y `COPAS WINERIM`.
- [x] Ocultar duplicado no deseado `T83` (`784242`) y marcar mapping `REJECTED`; canonicos: `902083` botella y `984242` copa.
- [x] Pausar temporalmente `auto_push_on_create/update` para cortar bucle de tandas `AUTO_CREATE`.
- [x] Guardar snapshots/rollback: `SA_PEDRERA_WINERIM_FAMILIES_2026-06-09.md`, `SA_PEDRERA_WINERIM_FAMILIES_APPLIED_2026-06-09.json`, `SA_PEDRERA_PROVIDER_CONFIG_BEFORE_WINERIM_FAMILIES_2026-06-09.json`, `SA_PEDRERA_AUTO_PUSH_FLAGS_BEFORE_PAUSE_2026-06-09.json`.
- [x] Probar sonda live de `evaluate-auto-push` tras push `ae9850c`: Lovable Cloud sigue con runtime antiguo y genera `AUTO_CREATE`; se bloquearon las 3 tareas de prueba y quedan `0 QUEUED / 0 RUNNING`.
- [x] Redesplegar en Lovable Cloud `agora-proxy` y `winerim-proxy`.
- [x] Validar dry-run `forceEvaluate:true` con `249018`: `queued=0`, `wouldQueue=0`, `create_skipped:formats_already_verified`.
- [x] Probar `winerim-proxy fetch-catalog` con flags apagados: `differential=true`, `0` tareas creadas, cadena de cache estabilizada.
- [x] Reactivar `auto_push_on_create=true` y `auto_push_on_update=true`.
- [x] Validar sonda normal post-activacion con `249018`: `queued=0`, `wouldQueue=0`, `create_skipped:formats_already_verified`, cola `0 QUEUED / 0 RUNNING`.
- [x] Procesar primera tanda real de auto-create Sa Pedrera: `3/3 SUCCESS`, `0` cola abierta, tracking `VERIFIED` y mappings `CONFIRMED`.
- [x] Observar tanda posterior `AUTO_UPDATE`: drenada por el procesador automatico hasta `0 QUEUED / 0 RUNNING`; sin `FAILED` nuevos.
- [x] Ocultar legacy de vino de forma reversible: `28` familias legacy ocultas, `521` productos legacy desactivados, `0` legacy visible/activo tras verificacion.
- [x] Confirmar que tras ocultar legacy siguen visibles las `8` familias Winerim y los flags automaticos `auto_push_on_create/update/verified_ready=true`.
- [x] Guardar snapshot/rollback: `SA_PEDRERA_LEGACY_HIDE_APPLIED_2026-06-16.json` e informe `SA_PEDRERA_LEGACY_HIDE_2026-06-16.md`.
- [x] Resolver incidencia `E516 - Hermós Brut Nature`: estaba en cola `AUTO_CREATE`, bloqueada por breaker residual; tras reset con sonda sana, quedó publicado como Agora `787386` en `ESPUMOSOS WINERIM`, tracking `VERIFIED` y mapping `CONFIRMED`.
- [x] Verificar `E520 -Philippe Pacalet Bulles Extra Brut`: publicado como Agora `787118` en `ESPUMOSOS WINERIM`, tracking `VERIFIED`, mapping `CONFIRMED`, sin tareas abiertas/fallidas; legacy antiguo `1177480` queda oculto.
- [x] Corregir en código el breaker residual caducado de `process-xml-outbound-queue`: si la pausa ya venció pero `consecutive_failures>=10`, limpia el breaker antes de procesar.
- [x] Confirmar estado vivo Sa Pedrera tras la corrección operativa: breaker limpio y `0` tareas abiertas Winerim→Agora.
- [ ] Cliente: validar visualmente en tablet todas las familias Winerim y confirmar que `T83` no aparece duplicado.
- [ ] Cliente: validar que el legacy de vino ya no aparece en tablets/terminales tras recargar Agora si hiciera falta.
- [ ] Cliente: validar que `E516 - Hermós Brut Nature` y `E520 -Philippe Pacalet Bulles Extra Brut` aparecen en `ESPUMOSOS WINERIM` tras refrescar/cerrar sesión en Agora.
- [ ] Confirmar redeploy de `agora-proxy` en Lovable Cloud con la corrección de breaker residual.
- [ ] Añadir alerta para tareas `AGORA_XML_UPSERT_PRODUCT` en `QUEUED` más de `10-15` minutos en conexiones activas.
- [ ] Cliente: decidir si `D207-Domaine Les Bruyeres...` debe permanecer en `TINTOS WINERIM` o excluirse por no ser `T###`.
- [ ] Monitorizar el siguiente ciclo de catalogo Sa Pedrera: ya hubo primera tanda pequena correcta; no debe aparecer cola masiva salvo cambios reales de Winerim.
- [ ] Sa Pedrera: clasificar los `13` fallos de la tanda outbound del 2026-06-16 y la tarea `AGORA_HIDE_PRODUCT` restante (`winerim_id=44833`) antes de limpiar/reintentar.
- [ ] Venta de prueba Sa Pedrera: una botella y una copa Winerim; validar `sales_line_items.mapped=true` y `stock_sync_log.SUCCESS`.

## P0 — Sa Pedrera `TINTOS WINERIM`
- [x] Analizar tintos activos Winerim: `200` botellas T### con precio.
- [x] Detectar nombres existentes en Agora antes de escribir: `197/200` ya existian, por lo que no se crean duplicados masivos.
- [x] Aplicar volcado controlado: `199` productos Winerim existentes movidos a `TINTOS WINERIM` (`900157`) y `1` producto nuevo creado (`T83`, `902083`).
- [x] Verificar post-write: `200/200` en `FamilyId=900157`, `UseAsDirectSale=false`, `SaleableAsMain=true`, familia visible, cache refrescada.
- [x] Guardar rollback/snapshot: `SA_PEDRERA_TINTOS_WINERIM_APPLIED_2026-06-09.json`.
- [x] Documentar operacion: `SA_PEDRERA_TINTOS_WINERIM_2026-06-09.md`.
- [ ] Pedir al cliente que abra `TINTOS WINERIM` y confirme orden visual `T1...T282`.
- [ ] Si la tablet no respeta el orden, investigar mecanismo real de layout/cache antes de reimportar.
- [ ] Probar una venta desde `TINTOS WINERIM` y confirmar `sales_line_items.mapped=true` + `stock_sync_log.SUCCESS`.

## P0 — Casa Nene Agora
- [x] Crear conexión Casa Nene en Lovable Cloud sin documentar tokens.
- [x] Verificar Agora externo: web/version, `Families`, `Products` e `Invoices` responden HTTP 200.
- [x] Verificar token Winerim API v2.
- [x] Sincronizar master data Agora y configurar defaults seguros: IVA 10%, `Barra/Bebidas`, almacén `CASA NENE`, sale centers `Barra/COMEDOR/TERRAZA`.
- [x] Sincronizar catálogo Winerim y stockIds por variante.
- [x] Crear familias `... WINERIM` y guardar mappings de familia por tipo/formato.
- [x] Preview XML completo sin escribir: 292 productos, 0 botones raíz, 0 duplicados, 0 mismatch de preparación.
- [x] Importar botellas y magnums por separado para evitar mappings de variantes inexistentes.
- [x] Verificar post-write: 292 productos Winerim visibles/vendibles, 0 botones raíz, mappings `CONFIRMED`, tracking `VERIFIED`.
- [x] Ocultar legacy de vino sin borrar: familias `5/6/7/8/9/13` ocultas y 148 productos legacy no vendibles.
- [x] Activar automático: `enabled`, `catalog_sync_enabled`, `auto_push_on_create`, `auto_push_on_update`, `auto_push_verified_ready`.
- [x] Fijar cursor inicial `last_business_day_synced=2026-06-07` para no reabrir ventas históricas legacy.
- [x] Comprobar cola abierta Casa Nene: 0 tareas abiertas.
- [x] Diagnosticar ventas intradía 2026-06-24: 3 botellas `Valbuxan Tinto Lexitimo` y 1 botella `Pazo de Señorans` estaban en Agora con mapping Winerim correcto.
- [x] Corregir manualmente stock Winerim del 2026-06-24 sin avanzar cursor diario: Valbuxan `7 -> 4`, Pazo `202 -> 201`, deltas pendientes `0`.
- [x] Preparar código de polling intradía `sync-intraday-sales` con descuento incremental por delta e invocación desde dispatcher por flag.
- [x] Validar primer deploy: `sync-intraday-sales` existe, pero el diseño por `sales_event_id` duplicó logs por cambio de IDs; se pausa intradía.
- [x] Restaurar el único decremento duplicado atribuible al test: `Pazo de Señorans` `192 -> 193`; bloquear 3 logs duplicados del test.
- [x] Preparar parche intradía por total diario `(winerim_product_id, variant)` para que cambios de ID de factura no dupliquen stock.
- [ ] Redeployar `agora-proxy` desde el commit del parche por total diario.
- [ ] Con Casa Nene todavía pausado, invocar `sync-intraday-sales` con `force=true` y confirmar `synced=0`, `failed=0` y stock Winerim sin cambios.
- [ ] Solo después de esa prueba, reactivar `provider_config.intraday_sales_sync_enabled=true` en Casa Nene.
- [ ] Confirmar que el siguiente ciclo de `sales-stock` del dispatcher lanza `auto-sync-sales` + `sync-intraday-sales` para Casa Nene y no toca stock si no hay ventas nuevas.
- [ ] Pedir al cliente validación visual en tablet: debe ver familias Winerim y no ver legacy `VINO`/`VINO FUERA DE CARTA`.
- [x] Validar primera venta real con producto Winerim: ventas guardadas, `stock_sync_log.SUCCESS`, variante botella, stockId correcto y sin delta pendiente tras reintento lógico.
- [ ] Validar una nueva venta real posterior al redeploy: comprobar `sales_events`, `sales_line_items`, `stock_sync_log.status=SUCCESS`, `variant`, `stock_id` y no doble deducción al reintentar.
- [ ] Si Casa Nene necesita vender copas, activar/preciar variantes de copa en Winerim; el automático debe publicarlas en `COPAS WINERIM`.

## P0 — Restaurante Jardi / El Jardí Parets Agora
- [x] Retest de conectividad Agora: `test` OK, ventas cerradas detectadas, ultimo cierre `2026-06-13`.
- [x] Retest de master data: `53` familias, `527` productos, `4` IVAs, `1` price list, `1` almacen, `6` sale centers, `2` preparation types, `5` preparation orders.
- [x] Retest Winerim: token OK, `174` vinos leidos, primera tanda `25/25` detalles enriquecidos.
- [x] Verificar que no hay cola tras la prueba: `0 QUEUED / 0 RUNNING / 0 FAILED / 0 BLOCKED`.
- [x] Configurar defaults:
  - IVA `10%`;
  - price list `Preu`;
  - almacen `Magatzem General`;
  - sale centers `MENJADOR`, `CELLER`, `JARDI`, `BAR`, `TERRASSA BAR`, `EMPORTAR`;
  - preparation type/order de bebida.
- [x] Enriquecer los `149` detalles Winerim restantes antes de preview/import completo.
- [x] Ejecutar preview XML completo sin escribir: validar 0 botones raiz no deseados, preparacion coherente, precios, IVA y familias destino.
- [x] Crear familias Winerim dedicadas y publicar:
  - `166` botellas;
  - `1` copa;
  - `1` magnum.
- [x] Activar conexion Jardí (`enabled=true`, `catalog_sync_enabled=true`, `auto_push_on_create=true`, `auto_push_verified_ready=true`).
- [x] Ejecutar primera sync ventas: `25` dias, `209` documentos, `2155` lineas, cursor en `2026-06-13`.
- [x] Mantener legacy visible como rollback.
- [x] Dejar rollback documentado: apagar flags y ocultar familias Winerim `900157`, `901954`, `903516`, `903925`, `904241`, `904289`, `908182`, `908875`.
- [ ] Pedir validacion visual al cliente: Winerim visible en familias dedicadas, legacy aun visible, sin productos Winerim en raiz.
- [ ] Probar primera venta real sobre producto Winerim y validar descuento:
  - `sales_line_items.mapped=true`;
  - `stock_sync_log.status=SUCCESS`;
  - `variant` y `stock_id` correctos;
  - no doble deduccion al reintentar.
- [ ] Corregir falso update recurrente de `Dulce de Invierno` (`winerim_id=271458`) antes de activar `auto_push_on_update=true`.
- [ ] Mientras lo anterior no este corregido, no prometer cambios de precio automaticos en Jardí; las altas nuevas si estan automaticas.
- [x] Exportar ventas Jardí `2026-04-15` a `2026-06-15` en modo read-only sin stock:
  - `449` facturas;
  - `4459` lineas;
  - `180` productos;
  - `60206.55` importe total;
  - ficheros `JARDI_SALES_EXPORT_2026-04-15_2026-06-15*`.
- [x] Confirmar que export Jardí no toco stock ni cursor: `last_business_day_synced=2026-06-13`, `stock_sync_log=0`, cola abierta `0`.
- [x] Auditar Winerim vs Agora actual en modo solo lectura:
  - informe `JARDI_WINERIM_AGORA_MATCH_PRECHECK_2026-06-17.md`;
  - `168/168` formatos Winerim publicables publicados en familias Winerim;
  - legacy visible con `281` productos vendibles;
  - legacy -> Winerim publicado: `103 MATCH`, `15 REVIEW`, `163 NO_MATCH`.
- [x] Cruzar Excel Winerim del cliente `Jardi export_17-06-2026_11-44-46.xlsx` contra Agora vivo:
  - informe `JARDI_EXCEL_AGORA_CROSSCHECK_2026-06-17.md`;
  - `168/168` formatos esperados publicados y vendibles;
  - `0` faltantes;
  - `0` Winerim publicados sin justificar por Excel.
- [ ] Revisar `JARDI_LEGACY_TO_WINERIM_PUBLISHED_MATCH_2026-06-17.csv` con cliente antes de ocultar legacy:
  - `MATCH`: candidatos a ocultar legacy si el cliente valida que usa Winerim;
  - `REVIEW`: revisión manual;
  - `NO_MATCH`: no ocultar sin autorización.
- [ ] Si se quiere ver el historico Jardí dentro de la UI/monitor, crear flujo/import read-only que persista ventas sin stock ni cursor; no usar `save-sales` directamente para ese objetivo.
- [ ] Corregir `detect-capabilities` para Agora XML: hoy puede marcar `NOT_CONNECTED` aunque `sync-master-data` funcione.

## P0 — Auditoría flota Agora 2026-06-04
- [x] Ejecutar auditoría read-only contra Lovable Cloud y endpoints Agora vivos.
- [x] Confirmar que todas las conexiones productivas registradas son Agora; el resto de providers existen en código/wizards pero no tienen conexión viva auditable.
- [x] Confirmar conectividad: `Katsu`, `Kava`, `La Candela`, `Luruna`, `Cienvinos` y `Sa Pedrera` responden catálogo/facturas; `Baco` responde pero está desactivado; `Sa Vida` sigue en HTTP 501.
- [x] Detectar que `Cienvinos` tiene las 8 familias Winerim ocultas aunque sus 428 productos Winerim estén vendibles dentro de familia.
- [x] Confirmar que `Baco` está efectivamente en rollback legacy: Winerim oculto/no vendible y legacy visible/vendible.
- [x] Confirmar que `Sa Pedrera` sigue híbrida: familias legacy/regionales visibles y mappings parciales; no es instalación "solo Winerim".
- [x] Confirmar stock reciente real solo donde hay logs `SUCCESS`: `Kava` copa+botella, `Luruna` botella, `Sa Pedrera` botella; el resto necesita venta/cierre de prueba.
- [x] Reparar `Cienvinos` con cambio mínimo: poner visibles las 8 familias `... WINERIM`, sin tocar precios, productos, IVA, preparación ni stock; verificado después `familias visibles=8`, `directSale=0`, `notSaleableAsMain=0`, `prepMismatch=0`.
- [x] Preparar rollback de la reparación Cienvinos: volver a `ShowInPos=false` en esas 8 familias si el cliente reporta impacto visual (`900157`, `901954`, `903516`, `903925`, `904241`, `904289`, `908182`, `908875`).
- [ ] Ejecutar venta/cierre de prueba por conexión para `Katsu`, `La Candela`, `Luruna` y `Cienvinos` con una botella y una copa Winerim cuando existan; validar `stock_sync_log.variant`, `stock_id`, `idempotency_key`, `SUCCESS`.
- [ ] En `Sa Pedrera`, revisar los `20 PENDING` y `58 REJECTED` actuales antes de prometer descuento de todo el legacy; priorizar copas con bloqueo terminal.
- [x] Resetear breakers/fallos obsoletos en conexiones que ya responden 200 después de una sonda controlada por conexión; no se reseteó `Sa Vida`.
- [ ] Crear métrica/vista ligera para colas abiertas por conexión; la consulta amplia de `outbound_tasks` canceló por timeout durante la auditoría.
- [x] Dejar sin tareas activas (`QUEUED/RUNNING=0`) a `Cienvinos`; el cron/cola ya no muestra pendientes.
- [x] Bloquear el único reintento abierto de `Sa Pedrera` (`AGORA_HIDE_PRODUCT` / `D715-Pancaliente`) por error duplicado y modo híbrido legacy; no reintentar sin revisión.
- [ ] Revisar deuda histórica `FAILED/BLOCKED` antes de limpiarla: `Kava` (`7/9`), `Luruna` (`10/58`), `Sa Pedrera` (`294/142`). No cerrar en masa sin clasificar causa y riesgo.
- [ ] Mantener `Sa Vida` fuera de procesamiento: backlog `QUEUED=1055`, `FAILED=3322`, `BLOCKED=1861` hasta que Agora devuelva 200 en API.
- [ ] Sa Pedrera: reprobar API HTTP; a las 11:47 CEST `export-master Families/Products` devuelve HTTP 501 (`El módulo de servicios de integración no está habilitado.`) aunque la web y `/version/` responden 200.
- [ ] Sa Pedrera: preparar dry-run `legacy-first` para detectar Winerim publicados que duplican legacy `CONFIRMED` por mismo `winerim_wine_id + format`, con propuesta de ocultar solo el Winerim duplicado y conservar legacy mapeado.
- [x] Sa Pedrera: generar informe de mapping/publicación `SA_PEDRERA_MAPPING_UPLOAD_REPORT_2026-06-04.md` con recuentos de Winerim publicado, legacy mapeado, legacy sin mapping y duplicados probables.
- [ ] Sa Pedrera: antes de ocultar duplicados, filtrar los `92` duplicados probables por calidad de mapping; priorizar `LEGACY_SAFE_MATCH=38` y revisar manualmente los `FUZZY=55` porque algunos candidatos son sospechosos.
- [x] Sa Pedrera: generar dry-run de matching por código `SA_PEDRERA_CODE_MATCH_DRY_RUN_2026-06-04.md`; confirma que `390/393` productos Winerim visibles tienen código, pero solo `1` legacy visible trae código extraíble.
- [x] Codificar helper `productCodeMatching.ts` y priorizar `CODE_EXACT` en `winerim-proxy` antes de fuzzy.
- [ ] Tras push/redeploy, ejecutar `match-products` en modo controlado o dry-run para confirmar que los nuevos matches por código quedan como `CODE_EXACT` y que `CODE_AMBIGUOUS` no auto-confirma.
- [ ] Sa Pedrera: decidir política visual con cliente: ocultar legacy sin mapping y usar Winerim codificado, o mapear manualmente legacy más usado, o hacer limpieza `legacy-first` solo para duplicados seguros.
- [ ] Sa Pedrera: revisar con cliente ejemplos concretos antes de aplicar: `Rock Angel`, `Binitord Blanc`, `Magnum Viña Sastre`, `Rioja Bordón crianza`, `Charles Heidsieck-Rosé`, `Nounat`.
- [ ] Confirmar redeploy diferencial de `winerim-proxy` y reactivar `auto_push_verified_ready` conexión por conexión solo tras `no_catalog_changes_detected` o `differential=true`.
- [ ] Validar con Winerim si los movimientos de stock por API aparecen en "Historial de ventas" o si hay endpoint adicional no documentado.

## P0 — Sa Vida API HTTP Agora
- [x] Reprobar Sa Vida con base URL `http://80.32.137.41:8984/` y token Agora indicado por el usuario; el valor guardado en Lovable Cloud coincide.
- [x] Confirmar que IP/puerto llegan al servidor correcto: raíz web HTTP 200, versión Agora `8.7.4`, installation type `2`.
- [x] Confirmar que el bloqueo no es token: `export-master` devuelve el mismo HTTP 501 con token correcto y sin token.
- [x] Reprobar en profundidad tras aviso del instalador de que el API HTTP está habilitada: sigue HTTP 501 en `export-master`, `export`, `tickets` e `import`; probado también sin barra final, con `Accept` XML, cabeceras alternativas, query params de token y comparación con Kava/Cienvinos/Baco.
- [x] Comprobar puertos públicos probables: solo responde `80.32.137.41:8984`; puertos `80`, `443`, `8080`, `8081`, `8888`, `8980`-`8983`, `8985`-`8990`, `9984` no exponen API Agora accesible.
- [ ] Enviar al instalador la prueba exacta local/externa:
  - Local en el PC Sa Vida: `curl -i -H 'Api-Token: <token>' -H 'Accept: application/xml' 'http://localhost:8984/api/export-master/?filter=Families'`.
  - Externa: `curl -i -H 'Api-Token: <token>' -H 'Accept: application/xml' 'http://80.32.137.41:8984/api/export-master/?filter=Families'`.
  - Si local=200 y externa=501, revisar NAT/port forwarding a otro equipo/servicio. Si local=501, activar realmente `API HTTP` y reiniciar/recargar servicio.
- [ ] Pedir a Agora/instalador revisión literal de `La integración a través del API HTTP no está habilitada.` en la instalación de Sa Vida; comprobar opción específica API HTTP, token, licencia/configuración, instancia correcta y reinicio del servicio.
- [ ] Cuando el instalador diga que está aplicado, reprobar exactamente: `GET /api/export-master/?filter=Families`, `GET /api/export-master/?filter=Products` y `GET /api/export/?business-day=<ayer>&filter=Invoices`; solo continuar si devuelven HTTP 200/XML.
- [ ] Si Sa Vida devuelve HTTP 200, entonces ejecutar en orden: `agora-proxy test`, `sync-master-data`, `find-last-business-day`, revisar backlog y solo después decidir limpieza/activación de colas.

## P0 — Integración Agora Cienvinos Ecija
- [x] Crear conexión en Lovable Cloud con credenciales reales y dejarla deshabilitada.
- [x] Probar alcance/credenciales Agora con `agora-proxy test`.
- [x] Sincronizar catálogo Winerim: 378 vinos leídos.
- [x] Backfill seguro de stockIds por variante desde Winerim: 372 botellas, 49 copas, 7 magnums.
- [x] Sincronizar master data Agora: 177 productos, 4 IVAs, 3 price lists, 1 almacén, 3 sale centers.
- [x] Configurar escritura inicial reversible: IVA 10%, `BARRA/BEBIDAS`, almacén general, Barra/Sala/Terraza, familias automáticas.
- [x] Ejecutar preview XML de muestra y preview global sin escribir en Agora.
- [x] Documentar rollback en `ROLLBACK_CIENVINOS_AGORA_2026-05-27.md`.
- [x] Crear familias dedicadas WINERIM en Agora y guardar mapping por tipo/formato.
- [x] Importar catálogo Winerim completo en Agora: 428 productos verificados.
- [x] Confirmar que no hay productos/familias legacy de vino fuera de WINERIM que ocultar.
- [x] Resolver 12 nombres duplicados de Winerim con sufijo corto en Agora.
- [x] Marcar capacidad de escritura Agora como verificada (`can_write_products=YES`, `readiness_status=READY`).
- [x] Cerrar 75 tareas `AGORA_XML_UPSERT_PRODUCT` supersedidas por la importación verificada para dejar la cola sin pendientes.
- [x] Codificar desambiguación automática de nombres duplicados en `generateImportXml` antes de activar auto-push/actualizaciones automáticas de catálogo.
- [x] Aplicar migraciones P0 en Lovable Cloud antes de activar automático: `20260526090000_stock_sync_variant_idempotency.sql` y `20260526091000_user_roles_has_role.sql`.
- [x] Desplegar edge functions actuales después de migraciones, especialmente `agora-proxy`, `winerim-proxy` y `agora-cron-dispatcher`.
- [ ] Confirmar tras despliegue que un preview XML con vinos duplicados genera sufijos deterministas y que Agora no devuelve HTTP 500 por nombre duplicado.
- [ ] Repetir `winerim-proxy fetch-catalog` tras despliegue y confirmar que el proxy ya captura `bottle/glass/magnum_stock_id` sin backfill manual.
- [x] Verificar post-write en Agora: familias creadas, productos visibles, precios en Barra/Sala/Terraza, IVA y preparation correctos.
- [ ] Ejecutar venta/cierre de prueba con producto WINERIM o esperar primer día cerrado con líneas resueltas; validar `save-sales` + `syncStockForDay` con `stock_sync_log.variant`, `stock_id`, `idempotency_key` y respuesta Winerim `previousStock/newStock`.
- [ ] Reejecutar el mismo día y confirmar que no hay doble deducción.
- [x] Activar `enabled=true` por instrucción operativa del usuario, con cursor inicial `last_business_day_synced=2026-05-27` para evitar reescaneos históricos.
- [x] Resolver el `Last Sync Never` operativo: `auto-sync-sales` comprobado manualmente sin días pendientes y `last_sync_at` actualizado tras chequeo real.
- [x] Drenar cola de actualización reaparecida: tareas Cienvinos `AGORA_XML_UPSERT_PRODUCT` terminan en 0 abiertas y 0 fallos.
- [x] Reparar visual Cienvinos tras auditoría del 2026-06-01: 428 productos Winerim publicados quedan `UseAsDirectSale=false`, `SaleableAsMain=true`, preparación coherente y 0 tareas `AGORA_XML_UPSERT_PRODUCT` abiertas.
- [ ] Confirmar redeploy efectivo del commit `a180c6c` en Lovable Cloud antes de activar cambios de precio automáticos: `winerim-proxy fetch-catalog` debe devolver `autoPushResult.reason=no_catalog_changes_detected` o `autoPushResult.differential=true`.
- [ ] Tras ese redeploy, activar `auto_push_on_update=true` en Cienvinos para que cambios de precio/nombre/formato se reflejen automáticamente sin reimportar lotes completos.
- [ ] Monitorizar el primer cierre nuevo con productos WINERIM; validar `stock_sync_log.variant`, `stock_id`, `idempotency_key` y respuesta Winerim `previousStock/newStock`.
- [ ] Si el cliente no quiere mantener vinos en los 3 sale centers, ajustar `selected_sale_center_ids` antes de futuras actualizaciones masivas.

## P0 — Revisión flota Agora 2026-05-27
- [x] Generar checklist operativa read-only de integraciones: `INTEGRATIONS_CHECKLIST_2026-06-01.md`.
- [x] Reparar visual/preparación en Katsu, Kava, La Candela, Luruna y Sa Pedrera: 0 productos Winerim activos quedan como botón raíz, 0 activos quedan sin pareja de preparación, 0 tareas `AGORA_XML_UPSERT_PRODUCT` abiertas en esas cinco conexiones tras la limpieza.
- [x] Refrescar master data de las cinco conexiones tras la reparación.
- [x] Subir fix de código a GitHub: commit `81c7dbb` (`Fix Agora visual routing and preparation repair`).
- [x] Confirmar redeploy efectivo de `agora-proxy` en Lovable Cloud: `preview-xml` genera `UseAsDirectSale="false"` y preparación completa para muestra de La Candela.
- [x] Cerrar tareas abiertas de catálogo supersedidas tras reparación: Cienvinos 85, Kava 27, Luruna 13 y Sa Pedrera 62 quedan en 0 abiertas.
- [x] Reparar desalineaciones residuales verificadas: Katsu y Sa Pedrera quedan con productos Winerim publicados `direct=0`, `notMain=0`, `mismatchPrep=0`.
- [x] Subir auto-push diferencial a GitHub: commit `a180c6c` (`Make Winerim catalog auto-push differential`).
- [ ] Confirmar redeploy efectivo de `winerim-proxy` en Lovable Cloud: `fetch-catalog` debe devolver `autoPushResult.reason=no_catalog_changes_detected` o `autoPushResult.differential=true`. Actualmente sigue devolviendo `auto_push_not_verified_no_manual_import_success_yet`.
- [ ] Solo después del redeploy diferencial, reactivar `auto_push_verified_ready=true` en Katsu, Kava, La Candela, Luruna y Sa Pedrera, ejecutar una verificación XML y confirmar que no se generan botones raíz ni reimportaciones masivas.
- [ ] Validar en tablets de Sa Pedrera que los vinos Winerim quedan dentro de familias regionales y que una orden de vino llega a barra.
- [ ] Ajustar reglas regionales de Sa Pedrera si el cliente identifica vinos concretos en una familia distinta a la esperada.
- [ ] Validar con Winerim si su "Historial de ventas" se alimenta de los movimientos `PUT /stock/{stockId}` o si necesitan un endpoint adicional de ventas no documentado.
- [ ] Validar con venta/cierre real de copa en `Katsu`, `La Candela`, `Luruna` y `Cienvinos`; hoy están preparados por stockIds/mappings, pero sin prueba reciente de descuento `SUCCESS` de variante `copa`.
- [ ] Sa Pedrera: revisar los `BLOCKED` históricos de copa y decidir si esos productos legacy/rechazados deben quedarse bloqueados, mapearse manualmente o ocultarse del TPV.
- [x] Sa Pedrera legacy matching fase 1: aplicados `38` mappings `CONFIRMED` con `LEGACY_SAFE_MATCH`; excluidos `Roda`, `Tokaji Aszú 6 Puttonyos` y `Magnum Marques de Murrieta` por ambigüedad/riesgo.
- [ ] Sa Pedrera legacy matching fase 2: revisar los `13` mappings `PENDING`, los `58` legacy sin mapping restante y, especialmente, los `34` con candidato pero sin variante/stockId Winerim.
- [x] Kava: revisar producto directo no-Winerim `EL LANCE` dentro de `TINTOS WINERIM`; queda oculto sin borrar (`1000011`, `SaleableAsMain=false`, `UseAsDirectSale=false`) porque existe producto Winerim confirmado para `El Lance 7 Fuentes`.
- [x] Luruna: revisar productos directos no-Winerim `COPA ONDALAN TINTO`, `VIUDA DE CLICQUOT ROSADO` y `COPA VIÑA SASTRE CRZ`; quedan ocultos sin borrar (`1164074`, `1164081`, `1164082`, `SaleableAsMain=false`, `UseAsDirectSale=false`).
- [x] Repetir auditoría XML de Cienvinos: verificado el 2026-06-04 contra XML vivo con 8/8 familias Winerim visibles, 428 productos Winerim, 0 botones raíz, 0 no vendibles como main y 0 mismatch de preparación.
- [ ] Sa Vida: mantener fuera de procesamiento hasta resolver HTTP 501 en `export-master`; revalidación 2026-06-02 con `http://80.32.137.41:8984/` sigue devolviendo `501` en `test`, `Products` y `Families`.
- [x] Cienvinos: revisar/drenar 85 tareas `AGORA_XML_UPSERT_PRODUCT` en `QUEUED`; quedan 0 abiertas tras verificar catálogo vivo.
- [ ] Cienvinos: confirmar por qué no hay ventas/cierres desde `2026-05-27`.
- [x] Kava: cerrar tareas abiertas de catálogo supersedidas por la reparación visual/preparación; quedan 0 `QUEUED/RUNNING` de `AGORA_XML_UPSERT_PRODUCT`.
- [x] Luruna: cerrar tareas abiertas de catálogo supersedidas por la reparación visual/preparación; quedan 0 `QUEUED/RUNNING` de `AGORA_XML_UPSERT_PRODUCT`.
- [x] Sa Pedrera: cerrar tareas abiertas de catálogo supersedidas por la reparación visual/preparación; quedan 0 `QUEUED/RUNNING` de `AGORA_XML_UPSERT_PRODUCT`.
- [x] Katsu y La Candela: escritura real verificada con import Agora HTTP 200 y `provider_capabilities` corregidas a `READY/XML_IMPORT/YES`.
- [x] Actualizar credenciales Sa Vida en Lovable Cloud sin documentar secretos.
- [x] Probar Sa Vida con `agora-proxy test` y `sync-master-data`: endpoints Agora devuelven HTTP `501`.
- [x] Marcar Sa Vida como `UNKNOWN/NOT_CONNECTED/NONE` en `provider_capabilities` para no mostrarla lista.
- [x] Resetear breakers obsoletos de Kava, Luruna y Sa Pedrera tras comprobar endpoints operativos.
- [ ] Pedir a Sa Vida/Agora que habiliten la integración/API HTTP en Agora: la IP `80.32.137.41:8984` carga `Administrar Ágora`, pero `/api/export` y `/api/export-master` devuelven `501` con `La integración a través del API HTTP no está habilitada.`
- [ ] Reprobar Sa Vida cuando el POS responda 200: `test`, `sync-master-data`, `find-last-business-day`, preview XML y backfill de stockIds antes de cualquier write masivo.
- [x] Hacer backfill/re-sync de stockIds por variante para Katsu, Kava, La Candela, Luruna, Sa Pedrera y Sa Vida con script controlado: 1.881 pares conexión/vino revisados, 1.359 filas actualizadas, 0 errores transitorios.
- [x] Reparar fallos actuales de `stock_sync_log` antes de declarar la flota Agora sana:
  - Sa Vida/Sa Pedrera/Kava/Katsu/La Candela/Luruna: mappings inaccesibles o sin variante marcados `REJECTED`; logs terminales recientes marcados `BLOCKED_TERMINAL`.
  - Auditoría posterior: `FAILED` últimos 24h = 0; mappings confirmados con stockId requerido faltante = 0.
- [x] Añadir guard anti-spam para fallos terminales de stock (`wine not found`, `variant not found`) sin avanzar cursor ni crear logs repetidos cada ciclo.
- [ ] Publicar y confirmar redeploy de los hotfixes de `agora-proxy`/`winerim-proxy` que respetan mappings `REJECTED` y `auto_push_on_update=false`.
- [ ] Decidir si Sa Vida debe pausarse/deshabilitarse hasta resolver HTTP 501/API REST y mappings, porque hoy aparece `enabled=true` aunque las capacidades están `NOT_CONNECTED`.
- [ ] Revisar tareas residuales por instalación tras redeploy:
  - Cienvinos: el runtime antiguo generó 82 updates `MANUAL`; ya se marcaron `SUCCESS` tras verificar que estaban publicados. Vigilar que no reaparezcan hasta redeploy.
  - Kava/Luruna/Sa Pedrera: tras la reparación del 2026-06-01 quedan 0 `QUEUED/RUNNING` de catálogo, pero hay que revisar históricos `FAILED/BLOCKED` si siguen ensuciando monitor.
  - Sa Vida: backlog grande (`1055 QUEUED`, `3322 FAILED`, `1861 BLOCKED`), no procesar hasta resolver HTTP 501.
- [ ] Decidir limpieza de la conexión `New Location` deshabilitada con URL inválida.
- [x] Revisar por qué Katsu y La Candela tenían tracking verificado pero `provider_capabilities` en `UNKNOWN/NOT_CONNECTED`; quedaron `READY/XML_IMPORT/YES` tras import real HTTP 200.

## P0 — Integración Agora Baco Getafe
- [x] Crear conexión en Lovable Cloud con credenciales reales y dejarla deshabilitada.
- [x] Probar alcance/credenciales Agora con `agora-proxy test`.
- [x] Confirmar endpoints Agora: `Products`, core master, `Invoices` y `Tickets` responden HTTP 200.
- [x] Sincronizar catálogo Winerim: 95 vinos leídos/enriquecidos.
- [x] Backfill seguro de stockIds por variante desde payload Winerim: 83 botellas, 21 copas, 19 magnums.
- [x] Sincronizar master data Agora: 40 familias iniciales, 3.785 productos iniciales, 4 IVAs, 3 price lists, 1 almacén, 5 sale centers.
- [x] Configurar escritura reversible: IVA 10%, `Barra/Bebidas`, almacén general, sale centers `Cafet.`, `Restaurante`, `Terraza`.
- [x] Crear familias dedicadas WINERIM y guardar mappings.
- [x] Ejecutar preview XML global: 118 productos exportables, 0 IDs duplicados tras desambiguación, 82 botellas, 21 copas, 15 magnums.
- [x] Importar catálogo Winerim en Agora y verificar post-write: 118/118 productos presentes, precios en listas 1/2/3, IVA/preparación correctos.
- [x] Corregir tracking/mappings tras timeout de importación: 118 mappings confirmados, formatos no exportables como `NOT_PUSHED`.
- [x] Ocultar familias legacy `VINO`, `FINOS`, `ROSADOS`, `TINTOS`, `CHAMPAGNE`, `BLANCOS`.
- [x] Ocultar 348 productos legacy de vino; verificación final 0 legacy visible/vendible.
- [x] Revisar reporte visual del cliente: el vídeo mostraba familias legacy aún visibles aunque productos no vendibles; se reforzó `ShowInPos=false` en legacy y `ShowInPos=true` en familias `... WINERIM`.
- [x] Corregir reporte de duplicado visual: 118/118 productos Winerim quedan con `UseAsDirectSale=false` para no salir como botones raíz y `SaleableAsMain=true` para seguir vendibles dentro de familias WINERIM; verificado `directRootButtons=0`, `notSaleableAsMain=0`.
- [x] Revisar reporte `Tamaral Crianza copas`: no existe copa de `Tamaral`/Crianza en Winerim; sí existe `C Tamaral Roble (RIBERA)` y `C Tamaral Verdejo` en `COPAS WINERIM`.
- [ ] Si Baco decide reactivar Winerim más adelante, confirmar primero si quieren que Winerim cree/active variante copa para `Tamaral`/Crianza o si `C Tamaral Roble (RIBERA)` era el producto correcto.
- [x] Marcar capacidad de escritura Agora como verificada (`can_write_products=YES`, `readiness_status=READY`).
- [x] Documentar rollback en `ROLLBACK_BACO_GETAFE_AGORA_2026-05-27.md`.
- [x] Aplicar migraciones P0 en Lovable Cloud antes de activar automático: `20260526090000_stock_sync_variant_idempotency.sql` y `20260526091000_user_roles_has_role.sql`.
- [x] Desplegar edge functions actuales después de migraciones, especialmente `agora-proxy`, `winerim-proxy` y `agora-cron-dispatcher`.
- [x] Validar post-redeploy en modo lectura: Baco tiene días cerrados, pero el cierre `2026-05-27` devuelve 0 líneas resueltas contra productos WINERIM; no sirve todavía como prueba real de stock.
- [ ] Validar con el cliente si los vinos deben publicarse también en `MUS` o `Personal`; por ahora quedan excluidos.
- [ ] Ejecutar venta/cierre de prueba con producto WINERIM resuelto; validar `save-sales` + `syncStockForDay` con `stock_sync_log.variant`, `stock_id`, `idempotency_key`.
- [ ] Evaluar en una fase posterior si Baco puede usar `Tickets` intradía con feature flag por conexión; no activar globalmente.
- [x] Activar `enabled=true` por instrucción operativa del usuario, con cursor inicial `last_business_day_synced=2026-05-27` para evitar reescaneos históricos legacy.
- [x] Resolver el `Last Sync Never` operativo: `auto-sync-sales` comprobado manualmente sin días pendientes y `last_sync_at` actualizado tras chequeo real.
- [x] Restaurar `provider_capabilities.can_write_products=YES` tras detectar degradación visual a `UNKNOWN`.
- [x] Revertir Baco a legacy por petición del usuario (2026-05-29): familias/productos Winerim ocultos, legacy restaurado y automatización Winerim apagada.
- [x] Verificar rollback contra Agora: 118 productos Winerim existentes pero 0 visibles/vendibles; 6 familias legacy visibles.
- [x] Verificar rollback en Lovable Cloud: `enabled=false`, `catalog_sync_enabled=false`, `write_mode=NONE`, `auto_push_on_create=false`, `auto_push_on_update=false`, `auto_push_verified_ready=false`.
- [x] Corregir rollback legacy tras feedback del cliente: 0 vinos legacy con `UseAsDirectSale=true`, subfamilias de vino bajo `VINO`, 195 productos legacy vendibles solo dentro de familia y 0 antiguos/borrados reactivados.
- [ ] Si se decide reactivar Baco con Winerim, hacerlo como nuevo piloto controlado: restaurar visibilidad Winerim desde backup, ocultar legacy, activar conexión y validar una venta/cierre real antes de darlo por automático.

## P0 — Front Agora audit 2026-05-26
- [x] Corregir navegación del wizard: `handleNext` permite llegar al paso 14 `Go Live` (`Math.min(14, s + 1)`).
- [ ] Añadir prueba/render smoke para navegación 13→14.
- [x] Resolver el riesgo de `Save to DB`: el guardado manual sincroniza stock y no actualiza `last_business_day_synced` si Winerim falla.
- [x] Corregir `AgoraTodaysSalesStock` para aceptar `SUCCESS` como estado sincronizado y mostrar `variant`, `stock_id`, `previousStock/newStock` cuando existan.
- [x] Corregir `SyncMonitor` para mostrar la ubicación en cada fila de `Stock Sync` y no confundir fallos de Sa Vida/Sa Pedrera/Kava con Baco/Cienvinos.
- [x] Corregir visualización de conexiones sin `last_sync_at`: si hay cursor diario, muestra `Checked through <fecha>` en vez de `Never`.
- [x] Revisar el cálculo de stock del panel de hoy: ya no mezcla botella/copa/magnum en un “stock antes” calculado; muestra stock por variante desde log o stock global como referencia.
- [x] Ajustar copy de Sales & Mapping / Today: indica días cerrados/post-cierre y evita prometer “today/15 min” como tiempo real.
- [x] Definir soporte MAGNUM en UI de catálogo: preview/push/backfill principales envían `MAGNUM` y backend valida elegibilidad.
- [x] Normalizar booleanos de master data en `AgoraFamilyVisibilityPanel` usando helper tipo `asBool(value, true)` para que `ShowInPos` ausente/null no se marque como oculto.
- [x] Bloquear en `AgoraProductVisibilityPanel` que un producto quede visible si su familia está oculta.
- [x] Añadir confirmación a acciones individuales de “Archivar familia + productos” y corregir el texto que habla de mover a `ARCHIVO WINERIM`.
- [x] En `AgoraManualMatchPanel`, permitir elegir/derivar `formatType` (`BOTTLE`/`GLASS`/`MAGNUM`) en mapping manual.
- [x] Evitar conexiones basura en test: la fila temporal nace deshabilitada y se elimina si el test falla.
- [x] Añadir test unitario para decisión de cursor: stock OK avanza, stock FAILED o token ausente no avanza.
- [x] Añadir test unitario para re-guardar un día ya sincronizado: la clave de grupo `sales_event_id + winerim_product_id + variant` es estable aunque cambie el `sales_line_item_id`.
- [ ] Añadir test/integración mock de `agora-proxy.save-sales` completo con cliente DB/fetch simulado.
- [ ] Añadir test/integración mock de `syncStockForDay`: al re-guardar un día ya `SUCCESS`, debe saltar el grupo y no hacer nuevo PUT.

## P0 — Sa Pedrera piloto `DULCES WINERIM`
- [x] Crear/mostrar familia controlada `DULCES WINERIM` reutilizando Agora family id `903925`.
- [x] Publicar `D701-D709` con formatos activos Winerim dentro de esa familia.
- [x] Verificar por API que los 14 productos quedaron con `FamilyId=903925` y nombre correcto.
- [x] Actualizar `product_mappings` y `winerim_push_tracking` a `VERIFIED` para esos 14 productos.
- [x] Documentar estado, decisiones, riesgos y rollback en `SA_PEDRERA_DULCES_WINERIM_TRIAL_2026-06-04.md`.
- [x] Revisar vídeo del cliente: duplicados B/C y orden incorrecto.
- [x] Corregir piloto: 9 productos visibles, uno por código, IDs `903701-903709`, antiguos archivados.
- [x] Verificar por API que `DULCES WINERIM` contiene solo los 9 nuevos visibles y que los 14 anteriores están ocultos/archivados.
- [x] Documentar corrección en `SA_PEDRERA_DULCES_WINERIM_ORDER_FIX_2026-06-04.md`.
- [x] Decidir temporalmente no mover copas a `COPAS WINERIM`: el piloto se valida completo dentro de `DULCES WINERIM`.
- [x] Resolver altas nuevas: publicar `D710` y `D716` en `DULCES WINERIM` con IDs `903710` y `903716`.
- [x] Cambiar código para que la acción controlada use todos los `D###` activos y no solo `D701-D709`.
- [x] Subir commit `1d62dc6` a GitHub con la lógica dinámica.
- [x] Probar dry-run post-push contra Lovable Cloud: sigue devolviendo `Unknown action`, por tanto no hay redeploy efectivo todavía.
- [x] Resolver redeploy efectivo de `agora-proxy`: dry-run `sa-pedrera-dulces-winerim-trial` incluye `D710` y `D716`.
- [x] Activar `auto_push_verified_ready=true` en Sa Pedrera tras dry-run correcto y con 0 tareas abiertas.
- [ ] Pedir al cliente validación en tablet: debe ver 11 botones en orden `D701-D710` y `D716`.
- [ ] Si el orden visual aún no coincide, revisar cache/sincronización local de tablet Agora o layout interno.
- [ ] Tras validación visual, decidir si el diseño definitivo separa copas en `COPAS WINERIM` o mantiene dulces juntos.
- [ ] Monitorizar próximo cron de catálogo: no debe generar backlog masivo y debe publicar futuras altas/cambios diferenciales.

## P0 — Kava legacy `GENEROSOS` / `DULCES`
- [x] Restaurar visibilidad de familias legacy `2069` (`GENEROSOS`) y `2070` (`DULCES`).
- [x] Restaurar vendibilidad dentro de familia para 15 productos legacy (`SaleableAsMain=true`, `UseAsDirectSale=false`).
- [x] Verificar por API que las familias están visibles, los 15 productos vendibles y 0 productos directos en raíz.
- [x] Refrescar master data Kava en Lovable Cloud (`1681` productos, `93` familias, sin truncation warnings).
- [x] Documentar rollback y riesgo de stock en `KAVA_LEGACY_DULCES_GENEROSOS_RESTORE_2026-06-04.md`.
- [ ] Confirmar visualmente con Kava que `GENEROSOS` y `DULCES` aparecen donde esperan.
- [ ] Si Kava quiere que esas ventas legacy descuenten stock Winerim, hacer mapping seguro producto a producto; no confirmar los mappings fuzzy `PENDING` actuales sin revisión.

## P0 — Auditoría Codex 2026-05-26
- [x] Unificar las dos ramas `auto-sync-sales` de `agora-proxy`: se eliminó la rama intradía inalcanzable y se conservó D-1/post-cierre.
- [x] Hacer `stock_sync_log` variant-aware: añadidos `variant`, `stock_id`, `idempotency_key`, índice parcial y compatibilidad con logs legacy.
- [x] Añadir claim/lock atómico para deducciones de stock y colas outbound antes de ejecutar writes externos; colas Agora/Revo usan `claim_outbound_tasks(...)` con fallback.
- [x] Desactivar o refactorizar `restore-glass-overdiscount`: queda dry-run por defecto y solo escribe con `allowLegacyFractionalRestore=true`.
- [x] Cambiar `sync-master-data` para que cualquier lectura de `Products` use `fetchAgoraProductsXmlCached` (con `forceRefresh` solo si se justifica).
- [x] Normalizar aliases de variantes Winerim también en `winerim-proxy` (`copa/glass`, `botella/bottle`, `magnum`) para capturar precio y `erpStock.id` aunque la API devuelva nombres en inglés.
- [x] Validar si `GET /api/v2/stock/{stockId}` existe realmente; decisión defensiva: se eliminó la dependencia para baseline y se usa `GET /stock/wine/{wineId}`.
- [x] Corregir `package-lock.json` para que `npm ci` pase en local/CI.
- [ ] Eliminar `.env` de artefactos/repositorio si está versionado y rotar secretos si los valores del ZIP eran reales. (`.gitignore` ya ignora `.env` y `.env.*`.)
- [x] Implementar base `user_roles` + `has_role() SECURITY DEFINER` sin reemplazar todavía policies `Allow all`.
- [ ] Reemplazar policies `Allow all` por RLS multi-tenant cuando exista modelo de usuarios/roles confirmado.
- [ ] Revisar migraciones con datos operativos de clientes y separar schema/data fixes para evitar mutaciones inesperadas al recrear entornos.
- [x] Corregir bug de incremento de `attempts` en `revo-proxy`.
- [ ] Añadir prueba de regresión específica para el contador `attempts` de Revo.
- [x] Validar contra Agora que el atributo real de orden de producto es `Product.Order`, no `SortOrder`; aplicado en Sa Pedrera con verificación viva.
- [x] Crear tests mínimos de utilidades variant-aware, idempotency key, group key y decisión de cursor.
- [ ] Crear tests de integración/mock para deducción completa, reintentos, doble venta copa+botella del mismo vino, `auto-sync-sales` D-1/intradía, y cache obligatoria de `Products`.
- [ ] Definir estrategia gradual para lint: bloquear errores nuevos y corregir primero hooks/dependencias, `no-explicit-any` en shared/proxies críticos y warnings de Fast Refresh.

## P0 — Despliegue seguro post-cambios
- [x] Publicar cambios P0 en el repo oficial GitHub (`main`, commit `5ecee98`) para que Lovable tenga código, migraciones, tests y rollback.
- [x] Confirmar tras el push que `.env` no se modificó ni se volvió a copiar desde la auditoría.
- [x] Validar en copia limpia antes del push: install, tests unitarios, TypeScript, build, lint acotado y parse TS de Edge Functions críticas.
- [x] Conseguir sesión Lovable Cloud autenticada en Chrome externo para operar el panel Cloud.
- [x] Aplicar primero migraciones `20260526090000_stock_sync_variant_idempotency.sql` y `20260526091000_user_roles_has_role.sql` en Lovable Cloud.
- [x] Desplegar edge functions después de las migraciones.
- [x] Confirmar contra backend real que existen `stock_sync_log.variant`, `stock_sync_log.stock_id`, `stock_sync_log.idempotency_key`, tabla `user_roles` y función `has_role()`.
- [x] Confirmar `claim_outbound_tasks(...)` con firma `p_task_types TEXT[]` usando conexión fake y sin reclamar tareas reales.
- [x] Revertir en fuente los cambios generados por Lovable en `src/integrations/supabase/types.ts` y `AgoraTodaysSalesStock`, conservando el redeploy ya aplicado en Cloud.
- [x] Confirmar que Cienvinos y Baco seguían `enabled=false` tras el redeploy, antes de la activación operativa posterior.
- [x] Activar Cienvinos y Baco: `enabled=true`, `auto_push_verified_ready=true`, `auto_push_on_create=true`, `auto_push_on_update=false`, `last_business_day_synced=2026-05-27`.
- [x] Ejecutar dispatcher manual `sales-stock` por conexión: ambos jobs responden OK, sin breaker, sin preflight fallido y sin días pendientes.
- [x] Procesar las 374 tareas `AGORA_XML_UPSERT_PRODUCT` de actualización que aparecieron para Cienvinos tras los lotes de catálogo/enriquecimiento; resultado final 374 `SUCCESS`, 0 tareas abiertas.
- [x] Restaurar/confirmar `provider_capabilities.can_write_products=YES`, `readiness_status=READY`, `write_mode=XML_IMPORT` en Cienvinos y Baco.
- [x] Corregir `process-xml-outbound-queue` para no dejar tareas `RUNNING` al agotarse el presupuesto temporal.
- [x] Corregir `sync-master-data` para no degradar `can_write_products=YES` a `UNKNOWN` tras una importación XML verificada.
- [x] Cambiar auto-queue de vinos recién `READY` para pasar por `evaluate-auto-push` y respetar gates automáticos.
- [x] Reparar en datos Lovable Cloud los mappings/stockIds antiguos de flota Agora sin tocar stock real: 1.359 filas de `winerim_wines` actualizadas, 1.197 mappings rechazados, 367 logs terminales bloqueados.
- [x] Validar tras reparación que `stock_sync_log` tiene `FAILED=0` en últimas 24h y que no quedan líneas históricas apuntando a mappings rechazados.
- [ ] Confirmar en Lovable Cloud que `agora-proxy` y `winerim-proxy` quedaron redeployados con los hotfixes de cola/capacidades/terminal-stock.
- [ ] Confirmar en Lovable Cloud que el nuevo cambio de `auto-sync-sales` queda desplegado: una conexión sin días pendientes debe actualizar `last_sync_at`.
- [x] Reestablecer capacidades verificadas tras la reparación (`Baco`, `Cienvinos`, `Kava`, `Luruna`, `Sa Pedrera`) a `can_write_products=YES`, `readiness_status=READY`, `write_mode=XML_IMPORT`.
- [ ] Tras redeploy, confirmar que esas capacidades no se degradan en el siguiente `sync-master-data`.
- [ ] Confirmar en preview que `SyncMonitor > Stock Sync` muestra columna Location.
- [ ] Confirmar redeploy de `agora-proxy` con `generateImportXml` emitiendo `UseAsDirectSale=false` / `SaleableAsMain=true`.
- [ ] Tras confirmar redeploy, vigilar Cienvinos durante un ciclo de cron de catálogo y comprobar que no se reencolan updates masivos mientras `auto_push_on_update=false`.
- [ ] Ejecutar una venta de prueba copa+botella en conexión controlada y verificar `stock_sync_log.variant`, `stock_id`, `idempotency_key`, `winerim_response.previousStock/newStock`.
- [ ] Reejecutar el mismo día de ventas y confirmar que `skipped` aumenta sin nuevo PUT a Winerim.
- [ ] Ejecutar `save-sales` manual en conexión controlada y confirmar que devuelve `cursorAdvanced=true` solo con `stockSync.failed=0`.
- [ ] Simular fallo Winerim/token ausente en conexión de prueba y confirmar que `last_business_day_synced` no avanza.
- [ ] Confirmar que el catch-up de `auto-sync-sales` rescata días guardados recientes con stock pendiente sin llamadas PUT nuevas para líneas ya `SUCCESS`.
- [ ] Revisar que `restore-glass-overdiscount` con `apply=true` devuelve `LEGACY_RESTORE_DISABLED` si no se pasa `allowLegacyFractionalRestore=true`.
- [ ] Vigilar 24h `stock_sync_log` por `FAILED` nuevos y `outbound_tasks` por tareas `RUNNING` antiguas.
- [ ] Implementar auto-update diferencial de catálogo antes de poner `auto_push_on_update=true` en Cienvinos/Baco.

## P0 — Validación
- [ ] Desplegar `SyncMonitor.tsx` para que muestre errores reales de Lovable Cloud/backend en vez de tablas vacías.
- [ ] Reintentar `/sync-monitor` cuando las queries REST de `pos_connections`, `sales_events`, `stock_sync_log` y `outbound_tasks` dejen de devolver HTTP `522`.
- [ ] Aplicar migración `20260713073627_add_agora_provider_sold_at_to_sales_lines.sql` en Lovable Cloud antes de desplegar `agora-proxy`.
- [ ] Desplegar `agora-proxy` con:
  - persistencia de `provider_sold_at`;
  - `soldAt` en `sales/import`;
  - carril `stockActive=true` -> `PUT /stock/{stockId}`;
  - carril `stockActive=false` -> `POST /sales/import` sin tocar stock.
- [ ] Sa Pedrera: ejecutar prueba controlada de venta botella y copa desde botones Winerim, comparar Agora `CreationDate`, `sales_line_items.provider_sold_at` y hora visible en ERP Winerim.
- [ ] Sa Pedrera: probar explícitamente una variante con stock activo y una variante con stock desactivado:
  - stock activo: debe descontar por `PUT /stock`;
  - stock desactivado: debe aparecer en historial con `sales_only_stock_inactive` y no mover unidades.
- [ ] Sa Pedrera: si las ventas con stock activo siguen mostrando hora de proceso, pedir a Winerim API soporte para `soldAt` en `PUT /stock/{stockId}` o endpoint combinado stock+venta.
- [ ] Definir checklist de auditoría por restaurante: catálogo Winerim activo/preciado vs Agora visible, auto-push nuevos/precios, ventas Agora vs ERP Winerim, `provider_sold_at`, stock activo/inactivo, legacy oculto a familia+producto.
- [ ] Redeploy urgente de `agora-proxy` desde `main` incluyendo commits `3917045` y `89c5950`.
- [ ] Tras redeploy, reintentar/drenar la tarea `AGORA_HIDE_PRODUCT` de Sa Pedrera para `B310- Albenc` (Winerim `296314`) y confirmar en master data que queda no vendible.
- [ ] Sa Pedrera: repetir `sync-open-tickets` y confirmar que las ventas de botella/copa Winerim entran en historial Winerim casi en tiempo real; verificar visualmente `Sanger Voyage 360` en botella y copa.
- [ ] Sa Pedrera: revisar por qué `winerim_push_tracking` marca algunos formatos `VERIFIED` que no aparecen en `provider_products`; endurecer `formats_already_verified` para exigir presencia real o verificación viva en master data.
- [ ] Kava: corregir los 404 de stock para `C CLOE Chardonnay [copa]` (Winerim `251918`) y `C Luis Alegre Crianza [copa]` (Winerim `147010`): revisar mapping, acceso Winerim, stockId por variante y si procede marcar venta sales-only cuando el stock no esté activo.
- [ ] Luruna: corregir 404 de stock para `CAMPILLO 2021 CRIANZA [botella]` (Winerim `156687`) con el mismo criterio: mapping/stockId/acceso o sales-only si no hay stock activo.
- [ ] Jardí: pedir a SAT/cliente revisar TPV encendido, DDNS, router/firewall y puerto `8984`; no activar `open_tickets_sync_enabled` hasta que `/api/export/tickets/` responda desde backend.
- [ ] Decidir política global por conexión para `auto_push_on_update`: si queda desactivado, cambios de precio, inactivos y retirada de precios no se propagan automáticamente. Activarlo solo tras confirmar diff/idempotencia y sin bucles de `AUTO_UPDATE`.
- [x] Crear/documentar conexiones faltantes en `pos_connections`: Saddle, Higuerón, O Bistro, Tintorera y Taberna de Elia.
- [x] Don Quijote Marbella: conexión creada, catálogo `114/114`, flags automáticos y cola cero; pendiente canary real.
- [ ] Saddle: backend aborta contra la IP aunque desde la máquina local responde; pedir DDNS/URL alternativa o revisión firewall/ruta desde Lovable Cloud/backend.
- [x] El Higuerón: `Invoices`, `tickets`, `Families` y `Products` revalidados con HTTP `200` usando la credencial literal correcta.
- [x] Tintorera: `tintorera.dyndns.org:8984` vuelve a responder; catalogo
  activado y pendiente solo de canaries reales y observacion de 24 horas.
- [ ] O Bistro: IP privada `192.168.1.22` no es accesible desde backend; pedir URL externa/DDNS/VPN.
- [ ] Taberna de Elia: ya activa en lectura; preparar revisión de matching legacy vs Winerim antes de publicar catálogo o activar stock.
- [x] El Bejeque: auditoría directa 2026-07-11 confirma `98/98` formatos Winerim activos/con precio presentes en Ágora, en familias Winerim y vendibles dentro de familia.
- [x] El Bejeque: legacy visible de vino confirmado a `0`; restos legacy detectados están no vendibles.
- [ ] El Bejeque: cuando Lovable Cloud/backend responda, ejecutar `sync-master-data` para refrescar caché interna tras la ocultación legacy y dejar trazabilidad dentro del middleware.
- [ ] El Bejeque: pedir venta real desde botón/familia Winerim para confirmar historial/stock Winerim antes de declarar `LIVE_AUTOMATIC` completo.
- [x] El Higuerón: recuperar de forma idempotente la venta de `B Viña Real Reserva`; stock Winerim confirmado `2 -> 1`, `SUCCESS`, sin duplicados.
- [ ] El Higuerón/flota Agora: desplegar `agora-proxy` con comparación de fechas naive en `sales_timezone` y observar el siguiente ciclo automático (`stockDeferredLines=0` para líneas ya maduras).
- [x] El Higuerón: confirmado visualmente en ERP Winerim `Viña Real Reserva · Botella · 13:32 · TPV · 1 ud · 28 €`.
- [x] Abadía Yuste: conexión creada y pruebas de conectividad/master/tickets completadas.
- [x] Abadía Yuste: catálogo `281/281 MATCH` validado por bloques, con legacy visible.
- [ ] Abadía Yuste: ejecutar canary real de botella y copa y confirmar ERP/stock/idempotencia.
- [ ] Añadir auditoría periódica que compare Winerim activo/preciado vs Agora visible por formato y genere lista de productos a ocultar/republicar sin tocar nada automáticamente.
- [ ] Jardí: confirmar con el cliente el nombre/ID exacto del "vino nuevo" que dice no ver. Auditoría 2026-06-18 no detecta ningún formato Winerim activo/con precio ausente en Agora; `Anais Blanc Organic` ya aparece en `BLANCOS WINERIM` y `COPAS WINERIM`.
- [ ] Jardí: explicar que las ventas importadas actuales vienen de botones legacy sin mapping (`mapped=false`) y por eso no descuentan stock ni generan historial Winerim. Para descontar: vender desde botones Winerim o hacer matching legacy -> Winerim producto a producto.
- [ ] Jardí: preparar propuesta de matching legacy seguro antes de ocultar legacy o prometer stock automático. Hay que revisar especialmente los legacy vendidos recientemente (`VI BLANC`, `VI RECOMANAT`, etc.).
- [ ] Jardí: tras desplegar el fix de `last_catalog_sync_at`, ejecutar `fetch-catalog` controlado y comprobar que el monitor deja de mostrar catálogo `Never/null`.
- [ ] Monitorizar 7 días (Agora): invocaciones a `/api/export-master`, breaker activations, zombies rescatados.
- [ ] Confirmar con Luruna que no ven más IPs AWS saturando su SQL Server.
- [ ] Verificar que Sa Vida / Sa Pedrera reanudan al volver el POS.
- [ ] Probar manualmente el guard de breaker: pausar una conexión BDP/Revo/Numier/ICG/Toast vía SQL y comprobar que el proxy devuelve 503 `CIRCUIT_BREAKER_OPEN`.
- [ ] Probar el panel `ConnectionHealthPanel` en preview con la conexión Luruna.

## P1 — Completar Capa 3 en cada proxy
- [ ] Reemplazar `fetch(...)` internos por `createResilientFetch(connectionId)` en:
  - [ ] bdp-proxy (1904 LOC, ~8 fetch)
  - [ ] revo-proxy (1704 LOC) — ya tiene su `revoFetch` con rate 120 req/min; valorar si unificar.
  - [ ] toast-proxy (881 LOC) — tiene `fetchWithRetry` propio + breaker en `provider_config`. Decidir unificación.
  - [ ] numier-proxy (1022 LOC, ~10 fetch)
  - [ ] icg-proxy (664 LOC)
- [ ] En cada uno: tras error de fetch, llamar `classifyPosError` + `applyCircuitBreaker`. Tras éxito, llamar `resetFailureCounter`.

## P1 — Winerim API v2
- [ ] Probar `POST /api/v2/wines/bulk` con token real y, si devuelve JSON correcto, usarlo para enriquecer lotes de hasta 100 vinos en vez de hacer detalle uno a uno.
- [ ] Probar `PUT /api/v2/stock/bulk` con token real y payload pequeño; confirmar que no devuelve HTML/login y que `errors[]` reporta éxitos parciales como indica la documentación.
- [ ] Si `stock/bulk` queda validado, migrar `syncStockForDay` a chunks de 100 con manejo por item, conservando fallback a PUT individual por feature flag.
- [ ] Capturar `erpStock.identifier` por variante y decidir si mapearlo como SKU/EAN/código externo en Agora.

## P1 — Panel salud en otros wizards
- [ ] Montar `<ConnectionHealthPanel connectionId={...} />` en BdpWizard, RevoWizard, ToastWizard, NumierWizard, IcgWizard, CloverWizard, SimphonyWizard, SquareWizard, CassaWizard, TcposWizard, HioposWizard, TouchBistroWizard.

## P2 — Mejoras
- [ ] Métricas históricas (tabla `proxy_metrics`) en lugar de depender de logs.
- [ ] Alertas automáticas cuando una conexión queda en breaker >2h.
- [ ] Vista "fleet status" en `/integrations` con un `ConnectionHealthPanel` por cada conexión activa.

## Bloqueos / esperando
- Cienvinos: activo en automático desde cursor `2026-05-27`; falta validar primer cierre nuevo con producto WINERIM resuelto.
- Cienvinos: falta confirmación operativa de si los vinos deben mantenerse publicados en Barra, Sala y Terraza o solo en un subconjunto.
- Cienvinos: visual reparado el 2026-06-04 y cola abierta final `QUEUED/RUNNING/FAILED/BLOCKED=0/0/0/0`. Esperar primer cierre con producto WINERIM y redeploy diferencial antes de prometer cambios de precio automáticos.
- Baco Getafe: revertido a legacy el 2026-05-29; integración Winerim desactivada en Lovable Cloud y oculta en Agora. Cualquier reactivación Winerim requiere nuevo piloto controlado.
- Sa Vida: credenciales cargadas, pero Agora responde HTTP `501` en catálogo y ventas. Esperando corrección externa de API REST/puerto/versión antes de procesar cola o escrituras.
- Lovable Cloud: reparación de stock/mappings aplicada; bloqueo restante: publicar/redeployar hotfixes actuales, drenar colas residuales antiguas, validar el primer descuento de stock WINERIM real y desarrollar auto-update diferencial de catálogo antes de activar `auto_push_on_update`.

## Notas
- Cron `rescue-zombie-outbound-tasks` corre cada 10 min.
- El módulo compartido vive en `supabase/functions/_shared/resilience.ts`. Importar con ruta relativa `../_shared/resilience.ts`.
- Toast tiene su propio breaker en `provider_config.circuit_breaker` — el global lo respeta porque actualiza `pos_connections.circuit_breaker_paused_until`. Convivencia OK pero no ideal.
## Tras ocultacion legacy de seis Agora - 2026-07-14

- [x] Chiquilla: confirmar legacy de vino oculto a nivel familia y producto; `77/77` formatos Winerim cubiertos.
- [x] Kava: ocultar residuos `TEST Espumosos` y `Vinos`; mantener `Cocteles` y otras familias no vinicolas.
- [x] Jardi: ocultar productos legacy `388-391` sin ocultar la familia mixta `BEGUDES`.
- [x] Sa Pedrera: mover `B MAGNUM 32 - Morgon` desde familia antigua oculta a `MAGNUM WINERIM`.
- [x] Sa Vida: ocultar familia legacy `95 VINOS` y productos `978-993`; preservar clasificacion geografica Winerim.
- [x] Taberna de Elia: confirmar legacy oculto a nivel familia y producto; `412/412` formatos Winerim cubiertos.
- [ ] Pedir confirmacion visual en los terminales de los seis restaurantes tras refrescar/reiniciar la pantalla de Agora.
- [ ] Ejecutar una venta controlada botella y copa desde botones Winerim donde aun no exista validacion operativa reciente; comparar Agora, middleware e historial ERP Winerim.
- [x] Sa Vida: completar la publicación fresh de formatos activos con precio; resultado final `missing=0` sin confundir clasificación Winerim con legacy real.

## P0 - Cierre de auditoría fresh de flota Agora (2026-07-14)

- [x] Auditar las `15` conexiones habilitadas contra catálogo fresh y separar las `7` deshabilitadas/solo lectura/revertidas.
- [x] Confirmar `14/15` habilitadas con catálogo Winerim completo; única no verificable: Qtomas por `No route to host`.
- [x] Confirmar Taberna de Elia con `8/8` familias visibles y `412/412` variantes vendibles.
- [x] Confirmar Sa Vida con `missing=0` (`1252/254/20` por BOTTLE/GLASS/MAGNUM).
- [x] Corregir el falso positivo de Sa Pedrera: `13/13` dulces cubiertos por la regla `single-button` y mappings confirmados.
- [ ] Qtomas: recuperar conectividad externa y ejecutar `test` + `sync-master-data` fresh.
- [ ] Qtomas: reconciliar `59 BLOCKED` y fallos históricos contra el master recuperado; procesar solo cambios que sigan siendo necesarios.
- [ ] Qtomas: confirmar que la alerta canónica se resuelve automáticamente tras dos probes sanos y que solo se emite un correo de recuperación.
- [ ] Taberna de Elia: obtener confirmación visual tras reiniciar/refrescar el terminal; si no aparece, revisar centro de venta/terminal con SAT.
- [ ] Taberna de Elia: hacer una venta real desde botón Winerim y comprobar historial/stock.
- [ ] Implementar en el auditor persistente la resolución por mapping/regla específica antes del fallback determinista.
- [ ] Clasificar como `WONT_FIX` las 7 tareas antiguas de Sa Pedrera que apuntan a formatos `ARCH`, sin reencolarlas ni tocar los botones activos `903xxx`.

## P0 - Cierre operativo Agora hacia `100%_SIGNED_OFF` (2026-07-14)

- [x] Ejecutar auditoría `READ-ONLY` A-I de las `15` conexiones habilitadas y separar catálogo completo de operación integral.
- [ ] Cienvinos: registrar canary de alta y cambio de precio, prueba de cancelación/reconciliación, recuperación idempotente y confirmación terminal; mantener cola y alertas a cero.
- [ ] Taberna de Elia: reconciliar/cerrar `sales_stale`, confirmar visualmente familias en terminal y registrar una venta real botella+copa con hora y stock correctos.
- [ ] Sa Pedrera: clasificar tareas legacy `BLOCKED` como `WONT_FIX` cuando corresponda, resolver los `10 NOT_PUSHED` elegibles y registrar canary/cancelación sin duplicar botones `903xxx`.
- [ ] Casa Nene: investigar y cerrar la alerta `sales_stale`; ejecutar una venta real de copa desde botón Winerim y registrar canary de alta/precio e idempotencia.
- [ ] El Higuerón: ejecutar una copa real y los canaries de alta/precio; comprobar la hora visible y la ausencia de duplicados.
- [x] Katsu Izakaya: cola `0`, historial botella+copa conciliado desde el corte legacy e idempotencia viva confirmada.
- [ ] Luruna: resolver `4 NOT_PUSHED` y confirmar uso real botella+copa desde botones Winerim.
- [ ] Chiquilla y PurOsushi: obtener prueba real botella+copa, stock activo/inactivo e historial TPV; PurOsushi mantiene legacy visible durante el piloto.
- [ ] Sa Vida: reconciliar tracking frente al master fresh, ejecutar canary y activar `auto_push_verified_ready` solo tras éxito; validar copa real.
- [ ] Restaurante Triana: revisar por qué hay `188 NOT_PUSHED`, activar copa automática solo tras canary y validar líneas resueltas.
- [ ] El Bejeque: diagnosticar `2 BLOCKED`, confirmar TPV en uso y realizar prueba botella+copa.
- [ ] Kava: confirmar si el POS sigue en uso, resolver `sales_stale` y validar botella+copa después del 11/07.
- [ ] Jardi: recuperar conectividad/breaker con SAT, releer master fresh y reconciliar `10 QUEUED` antes de procesar.
- [ ] Qtomas: recuperar ruta externa, releer master fresh y reconciliar `59 BLOCKED` más fallos históricos antes de cualquier escritura.
- [ ] Implementar evidencia persistente para canaries de alta/precio, prueba de cancelación, recuperación e idempotencia; hoy esos bloques aparecen como `NO EVIDENCE`.
- [ ] Corregir el monitor para que una actividad reciente cierre o invalide de forma coherente una alerta `sales_stale` obsoleta.

## P0 - Reconciliar historial de Cienvinos (2026-07-14)

- [ ] Mantener Cienvinos fuera de `100%_SIGNED_OFF`: el ERP no coincide con Agora el 12, 13 ni 14 de julio.
- [x] Implementar conciliación por documento/producto/variante y distinguir `OpenTicket` provisional de documento definitivo.
- [x] Corregir el cálculo para netear cantidades negativas/cancelaciones; no usar el valor absoluto para formar el total definitivo del día.
- [x] Leer `DocumentType`, separar identidad de abonos y preservar IDs históricos de facturas normales.
- [x] Desplegar `2804da4` y `20260715090000_agora_refund_sales_guard.sql` en Lovable Cloud.
- [x] Desactivar la escritura provisional de tickets abiertos con stock Winerim inactivo, manteniendo su captura.
- [ ] No considerar `sales/import skipped` como evidencia suficiente de una venta visible sin comprobar la referencia externa o el historial resultante.
- [x] Extraer los `sale_id` repetidos y preparar el lote exacto: `51` anulaciones y `44` unidades a reimportar.
- [ ] Obtener confirmación explícita y ejecutar el lote controlado; conservar la venta real `Convento botella` y comprobar que se restauran `31` botellas.
- [ ] Reescribir/reconciliar el ledger `stock_sync_log` contra el resultado definitivo para impedir reimportaciones posteriores.
- [ ] Verificar en ERP: 12/07 `37 / 199,50 EUR`; 13/07 `61 / 344 EUR` por limitación de PVP histórico; 14/07 `41 / 172,50 EUR`.
- [ ] Ejecutar de nuevo los tres días y exigir delta cero antes de reabrir la escritura intradía.
- [ ] Ejecutar una observación limpia de 24 horas y comparar Agora contra ERP Winerim por vino, variante, cantidad y hora.
- [ ] Solicitar a Winerim una operación reversible por `external_id` (cancelar/actualizar o cantidad negativa) y soporte de precio/importe histórico en `sales/import`.

## P0 - Auditoría intradía e idempotencia de flota (2026-07-16)

- [x] Confirmar `open_tickets_sync_enabled=true` e `intraday_sales_sync_enabled=true` en las `15/15` conexiones Agora activas.
- [x] Confirmar `open_tickets_stock_sync_enabled=true` en `13/15`; mantener Cienvinos y Jardi en captura sin mutación provisional por decisión documentada.
- [x] Auditar el ledger completo: `1.808` filas `SUCCESS` con clave y `0` `idempotency_key` duplicadas.
- [x] Observar canaries de Sa Pedrera y Kava durante varios ciclos y confirmar que el claim persiste al reemplazar snapshots.
- [x] Crear `scripts/audit-agora-intraday-history.mjs` para repetir flags, ledger e historial ERP sin escrituras.
- [ ] Mantener observación durante `24` horas y exigir que el contador de claves duplicadas siga en `0`.
- [ ] Conciliar por documento las diferencias de los últimos catorce días, empezando por Sa Pedrera, Cienvinos, Sa Vida, El Bejeque y Casa Nene.
- [x] Katsu: conciliar desde `2026-06-19`; resultado `PASS`, sin diferencias, duplicados ni stockIds ausentes.
- [x] Katsu: completar `14` filas / `24` unidades por `sales/import`, repetir y confirmar idempotencia sin movimiento de stock.
- [x] Katsu: auditar catalogo fresh `157/157`, limpiar cinco falsos fallos de whitespace y dejar cola cero.
- [x] Katsu: ejecutar dos ciclos de intradia y tickets abiertos con delta cero.
- [x] Katsu: importar histórico canónico `2026-04-16..2026-06-23` mediante
  `sales/import`: `253` tarjetas / `366` unidades, stock inalterado y segunda
  ejecución `253 skipped`.
- [x] Katsu: netear ticket/abono/factura, retirar seis tarjetas no canónicas y
  restaurar exactamente el stock mediante `No, solo ajuste`.
- [x] Katsu: auditar desde `2026-06-24`; historial y stock activo `PASS`, sin
  diferencias canónicas ni duplicados.
- [ ] Katsu: decidir con Winerim si se habilita histórico para `118` unidades
  de variantes actualmente inactivas, sin reactivarlas.
- [ ] Katsu: revisar manualmente `11` unidades de Hunters Sauvignon Blanc y
  Garnacha Tintorera, sin fuzzy automático.
- [ ] Katsu: desplegar el fix de `verify-products` para preservar tracking `HIDDEN`.
- [ ] Katsu: observar 24 horas, pedir confirmacion visual y registrar canary real de alta/cambio de precio antes de `100%_SIGNED_OFF`.
- [ ] Revisar los ocho candidatos de huella ERP idéntica antes de cualquier anulación: Bejeque `1`, Cienvinos `3`, Sa Pedrera `3`, Taberna de Elia `1`.
- [ ] Mejorar mapping de tickets abiertos donde la sonda sigue dejando muchas líneas sin resolver; un flag activo no basta para garantizar cobertura intradía.
- [ ] Añadir la ejecución del auditor a la checklist posterior a despliegues de `agora-proxy` y migraciones que afecten `sales_line_items` o `stock_sync_log`.

## P0 - Hallazgos auditoria fresh 2026-07-17

- [ ] PurOsushi: actualizar solo las listas `8` y `14` de `709944 / B Boissonneuse`; conservar snapshot y exigir `351/351` fresh.
- [ ] Qtomas: ejecutar un canary de una sola referencia; no repetir la evaluacion completa de `1430` productos. Activar flags solo tras PASS.
- [ ] Sa Vida: observar una alta o cambio real automatico durante dos ciclos y medir propagacion antes de activar `auto_push_verified_ready`.
- [ ] De la O: confirmar que no reaparece `No route to host`; no reencolar porque el catalogo actual ya esta `87/87`.
- [ ] Luruna: conservar evidencia y cerrar las cuatro tareas `BLOCKED` redundantes sin reimportar los productos ya exactos.
- [ ] Mantener la auditoria programada en `READ_ONLY`; cualquier correccion debe ejecutarse como operacion separada con snapshot y verificacion fresh.

## P0 - Hallazgos auditoria fresh 2026-07-18

- [ ] PurOsushi: corregir solo `PRICE_LIST_8` y `PRICE_LIST_14` de
  `709944 / B Boissonneuse` y `709986 / B Keller Kirchspiel Riesling GG`;
  conservar snapshot y exigir `357/357` fresh.
- [ ] Sa Vida: corregir diferencialmente `773705`, `848737`, `649038` y
  `849196`; no lanzar reconciliacion masiva.
- [ ] Sa Vida: ocultar las copas `925044 / Kir Yianni Paranga White` y
  `925054 / Microbio Circustancial`, ya sin precio de copa, y verificar que
  no quedan retirados vendibles.
- [ ] Sa Vida: ejecutar un canary automatico antes de valorar
  `auto_push_verified_ready=true`.
- [ ] Qtomas: probar alta/cambio de una sola referencia y activar los cuatro
  flags de catalogo solo tras propagacion, idempotencia y lectura fresh.
- [ ] Chiquilla: observar si reaparece `POS_DOWN`; no reencolar porque queda
  `77/77` exacto.
- [ ] De la O: observar si reaparece `No route to host`; no reencolar porque
  queda `86/86` exacto y 261569 ya esta verificado.
- [x] Confirmar las `22` colas activas en `QUEUED/RUNNING=0` y que no hay
  cambios legitimamente dentro de la ventana de cinco minutos.
- [x] Auditar retirados con elegibilidad actual, master fresh y ownership
  demostrado; no usar tracking `NOT_PUSHED` para ocultar productos.

## P0 - Hallazgos auditoria fresh 2026-07-20

- [ ] De la O: recuperar ruta externa, obtener master fresh y reconciliar la
  unica tarea activa; no procesarla a ciegas.
- [ ] Jardi: recuperar TPV/DDNS/NAT/puerto, obtener master fresh y reconciliar
  los `10` upserts con unas `31,8 h` de antiguedad.
- [ ] PurOsushi: corregir exclusivamente listas `8` y `14` de `709944` y
  `709986`; conservar snapshot y exigir `357/357` fresh.
- [ ] Qtomas: ejecutar canary de una referencia y activar catalog/create/update/
  verified-ready solo despues de propagacion, idempotencia y cola cero.
- [ ] Sa Vida: guardar snapshot e investigar por que `23` productos con
  tracking `HIDDEN` volvieron a estar vendibles.
- [ ] Sa Vida: corregir `649227`, `773705`, `848737`, `649038` y `849196`, y
  ocultar diferencialmente los `25` formatos retirados demostrados.
- [ ] Sa Vida: exigir `1540/1540`, cero retirados vendibles y canary automatico
  antes de activar `auto_push_verified_ready`.
- [ ] Chiquilla: observar recurrencia de abortos; no reencolar porque queda
  `75/75`, cola cero y `34` formatos verificados.
- [x] Confirmar que no hubo altas reales ni tareas de menos de cinco minutos;
  no declarar una reverificacion como tiempo de propagacion.

## Katsu Izakaya - cierre 100% tecnico 2026-07-20

- [x] Catalogo fresh `157/157`, tracking `157 VERIFIED / 35 HIDDEN`, cola y
  fallos recientes a cero.
- [x] Confirmar estructura `VINOS` / `COPAS DE VINOS`, ocho familias Winerim y
  cero productos directos legacy vendibles.
- [x] Confirmar retirados: `35 HIDDEN`, ninguno vendible; los `18 REJECTED`
  antiguos pertenecen a vinos inactivos y ocultos.
- [x] Conciliar siete dias contra el ERP Winerim: cero diferencias, duplicados
  o stockIds ausentes.
- [x] Validar botella, copa, stock activo y `sales_only_stock_inactive` con
  ventas reales.
- [x] Corregir el scope de `providerConfig`, recuperar la venta del 17/07 y
  demostrar segunda ejecucion no-op.
- [x] Avanzar el cursor sobre dias vacios comprobados, dejarlo en 19/07 y cerrar
  automaticamente `sales_stale`.
- [ ] Obtener confirmacion visual del cliente tras refrescar la comandera.
- [ ] Registrar una venta real de magnum solo si Katsu usa ese formato.
- [ ] Usar este checklist como plantilla para la siguiente conexion, sin
  reutilizar IDs, familias ni supuestos propios de Katsu.
- [x] Conciliar sabado 18 y domingo 19 contra facturas fresh y ERP: `3/3`
  ventas el sabado, `0/0` el domingo y cero ventas legacy.
- [ ] Confirmar visualmente en una comandera que un producto legacy conocido
  no aparece como seleccionable en el buscador de venta.

## Configuracion Codex del middleware 2026-07-20

- [x] Fijar Sol `high` + Fast mode para el orquestador del repositorio.
- [x] Crear roles `agora-operator`, `agora-auditor` y `agora-comms` con modelos
  acordes al riesgo.
- [x] Limitar concurrencia a seis agentes directos y desactivar fan-out
  recursivo mediante `max_depth=1`.
- [x] Validar sintaxis con `--strict-config` y confirmar features activas.
- [ ] Confirmar carga visual de modelo y roles al abrir una nueva tarea desde
  la raiz `bridge-to-winerim-release`.
- [ ] Medir la primera auditoria Terra y comparar latencia con el flujo previo.

## Katsu Izakaya - sake 17 y 18 de julio

- [x] Leer facturas frescas de Agora de ambos dias.
- [x] Netear unidades por producto y revisar anulaciones o lineas negativas.
- [x] Documentar `3` unidades / `67,00 EUR` el viernes y `2` unidades /
  `28,00 EUR` el sabado.

## Katsu Izakaya - comida 17 y 18 de julio

- [x] Leer la familia `CARTA` en las facturas frescas de ambos dias.
- [x] Separar bebidas, vinos, sake y cafes.
- [x] Aplicar la devolucion del sabado: `-4` unidades / `-43,75 EUR`.
- [x] Documentar el desglose completo por producto y los totales netos.

## Ocean Club y Finca Eslava - cierre live

- [x] Auditar conectividad, catalogo fresh, tracking, mappings, cola, alertas y
  ventas por ID exacto.
- [x] Confirmar Ocean `113/113` y Finca `123/123`, sin cola ni alertas abiertas.
- [x] Ocean: hacer visibles y verificar fresh las ocho familias Winerim.
- [x] Ocean: restaurar visibles las cinco familias legacy con producto, sin
  ocultar ni modificar productos.
- [x] Ocean: vincular el alias administrativo `Oceans` con el menu `756` en el
  auditor y confirmar que el ERP no contiene ventas.
- [ ] Ocean: canary real de botella y copa desde botones Winerim.
- [ ] Ocean: para el canary de copa, poner antes precio de copa a una referencia
  real y comprobar su alta automatica; actualmente hay `0` copas elegibles.
- [x] Finca: comprobar ajustes posteriores y restaurar Emilio Moro de `82` a
  `83` mediante `No, solo ajuste`, sin crear otra venta.
- [x] Finca: repetir catalogo fresh, conexion, tickets, cola, alertas e
  idempotencia despues de la correccion.
- [ ] Finca: cerrar soporte de anulacion definitiva y repetir canary real de
  botella y copa sin cancelacion.
- [ ] Verificar ambos canaries en ERP Winerim con hora, variante, stock e
  idempotencia antes de firmar el 100 %.

## Ocean Club - historico sin stock 2026-04-16 a 2026-07-15

- [x] Ejecutar dry-run de los `91` dias: `9.237` facturas, `81.798` lineas y
  cero errores.
- [x] Confirmar que el flujo previsto usa solo `sales/import`, IDs
  deterministas y no modifica stock.
- [ ] Validar los diez productos de nombre exacto (`231` filas / `238`
  unidades) y su variante botella.
- [ ] Crear y revisar aliases para coincidencias legacy, incluidos los tamanos
  grandes; no usar fuzzy para escribir.
- [ ] Obtener del cliente la referencia concreta asociada a cada tecla
  generica `GLS ...`, o excluirla expresamente.
- [ ] Guardar snapshot de stock y ejecutar un primer lote pequeno.
- [ ] Verificar ERP, hora, cantidad y stock inalterado; repetir el lote y
  exigir idempotencia antes de ampliar el backfill.

## El Higueron - siguiente checklist tras Katsu

- [x] Confirmar conectividad y API HTTP (`test` y tickets abiertos HTTP 200).
- [x] Confirmar catalogo fresh `292/292`, ocho familias, cola y alertas a cero.
- [x] Confirmar alta/cambio automatico con canary real en `61` segundos.
- [x] Confirmar flags intradia e idempotencia sin claves exactas repetidas.
- [x] Recuperar exactamente una vez la factura `14401` de `Domaine Vacheron
  Sancerre Blanc`, conservando la hora real y stock final `6`.
- [x] Reconciliar `La Vieille Ferme Rose Recolte`: retirar la venta provisional
  cancelada y dejar stock `22` mediante `No, solo ajuste`.
- [x] Endurecer `restore_stale_previous_days`: consultas en bloques de 100,
  fallo cerrado y correccion trazada de Belondrade y Finca Rodma.
- [x] Exigir delta cero entre cinco lineas cerradas y cinco tarjetas ERP,
  sin duplicados, cola ni alertas abiertas.
- [ ] Ejecutar una venta real de copa Winerim y comprobar ERP, hora local,
  variante, stock e idempotencia durante dos ciclos.
- [ ] Ejecutar un canary de stock inactivo si existe una referencia adecuada.
- [ ] Observar tickets durante un servicio actual; la ultima sonda solo
  devolvio tickets antiguos de los dias 15 y 17.
- [ ] Confirmar con el cliente si se oculta legacy de forma reversible.
- [ ] Firmar `100%_SIGNED_OFF` solo con conciliacion a cero.

## Casa Nene - checklist tras El Higueron

- [x] Confirmar conectividad, frecuencia cinco minutos y API HTTP fresh.
- [x] Confirmar catalogo `317/317`, ocho familias Winerim, cola y alertas a
  cero.
- [x] Confirmar legacy de vino oculto y `148` productos legacy no vendibles.
- [x] Confirmar `317` formatos elegibles y `30` retirados no vendibles; dejar
  tracking en `317 VERIFIED / 30 HIDDEN`.
- [x] Confirmar botella real, hora proveedor, stock activo e idempotencia del
  runtime actual.
- [x] Identificar y documentar `16` tarjetas duplicadas del 15/07 y la tarjeta
  provisional cancelada `142290`, con snapshot y rollback.
- [ ] Obtener autorizacion expresa para anular los `17` registros productivos.
- [ ] Anular exclusivamente los IDs documentados y verificar incrementos
  `+7`, `+3`, `+4`, `+2`; ajustar Bancales a `22` con `No, solo ajuste`.
- [ ] Repetir auditoria y exigir cero diferencias, considerando la hora original
  de Pepe Luis del 27/06 aunque su factura cerrara el 16/07.
- [ ] Observar dos ciclos de cinco minutos sin reaparicion de tarjetas.
- [ ] Registrar una venta real de magnum solo si Casa Nene utiliza ese formato.
- [ ] Firmar `100%_SIGNED_OFF` solo despues de la limpieza y conciliacion final.

## Casa Nene - 31 copas internas ocultas en Winerim

- [x] Inventariar las `31` fichas ocultas y capturar nombre, tipo y precio de
  copa desde el editor de Casa Nene.
- [x] Implementar la excepcion por conexion y solo para `GLASS` en generacion,
  cola, auto-push, auditoria, verificacion y reconciliacion.
- [x] Ejecutar TypeScript, bundle, build y suite completa (`104/104`).
- [x] Publicar commit `e10e1ac` y activar la lista de 31 variantes en la
  configuracion de Casa Nene, preservando todas las claves anteriores.
- [x] Verificar que no se ha encolado ni escrito nada con el runtime anterior.
- [x] Redesplegar unicamente `agora-proxy` desde `5d30421`.
- [x] Repetir dry-run con `270679` y exigir `would_queue:GLASS`.
- [x] Ejecutar auditoria fresh y revisar las 31 diferencias antes de escribir.
- [x] Publicar solo las 31 variantes `GLASS` en lotes pequenos y verificar cada
  lote; exigir familia `901954`, precio exacto y vendibilidad.
- [x] Exigir `31 MATCH`, `31 VERIFIED`, cero tareas activas/fallidas y carta
  publica Winerim todavia en `0/31`.
- [ ] Pedir una venta real de copa y comprobar historial `TPV`, hora, variante,
  idempotencia y stock segun configuracion.
- [ ] Abrir mejora de Winerim API v2 para exponer variantes ocultas a la
  integracion sin hacerlas visibles al cliente final.

## Vinatea - cierre tecnico

- [x] Confirmar catalogo fresh `132/132 MATCH`, cola cero y mappings Winerim
  verificados.
- [x] Crear `110` mappings legacy exactos y reversibles sin tocar Agora.
- [x] Resolver de nuevo lineas legacy y confirmar copas abiertas mapeadas.
- [x] Preparar prioridad tickets -> intradia -> cierre diario.
- [x] Preparar guard de cursor para dias con tickets que cierran tarde.
- [x] Pasar `22` tests dirigidos, TypeScript y build.
- [x] Importar de forma idempotente `9` lineas / `16` copas sin modificar
  stock y detectar la representacion incorrecta en el ERP Winerim.
- [ ] Redesplegar solo `agora-proxy` y `agora-cron-dispatcher` cuando exista
  una sesion CLI o de Cloud autenticada.
- [ ] Verificar que el cursor queda detras del 19/07 mientras siga abierto y
  que procesa su factura una sola vez al cerrar.
- [ ] Corregir Winerim `/sales/import`: debe conservar stockId/variante, qty y
  soldAt; reparar las nueve tarjetas de Vinatea sin tocar stock.
- [ ] Ejecutar venta real de copa legacy y copa Winerim, con ERP, hora,
  variante, cantidad, stock e idempotencia.
- [ ] Ejecutar alta o cambio de precio real y medir propagacion menor o igual
  a cinco minutos.
- [ ] Acordar con el cliente la ocultacion reversible de `CAVAS` y `BODEGA`.
## P0 - Abadia Yuste · cerrar legacy y copa canary

- [x] Confirmar catalogo fresh `281/281`, tracking/mappings completos y cola
  activa cero.
- [x] Conciliar tres botellas reales Agora contra `/erp/528/sales`, con hora,
  importe, origen TPV e idempotencia exactos.
- [x] Confirmar `sales/import` para las tres ventas con stock desactivado, sin
  movimiento de inventario.
- [x] Cuantificar legacy vendido: `28` unidades / `292 EUR` entre `17/07` y
  `20/07`.
- [ ] Cliente: vender una copa desde `COPAS WINERIM` y una referencia con stock
  activo.
- [ ] Probar un alta o cambio de precio Winerim y medir la propagacion menor o
  igual a cinco minutos.
- [ ] Validar los siete candidatos de matching legacy nominal y decidir entre
  mapping temporal u ocultacion reversible.
- [ ] Sustituir `Copa Rioja`, `Copa Ribera del Duero`, `Copa Vino extremeno` y
  `Copa semidulce` por botones Winerim identificables; no mapearlos a ciegas.
- [ ] Confirmar visualmente las ocho familias Winerim en todos los terminales.
- [ ] Usar `docs/operations/abadia-yuste-100-percent-checklist-2026-07-21.md`
  como evidencia y rollback.

## P0 - De la O · residual de stock y migracion de legacy

- [x] Confirmar catalogo fresh `112/112 MATCH`, cola activa cero y ciclos de
  cinco minutos.
- [x] Conciliar Agora, logs y `/erp/480/sales`; aislar `Vina Mein` y
  `Camarolos` como las dos diferencias historicas.
- [x] Implementar el calculo de cantidad no cubierta por movimiento de stock
  en los tres flujos de sincronizacion y probar sus casos limite de forma
  aislada.
- [x] Cuantificar uso legacy: `56` unidades / `454,50 EUR` en `14` botones
  entre el `16/07` y el `18/07`.
- [ ] Publicar solo `agora-proxy`; la CLI local requiere una sesion de
  despliegue.
- [ ] Ejecutar una venta real con cantidad superior al stock y exigir historial
  total correcto sin duplicar el movimiento de inventario.
- [ ] Ejecutar una copa desde `COPAS WINERIM` y comprobar ERP en menos de cinco
  minutos.
- [ ] Validar con el cliente los matches legacy y los precios de copa; no
  mapear `Cardiel`, `Fortuny`, `Munana1188`, `Fino Antique`, `Stars Rose`,
  `Lagar Santa Magdalena` o `Delicado` sin confirmacion.
- [ ] Corregir el monitor para no tratar `wine_inactive` o ausencia deliberada
  de precio como un fallo outbound operativo.
- [ ] Usar `docs/operations/de-la-o-100-percent-checklist-2026-07-21.md` como
  evidencia y rollback.

## P0 - El Higueron · orden alfabetico exclusivo por familia

- [x] Identificar los ocho IDs exactos de las familias Winerim.
- [x] Implementar `ALPHABETICAL_WINE_NAME` y `WINE_NAME_ONLY` por conexion.
- [x] Conservar `Name` con `B/C/M` y omitirlo solo en `ButtonText`.
- [x] Anadir dry-run, deteccion de duplicados, verificacion fresh y rollback.
- [x] Integrar el normalizador en altas y actualizaciones futuras.
- [x] Validar bundle, aserciones aisladas y `git diff --check`.
- [x] Desplegar unicamente `agora-proxy` desde `5c4d727`.
- [x] Ejecutar dry-run con los ocho IDs y resolver las dos colisiones
  detectadas antes de escribir.
- [x] Guardar snapshot fresh y activar solo en El Higueron las tres claves de
  presentacion.
- [x] Aplicar `292` cambios, verificar `292/292` fresh y repetir hasta obtener
  `changed=0` y cero etiquetas duplicadas.
- [x] Conservar evidencia/rollback en
  `docs/operations/el-higueron-alphabetical-presentation-2026-07-21.md`.
- [ ] Probar un alta o cambio de precio real y medir la propagacion; exigir
  que la familia afectada siga alfabetica y sin prefijo visible.
- [ ] Obtener confirmacion visual del cliente en todos sus terminales.

## P0 - Corte fresh Agora 2026-07-21 19:01

- [ ] Qtomas: preparar snapshot y ocultacion diferencial de los `267`
  productos Winerim retirados que siguen vendibles; verificar buscador y
  rollback antes de cerrar.
- [ ] Sa Vida: reconciliar por lotes los `278` formatos retirados vendibles,
  los `2` productos ausentes y los `5` diferentes; prohibida la sincronizacion
  masiva directa.
- [ ] Restaurante Triana: ocultar exclusivamente los magnum `1211359` Andre
  Clouet Grande Reserve y `1211360` Picogallo, y repetir lectura fresh.
- [ ] El Higueron: republicar diferencialmente los `10` productos distintos
  preservando orden alfabetico, etiquetas sin prefijo y desambiguacion.
- [ ] PurOsushi: corregir precios de Boissonneuse y Keller Kirchspiel Riesling
  GG en listas `8` y `14` y verificar `357/357`.
- [ ] Normalizar tracking de formatos que ya estan no vendibles en Chiquilla,
  El Bejeque, El Porton, Luruna, Cienvinos, Jardi y Sa Pedrera sin escribir de
  nuevo en Agora.
- [ ] Investigar por que De la O acumulo tareas unas `10 h` y Jardi unas `56 h`;
  confirmar que el siguiente cambio unitario completa en `<=5 min`.
- [ ] Tintorera: repetir un cambio unitario real, porque el alta masiva tuvo
  mediana `3 min` pero maximo `24 min`.

## P0 - Cierre de las seis auditorias del 2026-07-22

### El Higueron
- [x] Reconciliar las `292` variantes preservando orden alfabetico y botones
  sin prefijo visible.
- [x] Ocultar reversiblemente siete familias y `396` productos legacy; cero
  productos legacy vendibles por buscador.
- [x] Medir propagacion real Winerim -> Agora en `61 s`.
- [ ] Cliente: vender una copa Winerim y una referencia con stock desactivado.
- [ ] Obtener confirmacion visual en todos los terminales.

### Casa Nene
- [x] Confirmar catalogo fresh `372/372`.
- [x] Confirmar `31` copas internas, `24` botellas recuperadas y `148`
  productos legacy no vendibles.
- [x] Confirmar cola y fallos recientes a cero, stock `37/37` e idempotencia.
- [ ] Cliente: ejecutar una copa real y medir de nuevo propagacion comercial
  en `<=5 min`.

### De la O
- [x] Confirmar catalogo `119/119`, breaker cerrado y cola activa a cero.
- [x] Medir altas reales en `32,4-53,1 s`.
- [x] Validar que `VINOS > TINTOS WINERIM > producto` es viable con
  `ParentFamilyId=4`.
- [ ] Confirmar con el cliente y aplicar la jerarquia padre si la desea.
- [ ] Decidir retirada reversible del legacy, que continua en uso.
- [ ] Ejecutar canary real de cancelacion y cerrar conciliacion historica.

### Restaurante Cienvinos Ecija
- [x] Confirmar catalogo `519/519` y propagacion de `50-82 s`.
- [x] Normalizar cinco formatos inactivos: resultado `519 VERIFIED + 12
  HIDDEN`.
- [ ] Conciliar facturas Agora, ledger y ERP sin compensaciones a ciegas.
- [ ] Decidir con el cliente el tratamiento de `C MANZANILLA ZULETA`, aun
  vendible y usado sin ownership Winerim.

### El Bejeque
- [x] Confirmar catalogo `94/94`, cola cero y legacy oculto en familia,
  producto y buscador.
- [x] Dejar tickets abiertos en observabilidad y facturas cerradas como unica
  fuente definitiva de escritura.
- [x] Repetir sincronizaciones sin datos nuevos y verificar cero duplicados.
- [ ] Conciliar o aceptar formalmente seis duplicados historicos y una
  diferencia fraccionaria de magnum.

### Chiquilla
- [x] Confirmar que no hay cola activa ni breaker.
- [x] Comprobar que diez de once vinos con fallos historicos tienen un
  `SUCCESS` posterior.
- [x] Confirmar recuperacion de la API HTTP y catalogo fresh `73/73`.
- [x] Normalizar sin replay la tarea superseded de Winerim `139811` y cerrar
  su alerta outbound con evidencia fresh.
- [ ] Identificar de forma inequivoca la venta cancelada que aun figura
  positiva antes de cualquier reparacion de historial.

## P0 - Remediacion de la auditoria universal Agora 2026-07-22

### Integridad de ventas
- [ ] Kava: recuperar exactamente tres copas de Pampaneando y corregir la
  botella duplicada de Chavost sin volver a descontar stock.
- [ ] PurOsushi, Qtomas, Taberna de Elia y Sa Vida: dejar una unica fuente de
  escritura definitiva y reconciliar duplicados por ID externo/documento.
- [ ] Luruna: resolver los cuatro productos legacy vendidos sin mapping y el
  `404` de CAMPILLO antes de reanudar cualquier replay.
- [ ] Restaurante Triana: mapear sustitutos Winerim y ejecutar primera venta
  real integrada; actualmente todas las candidatas observadas son legacy.
- [ ] Cienvinos, Sa Pedrera, Jardi y Vinatea: conciliar Agora, ledger y ERP por
  documento, variante, cantidad y `sold_at`.

### Catalogo y automatizacion
- [x] Sa Vida: reconciliar por lotes, reparar tracking, activar verified-ready
  tras canary y verificar catalogo fresh final `1542/1542`.
- [ ] PurOsushi: corregir diferencialmente los dos productos con precios de
  lista distintos y repetir `357/357`.
- [x] Sa Pedrera: corregir `605908`, clasificar Albenc retirado sin replay,
  avanzar cursor y verificar catalogo fresh `483/483`.
- [ ] Jardi y Qtomas: normalizar tracking sin republicar productos ya exactos;
  Qtomas requiere activar automatismos de forma escalonada.

### Cierre de las conexiones mas proximas
- [ ] Chiquilla: los nueve retirados y la alerta superseded ya estan cerrados;
  queda resolver exclusivamente la cancelacion positiva con ID externo exacto.
- [ ] Casa Nene: ejecutar canary real de copa y sales-only y reconciliar los
  dos riesgos provisional/definitivo.
- [ ] Katsu: repetir una copa en menos de cinco minutos y probar cancelacion
  idempotente; magnum solo si el cliente lo usa.
- [ ] Don Quijote Marbella y Ocean Club: ejecutar primera bateria completa de
  canaries y decidir estrategia de legacy/categorias con el cliente.
- [ ] Abadia Yuste: probar copa, magnum, stock activo, cancelacion y recovery;
  clasificar el legacy todavia usado.

### Monitorizacion y firma
- [x] Normalizar alertas residuales de Chiquilla, Sa Pedrera y Sa Vida con
  snapshot, rollback y monitor dry-run `OK`; evidencia en
  `docs/operations/agora-remediation-alerts-2026-07-22.md`.
- [ ] Confirmar en el siguiente ciclo programado que esas tres alertas no se
  reabren.
- [ ] Incorporar conciliacion automatica Agora/ledger/ERP y alertar por ventas
  omitidas o duplicadas, no solo por HTTP, breaker y cola.
- [ ] Corregir cursores `sales_stale` sin adelantarlos manualmente y observar
  24/48 horas limpias antes de conceder `100%_SIGNED_OFF`.
- [ ] Reactivar Baco, Casa Esteban, Don Bernardo Ponzano, Don Bernardo
  Santander, La Candela, O Bistro y Saddle solo como onboardings controlados.

## P0 - Bloqueo de despliegue de cambios compartidos revisados el 2026-07-22

- [ ] Evitar que un fallo de `sales/import` despues de una deduccion parcial
  aumente la cantidad importada al reintentar; persistir por separado la parte
  ya descontada y la cantidad originalmente no cubierta.
- [ ] Prohibir una seleccion parcial de lineas del mismo grupo
  `evento + vino + variante`, o procesar siempre el grupo completo.
- [ ] Rechazar con `400` selectores presentes pero vacios/invalidos y propagar
  errores de consulta; nunca degradarlos a sincronizacion completa del dia.
- [ ] Hacer atomico el avance del cursor en base de datos mediante
  actualizacion condicional o `GREATEST()`.
- [ ] Autorizar acciones de escritura por secreto interno o rol y
  `connection_id`.
- [ ] Conservar desambiguacion estable de `ButtonText` antes de desplegar los
  cambios de presentacion.
- [ ] No desplegar `agora-proxy`, `_shared/stockSyncUtils.ts` ni el monitor
  modificado hasta cerrar estos puntos con pruebas de reintento, concurrencia y
  seleccion parcial.
