# DECISIONS_LOG

## 2026-08-04 - REST por conexion es observacional durante servicio

- El export REST se limita a GET secuencial/rate-limited, ventanas <=31 dias
  y artefactos privados por conexion.
- Aunque dos pasadas coincidan, no autoriza merge, cursor ni cutover porque
  PostgREST no comparte snapshot transaccional entre tablas/paginas.
- La consistencia autoritativa exige export oficial en staging, writer fence
  externo, drain >=130 s y reconcile exacto de dos capturas estables.

## 2026-08-04 - Baseline oficial, restore real y writer exclusivo

- Todo plan de merge se liga a los bytes/SHA-256 del export Lovable y a un
  backup restaurado en PostgreSQL descartable.
- El import aborta ante WAL/conteos concurrentes; un COMMIT ambiguo exige
  reconciliacion read-only antes de retry o restore.
- Rotar solo Winerim no cerca Agora: cada cutover necesita evidencia externa
  firmada de que el writer Lovable de esa conexion esta fuera del circuito.

## 2026-08-04 - Albariza separa catalogo live de activacion del runtime

- El catalogo se congela desde stock IDs completos + `wines/bulk`; la
  paginacion general no autoriza writes.
- Sin precio se excluye y stale se oculta con rollback, nunca se borra.
- Tener familias/productos en Agora no abre consumer, cron, ventas ni stock;
  esos gates requieren provision cifrado, fence y canary real independiente.

## 2026-08-03 - Scope activo liga grant exacto y PREPARED se cierra append-only

- El runtime compara los bytes exactos del grant con el SHA-256 inmutable del
  scope `ACTIVE`; grant y proof que solo coinciden entre si no autorizan nada.
- Un run no activado se cierra `PREPARED -> ABORTED`, retirando credenciales
  inactivas sin borrar evidencia. Replays y reactivaciones fallan cerrados.
- Sin venta legitima de copa no se activa el run B ni se sintetiza stock.

## 2026-08-03 - Bundle revisado debe arrancar en Workerd

- Los cuatro artefactos se generan con el bundler de Wrangler bajo Node 22+,
  se fijan despues con `no_bundle` y SHA-256, y consumer/executor deben pasar
  smoke de arranque Workerd antes de cualquier despliegue.
- Se descarta el prebundle `esbuild platform=node`: conservaba `require()`
  dinamicos de `pg` que el dry-run aceptaba pero Workerd no podia ejecutar.

## 2026-08-03 - Agora compartido solo en lectura; Winerim writer exclusivo

- El rescue de El Bejeque admite la credencial Agora no rotada solo en modo
  `shared-read-only`, con catalogo y outbound mutables cerrados.
- Winerim es la unica credencial exclusiva y debe coincidir con grant,
  attestation, bundle, config y `run_id` antes de readiness.
- Albariza usa recursos y onboarding separados; preview y canary preceden a
  cualquier carga completa.

> Append-only. Una decisión por bloque. Formato: fecha · decisión · razón · alternativa descartada.

---

## 2026-08-03 - R2 autorizado; no sustituye el writer fence
- **Decision**: activar R2 Standard, crear bucket exclusivo de El Bejeque y
  validar su ciclo remoto. Mantener el deploy unido a la pareja de tokens
  rotada y a la evidencia del writer fence.
- **Razon**: R2 ya puede conservar DLQ/evidencia, pero no evita que Lovable
  use las mismas credenciales si se recupera.
- **Alternativa descartada**: desplegar con manifests parciales, hashes
  ficticios o tokens compartidos solo porque el runtime permanezca inerte.
- **Rollback / mitigacion**: bucket vacio, sin bindings ni Workers; cuatro
  Queues sin productores/consumidores y todas las conexiones apagadas.

## 2026-08-03 - Recursos rescue segregados y R2 con gate de coste
- **Decision**: reservar `bejeque-20260803-a`, cuatro Queues dedicadas y una
  vault key rescue namespaced en el unico Secrets Store disponible. Mantener
  todo sin producer/consumer hasta completar la rotacion externa.
- **Razon**: Cloudflare limita la beta a un store por cuenta; los nombres y
  bindings separados evitan mezclar staging/rescue sin duplicar el store.
- **Alternativa descartada**: reutilizar colas compartidas, reutilizar la key
  staging o desplegar sin ledger R2.
- **Rollback / mitigacion**: colas sin bindings, secreto revocable y conexion
  rescue apagada. R2 exige checkout y no se habilita sin aprobacion explicita.

## 2026-08-03 - Activacion versionada y drain antes de rotacion
- **Decision**: cada canary usa un `run_id` unico y se activa en una sola
  transaccion ligada a manifests SHA-256. Scope y credenciales retirados son
  terminales, se conservan y no pueden reactivarse. `bootstrap` exige cero
  recibos; `rotate` puede conservar solo recibos del candidato con todas las
  generaciones anteriores terminales. Credenciales, RLS, readiness y vault
  deben coincidir con el mismo `run_id` activo.
- **Razon**: evita activaciones parciales, replay de artefactos y mezcla de
  generaciones o evidencias.
- **Alternativa descartada**: updates manuales separados, overwrite de
  credenciales o reutilizar el mismo scope.
- **Rollback / mitigacion**: pausar consumer/writer, revocar grants y esperar
  `>=130 s` antes de rotar; `401/403` antiguo, probe nuevo, retiro append-only
  y verificador exacto por UUID+`run_id`.

## 2026-08-03 - Credenciales inactivas y retirada sin borrado
- **Decision**: separar preparacion y activacion. El provisionador solo inserta
  Agora+Winerim cifrados con `active=false`; la retirada desactiva
  credenciales, scope y conexion, conservando filas y logs.
- **Razon**: un render parcial, scope expirado o abort del canary debe quedar
  fail-closed y auditable, sin abrir un segundo writer ni perder evidencia.
- **Alternativa descartada**: `upsert` de credenciales activas, limpieza por
  `DELETE/TRUNCATE` o reutilizar scripts antiguos de staging.
- **Rollback / mitigacion**: SQL transaccional con identidad exacta del scope,
  readback final y artefactos `0600`; la rotacion real sigue separada y gateada.

## 2026-08-03 - El Bejeque acepta stock inactivo solo como sales-only
- **Decision**: conservar identidades exactas con `stockActive=false` para
  historico `live=false`, exigiendo `stockId` exacto, pero bloquearlas para
  venta live y mutacion de stock.
- **Razon**: recupera `23` variantes historicas inequívocas sin convertir
  stock inactivo en stock operativo ni inventar mappings por nombre.
- **Alternativa descartada**: rechazar todo stock inactivo o permitirlo en
  live. La primera pierde historial verificable; la segunda puede descontar la
  variante equivocada.
- **Rollback / mitigacion**: transicion aditiva con SQL inverso probado sobre
  backup cifrado PG17; runtime y conexion permanecen apagados.

## 2026-07-21 - Ampliar la evidencia SLA sin confundirla con cierre al 100%
- **Decision**: registrar como verificadas en ambos sentidos dentro de siete
  minutos a Casa Nene, El Higueron, Kava, PurOsushi, Cienvinos Ecija, Sa
  Pedrera y Taberna de Elia; registrar otras diez conexiones solo en el
  sentido Agora a Winerim. Ninguna promociona automaticamente a
  `100%_SIGNED_OFF`.
- **Razon**: el segundo corte correlaciono timestamps reales de venta y de
  altas/cambios de catalogo que no estaban incluidos en el primer resumen del
  dia. La evidencia amplía el conjunto probado, pero no elimina deuda de
  legacy, cancelaciones, conciliacion, stock o estabilidad de 24 horas.
- **Alternativa descartada**: conservar el recuento preliminar de solo dos
  conexiones bidireccionales o convertir una latencia correcta en
  certificacion integral. Ambas lecturas contradicen la evidencia disponible.
- **Rollback / mitigacion**: es una reclasificacion documental, sin escrituras
  operativas. Cada canary conserva su timestamp y puede degradarse si una
  auditoria posterior descubre duplicados o divergencia fresh.

## 2026-07-21 - Casa Nene publica botella interna solo con opt-in y ownership confirmado
- **Decision**: desplegar la extension opt-in de Casa Nene y publicar `24`
  botellas internas con `publish_bottle=true` y precio explicito, manteniendo
  las `31` copas internas. Excluir `Balbas Barrica 5` y `Antidoto` mientras
  sus mappings sigan rechazados.
- **Razon**: el dry-run demostro `BOTTLE+GLASS` sin escrituras y la
  reconciliacion por cinco lotes termino en `372/372 MATCH`, con `24/24`
  mappings de botella confirmados y cola cero. La ficha puede permanecer
  fuera de la carta publica sin impedir la operativa interna de Agora.
- **Alternativa descartada**: reactivar todas las botellas por nombre,
  ignorar mappings rechazados o habilitar magnum. Eso transferiria ownership
  sin prueba y ampliaria la excepcion mas alla del requisito del cliente.
- **Rollback / mitigacion**: restaurar el snapshot
  `outputs/CASA_NENE_HIDDEN_VARIANTS_ROLLBACK_2026-07-21.json`, retirar los dos
  campos de las 24 entradas y ocultar diferencialmente solo esas botellas. Las
  copas y el resto del catalogo no se modifican.

## 2026-07-21 - Distinguir configuracion de evidencia del SLA de cinco minutos
- **Decision**: clasificar por separado `VERIFIED`, `PARTIAL`,
  `CONFIGURED_NOT_PROVEN` y `NOT_ACTIVE`. Solo se considera verificado el
  sentido Agora a Winerim o Winerim a Agora cuando existe una operacion real,
  timestamps correlacionables y lectura fresh dentro de siete minutos.
- **Razon**: la auditoria de las 30 conexiones encontro muchos flags y crons
  correctos, pero solo Casa Nene y Sa Pedrera tienen evidencia completa en
  ambos sentidos. Declararlas equivalentes ocultaria fallos de cursor,
  mapping, adopcion de botones o escritura intradia.
- **Alternativa descartada**: usar frecuencia configurada, cola vacia,
  `winerim_wines.updated_at` o la carga inicial como prueba de cinco minutos.
  Ninguno demuestra una modificacion real propagada de extremo a extremo.
- **Rollback / mitigacion**: no cambia datos ni runtime. Cada conexion puede
  promocionarse al aportar los dos canaries reales y 24 horas sin regresion.

## 2026-07-21 - Casa Nene exige autorizacion explicita por formato interno
- **Decision**: mantener la excepcion actual de copa y preparar una ampliacion
  que permita botella solo cuando la entrada de Casa Nene declare
  `publish_bottle=true` y un `bottle_sale_price` positivo y explicito. No
  desplegar ni cambiar produccion hasta revisar el patch.
- **Razon**: las `31` copas estan correctas, pero `26` botellas con precio,
  stock ID y producto Agora quedaron ocultas porque la ficha no aparece en la
  carta publica. `24` tienen mapping confirmado y dos estan rechazadas. El
  runtime equipara esa ausencia con `is_active=false` y la excepcion vigente
  autoriza exclusivamente `GLASS`.
- **Alternativa descartada**: reactivar botones manualmente, marcar las filas
  de cache como activas o reutilizar silenciosamente un precio antiguo. El
  siguiente ciclo desharia las dos primeras opciones y la tercera podria
  publicar un precio obsoleto.
- **Rollback / mitigacion**: snapshot completo, rollout en lotes de cinco y
  retirada de los dos campos solo de los `24` IDs confirmados. Magnum, los dos
  mappings rechazados y las cinco referencias sin botella recuperable
  permanecen bloqueados.

## 2026-07-21 - Ocultar legacy Agora exige flags de producto y sustituto confirmado
- **Decision**: considerar legacy retirado solo cuando la familia objetivo no
  sea visible y todos sus productos sustituidos tengan
  `SaleableAsMain=false` y `UseAsDirectSale=false`. Las ocultaciones futuras
  se haran por producto, con snapshot y sustituto Winerim confirmado.
- **Razon**: la auditoria fresh de las 30 conexiones encontro numerosas
  familias con `ShowInPos=false` cuyos productos siguen vendibles y, por
  tanto, localizables mediante buscador. Tambien encontro familias visibles
  reutilizadas como contenedores Winerim, como Katsu, donde el legacy interior
  si esta correctamente desactivado.
- **Alternativa descartada**: ocultar familias completas por nombre o asumir
  que todo producto sin ownership es legacy. Ambas opciones pueden retirar
  referencias sin sustituto, productos de comida/licores o productos Winerim
  antiguos cuyo ownership necesita repararse.
- **Rollback / mitigacion**: toda propuesta debe conservar XML/flags previos,
  limitarse a IDs auditados y validar catalogo fresh y ventas recientes antes
  de aplicar cambios.

## 2026-07-21 - Unificar nombres homonimos en auditoria y cola Agora
- **Decision**: Aplicar la misma desambiguacion por anada a la comparacion diferencial de `UPDATE` y a la generacion de tareas, y reprocesar como `UPDATE` los cinco bloqueos de Tintorera una vez verificado el catalogo fresh.
- **Razon**: El segundo enriquecimiento amplio Tintorera de `259` a `313` formatos y encontro tres pares con el mismo nombre. La cola generaba nombres seguros con anada, pero el guard diferencial comparaba el nombre base y podia omitir la actualizacion previa necesaria. El hotfix `aff6e6f` dejo `313/313 MATCH`, ownership completo y `0` tareas activas o fallidas.
- **Alternativa descartada**: Renombrar productos a mano en Agora, eliminar una anada, ignorar los bloqueos o forzar altas repetidas. Cualquiera rompe la fuente de verdad Winerim, pierde referencias o mantiene alertas falsas.
- **Rollback / mitigacion**: El snapshot anterior a la activacion permanece intacto. El cambio de codigo puede revertirse por commit; las cinco tareas se ejecutaron como actualizaciones idempotentes y se valido de nuevo el catalogo completo antes de cerrar.

## 2026-07-21 - Activar Tintorera con catalogo Winerim y legacy intacto
- **Decision**: Activar Tintorera mediante el runbook reversible, publicar solo botella/copa/magnum con precio, conservar el legacy sin cambios y dejar el estado en `LIVE_PENDING_SALE_CANARY`.
- **Razon**: El puerto externo volvio a responder y las lecturas fresh validaron API, `1027` productos legacy, centros, tarifa, IVA, almacen y preparacion. La carga quedo en `259/259 MATCH`, con mappings/tracking completos y cola cero, pero todavia no existe una venta real posterior a la activacion.
- **Alternativa descartada**: declarar la conexion al 100 %, publicar los `54` vinos sin precio, convertir formatos no estandar silenciosamente u ocultar legacy durante el primer ciclo.
- **Rollback / mitigacion**: usar el snapshot previo de `docs/operations/agora-live-ready-2026-07-21T13-50-29-684Z/`, deshabilitar la conexion y auto-push, y ocultar solo las ocho familias/productos creados por Winerim. Los productos legacy no requieren restauracion porque no se modificaron.

## 2026-07-21 - Nuevas activaciones Agora no escriben desde tickets abiertos
- **Decision**: El runbook de activacion habilita lectura de tickets abiertos e intradia, pero fija `open_tickets_stock_sync_enabled=false`; las facturas definitivas son la unica fuente de escritura de venta/stock.
- **Razon**: La API Winerim disponible no permite anular de forma idempotente una venta provisional ya creada por `PUT /stock`; escribir el ticket y despues la factura puede dejar duplicados visibles aunque el stock termine neto.
- **Alternativa descartada**: activar escritura provisional por defecto para aparentar tiempo real. Prioriza latencia sobre integridad del historial y no tiene rollback completo.
- **Rollback / mitigacion**: el cambio solo afecta a futuras ejecuciones del runbook. La captura sigue disponible y el flag puede revisarse por conexion cuando exista una anulacion idempotente en Winerim.

## 2026-07-14 · Certificar Cienvinos con canaries reales, reversibles y aislados
- **Decisión**: Validar altas/reactivaciones y cambios de precio desde el editor real de Winerim, usar una variación reversible de `0,01` euros sobre una referencia sin ventas recientes y simular la caída pausando únicamente el breaker de Cienvinos.
- **Razón**: El objetivo era demostrar el flujo completo Winerim -> cola -> Agora y su recuperación sin crear ventas ficticias, sin tocar stock y sin arriesgar al resto de la flota. Las tareas terminaron una sola vez, la evaluación posterior detectó ausencia de cambios y todos los valores de control se restauraron.
- **Alternativa descartada**: modificar directamente `winerim_wines`, insertar tareas o ventas sintéticas, o apagar el TPV. Esas acciones probarían el almacenamiento interno, no la operativa real, y podrían afectar al restaurante.
- **Rollback / mitigación**: restaurar el precio original y la actividad original desde Winerim, retirar el breaker canary, procesar una sola vez la tarea pendiente y exigir cola/alertas/breaker a cero antes de cerrar.

## 2026-07-14 · Separar conciliación cerrada de cancelación real en la evidencia por conexión
- **Decisión**: Marcar como validada en Cienvinos la conciliación idempotente `OpenTicket -> BasicInvoice`, pero no afirmar que una cancelación de vino de Cienvinos fue probada mientras no exista una cancelación real controlada.
- **Razón**: La venta real de dos copas de `C NY Hood Moscato Blanco` pasó de ticket abierto a factura cerrada con una sola deducción. La sonda no encontró una cancelación de vino; forzarla en base de datos o crear una comanda ajena al TPV falsearía la prueba. El mismo código de restauración sí cuenta con evidencia real en Sa Pedrera.
- **Alternativa descartada**: presentar una desaparición de ticket sin vino o una simulación de base de datos como cancelación validada. No demostraría el comportamiento que verá el cliente.
- **Rollback / mitigación**: la restauración de tickets abiertos puede desactivarse por conexión con `open_tickets_restore_stale_previous_days_enabled=false`; para cerrar Cienvinos se coordinará una cancelación real y se verificará que repetir el sync no genera una segunda compensación.

## 2026-07-13 · Validar catálogo/precios con `winerim-proxy/fetch-catalog`, no con `agora-proxy`
- **Decisión**: Usar `winerim-proxy/fetch-catalog` como entrada canónica para comprobar altas y cambios de precio Winerim → Agora.
- **Razón**: `agora-proxy` no expone `fetch-catalog`; su responsabilidad es evaluar/encolar/procesar la escritura a Agora. El refresco de catálogo Winerim, detección diferencial de candidatos y disparo de `evaluate-auto-push` viven en `winerim-proxy`.
- **Alternativa descartada**: seguir invocando `agora-proxy` con `action=fetch-catalog`. Devuelve `Unknown action` o, si se usasen IDs equivocados, `Connection not found`, y no prueba el flujo real.
- **Rollback / mitigación**: no aplica a datos; es una corrección de procedimiento. Para pruebas futuras: `winerim-proxy/fetch-catalog` → `agora-proxy/process-xml-outbound-queue`.

---

## 2026-07-13 · Mantener `auto_push_on_update=true` en conexiones READY tras validar guard diferencial
- **Decisión**: En conexiones Agora con `write_mode=XML_IMPORT` y `auto_push_verified_ready=true`, mantener `auto_push_on_update=true` cuando el guard devuelve `update_skipped:no_agora_changes` para productos ya alineados.
- **Razón**: La validación viva mostró el comportamiento esperado: Kava, Sa Pedrera, Triana y otros revisaron candidatos sin reencolar si no había cambio real; Cienvinos sí procesó un update real y dejó cola `0`.
- **Alternativa descartada**: apagar `auto_push_on_update` globalmente por miedo a colas repetidas. Con el guard desplegado, apagarlo impediría que cambios reales de precio/nombre entren automáticamente en Agora.
- **Rollback / mitigación**: si una conexión vuelve a generar cola repetitiva, desactivar temporalmente `auto_push_on_update` solo en esa conexión y revisar el diff contra XML de Agora antes de reintentar.

---

## 2026-07-13 · No activar Sa Vida como `auto_push_verified_ready` sin prueba controlada
- **Decisión**: No cambiar todavía `Sa Vida.auto_push_verified_ready` de `false` a `true`.
- **Razón**: Aunque Agora responde OK y hay mucho tracking verificado, también existen muchos formatos `NOT_PUSHED` y deuda histórica de stock de mayo. Activar `ready` puede publicar muchos productos/formats de golpe sin una sonda previa segura.
- **Alternativa descartada**: poner `ready=true` para dejarla aparentemente al 100%. Puede resolver el bloqueo visual del panel, pero aumenta riesgo de publicación masiva inesperada.
- **Rollback / mitigación**: activar primero una prueba acotada con allowlist/canary o validación manual de un subconjunto; si se activa y genera cola inesperada, pausar `auto_push_on_update` y drenar/revertir solo esa cola.

---

## 2026-07-13 · Taberna de Elia sigue bloqueada por decisión de estructura, no por conectividad
- **Decisión**: Mantener Taberna de Elia sin publicación automática Winerim hasta decidir estructura destino.
- **Razón**: La conexión Agora responde y las ventas llegan, pero no hay `winerim_push_tracking` verificado. Existe una decisión previa de no volcar Winerim directo porque la estructura legacy de bodega por regiones/denominaciones era compleja y el match inicial no era suficiente.
- **Alternativa descartada**: activar `auto_push_on_create/update` y subir familias Winerim sin confirmar. Puede duplicar productos y romper la organización visual de sala.
- **Rollback / mitigación**: si el usuario autoriza publicación, hacerlo sin ocultar legacy primero, verificar familia por familia y solo después decidir ocultación reversible.

---

## 2026-07-13 · Bloquear cierre al 100% hasta aplicar migración de hora real y redeploy del proxy
- **Decisión**: No declarar ninguna conexión Agora como “100% con altas, cambios de precio y ventas en tiempo real” hasta que Lovable Cloud tenga aplicado el commit `5b5fcdb` y la migración `20260713073627_add_agora_provider_sold_at_to_sales_lines.sql`.
- **Razón**: La base viva aún no expone `sales_line_items.provider_sold_at`; además, el runtime desplegado antes de este commit seguía generando `AUTO_UPDATE` repetidos para productos ya verificados. Sin estas dos piezas, se pueden guardar ventas sin hora real correcta y reabrir cola de cambios de precio sin cambios efectivos.
- **Alternativa descartada**: seguir activando `auto_push_on_update=true` o lanzar `fetch-catalog` masivos por conexión para forzar “verde”. Eso puede escribir productos ya correctos en Agora y crear ruido operativo sin resolver la causa.
- **Rollback / mitigación**: si el deploy no se puede hacer inmediatamente, pausar pruebas masivas de cambios de precio y tratar cualquier cola `AUTO_UPDATE` repetida como deuda del runtime antiguo, no como fallo del cliente.

---

## 2026-07-13 · No declarar los 8 Agora al 100% sin guard diferencial de cambios de precio desplegado
- **Decisión**: Aunque las colas quedaron limpias en 7 conexiones alcanzables, no declarar como cierre definitivo la actualización automática de precios hasta desplegar el guard diferencial de `agora-proxy` que compara Winerim contra el XML real de Agora y devuelve `update_skipped:no_agora_changes` cuando no hay cambios.
- **Razón**: La sonda viva sobre un vino ya verificado de `El Bejeque` encoló `AUTO_UPDATE` aunque no se había cambiado precio. Eso prueba que el runtime desplegado todavía no contiene el guard local y puede generar tandas repetidas de actualizaciones.
- **Alternativa descartada**: seguir ejecutando `fetch-catalog` masivo en todos los clientes con `auto_push_on_update=true`. Deja el panel aparentemente activo, pero reabre colas innecesarias y aumenta el riesgo de ruido operativo en Agora.
- **Rollback / mitigación**: si el redeploy no puede hacerse hoy, no lanzar pruebas masivas de `AUTO_UPDATE`. Si aparece cola repetitiva, drenarla por conexión y desactivar temporalmente `auto_push_on_update` solo en la conexión afectada hasta desplegar el guard.

---

## 2026-07-13 · Mappings contra vinos Winerim inactivos/no accesibles deben rechazarse explícitamente
- **Decisión**: Cuando una venta o mapping apunta a un Winerim ID que devuelve `404 Wine not found/not accessible` o que está inactivo en la caché, el mapping operativo se marca como `REJECTED` antes de seguir intentando stock.
- **Razón**: Casa Nene, Kava y Luruna tenían fallos vivos por mappings confirmados hacia vinos no accesibles. Si no se rechazan, el sistema seguirá intentando descontar stock contra referencias que Winerim no permite operar.
- **Alternativa descartada**: dejar el mapping confirmado confiando en que Winerim vuelva a exponer el vino. Eso mantiene fallos repetidos y ensucia `stock_sync_log`.
- **Rollback**: si el cliente/reactivación de Winerim recupera el vino, se puede volver a crear el mapping confirmado tras una nueva verificación de catálogo.

---

## 2026-07-13 · Jardí queda bloqueado por conectividad externa, no por cola del middleware
- **Decisión**: Tratar `Restaurante Jardi` como no cerrable al 100% hasta que SAT/cliente resuelva DDNS/router/firewall/servidor Agora.
- **Razón**: La cola está limpia, pero la sonda contra Agora devuelve `NETWORK_UNREACHABLE / No route to host`. Sin conectividad desde Lovable Cloud/backend no se pueden validar altas, precios ni ventas.
- **Alternativa descartada**: reintentar cola o tocar configuración de productos. No resolvería un bloqueo de red y puede crear deuda falsa.
- **Rollback**: no aplica a datos; cuando el servidor vuelva a responder, repetir `test`, `sync-master-data`, `verify-products` y una venta real.

---

## 2026-07-11 · El repo desplegable es GitHub, no la copia local de auditoría
- **Decisión**: A partir de esta correccion, cualquier cambio desplegable debe aplicarse y validarse en el clon oficial `goiko111/bridge-to-winerim`, no solo en copias locales de trabajo o auditoria.
- **Razón**: Lovable Cloud redeployo correctamente, pero el repo que desplego no contenia `probe-open-tickets`, `sync-open-tickets`, el flag `open_tickets_sync_enabled` del dispatcher ni la nueva regla de copas. Los cambios estaban en una copia local no trackeada.
- **Alternativa descartada**: pedir a Lovable otro redeploy sin cambiar GitHub. Repetiria el mismo resultado porque el runtime solo puede materializar lo que exista en la fuente desplegable.
- **Rollback**: revertir el commit GitHub de esta sesion y redeployar `agora-proxy`/`agora-cron-dispatcher`; no requiere tocar datos si no se activaron flags de tickets abiertos.

---

## 2026-07-11 · Piloto de tiempo casi real Agora con tickets abiertos queda detrás de flags
- **Decisión**: Implementar `probe-open-tickets` y `sync-open-tickets`, pero dejar el procesamiento recurrente apagado por defecto y activable por conexion mediante `provider_config.open_tickets_sync_enabled`. El descuento desde tickets abiertos requiere ademas `provider_config.open_tickets_stock_sync_enabled=true`.
- **Razón**: `/api/export/tickets/` puede dar visibilidad antes del cierre, pero no todas las instalaciones Agora exponen el endpoint igual ni todas las mesas abiertas son estables para descontar stock en el instante exacto. Separar captura y descuento permite canary por restaurante.
- **Alternativa descartada**: sustituir globalmente `auto-sync-sales` por tickets abiertos en toda la flota. Podria duplicar o adelantar descuentos en instalaciones que solo garantizan ventas tras cierre.
- **Rollback**: poner `open_tickets_sync_enabled=false` por conexion o revertir el commit. El flujo estable por `Invoices` queda intacto.

---

## 2026-07-11 · Las copas se publican por precio de copa, no por boolean legacy
- **Decisión**: Para Agora, el formato `GLASS` se considera publicable si Winerim tiene `glass_sale_price>0`; `serve_by_glass` deja de ser bloqueo duro y pasa a warning si viene apagado.
- **Razón**: En Sa Pedrera se observaron vinos con precio de copa visible en Winerim que no subian a Agora porque el boolean antiguo no estaba marcado. La fuente operativa para vender copa debe ser la variante/precio real.
- **Alternativa descartada**: exigir al cliente que active manualmente `serve_by_glass` ademas de poner precio de copa. Añade friccion, genera falsos negativos y contradice la regla funcional acordada: "si tiene precio de copa en Winerim, debe poder venderse como copa".
- **Rollback**: restaurar el gate anterior (`serve_by_glass=true && glass_sale_price>0`), aunque no recomendado salvo que Winerim confirme que puede haber precio de copa no vendible por diseño.

---

## 2026-06-25 · Migración generada del helper seguro queda como no-op
- **Decisión**: Mantener `20260625073417_a9f5092e-e4f6-49fa-a9ee-1f7fbe353f8d.sql` como no-op documentado.
- **Razón**: Lovable Cloud generó esa migración al aplicar `invoke_connection_health_monitor_secure(...)`, pero el repositorio ya contiene la migración canónica `20260625072756_secure_connection_health_monitor_cron.sql`. Duplicar la misma función no aporta valor y complica la historia de migraciones.
- **Alternativa descartada**: borrar la migración generada. Igual que en la anterior migración generada por Lovable, preferimos conservar el id remoto para explicar el despliegue sin ejecutar DDL duplicado.
- **Rollback**: si se confirma que ese id no existe en ningún historial de Lovable Cloud, se puede eliminar en una limpieza futura.

---

## 2026-06-25 · Emails del monitor solo con `MONITOR_CRON_SECRET`
- **Decisión**: Proteger `connection-health-monitor` para que `sendEmails=true` y `notifyClients=true` solo funcionen si la peticion trae `X-Monitor-Secret` y coincide con `MONITOR_CRON_SECRET`.
- **Razón**: La funcion usa permisos internos para registrar checks/alertas. Permitir que cualquier invocacion con anon key dispare emails podria generar spam o ruido operativo. El boton manual debe poder revisar estado, pero no enviar notificaciones.
- **Alternativa descartada**: usar service role key en el cron como unico control. Lovable Cloud no expone ese secreto y no conviene pegarlo en SQL; un secreto especifico de monitor reduce blast radius y es rotatable.
- **Rollback**: quitar `MONITOR_CRON_SECRET` o ejecutar el monitor con `sendEmails=false`. Las alertas seguiran registrandose sin notificaciones.

---

## 2026-06-25 · Migración generada por Lovable queda como no-op para evitar duplicados
- **Decisión**: Mantener `20260625071127_29af3b55-ae05-4175-a786-5d0b54aa740e.sql` en el repositorio, pero convertirla en no-op documentado.
- **Razón**: Lovable Cloud generó esa migración al aplicar el esquema del monitor, aunque el repositorio ya contenía la migración canónica `20260625044943_connection_health_monitor.sql`. Si ambas ejecutan el mismo DDL en un entorno nuevo, los `CREATE TRIGGER` duplicados pueden romper la instalación.
- **Alternativa descartada**: borrar completamente la migración generada. Eso limpiaría el árbol, pero perdería la referencia al id de migración que Lovable creó durante el despliegue.
- **Rollback**: si se confirma que Lovable no registró ese id de migración en ningún entorno, se puede eliminar el no-op en una limpieza posterior. Mientras tanto, conservarlo evita drift documental sin riesgo operativo.

---

## 2026-06-25 · Monitor desplegado, pero cron/email quedan bloqueados hasta configurar secretos
- **Decisión**: Dejar `connection-health-monitor` desplegada y operativa para checks manuales/persistentes, pero no activar un cron recurrente ni emails a cliente hasta configurar credenciales seguras (`RESEND_API_KEY`, remitente validado, destinatarios internos/cliente y credencial de invocacion del monitor).
- **Razón**: El primer run real ya abre alertas sin tocar ventas, stock, catalogo ni colas. Para convertirlo en automatismo recurrente con emails, la invocacion debe quedar protegida y trazable; no se debe depender de una llamada publica/anonima a una Edge Function que usa service role internamente.
- **Alternativa descartada**: activar `pg_cron` invocando la funcion sin secreto o con una credencial publica solo porque tecnicamente responde. Seria rapido, pero abre riesgo de spam de emails, ruido operativo y escrituras de alertas disparadas por terceros.
- **Rollback**: si el monitor genera ruido, pausar/eliminar el cron cuando exista y dejar de invocar la funcion. Las tablas `connection_alerts` y `connection_health_checks` pueden quedar como historico; no afectan a ventas, stock, mappings, catalogo ni conexiones POS.

---

## 2026-06-25 · Monitorizacion persistente con email sin tocar flujos operativos
- **Decisión**: Crear un sistema persistente de health checks e incidencias (`connection_health_checks`, `connection_alerts`, `connection_notification_contacts`) y una Edge Function `connection-health-monitor` que observe conexiones Agora, abra/cierre alertas y envie email si hay secretos configurados.
- **Razón**: Los fallos como Casa Nene/Jardi (`NETWORK_UNREACHABLE`) o Sa Vida (`401`) no deben depender de que alguien entre manualmente en logs o en Sync Monitor. El equipo necesita visibilidad y aviso proactivo, pero sin que el monitor reintente colas ni toque stock/catalogo.
- **Alternativa descartada**: hacer que el dispatcher de Agora envie emails directamente. Mezcla observabilidad con ejecucion operativa, aumenta el riesgo de duplicar ruido por cada job y haria mas dificil pausar notificaciones sin tocar ventas/catalogo.
- **Rollback**: desactivar el cron que invoque `connection-health-monitor` y dejar las tablas como historico inerte. No requiere revertir ventas, stock, mappings, catalogo ni conexiones POS porque el monitor solo lee y escribe en tablas propias de alertas.

---

## 2026-06-23 · Ocultar vinos inactivos en Agora sin renombrarlos como `[INACTIVO]`
- **Decisión**: Cambiar la tarea `AGORA_HIDE_PRODUCT` para preservar el nombre original del producto Agora y ocultarlo solo con `UseAsDirectSale=false` y `SaleableAsMain=false`. Si el producto ya tiene prefijo `[INACTIVO]`, el nuevo flujo lo limpia al reimportar el producto oculto.
- **Razón**: Sa Pedrera reportó que, si inactivan un vino durante el servicio tras vender la última botella, las facturas de mesas abiertas pueden imprimir el nombre maestro actualizado con `[INACTIVO]`, generando mala experiencia para el cliente final aunque el cobro sea correcto.
- **Alternativa descartada**: mantener el prefijo `[INACTIVO]` como señal visual interna. Esa señal debe vivir en `winerim_push_tracking.sync_status=HIDDEN`, `outbound_tasks` y paneles, no en el nombre comercial del producto.
- **Rollback**: restaurar el comportamiento anterior en `AGORA_HIDE_PRODUCT` volviendo a generar `Name="[INACTIVO] ${wineName}"`. No recomendado salvo que Agora no respete correctamente `UseAsDirectSale=false`/`SaleableAsMain=false`; en ese caso primero validar con producto de prueba.

---

## 2026-06-23 · Don Bernardo: read-only real antes de cualquier escritura Agora
- **Decisión**: Crear Don Bernardo Ponzano y Don Bernardo Santander como conexiones Agora read-only (`enabled=false`, `catalog_sync_enabled=false`, `write_mode=NONE`, auto-push apagado) y no subir catalogo ni ocultar legacy hasta revisar estructura y match.
- **Razón**: Ambos TPV tienen estructura de vino ya trabajada. Ponzano tiene cobertura preliminar segura `58/95` (`61,1%`) y Santander `42/147` (`28,6%`), insuficiente para activar stock o escritura automatica sin revision.
- **Alternativa descartada**: activar `XML_IMPORT`/auto-push o crear familias Winerim dedicadas inmediatamente. Habria riesgo de duplicar vinos, romper la organizacion visual y generar mappings incorrectos para stock.

## 2026-06-23 · Historico de ventas: analitica sin stock ni cursor operativo
- **Decisión**: Importar ventas historicas de Don Bernardo (`2026-03-23` a `2026-06-23`) como `historical_analytics`, con `stockEligible=false`, lineas `mapped=false` y sin `winerim_product_id`.
- **Razón**: El usuario quiere disponer del historico de 3 meses, pero sin descontar stock anterior a la integracion. Separarlo de la ruta operativa evita que un flujo futuro de stock intente deducir ventas pasadas.
- **Alternativa descartada**: usar `save-sales`/`auto-sync-sales` para el historico. Esas rutas estan pensadas para dias operativos y pueden descontar stock o avanzar cursor si hay mappings.

## 2026-06-23 · `sync-master-data` no debe activar escritura en auditorias
- **Decisión**: Cambiar `agora-proxy` para que `sync-master-data` no promocione `write_mode=NONE` a `XML_IMPORT` cuando `payload.preserveWriteMode=true` o `provider_config.read_only_onboarding=true`.
- **Razón**: Durante el alta read-only de Don Bernardo, la lectura de master data promociono temporalmente `write_mode` aunque no se habia aprobado escritura. Fue revertido a `NONE`, pero el comportamiento debe quedar bloqueado para futuras auditorias.
- **Alternativa descartada**: aceptar la promocion automatica porque auto-push seguia apagado. Aunque no escribe por si sola, reduce la claridad operativa y puede inducir a errores en onboarding comercial/tecnico.

## 2026-06-22 · Estudio Resto: viabilidad parcial, no integración completa todavía
- **Decisión**: Tratar la API `Api Resto` de Estudio Informatico como precheck parcial de lectura, no como integracion Winerim completa.
- **Razón**: La documentacion solo cubre autenticacion JWT, lectura de menu y lectura de stock agregado. No documenta ventas cerradas con lineas, ids idempotentes, anulaciones, fecha de negocio ni escritura de productos/precios. Ademas, la URL de ejemplo es privada/local, por lo que hace falta resolver conectividad segura desde backend.
- **Alternativa descartada**: crear ya una conexion productiva o prometer sincronizacion automatica. Con el contrato actual solo podriamos leer carta/stock, pero no cerrar el flujo catalogo Winerim -> POS ni ventas POS -> Winerim.

---

## 2026-06-19 · Katsu: pasar a modo definitivo con familias Winerim dedicadas
- **Decisión**: Activar Katsu Izakaya como instalacion definitiva Winerim en Agora: `WINERIM_DEDICATED_FAMILIES`, XML import por formato, copas activas, `auto_push_on_create=true`, `auto_push_on_update=true` y `auto_push_verified_ready=true`.
- **Razón**: La importacion controlada por formato verifico `131/131` formatos Winerim presentes y vendibles (`64` botellas, `65` copas, `2` magnums), `0` faltantes y `0` productos Winerim como boton raiz. La cola XML quedo finalmente en `0 QUEUED / 0 RUNNING / 0 FAILED / 0 BLOCKED`.
- **Alternativa descartada**: mantener Katsu en modo parcial/read-only o solo publicar los `11` faltantes detectados el 2026-06-17. Ya habia familias Winerim preparadas, stockIds por variante y validacion XML por formato; mantener el modo parcial perpetuaba ventas legacy sin stock Winerim.

---

## 2026-06-19 · Katsu: ocultar legacy reversible, no borrar ni sincronizar historico legacy
- **Decisión**: Ocultar el legacy de vino de Katsu mediante visibilidad/vendibilidad y guardar snapshot para rollback; no borrar productos, mappings ni historico.
- **Razón**: El objetivo operativo es que sala venda desde productos Winerim para que futuras ventas puedan mapear y descontar stock. Las ventas historicas venian de botones legacy y no sirven como prueba de stock Winerim; forzar stock historico podria descontar ventas antiguas con mappings ambiguos.
- **Alternativa descartada**: borrar legacy o reintentar sincronizar stock de ventas historicas legacy. Borrar rompe rollback; sincronizar historico puede producir descuentos incorrectos y no valida la operativa futura.

---

## 2026-06-19 · Flota Agora: no drenar colas cuando el POS no responde sano
- **Decisión**: No procesar colas de `Restaurante Jardi`, `Restaurante Cienvinos Ecija` ni `Sa Vida` hasta que sus tests Agora respondan correctamente.
- **Razón**: Jardi devuelve `502 No route to the Agora server`, Cienvinos termina en timeout y Sa Vida devuelve `501`. Reintentar escrituras o ventas contra esos estados solo aumentaria `FAILED/BLOCKED` y podria abrir breaker sin resolver la causa.
- **Alternativa descartada**: drenar o limpiar backlog para dejar el panel verde. Seria cosmetico y arriesgado: mezclaria problemas de red/API con tareas reales pendientes.

---

## 2026-06-17 · Katsu: no activar automático completo tras auditoría solo lectura
- **Estado posterior**: superada por la decisión del 2026-06-19 tras import XML por formato, ocultación reversible del legacy y cola final limpia.
- **Decisión**: Tratar Katsu como conexión operativa de lectura con catálogo Winerim parcial, pero no como instalación cerrada para stock ni autopush completo.
- **Razón**: La auditoría solo lectura confirma API Agora y Winerim OK, cola `0` y `8` familias Winerim visibles, pero solo `52/66` formatos esperados están visibles/vendibles; `3` están en familia legacy oculta y `11` faltan. Además, desde `2026-06-01` hay `283` documentos y `2.554` líneas guardadas, pero `0` líneas mapeadas y `0` `stock_sync_log`.
- **Alternativa descartada**: activar `auto_push_verified_ready=true` o publicar/mover productos directamente. Podría reimportar cola no diferencial, mantener copas incoherentes con la política actual o dar por bueno un stock que aún no descuenta ventas reales.

---

## 2026-06-17 · Taberna de Elia: no hacer volcado Winerim directo tras pre-match
- **Decisión**: Tratar Taberna de Elia como integración con fase previa de matching legacy/revisión manual, no como alta directa de familias Winerim ni ocultación legacy.
- **Razón**: El pre-match sobre `373` vinos operativos Winerim solo da `176` matches automáticos seguros (`47.2%`), con `96` candidatos en revisión, `101` sin match y `62` matches seguros con duplicidad/ambigüedad en Agora. Además, el TPV ya tiene una estructura visible de `Bodega` por denominaciones/regiones.
- **Alternativa descartada**: subir todo Winerim en paralelo y ocultar legacy después. Podría duplicar vinos, romper la organización visual de sala y confirmar mappings incorrectos para ventas/stock.

---

## 2026-06-17 · El Bejeque: match alto pero revisar visibilidad antes de escribir
- **Decisión**: Considerar El Bejeque viable para matching inicial, pero no escribir catálogo hasta aclarar por qué las familias de vino Agora están ocultas.
- **Razón**: El pre-match sobre `72` vinos operativos da `54` matches automáticos seguros (`75.0%`) y cobertura potencial `87.5%` con revisión, pero las familias legacy de vino (`TINTOS`, `BLANCOS`, `ROSADO`, `ESPUMOSO`, `FORTIFICADO`, `POSTRE`) figuran `ShowInPos=false`.
- **Alternativa descartada**: crear familias Winerim o reactivar legacy inmediatamente. Sin entender la visibilidad actual, se puede alterar una pantalla que quizá el cliente no usa así o que depende de otra capa/cache de Agora.

---

## 2026-06-17 · Agora pre-onboarding: auditar antes de crear conexión o subir catálogo
- **Decisión**: Tratar El Bejeque y Taberna de Elia como pre-onboarding read-only: inspeccionar API, familias, productos, ventas y estructura visual antes de crear `pos_connections`, importar Winerim u ocultar legacy.
- **Razón**: Ambos TPV tienen estructura legacy previa y Taberna de Elia conserva una organización de bodega por regiones. Subir Winerim sin entender la pantalla actual podría duplicar vinos, romper memoria visual o ocultar botones útiles.
- **Alternativa descartada**: crear la conexión y lanzar catálogo Winerim directamente porque los tokens ya estaban disponibles. Sería rápido, pero repetiría riesgos ya vistos en Baco/Sa Pedrera: duplicados, familias inesperadas y rollback operativo.

---

## 2026-06-17 · Agora: usar `Product.Order`, no `SortOrder`, para orden visual
- **Decisión**: Reordenar productos Agora mediante el atributo `Order` de `<Product>`, no `SortOrder`.
- **Razón**: Sa Pedrera aceptó una importación con `SortOrder`, pero `export-master Products` no devolvió ni persistió ese atributo. En cambio, los productos vivos de Agora sí exponen `Order`, y tras importar XML con `Order` la verificación confirmó `438/438` productos con el valor esperado.
- **Alternativa descartada**: mantener `SortOrder` como campo de orden. No rompía productos, pero no tenía efecto verificable y podía dar falsa sensación de sincronización automática.

---

## 2026-06-17 · Agora: orden comercial por código configurable y reversible
- **Decisión**: Añadir modo `provider_config.agora_product_sort_mode="COMMERCIAL_CODE_NUMERIC"` para ordenar productos Agora por códigos comerciales explícitos (`T501`, `E516`, `D709`, etc.) y hacer que la cola Winerim→Agora reordene automáticamente por `Product.Order` las familias afectadas tras imports correctos.
- **Razón**: Sa Pedrera trabaja con códigos correlativos en Winerim y espera que Agora refleje ese orden sin intervención diaria. Un producto nuevo como `T499` debe poder colocarse antes de `T501` cuando Winerim lo tenga así, no quedar al final por fecha de creación.
- **Alternativa descartada**: recrear productos con IDs nuevos correlativos para forzar orden visual. Podría romper mappings, tracking, histórico y ventas; además ya se decidió conservar IDs existentes para evitar duplicados.

---

## 2026-06-17 · Agora: precio Winerim obligatorio para aparecer operativo
- **Decisión**: Un vino/formato sin precio en Winerim no debe aparecer operativo en Agora. Si es nuevo, no se crea; si ya estaba publicado y pierde el precio, se oculta mediante `AGORA_HIDE_PRODUCT` con `_trigger_source="AUTO_PRICE_REMOVED"`.
- **Razón**: Precio ausente significa que el cliente todavía no quiere vender ese formato o que la ficha no está lista. Publicarlo en Agora podría permitir ventas con precio incorrecto o generar confusión en sala.
- **Alternativa descartada**: dejar visible un producto ya publicado cuando se elimina el precio en Winerim. Evita cambios visuales automáticos, pero contradice la regla de que Winerim es la fuente de verdad de carta/precio.

---

## 2026-06-16 · Agora outbound: limpiar breaker residual caducado antes de cortar la cola
- **Decisión**: Modificar `process-xml-outbound-queue` para que, si `circuit_breaker_paused_until` está vencido pero `consecutive_failures` sigue en `10` o más, limpie el breaker residual antes de procesar la cola.
- **Razón**: Sa Pedrera tenía vinos nuevos correctamente encolados (`E516`, `E520`) y Agora volvía a responder, pero el contador residual hacía que el procesador cortase inmediatamente con `breakerTripped=true`. La pausa caducada debe permitir reintentar por el camino normal.
- **Alternativa descartada**: resetear breakers manualmente cada vez que el cliente reporte un vino ausente. Eso arregla el síntoma, pero no elimina la causa y obliga a supervisión manual.

---

## 2026-06-16 · Sa Pedrera: resetear breaker residual solo tras sonda sana
- **Decisión**: Resetear `consecutive_failures`, `circuit_breaker_paused_until` y `circuit_breaker_reason` en Sa Pedrera después de confirmar que Agora respondía correctamente por XML.
- **Razón**: `E516 - Hermós Brut Nature` estaba correctamente cacheado y encolado como `AUTO_CREATE`, pero la cola no procesaba porque `consecutive_failures=10` seguía bloqueando el procesador aunque la pausa temporal ya había caducado. La sonda viva de `Families` y `Products` redujo el riesgo de reabrir un POS realmente caído.
- **Alternativa descartada**: importar `E516` manualmente fuera de la cola. Habría resuelto el síntoma, pero habría saltado idempotencia, tracking y mapping; era mejor desbloquear el mecanismo normal.

---

## 2026-06-16 · Sa Pedrera: ocultar legacy de vino de forma reversible
- **Decisión**: Ocultar el legacy de vino de Sa Pedrera en Agora mediante `ShowInPos=false` en familias legacy y `SaleableAsMain=false` / `UseAsDirectSale=false` en sus productos, preservando todos los registros y snapshots para rollback.
- **Razón**: El cliente ya validó las familias Winerim dedicadas y autorizó ocultar el legacy. Mantener productos/mappings/tracking permite volver atrás sin reconstruir la instalación y evita perder trazabilidad de ventas o referencias históricas.
- **Alternativa descartada**: borrar productos legacy o eliminar mappings. Aunque limpiaría visualmente de forma más agresiva, aumenta el riesgo de no poder revertir rápido y de romper ventas históricas o referencias del TPV.

---

## 2026-06-16 · Sa Pedrera: mantener auto-push activo tras ocultar legacy
- **Decisión**: Mantener `auto_push_on_create=true`, `auto_push_on_update=true` y `auto_push_verified_ready=true` después de ocultar el legacy.
- **Razón**: La instalación ya tiene familias Winerim visibles, mappings/tracking verificados y la primera tanda real de `AUTO_CREATE` fue pequeña y correcta. Si un vino se añade o activa en Winerim, debe entrar en Agora automáticamente en el siguiente ciclo de catálogo si cumple formato/precio y no hay bloqueo explícito.
- **Alternativa descartada**: apagar automatismos por prudencia tras ocultar legacy. Reduciría riesgo de cambios automáticos, pero contradice el objetivo operativo del cliente: no tener que entrar cada día a actualizar Agora.

---

## 2026-06-10 · Mantener activo auto-push Sa Pedrera tras primera tanda real correcta
- **Decisión**: Mantener `auto_push_on_create=true` y `auto_push_on_update=true` en Sa Pedrera despues de procesar la primera tanda real.
- **Razón**: El primer ciclo automatico genero solo `3` tareas `AUTO_CREATE`, todas legitimas y procesadas con `succeeded=3`, `failed=0`, `remaining=0`, sin breaker. Los tres vinos quedaron `VERIFIED` en tracking y `CONFIRMED` en mappings.
- **Alternativa descartada**: apagar de nuevo el automatico por prudencia despues de ver tareas nuevas. Habria impedido validar el flujo real; la tanda fue pequena, concreta y exitosa.

---

## 2026-06-10 · Reactivar auto-push Sa Pedrera tras runtime actualizado y sonda limpia
- **Decisión**: Activar `auto_push_on_create=true` y `auto_push_on_update=true` en Sa Pedrera.
- **Razón**: Lovable Cloud confirmo redeploy de `agora-proxy` y `winerim-proxy`; la sonda dry-run con `forceEvaluate:true` devolvio `queued=0`/`wouldQueue=0`/`create_skipped:formats_already_verified`; `fetch-catalog` corrio con flags apagados y no creo cola; tras activar, la sonda normal sobre `249018` tambien devolvio `queued=0` y la cola quedo en `0 QUEUED / 0 RUNNING`.
- **Alternativa descartada**: mantener el automatico apagado hasta validacion manual del cliente. Era mas conservador visualmente, pero ya estaba validado el guard anti-duplicados y mantenerlo apagado impediria que altas/cambios reales de Winerim suban a Agora.

---

## 2026-06-10 · No reactivar auto-push Sa Pedrera hasta redeploy verificado de Lovable Cloud
- **Decisión**: Mantener `auto_push_on_create=false` y `auto_push_on_update=false` en Sa Pedrera aunque el codigo correcto este en GitHub, hasta que Lovable Cloud ejecute la version nueva de `agora-proxy` y `winerim-proxy`.
- **Razón**: Tres sondas live con un vino ya verificado (`249018`) siguen generando `AUTO_CREATE` (`queued=1`) en vez de saltar con `create_skipped:formats_already_verified`. Se bloquearon inmediatamente las tareas de prueba y la cola final queda en `0 QUEUED / 0 RUNNING`.
- **Alternativa descartada**: reactivar los flags confiando en el codigo local o en el push `ae9850c`. Esa opcion podria recrear tandas de productos ya publicados y volver a tocar Agora sin necesidad.

---

## 2026-06-09 · Sa Pedrera tintos usa productos Winerim existentes, no duplicados nuevos
- **Decisión**: Para publicar `TINTOS WINERIM` en Sa Pedrera, mover los productos Winerim de botella `T###` ya existentes a la familia `900157` y crear solo los que no existan; no crear una segunda copia con IDs `902###` para todos.
- **Razón**: La revision previa detecto que `197/200` tintos ya existian en Agora con el mismo nombre. Agora rechaza nombres duplicados aunque cambie el ID, y crear copias habria duplicado la pantalla. Conservar los IDs existentes mantiene mappings, tracking e historico de ventas.
- **Alternativa descartada**: recrear todos los tintos con IDs correlativos por codigo para forzar orden visual. Era mas ordenado en teoria, pero chocaba con la restriccion real de nombres unicos y elevaba el riesgo de duplicados o import fallido.

---

## 2026-06-09 · Auditoria flota Agora no permite declarar todos los clientes como sanos
- **Decisión**: Comunicar el estado por conexion y no afirmar que toda la flota Agora salvo Sa Vida funciona correctamente en todos los aspectos.
- **Razón**: Kava y Sa Pedrera tienen descuentos de stock recientes; Casa Nene esta lista pero sin primera venta; Katsu y La Candela bajan ventas pero no mapean lineas de vino en los ultimos 7 dias; Luruna no responde por red; Cienvinos queda en timeout; Baco esta apagado por rollback legacy.
- **Alternativa descartada**: limpiar colas o reintentar todo en bloque para que el panel parezca verde. Mezcla deuda antigua, problemas de red y acciones visuales sensibles, y podria romper pantallas operativas.

---

## 2026-06-04 · Sa Pedrera debe tratar duplicados con política legacy-first, no borrado masivo
- **Decisión**: Para Sa Pedrera, si el cliente quiere mantener su pantalla legacy/regional, la corrección de duplicados debe ser `legacy-first`: cuando exista un producto legacy con mapping `CONFIRMED` para el mismo vino/formato, ocultar el producto publicado desde Winerim; conservar productos Winerim publicados solo donde no haya legacy seguro o donde el cliente quiera explícitamente nombre/formato Winerim.
- **Razón**: Sa Pedrera está configurada en `LEGACY_REGION_ROUTING`, por lo que conviven productos legacy y productos Winerim dentro de familias regionales. El matching no impide por sí solo que se publique un producto Winerim; solo permite que una venta legacy descuente stock. Borrar u ocultar todo Winerim dejaría fuera vinos nuevos o formatos sin legacy.
- **Alternativa descartada**: ocultar todos los Winerim publicados o todos los legacy visibles. Ambas opciones romperían parte de la operativa: la primera perdería vinos nuevos de Winerim; la segunda cambiaría la pantalla que el cliente quiere conservar.

---

## 2026-06-04 · Mantener Sa Vida bloqueada aunque el instalador indique API habilitada
- **Decisión**: No procesar catálogo, ventas, stock ni backlog de Sa Vida hasta que `http://80.32.137.41:8984/api/export-master/?filter=Families` y `Products` devuelvan HTTP 200/XML desde fuera.
- **Razón**: La revalidación profunda posterior al aviso del instalador sigue devolviendo HTTP 501 con el mensaje literal de Agora `La integración a través del API HTTP no está habilitada.` El mismo método funciona en Kava, Cienvinos y Baco, y Sa Vida devuelve 501 antes de validar token, por lo que reactivar colas solo generaría más fallos.
- **Alternativa descartada**: asumir que el módulo está correcto por confirmación verbal/local y limpiar o reintentar el backlog. Si el puerto público apunta a otra instancia o el servicio no recargó configuración, se reabrirían miles de tareas fallidas sin posibilidad de éxito.

---

## 2026-06-04 · Reparación mínima de flota Agora sin tocar stock, precios ni legacy operativo
- **Decisión**: Corregir solo lo que era claramente reversible y verificado: activar visibilidad de las 8 familias Winerim de Cienvinos, resetear breakers obsoletos en conexiones Agora que responden HTTP 200, marcar capacidades `READY/XML_IMPORT/YES` en esas conexiones sanas y bloquear un único `AGORA_HIDE_PRODUCT` de Sa Pedrera que reintentaba con error de duplicado.
- **Razón**: Cienvinos tenía productos correctos pero familias ocultas; era un fallo visual aislado y reversible. Los breakers antiguos eran ruido de monitorización tras comprobar salud real. En Sa Pedrera, el modo híbrido/legacy exige frenar reintentos de ocultación si Agora devuelve duplicados, porque alterar ese layout sin revisión puede romper la operativa del cliente.
- **Alternativa descartada**: reintentar o cerrar en masa todas las tareas `FAILED/BLOCKED` antiguas y tocar productos legacy. Ese camino habría reducido ruido de panel, pero con riesgo de ocultar productos que todavía se venden, reabrir duplicados o dar por resuelto stock no probado.

---

## 2026-06-04 · Auditoría de flota no invasiva y sin declarar "todo sano" en bloque
- **Decisión**: Tratar la revisión del 2026-06-04 como auditoría read-only: documentar hallazgos y próximos pasos, pero no reparar Cienvinos, Sa Pedrera, breakers ni mappings en la misma pasada sin validación específica.
- **Razón**: La auditoría encontró estados delicados que pueden ser intencionados o sensibles para operación real: Baco en rollback legacy, Sa Pedrera híbrida legacy/regional, Cienvinos con familias Winerim ocultas y varios clientes con auto-push pausado por seguridad. Tocar esos estados en bloque podría romper pantallas que el cliente usa hoy.
- **Alternativa descartada**: aplicar reparaciones automáticas inmediatas y comunicar la flota como completamente operativa. Habría riesgo de reabrir duplicados visuales, ocultar legacy necesario o prometer stock/Historial Winerim sin prueba real por conexión.

---

## 2026-06-01 · Auto-push de catálogo Agora debe ser diferencial antes de reactivar `auto_push_verified_ready`
- **Decisión**: Cambiar `winerim-proxy fetch-catalog` para que el auto-push solo evalúe vinos nuevos/no publicados o vinos con cambios reales en campos visibles (`name`, tipo, región, activo, copa y precios por formato), en vez de reencolar todo el lote procesado.
- **Razón**: Katsu, Kava, La Candela, Luruna y Sa Pedrera tienen `auto_push_on_update=true`; reactivar `auto_push_verified_ready` con el runtime anterior habría podido reimportar lotes completos en cada cron, cargando Agora y reabriendo riesgo visual.
- **Alternativa descartada**: reactivar ya las cinco conexiones porque `agora-proxy preview-xml` está corregido. Aún faltaba confirmar `winerim-proxy` desplegado, que es quien decide cuándo encolar updates automáticos.

## 2026-06-01 · Mantener pausado el auto-push verificado hasta redeploy real de Lovable Cloud
- **Decisión**: Dejar `auto_push_verified_ready=false` en Katsu, Kava, La Candela, Luruna y Sa Pedrera hasta que Lovable Cloud ejecute el commit `a180c6c` y `fetch-catalog` devuelva `autoPushResult.reason=no_catalog_changes_detected` o `autoPushResult.differential=true`.
- **Razón**: La prueba live tras el push seguía devolviendo `auto_push_not_verified_no_manual_import_success_yet`, señal del runtime anterior. El estado seguro es que los productos ya publicados funcionen, pero que no se generen nuevos updates automáticos hasta redeploy.
- **Alternativa descartada**: activar la automatización completa inmediatamente. Podía romper lo que acababa de quedar reparado.

## 2026-06-01 · Reparar Cienvinos y desalineaciones residuales sin borrar histórico
- **Decisión**: Reparar por XML los productos Winerim publicados de Cienvinos, Katsu y Sa Pedrera para que queden `UseAsDirectSale=false`, `SaleableAsMain=true` y preparación coherente, conservando IDs y ventas históricas.
- **Razón**: Cienvinos seguía con 428 productos Winerim como botones raíz; Katsu y Sa Pedrera tenían un producto verificado residual fuera de contrato. Borrar/recrear habría roto referencias, mappings e histórico.
- **Alternativa descartada**: dejarlo a que lo corrigiera el siguiente auto-update. El auto-update completo todavía depende del redeploy diferencial de `winerim-proxy`.

## 2026-06-01 · No prometer "Historial de ventas" Winerim como venta creada por API
- **Decisión**: Documentar que el flujo implementado descuenta stock Winerim por `PUT /api/v2/stock/{stockId}` y guarda historial canónico en Lovable Cloud; no existe en el código actual un POST de venta hacia Winerim.
- **Razón**: La documentación local Winerim API v2 disponible solo documenta endpoints de stock para este caso. Decir que se crea una venta en el Historial de ventas de Winerim sería asumir comportamiento no verificado.
- **Alternativa descartada**: afirmar que el Historial de ventas de Winerim queda garantizado solo porque el stock baja. Puede ser cierto si Winerim registra movimientos de stock como historial, pero hay que validarlo con Winerim o con su UI.

---

## 2026-05-18 · Desactivar cron `agora-dispatch-restore-stock` y eliminar `restore-stock` del dispatcher
- **Decisión**: `cron.unschedule('agora-dispatch-restore-stock')` (jobid 12) y eliminar el case `"restore-stock"` del `agora-cron-dispatcher` + del tipo `DispatchBody`. La acción `restore-glass-overdiscount` sigue existiendo en `agora-proxy` pero solo se puede invocar manualmente.
- **Razón**: El cron corría cada 5min con `apply: true` y reescribía el stock de Winerim en Sa Vida como `max(0, baseline - allHistoricalSales)`, dejando a 0 los vinos más vendidos cada vez que el cliente los reponía manualmente. Era una herramienta one-shot programada por error como recurrente.
- **Alternativa descartada**: subir el TTL del baseline o filtrar por fecha — sigue siendo destructivo para ajustes manuales del cliente.

---

## 2026-05-18 · Agora Kava no expone ventas en tiempo real → mantener flujo diario + proponer doble cierre
- **Decisión**: Confirmar que la versión de Agora desplegada en Kava SOLO devuelve datos por `/api/export/?filter=Invoices` (tras cierre de caja). Los filtros `Tickets`, `Orders`, `OpenInvoices`, `Receipts` devuelven HTTP 500. Mantener `auto-sync-sales` con scan hasta D-1 y proponer al cliente realizar doble cierre (comida + cena) para tener visibilidad 2 veces/día.
- **Razón**: No existe endpoint público en esta versión de Agora para tickets en curso. Forzar SQL directo al servidor del cliente requiere abrir puertos y rompe el contrato API-only.
- **Alternativa descartada**: (a) acceso SQL Server directo al backend de Agora — alto riesgo operativo y de seguridad; (b) polling especulativo de filtros no documentados — ya probado, devuelve 500.

---

## 2026-05-05 (tarde) · Extraer resiliencia a `_shared/resilience.ts`
- **Decisión**: Mover `fetchWithRetry`/`classifyPosError`/`applyCircuitBreaker` (originales en agora-proxy) a un módulo compartido + añadir `isConnectionPaused` y `preflightCheck`.
- **Razón**: Necesario para extender el patrón a BDP, Revo, Toast, Numier, ICG sin duplicar código.
- **Alternativa descartada**: copiar las funciones en cada proxy (deuda técnica inmediata).

## 2026-05-05 (tarde) · Aplicar SOLO guard de breaker en los 5 proxies (no reemplazar todos los fetch)
- **Decisión**: Añadir `isConnectionPaused` al inicio de cada handler. No reemplazar las llamadas `fetch(...)` internas todavía.
- **Razón**: Cubre el 80% del beneficio (cortar tráfico a un POS pausado) con cambio mínimo y reversible. Reescribir todas las llamadas en 6.3k LOC en una sola sesión es alto riesgo.
- **Alternativa descartada**: refactor masivo de cada proxy para usar `createResilientFetch` (queda como P1 siguiente).

## 2026-05-05 (tarde) · Pre-flight solo en jobs que tocan POS del cliente
- **Decisión**: En `agora-cron-dispatcher` añadir `GET /api/` con timeout 5s solo para `outbound-queue`, `sales-stock`, `restore-stock`. `catalog` queda sin filtro.
- **Razón**: `catalog` también sincroniza Winerim (no solo Agora); aunque el POS esté caído, el lado Winerim debe correr.
- **Alternativa descartada**: pre-flight en todos los jobs.

## 2026-05-05 (tarde) · Panel de salud genérico (no específico de Agora)
- **Decisión**: `ConnectionHealthPanel` recibe solo `connectionId`. Misma componente reutilizable para todos los providers.
- **Razón**: La Capa 3 ya marca a los 5 proxies con la misma semántica de breaker → un panel sirve para todos.
- **Alternativa descartada**: panel específico de Agora (no escalaba al resto).



## 2026-05-05 · Adoptar protocolo de 4 documentos de sesión
- **Decisión**: Trabajar con `PROJECT_CONTEXT.md`, `CURRENT_STATE.md`, `DECISIONS_LOG.md`, `NEXT_STEPS.md` como fuente de verdad. Leerlos al inicio y actualizarlos al cierre de cada sesión.
- **Razón**: Evitar asumir estado no documentado entre sesiones; trazabilidad de decisiones.
- **Alternativa descartada**: confiar solo en memoria del agente (`mem://`) — útil pero no transparente para el humano.

## 2026-05-05 · Cache de `/api/export-master/?filter=Products` (60s TTL)
- **Decisión**: Toda lectura del catálogo Agora pasa por `fetchAgoraProductsXmlCached`.
- **Razón**: Cada tarea de write descargaba ~1MB del XML para verificar → saturaba el SQL pool del cliente (Luruna).
- **Alternativa descartada**: subir el TTL más alto — sacrifica frescura tras escrituras.

## 2026-05-05 · Sistema de resiliencia multicapa para Agora
- **Decisión**: Implementar capas 1 (rate limiter 2 req/s), 2 (clasificador + circuit breaker), 3 (cron rescate zombies). Posponer capas 4 (health-check) y 5 (dashboard).
- **Razón**: Las 3 primeras eliminan el modo de fallo crítico (saturación POS + cola atascada). Las otras dos son QoL.
- **Alternativa descartada**: pausar manualmente las conexiones — no escalable.

## 2026-05-05 · Cleanup masivo de tareas (Sa Vida / Sa Pedrera / Kava)
- **Decisión**: Marcar tareas con "Connection refused" / >10 intentos como `BLOCKED`; zombies `RUNNING >15min` como `FAILED`.
- **Razón**: 11.879 tareas FAILED bloqueaban diagnóstico y consumían reintentos.
- **Alternativa descartada**: dejarlas — generaba ruido permanente.

## 2026-05-05 · Confirmar que las IPs AWS del informe del cliente son nuestras Edge Functions
- **Decisión**: Asumir responsabilidad y arreglar (no esquivar).
- **Razón**: Coincidencia con rangos de Supabase Edge Functions; patrón de carga coherente con nuestro proxy.

---

## 2026-05-26 · Registrar auditoría como revisión no invasiva antes de tocar stock/colas/seguridad
- **Decisión**: Documentar los hallazgos P0/P1 y dejar las acciones en `NEXT_STEPS.md`, sin aplicar cambios funcionales en esta misma pasada.
- **Razón**: Los hallazgos principales afectan deducción absoluta de stock, idempotencia, colas outbound y seguridad de datos. Son áreas críticas que requieren cambios pequeños, migraciones revisadas y pruebas de regresión antes de desplegar.
- **Alternativa descartada**: aplicar varios hotfixes en bloque durante la auditoría. Aumentaría el riesgo de romper flujos que hoy están funcionando en clientes reales.

## 2026-05-26 · Priorizar bugs de stock/idempotencia y contrato Agora antes de continuar mejoras P1
- **Decisión**: Añadir una sección P0 específica de auditoría en `NEXT_STEPS.md`, por encima de la extensión de Capa 3 a otros proxies.
- **Razón**: La resiliencia P1 sigue siendo importante, pero los problemas detectados pueden causar deducciones incorrectas, tareas duplicadas o incumplimiento de reglas duras ya acordadas.
- **Alternativa descartada**: mantener el backlog anterior sin reordenar; ocultaría riesgos más urgentes detrás de mejoras de infraestructura.

## 2026-05-26 · Incorporar documentación local Winerim API Token v2 como referencia, validando bulk contra producción
- **Decisión**: Registrar `/Users/GOIKO/Downloads/API_TOKEN_V2_DOCUMENTATION.html` como referencia técnica local para Winerim API v2, pero no activar automáticamente `stock/bulk` hasta probarlo con una conexión real.
- **Razón**: El HTML documenta `POST /wines/bulk` y `PUT /stock/bulk`, además de confirmar stock por variante con `erpStock.id`; sin embargo, el estado previo del proyecto indica que `stock/bulk` devolvía HTML/login en producción.
- **Alternativa descartada**: migrar directamente el flujo de stock a bulk solo porque el HTML lo documenta. El riesgo es dejar actualizaciones parciales sin trazabilidad suficiente o romper una integración que hoy funciona con PUT individual.

## 2026-05-26 · Hacer el P0 de stock con compatibilidad legacy y rollback explícito
- **Decisión**: Añadir idempotencia por línea/variante (`idempotency_key`) y mantener un guard de compatibilidad que respeta logs `SUCCESS` antiguos sin clave.
- **Razón**: Sin compatibilidad, reejecutar días históricos podría descontar dos veces ventas ya sincronizadas antes de la migración. La prioridad es no romper stock que ya funciona.
- **Alternativa descartada**: backfill agresivo de claves sobre logs antiguos. No hay suficiente información en todas las filas antiguas para reconstruir línea/variante sin ambigüedad.

## 2026-05-26 · Mantener `auto-sync-sales` en comportamiento efectivo D-1 y eliminar rama intradía muerta
- **Decisión**: Eliminar la segunda rama `auto-sync-sales`, que era inalcanzable, y conservar el flujo efectivo actual de días cerrados.
- **Razón**: Kava solo expone `Invoices` post-cierre y activar intradía sin verificación puede reabrir deducciones parciales o inconsistentes.
- **Alternativa descartada**: activar hoy intradía globalmente. Queda para una feature flag por conexión tras pruebas reales.

## 2026-05-26 · Añadir claim atómico con fallback para colas outbound
- **Decisión**: Crear `claim_outbound_tasks(...)` con `FOR UPDATE SKIP LOCKED` y usarlo en colas Agora/Revo, manteniendo fallback al selector anterior si la función no existe aún.
- **Razón**: Evita que dos invocaciones procesen la misma tarea a la vez sin bloquear despliegues donde la migración todavía no se haya aplicado.
- **Alternativa descartada**: cambiar todos los procesadores a RPC sin fallback; habría roto entornos si se desplegaban funciones antes que migraciones.

## 2026-05-26 · Bloquear escrituras de `restore-glass-overdiscount` salvo flag explícito
- **Decisión**: `restore-glass-overdiscount` queda dry-run por defecto; `apply=true` solo escribe si se añade `allowLegacyFractionalRestore=true`.
- **Razón**: La acción conserva lógica fraccional antigua y puede sobrescribir stock real del cliente. El bloqueo reduce riesgo sin borrar la herramienta de emergencia.
- **Alternativa descartada**: eliminar la acción por completo; podría ser útil para diagnóstico histórico mientras se reescribe variant-aware.

## 2026-05-26 · Auditar front Agora sin aplicar cambios funcionales inmediatos
- **Decisión**: Registrar hallazgos del front Agora en `CURRENT_STATE.md` y tareas P0/P1 en `NEXT_STEPS.md`, sin tocar todavía UI/backends asociados.
- **Razón**: Varios hallazgos afectan flujos operativos sensibles (guardado manual de ventas, stock, publicación de catálogo, visibilidad en TPV). Aplicarlos en bloque podría cambiar comportamiento que usan clientes reales.
- **Alternativa descartada**: corregir navegación, stock manual, magnum y visibilidad en una misma pasada. Se prioriza una secuencia pequeña y verificable, con rollback sencillo por cada cambio.

## 2026-05-26 · Cursor Agora condicionado a stock confirmado
- **Decisión**: `save-sales` y `auto-sync-sales` solo avanzan `last_business_day_synced` cuando el stock Winerim del día termina sin fallos. Si stock falla, el cursor queda atrás y el cron reintenta.
- **Razón**: Antes se podían guardar ventas y avanzar cursor sin descontar stock, obligando a intervención manual. El objetivo operativo es que cada cliente Agora funcione solo con cierres de caja.
- **Alternativa descartada**: mantener `Save to DB` como acción solo de persistencia. Es más cómodo para depurar, pero deja una vía real para saltarse stock.

## 2026-05-26 · Catch-up idempotente de stock para días ya guardados
- **Decisión**: `auto-sync-sales` revisa días recientes ya guardados con líneas de vino resueltas y ejecuta `syncStockForDay`, que salta lo ya sincronizado.
- **Razón**: Corrige casos históricos donde el cursor pudo avanzar antes de confirmar stock. La ejecución es barata cuando todo está ya en `SUCCESS` porque no llega a llamar a Winerim.
- **Alternativa descartada**: crear un cron nuevo separado para “stock pending”. Añade superficie operativa y configuración; se puede extraer más adelante si crece el volumen.

## 2026-05-26 · Guard anti doble-descuento por evento/vino/variante
- **Decisión**: además de `idempotency_key` por línea/variante, `syncStockForDay` considera sincronizado cualquier grupo `sales_event_id + winerim_product_id + variant` con `SUCCESS` previo.
- **Razón**: Las ventas se re-guardan borrando/reinsertando `sales_line_items`; los IDs de línea cambian y una clave solo por línea permitiría descontar dos veces al reejecutar un día.
- **Alternativa descartada**: recalcular deltas si un ticket cerrado cambia. Es más exacto en teoría, pero abre riesgo de doble deducción; para Agora post-cierre se asume ticket cerrado estable.

## 2026-05-26 · Activar MAGNUM en acciones principales de Agora
- **Decisión**: Preview/push/backfill principales envían `MAGNUM` junto a `BOTTLE` y `GLASS`.
- **Razón**: Backend y Winerim API v2 ya soportan variante magnum; dejarla fuera de los botones principales hacía que un formato “listo” no se automatizara.
- **Alternativa descartada**: añadir un toggle nuevo `write_magnum` ahora. Requiere migración/configuración extra; el backend ya valida por precio y elegibilidad, así que el riesgo funcional es bajo.

## 2026-05-26 · Mappings manuales deben declarar formato
- **Decisión**: `AgoraManualMatchPanel` permite elegir `BOTTLE`/`GLASS`/`MAGNUM` y deriva una propuesta inicial del nombre del producto Agora.
- **Razón**: Guardar siempre `BOTTLE` hacía ambiguas las ventas manualmente mapeadas de copa o magnum.
- **Alternativa descartada**: inferir siempre en backend sin mostrarlo. La inferencia por nombre es útil, pero debe ser visible/corregible por el operador.

## 2026-05-26 · Test de conexión sin basura operativa
- **Decisión**: las filas creadas durante `testConnection` nacen deshabilitadas y se eliminan si el test falla.
- **Razón**: Evita conexiones inválidas “New Location” que podrían aparecer en listados o diagnósticos.
- **Alternativa descartada**: crear un action backend que pruebe credenciales sin `connectionId`. Es más limpio, pero requiere reordenar el contrato del proxy; la limpieza en fallo es menor cambio y reversible.

## 2026-05-26 · Extraer reglas críticas de stock a utilidades puras testeables
- **Decisión**: mover la clave estable de grupo y la decisión de avance de cursor a `_shared/stockSyncUtils.ts`, con tests unitarios.
- **Razón**: Son reglas de seguridad operativa: no descontar dos veces y no avanzar cursor si stock falla. Deben quedar verificadas fuera del flujo completo de Edge Function.
- **Alternativa descartada**: dejar la lógica inline solo en `agora-proxy`. Funciona, pero dificulta detectar regresiones pequeñas.

## 2026-05-27 · Crear Cienvinos deshabilitado hasta completar despliegue P0
- **Decisión**: Crear la conexión Agora de `Restaurante Cienvinos Ecija` con credenciales reales, pero dejar `enabled=false`, auto-push desactivado y revisión manual obligatoria.
- **Razón**: La conexión y credenciales funcionan, pero Lovable Cloud aún no tiene aplicadas las migraciones de idempotencia variant-aware (`stock_sync_log.variant/stock_id/idempotency_key`) ni `user_roles/has_role()`. Activar cron antes de ese despliegue pondría en riesgo el stock automático.
- **Alternativa descartada**: activar inmediatamente la conexión por tener `test` correcto. El test solo valida alcance/credenciales, no garantiza deducción idempotente de stock ni seguridad de reintentos.

## 2026-05-27 · Backfill directo de stockIds Cienvinos como corrección de metadatos, no de stock
- **Decisión**: Consultar Winerim `GET /api/v2/stock/wine/{wineId}` para los 378 vinos y rellenar `bottle_stock_id`, `glass_stock_id`, `magnum_stock_id` en `winerim_wines`.
- **Razón**: El `winerim-proxy` actualmente desplegado leyó el catálogo, pero no persistió `erpStock.id`; la API real sí devolvió esos IDs. Sin stockIds, el flujo variant-aware no puede descontar la variante correcta.
- **Alternativa descartada**: esperar a una nueva sincronización automática con el proxy desplegado actual. Ya se comprobó que esa versión no capturaba los IDs, así que repetirla no aportaría valor.

## 2026-05-27 · Preparar XML de Cienvinos con familias automáticas deterministas
- **Decisión**: Configurar `auto_create_families=true`, IVA `Reducido` 10%, preparación `BARRA/BEBIDAS`, almacén general y sale centers Barra/Sala/Terraza; validar por `preview-xml` antes de cualquier import real.
- **Razón**: Agora Cienvinos devuelve 0 familias en master data y 3 listas de precio activas. Sin autocreación de familias, el XML quedaría sin una clasificación fiable; con IDs deterministas el resultado es repetible y reversible.
- **Alternativa descartada**: crear manualmente familias desde la interfaz antes de preview. Es más lento y no mejora la seguridad mientras no haya import real.

## 2026-05-27 · No escribir catálogo real en Agora Cienvinos hasta lote piloto verificado
- **Decisión**: Detenerse en preview global correcto (428 productos, 6 familias, 0 IDs duplicados) y no ejecutar `xml-import` todavía.
- **Razón**: Importar 428 productos modifica el TPV productivo. Aunque el XML sea válido, el primer write debe ser un lote piloto pequeño con verificación post-write y plan de rollback.
- **Alternativa descartada**: importar el catálogo completo de una vez. Ahorra tiempo, pero aumenta el impacto si el cliente no quiere todos los sale centers, familias o nombres generados.

## 2026-05-27 · Usar familias dedicadas WINERIM para Cienvinos
- **Decisión**: Crear familias `... WINERIM` dedicadas y mapear todo el catálogo de Winerim a esas familias, en lugar de mezclarlo con familias existentes del cliente.
- **Razón**: Es el despliegue más reversible: permite ver claramente qué productos vienen de Winerim y ocultar/restaurar ese bloque completo sin tocar comida/bebidas.
- **Alternativa descartada**: usar las familias genéricas auto-creadas `Vinos Tinto`, `Vinos Blanco`, etc. Cumplían técnicamente, pero no dejaban tan claro el origen WINERIM pedido por el usuario.

## 2026-05-27 · No ocultar productos previos de Cienvinos que no sean vino real
- **Decisión**: No ocultar los 177 productos preexistentes de Agora Cienvinos, porque no hay familias antiguas de vino y los candidatos por texto eran falsos positivos (`tinto limón`, `copa cerveza`, infusiones/licores).
- **Razón**: Ocultar por heurística habría podido romper bebidas/carta activa del cliente. El objetivo era ocultar vino legacy, no elementos operativos no-Winerim.
- **Alternativa descartada**: ocultar cualquier producto que contuviera palabras como `tinto`, `copa` o `manzanilla`. Esa regla habría sido demasiado agresiva.

## 2026-05-27 · Importar Cienvinos por formato y lotes pequeños
- **Decisión**: Tras fallar el XML global con HTTP 500, importar por formato (`BOTTLE`, `GLASS`, `MAGNUM`) y por lotes pequeños, verificando cada lote contra las 3 listas de precio.
- **Razón**: Agora aceptó los lotes pequeños y permitió aislar errores individuales sin repetir importaciones masivas ni dejar el catálogo a medias.
- **Alternativa descartada**: reintentar el XML global completo. Habría repetido el mismo 500 y aumentado carga sobre el POS.

## 2026-05-27 · Desambiguar nombres duplicados de Winerim con sufijo corto en Agora
- **Decisión**: Importar las 12 botellas duplicadas de nombre con sufijo corto basado en el ID Winerim visible en Agora, restaurando después los nombres originales en el catálogo cacheado local.
- **Razón**: Agora rechaza nombres duplicados aunque el `Id` de producto sea distinto. El sufijo mantiene todos los vinos vendibles sin borrar duplicados de Winerim.
- **Alternativa descartada**: saltar los duplicados o borrar uno de cada par. No era seguro asumir que son duplicados descartables; pueden representar añadas, precios o fichas distintas.

## 2026-05-27 · No activar cron global de Cienvinos hasta completar migraciones P0
- **Decisión**: Mantener `enabled=false` en Cienvinos aunque el catálogo ya esté importado y `provider_capabilities` esté en `READY/XML_IMPORT`.
- **Razón**: En Lovable Cloud aún faltan las columnas variant-aware de `stock_sync_log` y `user_roles/has_role()`. Además, el dispatcher Agora usa `enabled=true` para `catalog`, `sales-stock` y `outbound-queue`; no hay un interruptor seguro para encender solo catálogo sin ventas/stock.
- **Alternativa descartada**: activar Cienvinos inmediatamente por petición operativa. Habría podido lanzar `auto-sync-sales`/colas con idempotencia de stock incompleta.

## 2026-05-27 · Cerrar cola Cienvinos supersedida por import verificado
- **Decisión**: Marcar como `SUCCESS` las 75 tareas `AGORA_XML_UPSERT_PRODUCT` de Cienvinos que seguían `QUEUED`.
- **Razón**: Todas correspondían a botellas ya importadas y registradas como `PUSHED` en `winerim_push_tracking`. Dejarlas pendientes habría reintentado creates antiguos al activar la cola y podía provocar errores por productos ya existentes.
- **Alternativa descartada**: dejarlas en `QUEUED` o pasarlas a `BLOCKED`. `QUEUED` reabría el riesgo de duplicado; `BLOCKED` ensuciaría los paneles con una alarma que ya no requiere acción operativa.

## 2026-05-27 · Sa Vida queda marcada como no conectada pese a credenciales actualizadas
- **Decisión**: Cargar las credenciales nuevas de Sa Vida, pero marcar su capacidad Agora como `UNKNOWN/NOT_CONNECTED/NONE` tras recibir HTTP `501` en endpoints de catálogo y ventas.
- **Razón**: El servidor responde, pero la API REST de Agora no está disponible en los endpoints usados por el middleware. Presentarla como `READY` sería engañoso y fomentaría reintentos de escritura destinados a fallar.
- **Alternativa descartada**: forzar `READY/XML_IMPORT` por tener credenciales nuevas. Las credenciales no bastan si el módulo/API del POS responde `501`.

## 2026-05-27 · Limpiar breakers obsoletos en instalaciones Agora sanas
- **Decisión**: Resetear `consecutive_failures`, `circuit_breaker_paused_until` y `circuit_breaker_reason` en Kava, Luruna y Sa Pedrera tras comprobar endpoints operativos.
- **Razón**: Los breakers estaban caducados y los contadores eran residuo de incidentes anteriores; mantenerlos generaba señales falsas de degradación en paneles y diagnósticos.
- **Alternativa descartada**: esperar a que un flujo futuro los resetee automáticamente. Ya se había comprobado salud básica y el reset manual reduce ruido sin cambiar credenciales ni catálogo.

## 2026-05-27 · Desambiguación automática de nombres duplicados en XML Agora
- **Decisión**: Añadir una utilidad pura para que `generateImportXml` mantenga nombres únicos sin cambios, conserve el nombre al actualizar el mismo `Product Id` y añada sufijo corto determinista solo cuando haya duplicados reales o colisión con otro producto existente.
- **Razón**: Cienvinos demostró que Agora rechaza nombres duplicados aunque el `Id` sea distinto. Resolverlo manualmente funciona una vez, pero auto-push/actualizaciones futuras necesitaban la misma regla para no reintroducir HTTP 500.
- **Alternativa descartada**: sufijar todos los productos siempre. Sería más simple, pero cambiaría nombres que ya funcionan y haría más ruidoso el TPV.

## 2026-05-27 · Crear Baco Getafe deshabilitado y con catálogo controlado
- **Decisión**: Crear `Baco Getafe` en Lovable Cloud con `enabled=false`, importar catálogo Winerim manualmente y no activar cron global.
- **Razón**: La conexión Agora y Winerim funcionan, pero Lovable Cloud sigue sin migraciones P0 de stock idempotente. Activar `enabled=true` lanzaría también ventas/stock y colas automáticas.
- **Alternativa descartada**: activar la conexión al terminar la importación de catálogo. El catálogo está verificado, pero el stock automático aún no tiene la garantía de idempotencia por variante en producción.

## 2026-05-27 · Baco usa familias WINERIM separadas y oculta legado por familia/producto
- **Decisión**: Crear 8 familias WINERIM dedicadas, importar 118 productos Winerim ahí y ocultar las familias legacy `VINO`, `FINOS`, `ROSADOS`, `TINTOS`, `CHAMPAGNE`, `BLANCOS` junto con sus 348 productos.
- **Razón**: Es el despliegue más reversible y cumple la petición de dejar el vino antiguo fuera del TPV sin borrar histórico.
- **Alternativa descartada**: reutilizar las familias legacy existentes. Mezclar nuevo y viejo habría hecho más difícil verificar y revertir.

## 2026-05-27 · Excluir `Personal` y `MUS` de los sale centers Baco
- **Decisión**: Publicar precios en los sale centers `Cafet.`, `Restaurante` y `Terraza`, excluyendo `Personal` y `MUS`.
- **Razón**: Los tres primeros son centros de venta de cliente con price lists activas; `Personal` y `MUS` parecen operativos/internos o especiales. Publicar vinos ahí sin confirmación podría alterar flujos no comerciales.
- **Alternativa descartada**: publicar en los 5 sale centers por defecto. Es más amplio, pero menos conservador.

## 2026-05-27 · Corregir tracking tras timeout de importación Baco
- **Decisión**: Tras un HTTP `546` del `xml-import`, verificar directamente `export-master` y reconstruir `winerim_push_tracking`/`product_mappings` según productos realmente existentes.
- **Razón**: El XML se aplicó en Agora, pero el timeout dejó tracking local con falsos positivos para formatos no exportables. Corregirlo evita que el panel y futuras colas crean que hay 285 formatos publicados cuando solo hay 118.
- **Alternativa descartada**: reintentar la importación global. Habría duplicado carga y podía generar errores por productos ya existentes.

## 2026-05-27 · Desambiguar duplicados Baco temporalmente y restaurar nombres Winerim
- **Decisión**: Importar `Alión` y `Villacardiel` duplicados con sufijo corto en Agora (`M Alión 054`, `B Villacardiel 977`) y restaurar después los nombres Winerim locales originales.
- **Razón**: Agora rechaza nombres duplicados aunque los productos tengan `Id` distinto. El sufijo solo afecta al nombre visible del producto Agora necesario para distinguir variantes/fichas duplicadas.
- **Alternativa descartada**: saltar uno de los duplicados. No era seguro asumir que son equivalentes; en Baco representan productos/precios distintos.

## 2026-05-28 · Publicar cambios P0 en GitHub antes de tocar activación automática
- **Decisión**: Empujar al repo oficial `goiko111/bridge-to-winerim` los cambios P0 ya validados localmente, excluyendo `.env`, mediante el commit `5ecee98` (`Stabilize Agora automation and stock sync`).
- **Razón**: El README del proyecto indica que los pushes a GitHub se reflejan en Lovable. La UI de Lovable Cloud requería login en el navegador integrado, así que GitHub era la vía disponible para dejar código, migraciones, tests y rollback en la fuente oficial sin esperar credenciales.
- **Alternativa descartada**: activar Cienvinos/Baco solo con el catálogo importado. El backend real seguía sin columnas `stock_sync_log.variant/stock_id/idempotency_key` ni `user_roles`, por lo que activar `enabled=true` habría encendido ventas/stock con garantías incompletas.

## 2026-05-28 · No asumir que GitHub aplica DDL en Lovable Cloud
- **Decisión**: Tratar el push a GitHub como publicación de código/migraciones, pero no como prueba de migración aplicada. Se validó contra backend real después del push y las columnas/tablas seguían faltando.
- **Razón**: La seguridad operativa depende del esquema real, no de que los archivos existan en el repositorio. La verificación por REST demostró que `stock_sync_log.variant` y `user_roles` aún no están disponibles.
- **Alternativa descartada**: esperar pasivamente y activar cuando el repo estuviera actualizado. Sin confirmación de DDL y redeploy de funciones, el riesgo de romper stock automático sigue abierto.

## 2026-05-28 · Aplicar migraciones P0 antes de activar conexiones Agora
- **Decisión**: Ejecutar en Lovable Cloud las migraciones `20260526090000_stock_sync_variant_idempotency.sql` y `20260526091000_user_roles_has_role.sql`, verificar columnas/tabla/RPCs contra el backend real y mantener Cienvinos/Baco deshabilitados.
- **Razón**: El stock automático depende de `variant`, `stock_id`, `idempotency_key` y del claim atómico de colas. Activar sin ese esquema podía provocar deducciones ambiguas o reintentos no idempotentes.
- **Alternativa descartada**: activar `enabled=true` tras importar catálogo, confiando en que el código con fallback bastaría. El fallback protege despliegues parciales, pero no es la garantía correcta para clientes productivos.

## 2026-05-28 · Redeploy de Edge Functions tras migraciones y corrección de cambios generados por Lovable
- **Decisión**: Redeployar `agora-proxy`, `winerim-proxy`, `agora-cron-dispatcher` y `revo-proxy` desde Lovable Cloud después de aplicar DDL. Al detectar que Lovable generó cambios en `src/integrations/supabase/types.ts` y un cast menor de UI, revertir esos cambios en fuente porque el protocolo del proyecto prohíbe tocar `src/integrations/supabase/{client,types}.ts`.
- **Razón**: El redeploy era necesario para que el backend ejecutase la lógica P0 actual, pero no justifica romper una regla dura de mantenimiento ni dejar cambios no solicitados en archivos generados.
- **Alternativa descartada**: conservar los tipos actualizados generados automáticamente. Aunque reflejan el nuevo esquema, contradicen la regla explícita del proyecto y pueden introducir churn/confianza falsa en tipos generados.

## 2026-05-28 · No activar automático hasta una venta WINERIM real validada
- **Decisión**: Mantener `enabled=false` en Cienvinos y Baco tras migraciones y redeploy. La siguiente activación requiere una venta/cierre con producto WINERIM resuelto y verificación de `stock_sync_log.variant`, `stock_id`, `idempotency_key` y reejecución sin doble descuento.
- **Razón**: Cienvinos no tiene facturas cerradas recientes y Baco tiene cierres legacy con 0 líneas resueltas contra productos WINERIM. No existe aún una prueba real de deducción de stock por variante en estas instalaciones nuevas.
- **Alternativa descartada**: activar cron global inmediatamente. `enabled=true` dispara catálogo, ventas/stock y cola outbound juntos; sin prueba real de stock, el riesgo operativo sigue siendo innecesario.

## 2026-05-28 · Activar Cienvinos y Baco en producción controlada
- **Decisión**: Tras instrucción explícita del usuario, activar `enabled=true` en Cienvinos y Baco, marcar `auto_push_verified_ready=true`, encender `auto_push_on_create=true`, dejar `auto_push_on_update=false`, y fijar `last_business_day_synced=2026-05-27`.
- **Razón**: Las migraciones P0 y Edge Functions actuales ya están desplegadas, ambas conexiones están `READY/XML_IMPORT`, sin breakers y sin cola abierta. El cursor inicial evita reescaneos históricos inútiles: Cienvinos no tiene facturas cerradas recientes y Baco tiene histórico legacy sin líneas WINERIM resueltas.
- **Alternativa descartada**: dejar ambas conexiones apagadas hasta una venta real WINERIM. Era la postura más conservadora, pero el usuario priorizó que funcionen ya con normalidad; se compensa arrancando desde el último día cerrado y monitorizando el primer cierre nuevo.

## 2026-05-28 · Mantener auto-update de catálogo apagado hasta hacerlo diferencial
- **Decisión**: No activar todavía `auto_push_on_update` en Cienvinos/Baco aunque sí se active el cron general y el auto-create.
- **Razón**: La implementación actual de `fetch-catalog` llama `evaluate-auto-push` con `eventType=UPDATE` para cada lote procesado, no solo para vinos cambiados. Encender `auto_push_on_update` ahora podría reencolar/reimportar muchos productos en cada sincronización de catálogo y cargar Agora innecesariamente.
- **Alternativa descartada**: encender `auto_push_on_update=true` para lograr automatización total inmediata. Es funcionalmente tentador, pero aumenta el riesgo de sobreescrituras masivas y de carga POS; la mejora correcta es detectar cambios reales antes de encolar updates.

## 2026-05-28 · Evitar zombies `RUNNING` en colas Agora por agotamiento de tiempo
- **Decisión**: Modificar los procesadores de cola Agora para no reclamar lotes cuando queda poco presupuesto de ejecución y reencolar cualquier tarea ya reclamada que no llegue a procesarse.
- **Razón**: Durante la activación de Cienvinos, el procesador completó imports correctamente pero dejó tareas en `RUNNING` al agotar tiempo después de reclamar un lote. El resultado operativo era una cola aparentemente atascada sin error real.
- **Alternativa descartada**: esperar al cron de rescate de zombies. Funciona como red de seguridad, pero para clientes nuevos en producción es mejor que el procesador no cree zombies en condiciones normales.

## 2026-05-28 · Preservar capacidades verificadas y usar gates automáticos para vinos recién READY
- **Decisión**: `sync-master-data` no debe degradar `can_write_products=YES` a `UNKNOWN` si ya hubo XML import verificado. Además, los vinos que pasan de pricing incompleto a `READY` se evalúan con `evaluate-auto-push` (`CREATE`) en vez de llamar al encolador manual directo.
- **Razón**: Baco había importado correctamente pero una lectura de master data volvió a mostrar la capacidad de escritura como `UNKNOWN`. El encolado directo de newly-ready también podía saltarse gates como `auto_push_on_create`, `auto_push_verified_ready` o `write_mode`.
- **Alternativa descartada**: corregir solo los valores en base de datos. Arregla la foto puntual, pero no evita que una sincronización futura vuelva a degradar capacidades o encolar fuera de las reglas automáticas.

## 2026-05-28 · Reforzar visibilidad de familias Baco tras reporte visual
- **Decisión**: Forzar `ShowInPos=false` en las familias legacy de vino de Baco (`VINO`, `FINOS`, `ROSADOS`, `TINTOS`, `CHAMPAGNE`, `BLANCOS`) y `ShowInPos=true` en las familias dedicadas `... WINERIM`.
- **Razón**: El vídeo del cliente mostraba productos legacy antiguos en la familia `VINO`. En Lovable Cloud esos productos ya estaban no vendibles, pero varias familias legacy seguían visibles, lo que mantenía ruido visual y podía confundir al equipo de sala.
- **Alternativa descartada**: dejarlo como estaba porque `UseAsDirectSale=false` y `SaleableAsMain=false` ya impedían vender legacy. Técnicamente evitaba cobros, pero no cumplía la petición operativa de que las familias/vinos antiguos desaparezcan del TPV.

## 2026-05-28 · Interpretar `last_sync_at` como último chequeo operativo aunque no haya días pendientes
- **Decisión**: Cambiar `auto-sync-sales` para que actualice `last_sync_at` cuando el POS responde y no hay días cerrados pendientes, sin mover `last_business_day_synced`.
- **Razón**: Baco y Cienvinos estaban sanos y con cursor `2026-05-27`, pero el Sync Monitor mostraba `Never` porque el flujo no escribía `last_sync_at` en el camino "No pending days to sync". Eso confundía activación con fallo operativo.
- **Alternativa descartada**: rellenar `last_sync_at` solo a mano en base de datos. Arregla la foto puntual, pero deja el mismo síntoma en el siguiente cliente nuevo o en cualquier conexión sin cierres pendientes.

## 2026-05-28 · Hacer visible la conexión origen en fallos de `stock_sync_log`
- **Decisión**: Añadir ubicación a la pestaña `Stock Sync` del Sync Monitor.
- **Razón**: La pestaña mostraba las últimas 100 filas globales sin indicar conexión; los fallos de Sa Vida/Sa Pedrera/Kava podían parecer fallos de Baco o Cienvinos.
- **Alternativa descartada**: explicar el origen solo en documentación. La UI debe mostrar la conexión para evitar diagnósticos falsos durante soporte.

## 2026-05-28 · No declarar toda la flota Agora como lista hasta reparar mappings/stockIds antiguos
- **Decisión**: Separar el estado de Baco/Cienvinos (limpios y preparados para primer cierre nuevo) del resto de instalaciones Agora, que aún tienen deuda operativa.
- **Razón**: Sa Vida, Sa Pedrera y Kava tienen fallos reales de stock; Katsu/La Candela/Luruna tienen stockIds incompletos o capacidades inconsistentes. Decir "todo listo" ocultaría riesgos de stock no descontado o reintentos repetidos.
- **Alternativa descartada**: considerar `enabled=true` y token Winerim como suficiente. La preparación real exige cursor, mappings, stockIds por variante, capacidades de escritura y logs sin fallos recientes.

## 2026-05-28 · Tratar fallos terminales de stock Winerim como bloqueados, no reintentables
- **Decisión**: Clasificar `wine not found`, `not accessible` y `Variant '<formato>' not found` como fallos terminales de stock; bloquear su repetición en `syncStockForDay` y marcar logs históricos como `BLOCKED_TERMINAL`.
- **Razón**: Reintentar cada ciclo no corrige un vino inaccesible ni una variante que no existe en Winerim; solo genera ruido en Sync Monitor, alertas falsas y riesgo de no ver fallos nuevos reales.
- **Alternativa descartada**: dejar todos los errores como `FAILED` recuperables. Era más simple, pero mantenía bucles de reintento y mezclaba datos obsoletos con incidencias operativas reales.

## 2026-05-28 · Un mapping `REJECTED` tiene prioridad sobre tracking histórico
- **Decisión**: Cambiar la resolución de ventas Agora para que `product_mappings.REJECTED` bloquee el uso de `winerim_push_tracking` aunque el producto figure como `PUSHED` o `VERIFIED`.
- **Razón**: El tracking demuestra que un producto se creó en Agora, no que el vino/variante siga siendo descontable con el token Winerim actual. Los fallos de Sa Vida/Sa Pedrera/Kava demostraron que tracking histórico podía volver a mapear productos obsoletos.
- **Alternativa descartada**: actualizar solo `product_mappings`. Sin cambiar la prioridad, el mismo producto podía resolverse por tracking y volver a fallar stock.

## 2026-05-28 · Reparar stockIds y mappings por lectura, sin tocar inventario real
- **Decisión**: Ejecutar una reparación controlada con `GET /api/v2/stock/wine/{wineId}` para backfill de `bottle/glass/magnum_stock_id`, rechazar mappings imposibles y limpiar líneas históricas ya rechazadas, sin hacer ningún `PUT /stock`.
- **Razón**: La preparación automática de ventas requiere stockIds por variante y mappings válidos; escribir cantidades de stock durante una reparación de metadata habría sido innecesario y arriesgado.
- **Alternativa descartada**: forzar un re-sync completo de catálogo y ventas. Habría mezclado lectura, escritura y colas POS, aumentando el blast radius cuando el problema concreto era metadata/mapping.

## 2026-05-28 · Respetar `auto_push_on_update=false` desde `winerim-proxy`
- **Decisión**: El enriquecimiento de catálogo solo invoca `evaluate-auto-push` con `eventType=UPDATE` cuando la conexión es Agora y `auto_push_on_update=true`.
- **Razón**: Cienvinos volvió a reencolar updates masivos pese a tener auto-update apagado. La automatización debe crear vinos nuevos, pero no reimportar todo cada día hasta tener detección diferencial de cambios.
- **Alternativa descartada**: limpiar la cola manualmente cada vez que reaparezca. Corrige la foto puntual, pero deja la causa viva en cada ciclo de catálogo.

## 2026-05-28 · Cerrar updates Cienvinos supersedidos solo si ya están publicados
- **Decisión**: Marcar como `SUCCESS` las 82 tareas abiertas de Cienvinos generadas por el runtime antiguo únicamente después de comprobar que todos sus formatos ya estaban `PUSHED` o `VERIFIED` en `winerim_push_tracking`.
- **Razón**: Eran updates `MANUAL` de productos ya importados; procesarlos otra vez habría cargado Agora sin aportar cambios y mantenerlos abiertos hacía parecer que Cienvinos estaba atascado.
- **Alternativa descartada**: borrar las tareas o marcarlas `SUCCESS` sin verificación. Borrarlas pierde trazabilidad; cerrarlas sin comprobar tracking podría ocultar productos realmente pendientes.

## 2026-05-28 · Baco: productos Winerim presentes pero no direct-sale
- **Decisión**: Esta decisión queda corregida por la decisión siguiente. El intento de forzar `UseAsDirectSale=true` resolvía botones directos, pero provocaba duplicado visual en la pantalla raíz.
- **Razón**: En Agora, `UseAsDirectSale=true` no significa solo "vendible"; significa que el producto aparece también como venta directa fuera de su familia. La vendibilidad dentro de familia depende de `SaleableAsMain=true`.
- **Alternativa descartada**: mantener `UseAsDirectSale=true`. El cliente confirmó duplicidad visual: los vinos aparecían dentro de `TINTOS WINERIM` y también abajo en la pantalla principal.

## 2026-05-28 · Baco: quitar duplicados raíz manteniendo venta dentro de familia
- **Decisión**: Dejar los 118 productos Winerim de Baco con `UseAsDirectSale=false` y `SaleableAsMain=true`.
- **Razón**: Así desaparecen los botones duplicados de la pantalla principal y los vinos siguen vendibles cuando se entra en su familia WINERIM (`TINTOS WINERIM`, `BLANCOS WINERIM`, `COPAS WINERIM`, etc.).
- **Alternativa descartada**: reimportar catálogo completo o ocultar productos. Reimportar era innecesario y ocultar productos rompería la venta dentro de familia.

## 2026-05-29 · Baco: no crear `C Tamaral Crianza` sin variante copa en Winerim
- **Decisión**: No crear manualmente un producto `C Tamaral Crianza` en Agora mientras Winerim no exponga una variante copa para el vino correspondiente (`Tamaral`/Crianza).
- **Razón**: En Winerim, la copa publicada es `Tamaral Roble` (`C Tamaral Roble (RIBERA)` en `COPAS WINERIM`). El vino `Tamaral` no tiene `glass_sale_price` ni `glass_stock_id`, por lo que crear una copa manual rompería la trazabilidad y el descuento de stock por variante.
- **Alternativa descartada**: renombrar `C Tamaral Roble` a `C Tamaral Crianza` o crear un producto alias. Podría resolver la queja visual, pero introduciría una equivalencia de negocio no confirmada y stock posiblemente incorrecto.

## 2026-05-29 · Generar Winerim en Agora como vendible dentro de familia, no como botón raíz
- **Decisión**: Cambiar `generateImportXml` para emitir `UseAsDirectSale=false` y `SaleableAsMain=true` en productos Winerim.
- **Razón**: Es la política validada en Baco: evita duplicados en la pantalla raíz y conserva la venta dentro de `... WINERIM`.
- **Alternativa descartada**: mantener el generador con `UseAsDirectSale=true` y corregir manualmente cada cliente. Eso reintroduciría duplicados en futuras reimportaciones o nuevos clientes Agora.

## 2026-05-29 · Revertir Baco Getafe a catálogo legacy sin borrar Winerim
- **Decisión**: Revertir operativamente Baco Getafe a su catálogo legacy: ocultar familias/productos Winerim, restaurar familias legacy, dejar vendibles los productos legacy activos, mantener no vendibles los legacy ya borrados y desactivar la automatización Winerim de esa conexión.
- **Razón**: El cliente reportó problemas operativos tras la integración Winerim. La vía más segura era quitar Winerim de la pantalla y devolver la operativa conocida sin eliminar histórico ni productos creados, dejando una ruta reversible si se decide reactivar Winerim más adelante.
- **Alternativa descartada**: borrar productos/familias Winerim o seguir ajustando nombres/visibilidad sobre la marcha. Borrar perdería trazabilidad y complicaría una vuelta atrás; seguir corrigiendo sobre producción mantenía al cliente en una operativa que ya había pedido revertir.

## 2026-05-29 · Baco legacy debe vender dentro de `VINO`, no como venta directa
- **Decisión**: Corregir el rollback de Baco para dejar todos los productos legacy de vino con `UseAsDirectSale=false`, mantener `SaleableAsMain=true` solo para los productos legacy esperados y colgar `FINOS`, `ROSADOS`, `TINTOS`, `CHAMPAGNE` y `BLANCOS` bajo la familia raíz `VINO`.
- **Razón**: El cliente confirmó que el estado anterior no tenía cinco pantallas de vinos en el frontal; los vinos estaban dentro de la categoría `VINO`. En Agora, `UseAsDirectSale=true` crea botones directos en la pantalla principal, que fue justo el problema visible tras el primer rollback.
- **Alternativa descartada**: mantener todos los productos activos como direct-sale. Aunque eran vendibles, rompía la operativa de sala y reactivaba visualmente referencias que el cliente no quería ver en el frontal.

## 2026-06-01 · Auditar integraciones en modo solo lectura antes de tocar colas
- **Decisión**: Generar una checklist operativa por integración (`INTEGRATIONS_CHECKLIST_2026-06-01.md`) con datos reales de Lovable Cloud y no ejecutar limpiezas, reintentos ni cambios de configuración durante esta revisión.
- **Razón**: La flota contiene estados mezclados: algunas conexiones tienen ventas/stock recientes, otras tienen capacidades degradadas o colas históricas. Antes de tocar datos conviene separar diagnóstico, prioridades y acciones seguras.
- **Alternativa descartada**: drenar colas o corregir capacidades durante la auditoría. Habría mezclado observación con mutación y podría ocultar el estado real que se quería revisar.

## 2026-06-01 · Reparar visual Agora sin borrar histórico
- **Decisión**: En Katsu, Kava, La Candela, Luruna y Sa Pedrera, dejar los productos Winerim activos con `UseAsDirectSale=false`, `SaleableAsMain=true` y pareja de preparación configurada.
- **Razón**: `UseAsDirectSale=true` crea botones raíz y desordena la pantalla; `SaleableAsMain=true` mantiene la venta dentro de la familia. Los campos de preparación vacíos explican de forma plausible que algunos vinos no llegasen a barra.
- **Alternativa descartada**: ocultar productos o familias Winerim. Habría quitado ruido visual, pero también podía dejar vinos inaccesibles para sala y romper operativa.

## 2026-06-01 · Sa Pedrera conserva estructura legacy regional
- **Decisión**: En Sa Pedrera, enrutar productos Winerim a familias legacy visibles por región/tipo (`T Rioja Navarra`, `T Ribera C.Leon`, `B Galicia`, `Champagnes`, `MAGNUMS`, etc.) mediante reglas en `provider_config.agora_family_routing_rules`.
- **Razón**: El cliente explicó que antes trabajaban visualmente por regiones; poner todo en `TINTOS WINERIM`/`BLANCOS WINERIM` o dejar botones directos rompe esa memoria operativa.
- **Alternativa descartada**: hacer visibles las familias `... WINERIM` o agrupar solo por tipo. Técnicamente sería más simple, pero no respeta la organización que el cliente usa en tablets.

## 2026-06-01 · Pausar auto-push verificado hasta confirmar redeploy de Lovable Cloud
- **Decisión**: Mantener `auto_push_verified_ready=false` temporalmente en Katsu, Kava, La Candela, Luruna y Sa Pedrera tras la reparación.
- **Razón**: El código corregido está en GitHub (`81c7dbb`), pero el `preview-xml` real de Lovable Cloud seguía generando `UseAsDirectSale=true`. Al reactivar antes del redeploy se creó una carrera `AUTO_UPDATE` que reintrodujo parte del problema visual en La Candela/Katsu.
- **Alternativa descartada**: dejar el automático encendido confiando en el push a GitHub. Sin preview de runtime confirmado, el sistema podía volver a escribir el catálogo con la política antigua.

## 2026-06-01 · No certificar copas sin venta real reciente por conexión
- **Decisión**: Separar el estado "preparado técnicamente" del estado "probado con venta real" para descuentos de copa en Agora.
- **Razón**: Varias conexiones tienen `glass_stock_id` completo y mappings confirmados, pero no tienen ventas recientes de copa en `stock_sync_log`. Kava y parte de Sa Pedrera sí demuestran descuentos de copa reales; Katsu, La Candela, Luruna y Cienvinos requieren venta/cierre de prueba antes de declararlas perfectas.
- **Alternativa descartada**: considerar que tener stockIds y mappings basta para comunicar que "todas las copas descuentan bien". Eso ocultaría el riesgo de una variante/mapping no ejercitado por ventas reales.

## 2026-06-01 · Tratar legacy visible como estado explícito, no como fallo genérico
- **Decisión**: Mantener Baco como legacy por rollback y Sa Pedrera con estructura legacy regional mientras no haya instrucción explícita de ocultarlo; revisar solo los productos directos residuales de Kava/Luruna como posibles excepciones o legacy pendiente.
- **Razón**: En Baco el rollback fue pedido por el usuario y en Sa Pedrera el cliente pidió conservar organización regional. Ocultar legacy sin validar operativa de sala podría romper botones conocidos y referencias que todavía usan.
- **Alternativa descartada**: ocultar de golpe todo producto/familia no-Winerim. Es más limpio a nivel técnico, pero puede alterar la pantalla que los camareros usan y provocar incidencias de servicio.

## 2026-06-01 · Ocultar residuos directos legacy en Kava y Luruna sin borrar productos
- **Decisión**: Ocultar con `SaleableAsMain=false` y `UseAsDirectSale=false` cuatro productos directos no-Winerim: Kava `1000011` / `EL LANCE`; Luruna `1164074` / `COPA ONDALAN TINTO`, `1164081` / `VIUDA DE CLICQUOT ROSADO`, `1164082` / `COPA VIÑA SASTRE CRZ`.
- **Razón**: No tenían tracking ni mapping Winerim, por lo que una venta desde esos botones podía no descontar stock en Winerim. En Kava además existe reemplazo Winerim confirmado para `El Lance 7 Fuentes`.
- **Alternativa descartada**: borrar productos o familias. Ocultar conserva histórico y permite rollback inmediato poniendo esos IDs de nuevo visibles si el cliente confirma que eran excepciones operativas necesarias.

## 2026-06-01 · Sa Pedrera: confirmar solo legacy inequívoco con variante Winerim válida
- **Decisión**: Insertar `38` mappings `CONFIRMED` para productos legacy de Sa Pedrera mediante `LEGACY_SAFE_MATCH`, y dejar fuera los casos ambiguos o sin variante válida.
- **Razón**: Un legacy vendido sin mapping no descuenta stock Winerim, pero un mapping erróneo descuenta el vino equivocado. La fase 1 prioriza matches con nombre fuerte, familia compatible y `stock_id` de la variante disponible.
- **Alternativa descartada**: confirmar automáticamente todos los candidatos del dry-run. Se detectaron falsos positivos (`Roda`, `Tokaji 6 Puttonyos`, `Magnum Marques de Murrieta`) y se corrigieron manualmente dos casos (`MACAN`, `Alba`) antes de escribir.

## 2026-06-02 · Sa Vida: no reactivar tras nueva IP si Agora sigue devolviendo 501
- **Decisión**: Mantener Sa Vida como no operativa aunque la URL esté normalizada a `http://80.32.137.41:8984/`.
- **Razón**: Las pruebas `test`, `Products` y `Families` siguen devolviendo HTTP 501 desde Agora; resetear breaker/capacidades o procesar colas generaría fallos repetidos y podría reactivar writes contra un POS no preparado.
- **Alternativa descartada**: asumir que el cambio de IP resolvía la incidencia y reactivar la conexión. La prueba viva demuestra que el módulo REST/export-master sigue sin responder correctamente.

## 2026-06-04 · Sa Pedrera: no ocultar Winerim duplicado sin filtrar calidad del mapping
- **Decisión**: No aplicar ocultación masiva de los `92` duplicados probables legacy + Winerim en Sa Pedrera hasta separar mappings seguros (`LEGACY_SAFE_MATCH`) de mappings difusos antiguos (`FUZZY`) y revisar los casos sospechosos.
- **Razón**: El total de `product_mappings.CONFIRMED` mezcla productos Winerim importados (`XML_IMPORT`) con legacy real, y algunos `FUZZY` antiguos apuntan a vinos no equivalentes. Usar ese número bruto para ocultar botones podría esconder el producto correcto o dejar un legacy descontando stock de un vino equivocado.
- **Alternativa descartada**: ocultar automáticamente todo producto Winerim que tenga cualquier mapping `CONFIRMED` para el mismo `winerim_wine_id + format`. Sería rápido, pero demasiado arriesgado en un servicio activo y en una carta organizada visualmente por regiones.

## 2026-06-04 · Priorizar matching por código comercial exacto sobre fuzzy
- **Decisión**: Añadir una capa de matching por código comercial exacto (`CODE_EXACT`) antes del fuzzy: extraer códigos tipo `T31`, `B303`, `G801`, `MAGNUM21` desde nombres Winerim y etiquetas Agora generadas (`B T31-...`, `C B303-...`).
- **Razón**: Sa Pedrera usa códigos correlativos en Winerim y los productos publicados en Agora conservan esos códigos. Cuando existe código, es una señal más fiable que similitud de nombre.
- **Alternativa descartada**: seguir confiando primero en fuzzy. Ya se observaron falsos positivos de fuzzy antiguos; el código exacto reduce riesgo de descontar stock del vino equivocado.

## 2026-06-04 · No interpretar números en nombres como códigos
- **Decisión**: Exigir separador de código (`-`) para extraer códigos; ejemplos válidos `G801-Papirusa`, `B T31-Semele`, `MAGNUM 21 - Finca La Montesa`; ejemplos no válidos `Magnum 4 Kilos`, `As 2 Ladeiras`, `200 Monges Rioja`.
- **Razón**: En la carta de vinos hay números que forman parte del nombre comercial. Interpretarlos como código produciría matches gravemente incorrectos, como mapear `Magnum 4 Kilos` a `MAGNUM 4 - Viña Mein Blanco`.
- **Alternativa descartada**: extraer cualquier prefijo letra+número o palabra+número. Parecía aumentar cobertura, pero el primer dry-run demostró falsos positivos peligrosos.

## 2026-06-04 · Sa Pedrera: piloto de dulces acotado a `D701-D709`
- **Decisión**: Publicar solo `D701-D709` en la familia Agora existente `903925`, renombrándola/mostrándola como `DULCES WINERIM`, sin tocar el resto de la estructura legacy regional.
- **Razón**: El cliente quiere validar si el orden por código Winerim resuelve el problema visual antes de aplicar cambios amplios en Sa Pedrera. Reutilizar la familia existente evita duplicar familias y limita el rollback.
- **Alternativa descartada**: reordenar/ocultar de golpe toda la carta legacy o todas las familias Winerim. El riesgo operativo es alto porque Sa Pedrera trabaja con memoria visual regional y todavía está validando qué quiere conservar.

## 2026-06-04 · Sa Pedrera: no crear formatos no activos en Winerim
- **Decisión**: Incluir copas dulces solo cuando `serve_by_glass=true`; no crear copa para `D707` aunque haya `glass_sale_price` cacheado, porque Winerim marca ese vino como no servido por copa.
- **Razón**: El stock variant-aware depende de variantes reales. Crear una copa visual no activa puede permitir ventas que Winerim no espera descontar como variante copa.
- **Alternativa descartada**: publicar todos los productos con cualquier precio de copa. Aumenta cobertura visual, pero puede crear botones no autorizados por la configuración real del vino.

## 2026-06-04 · Sa Pedrera: verificar orden visual en tablet antes de escalar
- **Decisión**: Considerar verificada por API la pertenencia/nombre de los 14 productos, pero dejar pendiente la validación visual de orden en tablet.
- **Razón**: En ese momento solo se verificó familia/nombre en `export-master`; no se había comprobado qué atributo controlaba realmente el orden visual de producto en tablet. El XML se envió en orden `D701-D709`, pero la API no demostraba cómo lo presentaría la tablet.
- **Alternativa descartada**: asumir que el orden de envío o `SortOrder` funcionaba por el hecho de importarlo. Escalarlo sin prueba visual podía reproducir el problema de desorden.

## 2026-06-04 · Kava: restaurar legacy `GENEROSOS` y `DULCES` sin convertirlo en Winerim
- **Decisión**: Mostrar las familias legacy `GENEROSOS` (`2069`) y `DULCES` (`2070`) y hacer vendibles sus 15 productos dentro de familia, manteniendo `UseAsDirectSale=false`.
- **Razón**: Kava pidió recuperar esas familias legacy para operativa de sala. Hacer solo visible la familia no bastaba porque los productos estaban `SaleableAsMain=false`; activar `UseAsDirectSale=true` habría creado duplicados en pantalla raíz.
- **Alternativa descartada**: inventar mappings Winerim o confirmar mappings fuzzy de baja calidad. La mayoría no tienen mapping confirmado y dos candidatos `PENDING/FUZZY` tenían score muy bajo, por lo que mapearlos podría descontar stock del vino equivocado.

## 2026-06-04 · Sa Pedrera: controlar piloto de dulces con `Product.Id` determinista
- **Decisión**: En el piloto `DULCES WINERIM`, sustituir los productos basados en `winerim_id` por IDs correlativos `903701-903709`.
- **Razón**: El vídeo del cliente demostró que, con la importación usada entonces, la tablet seguía un orden compatible con `Product.Id`; `SortOrder` no controlaba la posición efectiva.
- **Alternativa descartada**: reimportar los mismos productos cambiando solo `SortOrder`. Ya se había enviado así y el cliente seguía viendo `D707`, `D702`, `D706`, etc.

## 2026-06-04 · Sa Pedrera: un solo botón visible por código en `DULCES WINERIM`
- **Decisión**: Dejar un único producto visible por código `D701-D709`: copa si Winerim tiene `serve_by_glass=true`, botella si no hay copa activa.
- **Razón**: El cliente reportó duplicados porque algunos códigos tenían botella y copa en la misma familia. Para validar el orden y la usabilidad, la familia debe mostrar una sola referencia por código.
- **Alternativa descartada**: mantener B+C juntos en la misma familia. Conserva todos los formatos, pero recrea exactamente el problema visual reportado.

## 2026-06-04 · Sa Pedrera: mantener temporalmente copas dulces dentro de `DULCES WINERIM`
- **Decisión**: No mover ahora las copas `D701-D706` a `COPAS WINERIM`; mantener todo el piloto `D701-D709` dentro de `DULCES WINERIM` y centrarse en validar que queda ordenado.
- **Razón**: El objetivo inmediato del cliente es comprobar si los dulces aparecen ordenados y sin duplicados. Cambiar de familia en este momento introduciría una segunda variable y dificultaría saber si la solución visual funciona.
- **Alternativa descartada**: separar ya por formato (`COPAS WINERIM` para copas y `DULCES WINERIM` para botellas). Puede ser el diseño final correcto, pero se pospone hasta que el cliente valide el piloto ordenado.

## 2026-06-05 · Sa Pedrera: `DULCES WINERIM` debe seguir todos los `D###` activos
- **Decisión**: Ampliar la lógica de `DULCES WINERIM` para publicar todos los vinos activos `D###` de tipo postre/dulce, usando IDs `903xxx` y una única variante visible por código.
- **Razón**: El cliente validó el orden, pero al activar/añadir `D710` y `D716` no aparecían porque el piloto estaba limitado a `D701-D709` y el auto-push general seguía pausado.
- **Alternativa descartada**: reactivar directamente el auto-push general. Sus reglas actuales podrían enviar postres a familias legacy y usar IDs derivados de `winerim_id`, reabriendo el problema visual.

## 2026-06-05 · Sa Pedrera: no reactivar `auto_push_verified_ready` sin verificar redeploy
- **Decisión**: Mantener `auto_push_verified_ready=false` hasta probar en Lovable Cloud desplegado que `sa-pedrera-dulces-winerim-trial` y el generador automático devuelven la nueva lógica dinámica.
- **Razón**: La corrección viva se aplicó por import controlado; activar el gate con runtime antiguo podría publicar futuros cambios con la lógica anterior.
- **Alternativa descartada**: activar el gate inmediatamente después de la importación manual. Resolvería la apariencia de automatismo, pero aumenta el riesgo de romper la pantalla validada si el runtime no está actualizado.

## 2026-06-05 · Sa Pedrera: activar auto-push tras dry-run correcto
- **Decisión**: Activar `auto_push_verified_ready=true` en Sa Pedrera tras confirmar que Lovable Cloud ya ejecuta la acción `sa-pedrera-dulces-winerim-trial` y que el dry-run devuelve `D701-D710` + `D716` con IDs `903xxx`.
- **Razón**: La función viva ya contiene la lógica dinámica y la conexión está limpia: `can_write_products=YES`, `readiness_status=READY`, sin breaker y 0 tareas abiertas.
- **Alternativa descartada**: mantener el gate apagado indefinidamente. Resolvería el riesgo de reimportaciones, pero seguiría impidiendo que altas/cambios reales de Winerim se publiquen automáticamente en Agora.

## 2026-06-08 · Casa Nene: publicar Winerim en familias dedicadas antes de ocultar legacy
- **Decisión**: Crear Casa Nene como instalación `WINERIM_SEPARATE_FAMILIES`, publicar primero todo el catálogo Winerim exportable dentro de familias `... WINERIM`, verificarlo por API y solo después ocultar el legacy de vino.
- **Razón**: El usuario pidió subir Winerim en familias Winerim y ocultar legacy una vez estuviera todo OK. Verificar antes evita dejar al cliente sin carta si falla importación, precios, preparación o visibilidad.
- **Alternativa descartada**: ocultar el legacy antes de importar Winerim. Habría reducido duplicados durante la ventana de trabajo, pero un fallo intermedio habría dejado la operativa de sala sin vinos.

## 2026-06-08 · Casa Nene: importar por formato real, no por todos los formatos posibles
- **Decisión**: Importar Casa Nene en dos operaciones: `277` botellas con `formatTypes=["BOTTLE"]` y `15` magnums con `formatTypes=["MAGNUM"]`; no importar copas.
- **Razón**: Winerim no expone copas activas/preciadas para Casa Nene. Además, el endpoint `xml-import` registra mappings por cada `formatType` solicitado, aunque la validación omita productos inválidos; pedir formatos inexistentes habría creado mappings/tracking de variantes no publicadas.
- **Alternativa descartada**: enviar `BOTTLE`, `GLASS` y `MAGNUM` para todos los vinos. Era más simple, pero podía dejar señales falsas de productos no creados y complicar futuras deducciones de stock.

## 2026-06-08 · Casa Nene: arrancar ventas desde 2026-06-07
- **Decisión**: Activar Casa Nene con `last_business_day_synced=2026-06-07`.
- **Razón**: La integración se puso en marcha el 2026-06-08 y se ocultó legacy después de publicar Winerim. Reprocesar histórico anterior podía intentar descontar ventas legacy ya operadas fuera del flujo nuevo.
- **Alternativa descartada**: dejar el cursor vacío para backfill automático. Podría recuperar ventas antiguas, pero no son una prueba limpia del nuevo catálogo y aumentan el riesgo de descuadres de stock.

## 2026-06-09 · Sa Pedrera pasa a familias Winerim dedicadas sin ocultar legacy
- **Decisión**: Configurar Sa Pedrera con `WINERIM_DEDICATED_FAMILIES` y reglas de routing Winerim para tintos, blancos, rosados, espumosos, fortificados, magnums, copas y dulces, manteniendo visible el legacy regional.
- **Razón**: El cliente valido el enfoque de `DULCES WINERIM` y `TINTOS WINERIM`, pero queria que el resto de familias Winerim quedara ordenado sin perder su estructura legacy. El routing regional anterior reubicaba productos Winerim fuera de las familias dedicadas y deshacia parte del trabajo.
- **Alternativa descartada**: ocultar legacy regional y convertir Sa Pedrera en solo Winerim. Era mas limpio tecnicamente, pero el cliente aun trabaja con memoria visual regional y pidio no romper esa operativa.

## 2026-06-09 · Pausar temporalmente auto-push de catalogo Sa Pedrera
- **Decisión**: Dejar `auto_push_on_create=false` y `auto_push_on_update=false` solo en Sa Pedrera despues de aplicar las familias, manteniendo ventas/stock activos.
- **Razón**: El runtime vivo genero tandas repetidas `AUTO_CREATE` para productos ya verificados, cada una reimportando contra Agora. Pausar el auto-push evita sobrecargar el TPV y protege el estado visual mientras se confirma el despliegue de la guarda idempotente.
- **Alternativa descartada**: dejar el auto-push activo y confiar en que el deploy acabara entrando. Durante la sesion siguieron apareciendo tandas de `63` tareas, asi que era un riesgo operativo real.

## 2026-06-09 · T83 canonico y duplicado estandar no vendible
- **Decisión**: Mantener como productos canonicos de `T83` el `902083` para botella y `984242` para copa; dejar el duplicado `784242` no vendible y su mapping `REJECTED`.
- **Razón**: Agora rechazo crear/renombrar por nombre duplicado y el flujo automatico llego a crear un producto estandar alterado (`B T83- ... 242`). Mantenerlo vendible habria duplicado el vino en pantalla y podria resolver ventas contra el producto incorrecto.
- **Alternativa descartada**: borrar el producto duplicado en Agora. Borrar es mas destructivo y no siempre reversible desde la API; marcarlo no vendible es suficiente para sacarlo de operativa.

## 2026-06-09 · D207 se acepta como tinto real fuera de secuencia T###
- **Decisión**: No ocultar `D207-Domaine Les Bruyeres 'Georges' Crozes-Hermitage` (`675360`) dentro de `TINTOS WINERIM`.
- **Razón**: Winerim lo clasifica como `tinto`, esta activo y tiene precio de botella. Aunque no encaja con el subconjunto ordenado `T###`, ocultarlo podria dejar fuera un vino activo real.
- **Alternativa descartada**: forzar que `TINTOS WINERIM` contenga solo codigos `T###`. Resolveria pureza visual, pero contradice el dato activo de Winerim hasta que el cliente confirme que quiere excluirlo.

## 2026-06-12 · Iniciar migración controlada a Cloudflare sin tocar producción Lovable Cloud
- **Decisión**: Empezar la migración hacia `middleware.winerim.wine` en Cloudflare con una primera pieza no destructiva: Worker `middleware-api`, configuración Wrangler, pantalla `/onboarding` y endpoint `POST /api/onboarding/test` para validar credenciales sin crear conexiones, sin persistir tokens, sin escribir productos y sin ocultar legacy.
- **Razón**: El equipo necesita operar integraciones sin depender de acceso a Lovable y con una interfaz simple para comerciales. Empezar por onboarding/test reduce riesgo porque valida URL/token POS y token Winerim antes de tocar clientes reales, y permite construir staging/canary en paralelo mientras Lovable Cloud sigue siendo producción.
- **Alternativa descartada**: migrar de golpe Edge Functions, crons, colas y clientes productivos a Cloudflare. Aunque acelera la independencia de Lovable, concentraría demasiados riesgos a la vez: DNS, secrets, rate limits, colas, idempotencia, observabilidad y rollback.

## 2026-06-12 · Mantener Postgres gestionado como base principal y no usar D1 para el core transaccional
- **Decisión**: Usar Cloudflare para UI, Workers, Access, colas/crons y dominio, pero mantener Postgres gestionado como base principal del middleware multi-tenant.
- **Razón**: El proyecto depende de relaciones, auditoría, constraints, colas idempotentes, RLS/roles, trazabilidad de ventas y operaciones por `connection_id`. D1 puede ser útil para cachés o configuración periférica, pero no es el reemplazo prudente del core transaccional en esta fase.
- **Alternativa descartada**: rediseñar inmediatamente la base sobre D1. Sería una reescritura innecesaria y aumentaría el riesgo de regresiones en stock, ventas e idempotencia.

## 2026-06-12 · Ajustar onboarding REVO a los requisitos oficiales antes de staging Cloudflare
- **Decisión**: Cambiar la pantalla y el Worker de onboarding para que REVO pida `tenant`, access token Bearer y `client-token`, usando por defecto `https://revoxef.works/api/external` y probando `GET /v2/paymentMethods` con los headers oficiales.
- **Razón**: La API pública de REVO no se valida con una URL/token genéricos: requiere `tenant`, `Authorization: Bearer <token>` y `client-token`. Mantener el probe anterior habría dado falsos negativos y habría confundido al equipo comercial justo en el flujo que queremos simplificar.
- **Alternativa descartada**: mantener un único campo “Token POS” para REVO y resolverlo manualmente después. Es más simple visualmente, pero desplaza el error al equipo técnico y rompe la idea de que comercial pueda dejar una integración lista para revisión sin conocer formatos internos.

## 2026-06-12 · Desplegar solo Worker staging y dejar Pages pendiente de Access
- **Decisión**: Desplegar únicamente `winerim-middleware-api-staging` en Cloudflare Workers, validarlo por `workers.dev` y no desplegar todavía Cloudflare Pages ni producción.
- **Razón**: El Worker inicial no escribe, no guarda tokens y sirve para validar el runtime Cloudflare con bajo riesgo. La interfaz completa debe quedar protegida con Cloudflare Access antes de exponerla en `middleware.winerim.wine` o `staging.middleware.winerim.wine`.
- **Alternativa descartada**: publicar inmediatamente el frontend en Pages. Acelera la revisión visual, pero expondría una interfaz operativa antes de tener cerrada la política de acceso y el dominio de staging.

## 2026-06-12 · No resolver DNS staging sin permiso/registro Cloudflare explícito
- **Decisión**: Mantener `api-staging.middleware.winerim.wine` como tarea pendiente y usar temporalmente `https://winerim-middleware-api-staging.gugocreative.workers.dev` para pruebas controladas.
- **Razón**: Wrangler dejó creada la ruta Worker, pero el host `api-staging.middleware.winerim.wine` no resuelve DNS y la CLI disponible no expone una operación segura de creación de DNS. Crear registros DNS a ciegas podría interferir con la zona `winerim.wine`.
- **Alternativa descartada**: crear manualmente un registro DNS desde scripts no versionados o con credenciales implícitas. Es mejor hacerlo desde Cloudflare Dashboard/API con confirmación del registro exacto y dejarlo documentado.

## 2026-06-12 · Subir migración Cloudflare en rama y PR draft, no en `main`
- **Decisión**: Subir `codex/cloudflare-middleware-onboarding` a GitHub y abrir PR draft `#1`, manteniendo `main` sin cambios.
- **Razón**: La rama en `/tmp` no es un lugar persistente suficiente para continuar trabajo crítico. Un PR draft preserva el estado, permite revisión y evita mezclar el scaffold Cloudflare con producción antes de cerrar DNS, Access y pruebas reales.
- **Alternativa descartada**: empujar directamente a `main`. Aunque aceleraría el despliegue, no está justificado porque Pages aún no tiene Access y el dominio staging aún no resuelve.

## 2026-06-12 · Proteger Pages staging con Access, no la API staging todavía
- **Decisión**: Aplicar Cloudflare Access primero sobre `staging.middleware.winerim.wine` y dejar `api-staging.middleware.winerim.wine` sin Access hasta implementar validación explícita de Access/JWT o service tokens en el Worker.
- **Razón**: La UI llama a la API desde navegador. Si se protege la API con Access sin adaptar CORS y validación de tokens, el onboarding fallará aunque la UI esté autorizada. El endpoint actual de API staging no escribe ni guarda tokens, por lo que el riesgo temporal es acotado.
- **Alternativa descartada**: proteger UI y API con Access simultáneamente. Es más cerrado en apariencia, pero rompería el flujo actual o exigiría autenticación técnica adicional que aún no está implementada.

## 2026-06-12 · Añadir headers Pages defensivos sin CSP estricta
- **Decisión**: Añadir `public/_redirects` y `public/_headers` para Cloudflare Pages, con fallback SPA y cabeceras defensivas basicas, pero sin `Content-Security-Policy` estricta.
- **Razón**: El fallback es necesario para que `/onboarding` funcione al abrir URL directa. Las cabeceras basicas reducen riesgo sin afectar al frontend. Una CSP estricta puede romper estilos o librerias si no se audita primero.
- **Alternativa descartada**: activar CSP completa desde el primer despliegue. Es mejor seguridad a largo plazo, pero hacerlo sin inventario de dependencias aumentaria riesgo de una UI rota en staging.

## 2026-06-13 · Usar `compatibility_date=2026-05-03` para que Wrangler local arranque
- **Decisión**: Cambiar `wrangler.middleware.toml` de `compatibility_date=2026-06-12` a `2026-05-03` y ajustar el origen local permitido a `http://127.0.0.1:8084`.
- **Razón**: `wrangler 4.86.0` despliega staging, pero su runtime local no arranca con una fecha posterior a `2026-05-03`. El Worker no usa APIs que dependan de una fecha posterior, y la UI local necesita CORS desde `127.0.0.1:8084`.
- **Alternativa descartada**: mantener `2026-06-12` y dejar el Worker local apagado. La pantalla `/onboarding` cargaria, pero el boton `Probar` fallaria contra `localhost:8787`.

## 2026-06-15 · Resolver URL de API por entorno para evitar Pages roto por env faltante
- **Decisión**: Añadir `src/lib/middlewareApiUrl.ts` y usarlo en `/onboarding`: primero respeta `VITE_MIDDLEWARE_API_URL`, despues resuelve por hostname (`staging.middleware.winerim.wine` / `middleware.winerim.wine`) y finalmente cae a `http://127.0.0.1:8787`.
- **Razón**: En Cloudflare Pages, una variable `VITE_MIDDLEWARE_API_URL` olvidada haria que la UI llamara a localhost. Resolver por hostname hace el despliegue mas tolerante sin exponer secretos ni cambiar runtime.
- **Alternativa descartada**: depender siempre de `VITE_MIDDLEWARE_API_URL`. Es explicito, pero fragil para un flujo que queremos que pueda operar el equipo sin ajustes tecnicos diarios.

## 2026-06-15 · Preparar `onboarding_requests` sin activar escritura ni guardar tokens
- **Decisión**: Versionar la migracion `20260615073500_onboarding_requests.sql` y la utilidad `onboardingRequest.ts`, pero no conectar todavia la UI/Worker a escritura.
- **Razón**: Necesitamos una bandeja de solicitudes para que comercial no dependa de Lovable Cloud, pero guardar tokens en claro o crear conexiones automaticamente seria un salto de riesgo. La tabla guarda solo metadata sanitizada y referencias externas a secretos.
- **Alternativa descartada**: insertar directamente en `pos_connections` desde `/onboarding`. Aceleraria el alta, pero saltaria revision tecnica, dry-run, rollback y protecciones de legacy/mappings.

## 2026-06-15 · No crear Pages ni Secrets Store antes de cerrar Access y modelo de secretos
- **Decisión**: No crear todavia proyecto Cloudflare Pages publico ni Secrets Store real desde Wrangler, aunque la CLI permite gestionar ambas piezas.
- **Razón**: La UI de onboarding debe estar protegida por Cloudflare Access antes de exponerse al equipo, y los tokens POS/Winerim necesitan un modelo claro de referencias opacas antes de persistir solicitudes.
- **Alternativa descartada**: desplegar Pages inmediatamente en dominio temporal o crear un Secrets Store sin contrato de nombres/permisos. Seria rapido para demo, pero aumentaria superficie publica y deuda de seguridad.

## 2026-06-15 · Preparar CORS/credenciales para Cloudflare Access sin activar autenticación propia
- **Decisión**: Hacer que `/onboarding` envie `credentials: "include"` y que el Worker responda CORS con origen permitido, credenciales, `Vary: Origin` y cabeceras `CF-Access-*`.
- **Razón**: Cuando `staging.middleware.winerim.wine` y/o la API pasen por Cloudflare Access, el navegador necesitara enviar cookies/credenciales sin que el preflight bloquee el boton `Probar`. El cambio es reversible y no altera la logica de negocio.
- **Alternativa descartada**: proteger la API con Access antes de adaptar CORS/frontend. Habria dado una sensacion de seguridad, pero podria romper el flujo de onboarding desde el navegador.

## 2026-06-15 · Katsu Izakaya debe matchearse por fases y no en bloque
- **Decisión**: No aplicar mappings legacy en Katsu durante el primer analisis; documentar un dry-run y preparar una fase segura antes de escribir nada.
- **Razón**: El TPV actual permite recuperar mappings legacy, especialmente copas vendidas, pero mezcla productos legacy reales con productos generados por Winerim y existe al menos un mapping confirmado desalineado (`972845`, actualmente `C. SAN SALVADOR GODELLO`, apuntando a `Abad Dom Bueno Godello Esencia`). Un matching masivo podria descontar stock del vino equivocado.
- **Alternativa descartada**: insertar automaticamente todos los matches con score alto. Habria recuperado parte del stock, pero con riesgo de duplicar vino/formato ya confirmado o de propagar mappings antiguos incorrectos.

## 2026-06-15 · Katsu revela que la clasificacion de candidatos de vino infla el monitor
- **Decisión**: Tratar el contador de Katsu como contaminado hasta corregir `isWineCandidate()` para respetar reglas explicitas de familias no-vino y separar `NEEDS_REVIEW` de candidato operativo.
- **Razón**: Katsu tiene `wine_family_rules` marcando `CARTA` y `KATSU LIQUIDO` como no-vino, pero las ventas de comida/bebida siguen entrando como `is_wine_candidate=true` porque el helper usa `DEFAULT_CONFIG` e incluye `NEEDS_REVIEW`. El dato bruto de lineas no mapeadas no representa solo vino.
- **Alternativa descartada**: asumir que las `5242` lineas candidatas no mapeadas son vinos pendientes. El corte real por familias `VINOS` / `VINOS POR COPAS` baja el problema a `299` lineas de vino, con `218` recuperables por `20` productos seguros.

## 2026-06-15 · Jardí Parets queda validado en lectura pero no activado
- **Decisión**: Mantener `Restaurante Jardi` deshabilitado y sin auto-push tras el retest, aunque Ágora y Winerim respondan correctamente.
- **Razón**: La conexion lee ventas, master data y Winerim, pero aun no tiene configurados defaults de escritura, familias destino ni politica visual sobre los `283` productos legacy de vino ya visibles en Agora.
- **Alternativa descartada**: activar automaticamente despues del test. Habria creado riesgo de publicar o sincronizar sin IVA/lista/almacen/sale centers/preparacion/familias confirmadas.

## 2026-06-15 · No usar `detect-capabilities` como veredicto para Agora XML
- **Decisión**: Tratar el resultado de `detect-capabilities` en Agora como diagnostico incompleto cuando la instalacion usa XML import/export.
- **Razón**: En Jardí, `sync-master-data` leyo `export-master` correctamente, pero `detect-capabilities` marco `can_read_catalog=false` porque depende de `connection.catalog_endpoint` y probo endpoints REST que no son el flujo XML real del middleware.
- **Alternativa descartada**: comunicar Jardí como `NOT_CONNECTED` por el estado de `provider_capabilities`. Eso contradice las pruebas reales de `test`, `find-last-business-day`, `sync-master-data` y `fetch-day`.

## 2026-06-15 · Activar Jardí Parets con familias Winerim y legacy visible
- **Decisión**: Publicar Winerim en Jardí usando familias dedicadas `... WINERIM`, activar la conexion y dejar el legacy visible sin borrar ni ocultar nada.
- **Razón**: La lectura de Agora/Winerim, los defaults de escritura, el dry-run XML y el import real quedaron verificados. Se publicaron `168` productos Winerim (`166` botellas, `1` copa y `1` magnum) con mappings confirmados, tracking y `provider_capabilities=READY`. Mantener legacy visible da rollback operativo inmediato si el cliente no valida la pantalla.
- **Alternativa descartada**: ocultar ya las familias legacy de vino. Habria completado el cambio visual, pero sin validacion del cliente aumentaria el riesgo de dejarles sin su operativa anterior.

## 2026-06-15 · Dejar `auto_push_on_update=false` en Jardí hasta corregir vinos solo-copa
- **Decisión**: Activar altas automaticas (`auto_push_on_create=true`) pero mantener actualizaciones automaticas apagadas (`auto_push_on_update=false`) en Jardí.
- **Razón**: Con `auto_push_on_update=true`, las pasadas de catalogo detectan repetidamente `Dulce de Invierno` (`winerim_id=271458`) como `changedWines=1` y generan un update de copa aunque la ficha queda `VERIFIED`. Para proteger el cron y evitar ruido periodico, se prioriza que las altas nuevas suban solas y se deja precio/update automatico pendiente de correccion.
- **Alternativa descartada**: dejar updates automaticos activos porque la cola acababa en `SUCCESS`. Aunque no quedaba cola atascada, repetir updates innecesarios cada cron es deuda operativa y puede molestar a Agora.

## 2026-06-15 · Rollback Jardí = apagar automatismos y ocultar familias Winerim, no borrar productos
- **Decisión**: Documentar rollback de Jardí mediante flags (`enabled=false`, `catalog_sync_enabled=false`, `auto_push_on_create=false`, `auto_push_on_update=false`) y `ShowInPos=false` en familias Winerim si el cliente reporta problema.
- **Razón**: El legacy sigue visible/vendible y no se ha tocado. Ocultar las familias Winerim revierte la pantalla sin perder mappings, tracking ni trazabilidad de lo publicado.
- **Alternativa descartada**: borrar productos/mappings Winerim. Borrar aumenta riesgo de inconsistencias y elimina la idempotencia necesaria para reactivar o reparar.

## 2026-06-15 · Exportar ventas históricas de Jardí con `fetch-day`, no con `save-sales`
- **Decisión**: Para ver ventas de Jardí de los ultimos dos meses sin descontar stock, usar `agora-proxy.fetch-day` y generar CSV locales, sin escribir en Lovable Cloud.
- **Razón**: `save-sales` guarda ventas y tiene logica de cursor/stock con `skipStockSync`; aunque se puede usar con cuidado, no era necesario para el objetivo de analisis y podia dejar ventas historicas preparadas para catch-up de stock si hubiese lineas resueltas.
- **Alternativa descartada**: ejecutar `save-sales` con `skipStockSync=true` y restaurar cursor despues. Es mas cercano al monitor, pero introduce riesgo operativo innecesario para una consulta historica.

## 2026-06-16 · REVO: partner usa su `client-token`; cliente aporta `tenant` y access token
- **Decisión**: Para Tigre / Grupo Costeño, primero confirmar si Winerim ya tiene `client-token`/Integrator Token vigente como partner. Si existe, el alta de cliente debe pedir `tenant` y access token de la cuenta REVO del cliente; el API Request form queda para obtener/renovar/habilitar el `client-token` o registrar la integración si REVO lo exige.
- **Razón**: La documentación oficial de REVO XEF requiere tres headers: `tenant`, `Authorization: Bearer <token>` y `client-token`. El `client-token` corresponde al integrador/partner; el tenant y el access token salen de la cuenta del cliente.
- **Alternativa descartada**: pedir al cliente/distribuidor que nos genere tambien el `client-token`. Mezcla responsabilidades y puede bloquear el alta aunque Winerim ya sea partner.

## 2026-06-16 · Cloudflare onboarding: endpoint de solicitudes apagado por defecto
- **Decisión**: Implementar `POST /api/onboarding/requests` y el boton `Enviar a revisión`, pero mantener el guardado real desactivado por `ONBOARDING_REQUESTS_ENABLED=false` en local, staging y produccion.
- **Razón**: Permite avanzar el control plane fuera de Lovable Cloud con tests, UI y contrato de datos, sin crear conexiones, sin escribir en POS, sin guardar tokens y sin exponer una bandeja operativa antes de tener Cloudflare Access y secrets configurados.
- **Alternativa descartada**: activar ya el guardado de solicitudes en staging. Aceleraria la demo, pero mezclaria dos riesgos pendientes: Access no validado y `LOVABLE_CLOUD_SERVICE_KEY` aun no configurado como secret del Worker.

## 2026-06-16 · Cloudflare onboarding: no guardar secretos ni `secret_refs` hasta decidir storage
- **Decisión**: Guardar solo metadata sanitizada y dejar `secret_refs={}` en la primera version de solicitudes.
- **Razón**: La tabla y el Worker ya bloquean claves sensibles y redaccion de valores conocidos, pero el proyecto aun no ha elegido storage real de tokens multi-tenant. Es mejor perder comodidad temporal que introducir secretos en claro o referencias ambiguas.
- **Alternativa descartada**: guardar tokens cifrados directamente en `onboarding_requests`. Seria util para conversion automatica, pero adelanta una decision de seguridad que debe cerrarse aparte.

## 2026-06-16 · Cloudflare onboarding: revisar solicitudes no equivale a crear conexiones
- **Decisión**: Añadir `GET /api/onboarding/requests`, `PATCH /api/onboarding/requests/:id` y pantalla `/onboarding/requests`, pero limitarlo a listar y cambiar estados de revision.
- **Razón**: El equipo necesita operar un embudo fuera de Lovable Cloud, pero convertir una solicitud en `pos_connections` requiere dry-run tecnico, reglas de legacy, mappings, rollback y aprobacion explicita.
- **Alternativa descartada**: que `APPROVED` cree automaticamente la conexion. Ahorraria clicks, pero saltaria los pasos que evitan romper instalaciones Agora/Revo ya operativas.

## 2026-06-16 · Cloudflare staging desplegado con storage apagado
- **Decisión**: Desplegar `winerim-middleware-api-staging` version `cc726f8e-1047-4888-a8f0-0760a9290f57` con `ONBOARDING_REQUESTS_ENABLED=false`.
- **Razón**: Permite probar health, CORS, validacion y rutas nuevas en Cloudflare real sin activar almacenamiento ni necesitar secretos.
- **Alternativa descartada**: esperar a tener DNS/Access antes de desplegar. Mantendria el arbol mas teorico; desplegar apagado reduce incertidumbre del runtime sin introducir riesgo operativo.

## 2026-06-16 · Smoke test staging versionado
- **Decisión**: Añadir `scripts/verify-cloudflare-staging.sh` y `npm run cf:api:verify:staging`.
- **Razón**: La migracion necesita comprobaciones repetibles por cualquiera del equipo: health, validacion, CORS y storage disabled.
- **Alternativa descartada**: depender de curls manuales escritos en la conversacion. Son faciles de perder y no dejan contrato versionado.

## 2026-06-16 · Cloudflare Access: validar JWT cuando exista app Access real
- **Decisión**: Preparar validacion de `CF-Access-Jwt-Assertion` en el Worker mediante `CF_ACCESS_AUD` y `CF_ACCESS_TEAM_DOMAIN`, pero dejar esas variables sin configurar hasta crear la app Access real.
- **Razón**: El header de email es suficiente solo si confiamos plenamente en que la ruta esta detras de Access. Validar firma/audience dentro del Worker da una segunda defensa para rutas privadas como la bandeja de solicitudes.
- **Alternativa descartada**: activar ya la exigencia JWT sin app Access/DNS. Romperia las pruebas actuales y no aportaria seguridad real hasta tener el Audience Tag correcto.

## 2026-06-16 · Cloudflare staging redeploy con JWT preparado y storage apagado
- **Decisión**: Redeployar `winerim-middleware-api-staging` version `f980c8ec-6cc7-4355-9f3c-38f3affa4aad` manteniendo `ONBOARDING_REQUESTS_ENABLED=false`.
- **Razón**: Deja el runtime listo para Access JWT y mantiene el rollback activo: las rutas privadas existen pero no almacenan nada ni consultan Lovable Cloud.
- **Alternativa descartada**: esperar a DNS/Access antes de redeployar JWT. Desplegar apagado reduce riesgo de integracion posterior.

## 2026-06-16 · Cloudflare onboarding: transiciones de estado explicitas
- **Decisión**: Hacer que `PATCH /api/onboarding/requests/:id` lea el estado actual y aplique una maquina de estados controlada antes de actualizar.
- **Razón**: La bandeja sera usada por equipo comercial/tecnico. Sin transiciones, un error de UI o payload podria marcar una solicitud `CONVERTED` sin pasar por aprobacion real, creando confusion aunque no cree conexion automaticamente.
- **Alternativa descartada**: permitir cualquier estado valido desde cualquier estado. Es mas simple, pero elimina trazabilidad operativa.

## 2026-06-16 · `CONVERTED` como estado terminal manual hasta conversion auditada
- **Decisión**: `CONVERTED` no permite salida y solo se puede alcanzar desde `APPROVED`.
- **Razón**: Hasta que exista un flujo auditado de conversion a `pos_connections`, `CONVERTED` debe ser una marca final posterior a aprobacion, no una accion casual desde la cola.
- **Alternativa descartada**: permitir `READY_FOR_TECHNICAL_REVIEW -> CONVERTED`. Saltaria revision y dry-run.

## 2026-06-16 · Compartir maquina de estados entre UI y Worker
- **Decisión**: Mover las transiciones de `onboarding_requests` a `src/lib/onboardingRequest.ts` y consumirlas desde el Worker y desde `/onboarding/requests`.
- **Razón**: La UI no debe ofrecer acciones que el backend rechaza. Duplicar transiciones en dos sitios aumenta el riesgo de inconsistencias cuando se añadan estados como conversion auditada o vuelta a revision.
- **Alternativa descartada**: mantener la UI con botones genericos y confiar en el HTTP 409 del Worker. Es seguro a nivel backend, pero confuso para el equipo operativo.

## 2026-06-16 · CORS debe cubrir `PATCH` antes de activar la bandeja
- **Decisión**: Incluir `PATCH` en `Access-Control-Allow-Methods` y validarlo en tests y smoke staging.
- **Razón**: La bandeja de solicitudes cambia estados mediante `PATCH /api/onboarding/requests/:id`. Sin preflight `PATCH`, el navegador bloquearia la accion aunque el Worker funcionase.
- **Alternativa descartada**: esperar a detectar el fallo en staging con Access. Corregirlo ahora es de bajo riesgo y evita una falsa averia de la UI.

## 2026-06-16 · Readiness separado del smoke test
- **Decisión**: Añadir `npm run cf:readiness:staging` para distinguir runtime OK de infraestructura pendiente.
- **Razón**: `workers.dev` puede estar sano mientras faltan DNS, Pages o Access. El comando permite ver `0` fallos con pendientes explicitos sin confundirlo con una migracion completada.
- **Alternativa descartada**: ampliar el smoke test principal hasta fallar por DNS/Pages pendientes. Eso bloquearia deploys seguros del Worker aunque la infraestructura externa aun no este creada.

## 2026-06-16 · Documentar Secrets Store sin crear recursos todavia
- **Decisión**: Documentar Cloudflare Secrets Store como opcion, junto a gestor externo y cifrado de aplicacion, pero no crear store ni guardar tokens reales.
- **Razón**: Wrangler muestra Secrets Store como open beta. Antes de usarlo con clientes hace falta cerrar naming, permisos, rotacion y contrato de `secret_refs`.
- **Alternativa descartada**: crear un store staging ya mismo. Seria rapido, pero adelanta una decision de seguridad que todavia no esta cerrada.

## 2026-06-17 · Jardí: no ocultar legacy en bloque tras pre-check
- **Decisión**: Mantener Jardí con familias Winerim visibles y legacy visible, sin ocultar legacy en bloque.
- **Razón**: La auditoría solo lectura confirma que los `168/168` formatos Winerim publicables están publicados en Agora, pero el legacy de vino todavía tiene `281` productos vendibles y solo `103` tienen match automático seguro contra Winerim publicado; `163` no tienen match fiable.
- **Alternativa descartada**: ocultar todo el legacy de vino como en una migración completa. Habría eliminado duplicados, pero también podría ocultar productos que el cliente sigue usando y que no tienen equivalente Winerim claro.

## 2026-06-18 · Jardí: no prometer descuento/historial Winerim mientras las ventas entren por legacy sin mapping
- **Decisión**: Tratar Jardí como catálogo Winerim publicado pero ventas legacy no mapeadas hasta que se haga matching o el cliente venda desde los botones Winerim.
- **Razón**: La auditoría viva muestra ventas importadas hasta business day `2026-06-17`, pero `2386/2386` líneas están `mapped=false` y `stock_sync_log=0`. No consta ningún descuento de stock enviado a Winerim ni una venta registrada como historial Winerim.
- **Alternativa descartada**: decir al cliente que la venta ya descuenta stock o aparece en historial. Sería incorrecto con los datos actuales y ocultaría que el legacy sigue siendo el origen de venta.

## 2026-06-18 · Winerim proxy: registrar `last_catalog_sync_at` al completar catálogo
- **Decisión**: Actualizar `pos_connections.last_catalog_sync_at` cuando `winerim-proxy/fetch-catalog` completa el recorrido de catálogo Winerim.
- **Razón**: Jardí tenía catálogo sincronizado y verificable, pero el monitor podía mostrar `Never/null` porque el proxy no dejaba marca de catálogo completo. La trazabilidad debe reflejar la sincronización real.
- **Alternativa descartada**: dejarlo solo como dato inferido desde `winerim_wines.updated_at`. Dificulta soporte y hace que el equipo comercial/técnico vea falsos negativos en el monitor.

## 2026-06-24 · Casa Nene: activar polling intradía por flag y no global
- **Decisión**: Añadir `sync-intraday-sales` para Agora y hacer que el dispatcher lo invoque solo cuando `provider_config.intraday_sales_sync_enabled=true`.
- **Razón**: Casa Nene necesita que ventas del día descuenten stock sin esperar al cierre. Activarlo por conexión limita el riesgo y mantiene el comportamiento D-1 en el resto de instalaciones Agora.
- **Alternativa descartada**: cambiar globalmente `auto-sync-sales` para procesar siempre el día actual. Podría tocar instalaciones donde `Invoices` no está completo hasta cierre y reabrir problemas de idempotencia.

## 2026-06-24 · Casa Nene: stock intradía por delta idempotente
- **Decisión**: Para ventas intradía, calcular el objetivo por `(sales_event_id, winerim_product_id, variant)` y descontar solo `cantidad_actual - cantidad_SUCCESS_ya_sincronizada`.
- **Razón**: Durante el servicio una factura puede crecer. Reimportar todo el día sin delta duplicaría descuentos; saltar grupos ya sincronizados impediría descontar ampliaciones de factura.
- **Alternativa descartada**: reutilizar tal cual el flujo line-idempotent de día cerrado. Es seguro ante reintentos simples, pero no cubre incrementos de una factura abierta o actualizada.

## 2026-06-24 · Casa Nene: intervención manual documentada antes del redeploy
- **Decisión**: Guardar las ventas del día y corregir manualmente Winerim para las 3 botellas de Valbuxan y 1 Pazo de Señorans detectadas.
- **Razón**: El cliente necesitaba ver el stock corregido ya, y el runtime desplegado todavía no tenía la acción intradía (`Unknown action`).
- **Alternativa descartada**: esperar al siguiente cierre D-1. Habría mantenido el descuadre visible durante el servicio y no resolvía la necesidad operativa inmediata.

## 2026-06-24 · Casa Nene: intradía debe deduplicar por total diario, no por evento
- **Decisión**: Sustituir la comparación intradía basada en `sales_event_id` por una comparación de total diario por `(winerim_product_id, variant)` contra la cantidad `SUCCESS` ya descontada en ese business day.
- **Razón**: En la validación post-deploy, las ventas importadas manualmente tenían IDs de evento antiguos y el runtime recreó eventos con IDs de documento distintos. Comparar por evento interpretó ventas ya descontadas como nuevas. El total diario evita dobles descuentos cuando cambian IDs de factura o cuando se reimporta el día en curso.
- **Alternativa descartada**: mantener `sales_event_id` y limpiar manualmente los eventos antiguos. Eso arreglaría Casa Nene puntualmente, pero dejaría el mismo fallo latente si otra instalación cambia identificadores o si una reimportación genera eventos equivalentes.

## 2026-06-24 · Casa Nene: pausar intradía hasta validar parche total-diario
- **Decisión**: Desactivar temporalmente `intraday_sales_sync_enabled` en Casa Nene, bloquear los logs duplicados del primer test y restaurar solo el descuento duplicado atribuible (`Pazo de Señorans` `192 -> 193`).
- **Razón**: El primer deploy ya ejecutaba la acción nueva, pero todavía podía duplicar deducciones por cambio de IDs. Pausar evita que el dispatcher repita el problema antes del segundo redeploy.
- **Alternativa descartada**: dejar el flag activo y confiar en que el siguiente ciclo no encuentre deltas. Era arriesgado mientras el código vivo seguía usando la comparación por evento.

## 2026-06-25 · Flota Agora: separar conectividad, catalogo, ventas y stock en el status
- **Decisión**: Clasificar cada integracion Agora por capas independientes: sonda viva/conectividad, catalogo Winerim->Agora, ventas Agora->Lovable Cloud, mapeo de lineas y descuento/historial Winerim.
- **Razón**: Varias conexiones responden a la sonda pero no descuentan stock (`La Candela`, `Luruna`), otras tienen catalogo publicado pero no conectividad viva (`Jardi`, `Casa Nene`), y otras estan en read-only por decision (`Don Bernardo`). Decir simplemente "funciona" oculta riesgos operativos diferentes.
- **Alternativa descartada**: usar solo `enabled=true` o `provider_capabilities=READY` como veredicto. Es insuficiente para soporte, porque no demuestra venta mapeada ni `stock_sync_log.SUCCESS` reciente.

## 2026-06-25 · Agora: checklist obligatorio por integracion
- **Decisión**: Usar `AGORA_INTEGRATION_CHECKLIST.md` como protocolo obligatorio para cada alta o cambio importante de una integracion Agora.
- **Razón**: Las integraciones mezclan red, catalogo, legacy visual, mappings, ventas, stock e historico. Sin checklist comun se corre el riesgo de activar automatismos sin rollback, sin venta de prueba o sin confirmar que las copas descuentan en su variante.
- **Alternativa descartada**: seguir resolviendo cada cliente como caso unico. Es flexible, pero no escala con muchos clientes y hace dificil que soporte/comercial sepan que falta para considerar una instalacion lista.

## 2026-06-25 · Katsu: tratar el siguiente paso como ajuste visual, no como reimportacion masiva
- **Decisión**: Para Katsu Izakaya, el siguiente paso es reorganizar la pantalla en dos accesos raiz (`Vinos` y `Copas de Vino`) manteniendo los productos Winerim, mappings, stockIds y legacy oculto reversible ya existentes.
- **Razón**: La integracion ya tiene catalogo Winerim publicado, ventas recientes importadas, descuentos de copa `SUCCESS` y cola abierta a cero. Reimportar o recrear productos para resolver la pantalla aumentaria riesgo sin necesidad.
- **Alternativa descartada**: rehacer la importacion completa o volver a matchear legacy en bloque. Ya se descarto el matching legacy masivo por riesgo de descontar stock equivocado, y la pantalla puede corregirse con familias/visibilidad.

## 2026-06-25 · Katsu: activar intradia y pausar updates repetidos por seguridad
- **Decisión**: Activar en Katsu `intraday_sales_sync_enabled=true` y mantener `auto_push_on_create=true`, pero dejar `auto_push_on_update=false` despues de aplicar una tanda controlada de updates.
- **Razón**: La estructura visual `VINOS` / `Copas de Vino` ya esta viva y el cliente necesita descuento de ventas en ciclo corto. Se probo `auto_push_on_update=true`, `fetch-catalog` detecto `68` updates y se drenaron sin errores, pero el cron de catalogo volvio a encolar otra tanda `AUTO_UPDATE`, confirmando riesgo de bucle. No se debe dejar activo algo que pueda tocar Agora cada ciclo sin cambios reales.
- **Alternativa descartada**: dejar `auto_push_on_update=true` pese al bucle para cumplir "todo automatico". Aumentaria riesgo operativo y ruido de cola; el camino correcto es corregir la idempotencia y reactivarlo despues.

## 2026-06-25 · Katsu: cerrar deuda outbound verificada en vez de reintentar ocultaciones ya efectivas
- **Decisión**: Marcar como resueltas `4` tareas `AGORA_HIDE_PRODUCT` bloqueadas tras verificar en master data que los `8` productos afectados ya estaban no vendibles (`UseAsDirectSale=false`, `SaleableAsMain=false`).
- **Razón**: Eran falsos positivos operativos por respuesta incompleta (`unexpected end of file`) despues de una ocultacion que ya se habia aplicado. Mantenerlas `BLOCKED` dejaba Katsu con alerta abierta aunque la pantalla estaba correcta.
- **Alternativa descartada**: reintentar las ocultaciones en bloque. Podia recrear ruido sin aportar cambio funcional porque el estado destino ya estaba verificado.

## 2026-06-26 · Agora: tracking oculto bloquea fallback de mapping en ventas
- **Decisión**: Cambiar `buildSalesResolutionMap()` para que un producto presente en `winerim_push_tracking` solo resuelva ventas si su tracking esta `VERIFIED` o `PUSHED`; si esta `HIDDEN` u otro estado no verificado, no se usa el fallback de `product_mappings.CONFIRMED`.
- **Razón**: La auditoria detecto dos fallos reales: `Katsu C Saiaz Rosado` y `Sa Pedrera C B310- Albenc [copa]` tenian tracking oculto, pero seguian resolviendo ventas por mapping confirmado y por tanto intentaban descontar stock Winerim. El tracking es la fuente mas actual sobre si el formato esta disponible para venta.
- **Alternativa descartada**: corregir solo esos dos mappings a mano. Habria parado el ruido puntual, pero dejaria el bug latente para cualquier formato oculto por inactivo, sin precio, sin `serve_by_glass` o rollback visual.

## 2026-06-26 · Auditoria Agora: no ejecutar `fetch-catalog` en bloque para comprobar automaticos
- **Decisión**: Comprobar catalogo mediante `winerim_wines` + `winerim_push_tracking` + colas, sin lanzar `fetch-catalog` masivo en todas las conexiones.
- **Razón**: `fetch-catalog` puede disparar `evaluate-auto-push` y encolar escrituras reales cuando hay flags automaticos activos. La auditoria pedida era diagnostica; no debia crear o actualizar productos sin revisar cada conexion.
- **Alternativa descartada**: refrescar catalogo Winerim de todos los clientes en una sola pasada. Daria datos recientes, pero podria tocar Agoras en produccion, reactivar deuda o repetir el bucle de `AUTO_UPDATE` visto en Katsu.

## 2026-06-26 · Agora: registrar historial Winerim cuando el stock no se mueve
- **Decisión**: Anadir en `agora-proxy` un fallback a `POST /api/v2/sales/import` cuando una venta mapeada llega a Winerim pero el `PUT /stock/{stockId}` no cambia stock (`previousStock === newStock`).
- **Razón**: En Cienvinos las ventas estaban llegando y el stock sync quedaba `SUCCESS`, pero Winerim tenia variantes a `stock=0`; el `PUT` aceptado era `0 -> 0`, por lo que no se generaba una bajada visible ni historial de venta. `sales/import` registra venta sin modificar inventario y es idempotente por `orderId`.
- **Alternativa descartada**: usar siempre `sales/import` ademas del `PUT`. Podria duplicar historial cuando el stock si baja de verdad, porque Winerim documenta que bajar stock mediante `PUT /stock/{stockId}` ya registra una venta como efecto lateral.

## 2026-06-26 · Cienvinos: backfill idempotente de historial sin tocar stock
- **Decisión**: Importar en Winerim las `34` lineas de Cienvinos ya sincronizadas como `SUCCESS` pero sin movimiento de stock (`0 -> 0`) usando `POST /api/v2/sales/import`.
- **Razón**: El cliente necesitaba que esas ventas ya procesadas aparezcan tambien en historial Winerim. El endpoint import registra venta sin modificar inventario; se verifico idempotencia con una segunda ejecucion (`imported=0`, `skipped=34`, `failed=0`).
- **Alternativa descartada**: modificar stock a mano o reabrir/reintentar `stock_sync_log`. Habria alterado inventario real o podria duplicar descuentos; el problema era de historial, no de stock operativo.

## 2026-06-26 · Extender backfill de historial 0->0 a la flota Agora
- **Decisión**: Aplicar el mismo backfill idempotente de Cienvinos a todas las conexiones Agora con filas `stock_sync_log.SUCCESS` donde `previousStock === newStock` y no existia `salesImport` previo.
- **Razón**: Esas ventas ya habian sido aceptadas por el flujo de stock, pero al no moverse el inventario no garantizaban historial visible en Winerim. `POST /api/v2/sales/import` resuelve el historico sin tocar stock y con `orderId` determinista.
- **Alternativa descartada**: esperar a que cada cliente reporte individualmente la falta de historial. Mantendria descuadres visibles ya detectables y obligaria a repetir el mismo diagnostico caso por caso.

## 2026-06-26 · No forzar backfill Sa Pedrera cuando Winerim no expone la misma variante
- **Decisión**: En Sa Pedrera, importar solo los casos donde Winerim expone actualmente la misma variante con un stockId nuevo; no convertir ventas de copa a botella ni usar stockIds que Winerim devuelve como inaccesibles.
- **Razón**: Varias ventas historicas apuntan a stockIds antiguos o a variantes que hoy ya no existen como tal en Winerim (`copa` vendida, pero Winerim solo expone `botella`, o `GET /stock/wine/{id}` devuelve 404). Forzarlas podria crear historial en una variante incorrecta.
- **Alternativa descartada**: importar todas las ventas pendientes contra el stockId disponible aunque sea de otra variante. Eso maquillaria el historico, pero romperia la trazabilidad copa/botella y podria confundir stock/margenes.

## 2026-07-11 · Agora: activar piloto de tickets abiertos para ventas casi en tiempo real
- **Decisión**: Activar `intraday_sales_sync_enabled`, `open_tickets_sync_enabled` y `open_tickets_stock_sync_enabled` en conexiones Agora activas cuyo endpoint `/api/export/tickets/` responde correctamente.
- **Razón**: Agora no expone un webhook universal de venta cerrada en estas instalaciones. La vía más cercana a tiempo real es leer tickets abiertos cada pocos minutos, registrar ventas elegibles y reconciliar después con `Invoices` cuando la factura cierre.
- **Alternativa descartada**: esperar únicamente al cierre D-1. Es más estable, pero no cubre la necesidad operativa de clientes como Sa Pedrera, Casa Nene o Cienvinos de ver ventas y stock durante el servicio.
- **Rollback**: desactivar en la conexión `provider_config.open_tickets_sync_enabled`, `provider_config.open_tickets_stock_sync_enabled` y, si hiciera falta, `provider_config.intraday_sales_sync_enabled`. El flujo cerrado por `Invoices` queda intacto.

## 2026-07-11 · Agora: reconciliar stock incremental cuando conviven tickets abiertos e invoices
- **Decisión**: Cambiar `auto-sync-sales` para usar reconciliación incremental de stock cuando una conexión tenga `open_tickets_sync_enabled=true`, aunque `intraday_sales_sync_enabled` no estuviera activo.
- **Razón**: Si un ticket abierto ya descontó una unidad y más tarde esa misma venta aparece en `Invoices`, el flujo cerrado no debe volver a aplicar todo el día como si fuera la primera vez. La reconciliación incremental reduce riesgo de doble descuento.
- **Alternativa descartada**: confiar solo en el flag intradía. Podía fallar si un cliente tenía tickets abiertos activos pero intradía desactivado por error de configuración.
- **Rollback**: volver a la expresión anterior y desactivar `open_tickets_stock_sync_enabled` por conexión hasta corregir cualquier caso anómalo.

## 2026-07-11 · Agora: tolerar respuestas de importación con cuerpo incompleto
- **Decisión**: Añadir lectura best-effort del cuerpo HTTP en imports XML de Agora para que `res.text()` no tumbe una tarea ya aplicada con `TypeError: unexpected end of file`.
- **Razón**: En Sa Pedrera, una ocultación de `B310- Albenc` quedó bloqueada porque Agora devolvió una respuesta sin cuerpo legible. Este error no siempre significa que la escritura no se haya aplicado.
- **Alternativa descartada**: reintentar manualmente esas tareas sin cambiar código. Mantendría el falso bloqueo cada vez que Agora devuelva cuerpo truncado.
- **Rollback**: revertir commit `89c5950` si se observa que respuestas ilegibles esconden errores reales; antes de revertir, verificar master data para confirmar el estado del producto en Agora.

## 2026-07-11 · Agora: no activar tickets abiertos en instalaciones sin ruta de red
- **Decisión**: No activar el modo casi en tiempo real en Jardí mientras `eljardiparets.ddns.net:8984` devuelva `NETWORK_UNREACHABLE / No route to host`.
- **Razón**: El fallo es de conectividad entre backend y TPV, no de lógica de Winerim. Activar el cron generaría alertas y breaker sin capturar ventas.
- **Alternativa descartada**: activar igualmente para que se recupere cuando vuelva la red. El flujo de `Invoices` ya cubre recuperación de ventas cerradas; tickets abiertos no aportan valor si el servidor no enruta.

## 2026-07-11 · Nuevas integraciones Agora: alta read-only antes de escritura
- **Decisión**: Crear Saddle, El Higuerón, Tintorera, O Bistro y Taberna de Elia en modo seguro: `write_mode=NONE`, auto-push apagado y legacy visible.
- **Razón**: Varias tienen estructura previa desconocida o bloqueos de red/token. Activar escritura o publicar familias Winerim sin validar puede duplicar vinos, romper pantallas de sala o generar ventas sin mapping correcto.
- **Alternativa descartada**: usar la misma receta de “familias Winerim + ocultar legacy” en todas. Taberna de Elia ya tenía una decisión previa de matching obligatorio, Saddle tiene armonías/menús complejos, Higuerón menciona control de stock externo, O Bistro no es accesible y Tintorera no responde.
- **Rollback**: si alguna fila creada genera confusión, dejar `enabled=false`, `write_mode=NONE` y conservar credenciales para retomar cuando el SAT resuelva red/token.

## 2026-07-11 · Taberna de Elia: activar lectura pero no stock ni catálogo Winerim
- **Decisión**: Dejar Taberna de Elia `enabled=true` en `PULL_ONLY` para importar ventas cerradas y mantener catálogo Winerim cacheado, pero sin stock ni publicación de productos.
- **Razón**: La API responde bien y ya permite importar ventas históricas/cerradas, pero el matching actual no resuelve líneas (`resolvedLines=0`) y el legacy de bodega tiene estructura por regiones/denominaciones.
- **Alternativa descartada**: activar `XML_IMPORT` y volcar familias Winerim ya. Reabriría el riesgo documentado el 2026-06-17: duplicados y pérdida de organización visual.

## 2026-07-11 · El Bejeque: ocultar legacy de vino manteniendo rollback
- **Decisión**: Ocultar el legacy visible de vinos en El Bejeque (`VINOS`, `BLANCOS`, `TINTOS`, `ESPUMOSO`, `POSTRE`, `FORTIFICADO`, `ROSADO`) y dejar no vendibles sus productos, manteniendo intactas las familias Winerim.
- **Razón**: El cliente ya puede operar desde familias Winerim y la convivencia con legacy genera duplicidad visual y riesgo de ventas que no resuelvan contra Winerim.
- **Alternativa descartada**: borrar productos/familias legacy. Se conserva todo para rollback y trazabilidad.
- **Rollback**: reactivar `ShowInPos=true` en las familias legacy necesarias y `UseAsDirectSale=true`/`SaleableAsMain=true` en los productos legacy que el cliente quiera recuperar.

## 2026-07-11 · Abadía Yuste: esperar alta backend antes de escribir en Agora
- **Decisión**: Tratar Abadía Yuste como pre-onboarding validado externamente, pero no escribir en Agora ni ocultar legacy hasta crear conexión en Lovable Cloud.
- **Razón**: Agora y Winerim responden correctamente, pero Lovable Cloud/backend está devolviendo `522`, así que no hay trazabilidad en `pos_connections`, `agora_master_data`, colas ni rollback del middleware.
- **Alternativa descartada**: escribir familias Winerim directamente por API de Agora. Aunque técnicamente posible, saltaría la idempotencia, el monitor, los mappings y la documentación operativa.
- **Rollback**: no aplica aún porque no se ha escrito nada en Agora desde Winerim.

## 2026-07-11 · El Bejeque: catálogo Winerim OK, no tocar restos no vendibles
- **Decisión**: Considerar El Bejeque correcto a nivel catálogo Winerim -> Ágora tras auditoría directa: `98/98` formatos activos con precio están publicados en familias Winerim y vendibles con `SaleableAsMain=true`.
- **Razón**: El cruce directo no detecta faltantes ni familias incorrectas, el legacy visible de vino es `0`, y los únicos `3` productos extra dentro de familias Winerim (`B Cloe`, `B Juan Escudero Marmajuelo`, `C Cloe`) ya están no vendibles.
- **Alternativa descartada**: ocultar o borrar esos restos directamente por API ahora. No aportan riesgo visual ni operativo, y con Lovable Cloud/backend en timeout conviene esperar a `sync-master-data` para que el middleware conserve trazabilidad.
- **Rollback**: no se ha hecho ninguna escritura en esta auditoría. Si se necesitara recuperar legacy, se mantiene el rollback documentado el 2026-07-11: reactivar familias/productos legacy sin borrar nada.

## 2026-07-11 · El Higuerón: bloqueo por API HTTP de Ágora
- **Decisión**: Mantener Higuerón bloqueado y sin escritura hasta que el SAT/cliente confirme una clave API HTTP válida.
- **Razón**: El token Winerim responde HTTP `200`, pero Ágora devuelve HTTP `401` en catálogo, productos, facturas y tickets abiertos con la clave facilitada. El fallo está en credencial/módulo API HTTP de Ágora, no en Winerim.
- **Alternativa descartada**: intentar publicar familias Winerim o activar ventas igualmente. Sin lectura básica de Ágora no hay forma segura de validar estructura, legacy, ventas ni rollback.
- **Rollback**: no aplica porque no se ha hecho escritura.

## 2026-07-13 · Agora: preservar hora local de venta sin duplicar historial
- **Decisión**: Persistir la hora original de Agora por línea (`provider_sold_at`) y usarla como `soldAt` en `POST /api/v2/sales/import` únicamente cuando el fallback sales-only sea necesario porque el stock no se ha movido.
- **Razón**: Winerim ya tiene `/api/v2/sales/import`, pero ese endpoint no modifica stock. Usarlo siempre junto al `PUT /stock/{stockId}` podría duplicar historial si Winerim ya registra venta como efecto lateral del stock. Guardar la hora real permite auditar y corregir los casos sales-only sin romper los casos con stock activo.
- **Alternativa descartada**: sustituir todo el flujo de stock por `sales/import`. Resolvería la hora visible, pero dejaría de descontar inventario cuando el stock está activo.
- **Rollback**: revertir la migración nueva (`provider_sold_at`, `provider_sold_at_source` e índice) y el cambio de `agora-proxy` que extrae `CreationDate`/pasa `soldAt` al fallback. El flujo anterior de stock por `PUT /stock` queda intacto.

## 2026-07-13 · Agora: dos carriles Winerim según stock activo
- **Decisión**: Enviar ventas a `PUT /api/v2/stock/{stockId}` solo cuando la variante Winerim tenga `stockActive=true`; si `stockActive=false`, registrar la venta por `POST /api/v2/sales/import` sin tocar stock.
- **Razón**: El usuario confirmó que Winerim expone dos comportamientos distintos: un endpoint descuenta stock cuando el stock está activado y otro marca venta aunque el stock no esté activado. Mezclar ambos casos como “stock a cero” podía dejar sin historial ventas de restaurantes que tienen stock desactivado por operativa.
- **Alternativa descartada**: forzar siempre `PUT /stock` aunque `stockActive=false`. Eso podría no registrar historial, podría fallar o podría activar efectos de inventario que el cliente no quiere.
- **Rollback**: revertir las ramas `sales_only_stock_inactive` y volver al flujo anterior donde toda variante con `stockId` intenta `PUT /stock`. Mantener esta opción solo como emergencia, porque perdería ventas sales-only de clientes sin stock activo.

## 2026-07-13 · Sync Monitor: error visible antes que falso vacío
- **Decisión**: El `Sync Monitor` debe mostrar errores de carga de Lovable Cloud/backend y conservar datos previos; no debe convertir errores de query en listas vacías.
- **Razón**: Con HTTP `522` en `pos_connections`, `sales_events`, `stock_sync_log` u `outbound_tasks`, la UI anterior mostraba “No connections found”/tablas vacías. Eso inducía a pensar que Agora no tenía datos o que se habían perdido integraciones.
- **Alternativa descartada**: dejar el comportamiento actual y diagnosticar verbalmente cada vez. Es peligroso operativamente porque oculta una caída de infraestructura.
- **Rollback**: revertir el cambio local en `src/pages/SyncMonitor.tsx`; no afecta datos ni integraciones.

## 2026-07-13 · Agora open tickets: tickets cancelados son provisionales y reversibles
- **Decisión**: Tratar los `OpenTicket` de Agora como ventas provisionales. Por defecto, un `OpenTicket` con `BusinessDay` anterior al día operativo actual no debe mutar stock, y si un ticket abierto antiguo desaparece sin estar cubierto por una factura cerrada (`Invoices`), el middleware puede restaurar la diferencia con una fila negativa idempotente en `stock_sync_log` (`open_ticket_cancellation_restore`).
- **Razón**: En Sa Pedrera, una venta ficticia/cancelada de `E510-Izar-Leku Brut Vintage` quedó abierta desde `2026-07-11`, se sincronizó el `2026-07-13`, descontó la única botella y dejó el vino fuera de carta por stock `0`. El modo casi en tiempo real tiene que cubrir cancelaciones/cierres tardíos sin romper la reconciliación diaria definitiva.
- **Alternativa descartada**: desactivar por completo el piloto de tickets abiertos. Reduciría riesgo, pero volvería a obligar al cliente a esperar al cierre. También se descarta revertir cualquier ticket desaparecido sin comparar contra `Invoices`, porque podría reponer stock de una venta ya cerrada correctamente.
- **Rollback**: desactivar por conexión `provider_config.open_tickets_stock_current_day_only=false` si se quiere permitir stock sobre tickets antiguos, o `provider_config.open_tickets_restore_stale_previous_days_enabled=false` si se quiere apagar solo la restauración automática. Como rollback total, desactivar `provider_config.open_tickets_stock_sync_enabled` y dejar `Invoices` como único flujo de stock.

## 2026-07-13 · El Higuerón: mantener bloqueado tras revalidación
- **Decisión**: Mantener `El Higuerón` sin activar (`enabled=false`, `write_mode=NONE`, auto-push apagado) hasta recibir una clave API HTTP de Agora que responda correctamente.
- **Razón**: La clave guardada coincide con la facilitada y Winerim responde HTTP `200`, pero Agora sigue devolviendo HTTP `401` en `Invoices`, `tickets`, `Families` y `Products`. Sin lectura de catálogo/ventas no se puede validar estructura, publicar familias ni garantizar rollback.
- **Alternativa descartada**: activar la integración en modo parcial o intentar escribir familias Winerim. Sería inseguro porque no podemos leer master data, productos existentes, ventas ni estado real del legacy.
- **Rollback**: no aplica porque no se ha hecho ninguna escritura; la conexión queda preparada para retomar cuando SAT/cliente facilite una clave válida.
## 2026-07-14 - Retirar legacy solo por ocultacion reversible y por propiedad real

### Decision
- En Chiquilla, Kava, Jardi, Sa Pedrera, Sa Vida y Taberna de Elia, `quitar legacy` significa `ShowInPos=false` para familias y `UseAsDirectSale=false` + `SaleableAsMain=false` para productos, nunca borrado.
- No se clasifica una familia como legacy solo porque no contenga la palabra `WINERIM`: en Sa Vida las familias geograficas generadas por Winerim se conservan; en Jardi la familia mixta `BEGUDES` y la raiz `BODEGA` se conservan porque contienen operativa no vinicola.
- Si un producto Winerim queda dentro de una familia legacy oculta, se mueve a su familia Winerim antes de cerrar el cleanup, como `B MAGNUM 32 - Morgon` en Sa Pedrera.

### Razon
- Ocultar por nombre o por jerarquia completa podia retirar cocteles, destilados, bebidas y productos Winerim validos. La propiedad del producto y su sustituto Winerim deben comprobarse antes de escribir.
- La ocultacion reversible conserva historico, trazabilidad y una salida de rollback sin duplicar botones visibles.

### Alternativa descartada
- Borrar familias/productos o esconder toda raiz `BODEGA/BEBIDAS` de forma masiva. Se descarta por riesgo de eliminar operativa no relacionada con vino.

## 2026-07-14 — tSpoonLab y Holded arrancan en lectura, con responsabilidades separadas

**Decisión:** implementar primero clientes/proxies de solo lectura para tSpoonLab y Holded. tSpoonLab será fuente de menús, armonías, recetas y documentos operativos; Holded será destino contable; Agora seguirá siendo fuente operativa de la venta y Winerim del catálogo/stock de vino.

**Razón:** una conexión directa con escritura sin separar responsabilidades puede duplicar stock, consumos o facturas. El descubrimiento read-only permite validar centros, códigos TPV, composiciones, series, impuestos y almacenes sin impacto productivo.

**Riesgos controlados:** no existen acciones de escritura en los proxies nuevos; HTTPS es obligatorio; se aplican timeout, reintento y circuit breaker; las credenciales no se devuelven en respuestas.

**Alternativa descartada:** activar de inmediato el envío de ventas/documentos entre los cuatro sistemas usando el estado actual de las recetas. Se descarta porque no conserva la composición histórica ni garantiza idempotencia/reversión.

## 2026-07-14 — Menús y armonías requieren instantánea versionada por venta

**Decisión:** cada venta de menú/armonía deberá asociarse a una instantánea de componentes aplicable en ese momento antes de descontar vinos en Winerim.

**Razón:** si tSpoonLab cambia el menú después, recalcular una venta anterior con la receta actual produciría consumos incorrectos.

**Alternativa descartada:** consultar siempre la receta vigente y asumir que nunca cambia.

## 2026-07-14 — Brief partner Agora V6

**Decisión:** entregar al partner de Agora un documento específico que mantiene Agora como TPV de referencia y presenta tSpoonLab/Holded como extensiones, no como sustitutos.

**Razón:** el partner necesita confirmar identificadores, componentes/modificadores, cancelaciones, endpoints, límites y proceso de piloto sin recibir una propuesta que invada funciones de TPV o facturación.

## 2026-07-14 — Tintorera se activa solo despues de recuperar lectura externa

**Decisión:** mantener Tintorera desactivado, `PULL_ONLY`, `write_mode=NONE`, sin auto-push y con legacy visible hasta que Agora responda por el puerto externo `8984` y se complete la auditoria read-only.

**Razón:** Winerim esta disponible y su catalogo de 302 vinos esta listo, pero `tintorera.dyndns.org:8984` termina en timeout tanto desde la red de diagnostico como desde Lovable Cloud/backend. Publicar sin poder leer Families, Products, ventas ni la estructura legacy impediria verificar el resultado y revertir con precision.

**Riesgos controlados:** no se ha modificado catalogo, ventas, stock ni visibilidad en Agora. Cuando vuelva la conectividad, la primera fase sera snapshot y comparacion; el legacy seguira visible durante el piloto.

**Alternativa descartada:** habilitar la conexion o encolar los 302 vinos confiando en que el TPV procese las tareas al volver. Se descarta porque podria crear duplicados o aplicar formatos incorrectos sin observabilidad.

**Rollback:** no aplica al estado actual porque no hubo escrituras. En la activacion futura, el rollback sera apagar flags por conexion y ocultar de forma reversible solo los productos/familias Winerim creados.

## 2026-07-14 — Tintorera requiere politica explicita para formatos no estandar

**Decisión:** botella pequena, media botella y botella tienda no se convertiran automaticamente a botella estandar de Agora.

**Razón:** Winerim expone 5, 4 y 3 precios respectivamente para esos formatos. Colapsarlos sin validar podria vender una capacidad o canal con precio incorrecto y descontar la variante equivocada.

**Alternativa descartada:** tratar cualquier variante que no sea copa o magnum como botella. Solo se aplicara si cliente/SAT confirma expresamente esa equivalencia.

## 2026-07-14 — Ventas Agora a Holded; pedidos y stock desde tSpoonLab

**Decisión:** usar las ventas cerradas de Agora como fuente de los documentos enviados a Holded y leer desde tSpoonLab pedidos de compra, albaranes, almacenes e inventario/stock. Holded no controlara el inventario operativo.

**Razón:** Agora conoce la venta y el cierre real; tSpoonLab conoce compras y existencias operativas. Usar tSpoonLab tambien como fuente de venta o Holded como segundo stock crearia reconciliaciones ambiguas.

**Alternativa descartada:** copiar ventas desde tSpoonLab a Holded y permitir que el documento Holded descuente stock. Se descarta para evitar duplicidad con Agora/Winerim y divergencias entre tres inventarios.

**Rollback:** apagar la escritura Holded por conexion. Los cierres permanecen pendientes y no se modifica tSpoonLab.

## 2026-07-14 — PurOsushi mantiene legacy visible durante el piloto

**Decisión:** restaurar el legacy de PurOsushi usando la instantanea previa, incluyendo los valores exactos de `ShowInPos`, `UseAsDirectSale` y `SaleableAsMain`; no borrar ningun elemento.

**Razón:** el usuario pide convivencia temporal mientras se validan ventas, catalogo y automatismos Winerim. Reactivar ambos flags de producto de forma indiscriminada podria cambiar la disposicion original de los botones.

**Alternativa descartada:** usar `visible=true` para todos los productos legacy. No preservaria los flags distintos que tenia cada producto antes de la ocultacion.

**Rollback:** volver a aplicar la instantanea de ocultacion de `2026-07-14` y mantener guardado el snapshot original.

## 2026-07-14 · Yurest V2: Blasco aislado y credenciales solo en secretos

**Decisión:** implementar Yurest mediante Customer Session V2, fijando `store_id=2054` para Blasco y manteniendo la primera fase en solo lectura.

**Razón:** el usuario master devuelve datos de 18 locales. Sin scoping estricto se mezclarían costes, inventarios y compras de otros centros. La API ya ofrece catálogo, costes, almacenes e inventarios útiles, pero stock actual y movimientos devuelven HTTP 500 y faltan permisos de albaranes/locales.

**Alternativa descartada:** guardar usuario, contraseña y token en `provider_config` o en el repositorio. Se usarán secretos de Lovable Cloud referenciados por nombre para no exponer credenciales en tablas de configuración.

**Rollback:** no hay escrituras ni conexión activa. Retirar `yurest-proxy`, el cliente compartido y la configuración tipada devuelve el repositorio al estado anterior sin afectar Agora ni otros proveedores.

## 2026-07-14 · Agora: interpretar timestamps locales con la zona del restaurante

**Decisión:** los timestamps de Agora sin `Z` ni offset se comparan como hora local de `provider_config.sales_timezone`; los timestamps con zona explícita se comparan como instantes absolutos.

**Razón:** Agora devolvió `CreationDate=2026-07-14T12:31:09` en Higuerón mientras el runtime operaba en UTC. `Date.parse` la trató como UTC y el filtro de antigüedad aplazó una venta real durante el desfase horario completo.

**Riesgos controlados:** se conserva el margen de seguridad por conexión, los valores ausentes o no interpretables mantienen el comportamiento permisivo anterior y hay pruebas para fecha naive, fecha con zona y fallbacks.

**Alternativa descartada:** fijar `open_tickets_min_line_age_minutes=0` para toda la flota. Evitaría el síntoma, pero eliminaría la protección contra líneas recién creadas o todavía editables.

**Rollback:** revertir `agoraLocalTime.ts` y volver a la comparación con `Date.parse`; no requiere migración ni modifica datos.

## 2026-07-14 · Agora: zona horaria explícita en toda la flota

**Decisión:** fijar `provider_config.sales_timezone=Europe/Madrid` en las `22` conexiones Agora existentes, preservando el resto de su JSON de configuración.

**Razón:** la corrección de fechas naive solo es determinista si cada conexión declara su zona. También evita que altas antiguas dependan implícitamente de la zona del runtime.

**Alternativa descartada:** dejar el fallback de código como única fuente. Funcionaría hoy, pero una conexión sin zona seguiría siendo ambigua y difícil de auditar.

**Rollback:** retirar únicamente la clave `sales_timezone` de una conexión si cambia de país o requiere otra zona; no revertir el parser local.

## 2026-07-14 · Taberna de Elia: activar tickets abiertos tras sonda sin vino resuelto

**Decisión:** activar en Taberna de Elia captura y stock por tickets abiertos con margen de dos minutos, día actual y zona Europe/Madrid.

**Razón:** `/api/export/tickets/` responde HTTP 200 y la primera ejecución controlada no contenía vinos Winerim resueltos, por lo que no hubo mutación de stock. El flujo queda preparado para validar una venta real sin esperar al cierre.

**Alternativa descartada:** mantenerla solo en facturas cerradas pese a tener el endpoint disponible. Retrasaría el historial y no acercaría la instalación al patrón de Cienvinos.

**Rollback:** desactivar `open_tickets_stock_sync_enabled` para conservar solo captura, o también `open_tickets_sync_enabled` para volver al flujo de facturas.

## 2026-07-14 · Yurest: desplegar lectura segura, mantener conexión inactiva

**Decisión:** desplegar `yurest-proxy`, configurar secretos y registrar Blasco como conexión desactivada `PULL_ONLY`/`write_mode=NONE`.

**Razón:** ya se pueden analizar costes e inventarios reales aislados al local `2054`, pero stock, movimientos, albaranes, facturas y listado de pedidos siguen incompletos o bloqueados.

**Alternativa descartada:** esperar a que Yurest resuelva todos los endpoints antes de desplegar nada. La lectura actual ya permite avanzar en matching y diagnóstico sin riesgo operativo.

**Rollback:** desactivar o retirar la función y la conexión inactiva; no existen escrituras en Yurest ni automatismos asociados.

## 2026-07-14 · Catálogo: no ocultar errores al guardar la fecha final

**Decisión:** tratar como error la imposibilidad de persistir `last_catalog_sync_at` al finalizar el enriquecimiento completo.

**Razón:** el cliente recibía `complete=true` aunque la pantalla pudiera seguir mostrando `Never`, porque la respuesta de PostgREST no se comprobaba. El estado operativo debe ser coherente con la respuesta del endpoint.

**Alternativa descartada:** limitarse a un `console.error` y continuar con éxito. Mantendría falsos positivos y dificultaría detectar permisos/RLS o fallos transitorios.

**Rollback:** volver a registrar el error sin lanzar excepción; no afecta catálogo ni colas, pero reintroduce estados silenciosamente inconsistentes.

## 2026-07-14 - Una escritura Agora exige verificación fresh

**Decisión:** ninguna alta, actualización o cambio de visibilidad de familia/producto se marca como éxito hasta releer el catálogo Agora sin caché y comprobar el estado esperado.

**Razón:** una respuesta aceptada por `/api/import/` no garantiza por sí sola que el objeto exista o conserve los atributos requeridos. La lectura posterior evita falsos `SUCCESS` y permite reintentos idempotentes.

**Alternativa descartada:** confiar solo en HTTP/import response y actualizar tracking inmediatamente.

## 2026-07-14 - Los mappings confirmados mandan en la auditoría de cobertura

**Decisión:** resolver primero mappings `CONFIRMED` y reglas específicas de conexión; usar IDs deterministas solo como fallback.

**Razón:** Sa Pedrera representa sus dulces con botones únicos `903xxx`. El recuento genérico BOTTLE/GLASS generó falsos huecos y habría creado duplicados si se reparaba sin contexto.

**Alternativa descartada:** exigir siempre los tres IDs deterministas por vino y formato, ignorando excepciones comerciales ya verificadas.

## 2026-07-14 - Qtomas se trata como un solo incidente de conectividad

**Decisión:** conservar una única alerta canónica `connectivity/POS_DOWN`; breaker, backlog y ventas estancadas se correlacionan como síntomas del mismo corte mientras el probe siga `DOWN`.

**Razón:** el host falla en TCP con `No route to host`; abrir y notificar una alerta independiente por cada síntoma produce ruido sin aportar acciones distintas.

**Alternativa descartada:** enviar un correo nuevo en cada ciclo y por cada métrica degradada.

## 2026-07-14 - Taberna de Elia no se reimporta ante un problema visual

**Decisión:** con `8/8` familias visibles y `412/412` variantes verificadas fresh, pedir primero refresco/reinicio del terminal y revisión SAT si persiste.

**Razón:** volver a importar productos ya correctos añade riesgo de duplicados o cambios de orden y no soluciona una caché local del terminal.

**Alternativa descartada:** repetir una carga masiva para intentar forzar la interfaz.

## 2026-07-14 - Catálogo completo no equivale a integración al 100%

**Decisión:** adoptar tres estados verificables: `CATALOG_READY`, `LIVE` y `100%_SIGNED_OFF`. Una conexión solo alcanza el último cuando supera conectividad, catálogo, automatización, ventas botella+copa, stock activo/inactivo, idempotencia/recuperación, salud y aceptación del terminal.

**Razón:** la auditoría operativa mostró `14/15` catálogos completos pero `0/15` conexiones con evidencia de todos los bloques. Casa Nene sirve como referencia de onboarding y auto-push, no como prueba integral de operación.

**Riesgo mitigado:** evitar prometer al cliente que todo funciona por observar familias/productos, cuando podrían faltar ventas resueltas, copas, cambios de precio, recuperación o confirmación visual.

**Alternativa descartada:** usar un único porcentaje agregado o marcar `PASS` cuando no existe evidencia. Oculta fallos distintos y produce falsos positivos.

## 2026-07-14 - Los tickets abiertos de Agora no son historial definitivo

**Decisión:** las facturas cerradas de Agora son la fuente contable definitiva. Un `OpenTicket` puede capturarse y mostrarse como provisional, pero no debe crear una venta definitiva en Winerim mientras no exista una operación reversible por identificador externo y una conciliación al cierre.

**Razón:** la comparación real de Cienvinos mostró acumulados `1,2,3...`, `31` filas repetidas de una botella sin ventas históricas equivalentes y faltantes al cerrar los días 12 y 13. El historial ERP no puede corregirse de forma segura únicamente restaurando stock.

**Riesgos controlados:** no se anulan ventas ni se modifica stock durante la auditoría. La corrección futura deberá relacionar cada fila ERP con documento, producto, variante y cantidad de Agora antes de escribir.

**Alternativa descartada:** seguir enviando cada estado del ticket abierto a `sales/import` o `PUT stock` y compensarlo después. Winerim no ofrece en este flujo una eliminación/actualización inequívoca de la venta provisional y la compensación de stock no limpia el historial.

**Rollback:** cualquier activación futura de mutación desde tickets abiertos seguirá siendo un flag por conexión; desactivarlo conserva captura y facturas cerradas sin tocar catálogo.

## 2026-07-15 - Cienvinos: capturar tickets abiertos, escribir solo facturas definitivas con stock inactivo

**Decisión:** mantener la lectura de tickets abiertos para diagnóstico y baja latencia, pero no llamar a `sales/import` ni mutar stock desde ellos cuando la variante Winerim tenga el stock inactivo. La venta se escribe al recibir la factura definitiva.

**Razón:** `sales/import` es una escritura irreversible con la API actual: no permite cancelar por `external_id`, actualizar una cantidad acumulada ni enviar cantidades negativas. En Cienvinos, cada snapshot `1,2,3...` terminó convertido en una venta adicional.

**Riesgos controlados:** las ventas sin stock activo dejan de ser casi inmediatas y esperan al cierre del documento; a cambio, no se duplica el historial. Las variantes con stock activo siguen requiriendo una estrategia reversible antes de reactivar mutación desde tickets abiertos.

**Alternativa descartada:** compensar acumulados con nuevas ventas negativas o restauraciones manuales. La API no admite ventas negativas y restaurar stock no elimina la fila incorrecta del historial.

**Rollback:** `open_tickets_stock_sync_enabled` sigue siendo un flag por conexión. Solo debe reactivarse cuando Winerim soporte actualización/cancelación idempotente por referencia externa.

## 2026-07-15 - Facturas y abonos Agora conservan signo e identidad distinta

**Decisión:** netear cantidades con su signo, leer `DocumentType` y añadir namespace al identificador de abonos, preservando el identificador histórico de facturas normales.

**Razón:** usar `abs()` convertía devoluciones en consumo y usar únicamente el número permitía que factura y abono colisionaran. Cambiar también los IDs de facturas ya procesadas habría roto la idempotencia histórica y duplicado ventas.

**Riesgos controlados:** los abonos quedan almacenados para conciliación pero marcados como no elegibles para `sales/import`/stock hasta disponer de una operación reversible en Winerim.

**Alternativa descartada:** renombrar retrospectivamente todos los documentos. Habría hecho que el middleware considerase nuevas facturas ya importadas.

## 2026-07-15 - No alterar PVP vivo para reproducir importes históricos

**Decisión:** reparar Cienvinos con cantidades y variantes exactas, aceptando que el 13/07 Winerim valore Terras Gauda al PVP actual mientras `sales/import` no acepte importe o precio histórico.

**Razón:** bajar temporalmente el PVP a `18 EUR`, importar y restaurarlo a `42 EUR` expondría un precio incorrecto en Agora/carta y abriría una carrera con la sincronización automática.

**Alternativa descartada:** manipular el precio productivo durante la reparación. El riesgo comercial es mayor que conservar una discrepancia monetaria conocida y documentada.

## 2026-07-16 - El Portón queda desactivado hasta una venta real de botella y copa

**Decisión:** publicar y verificar el catálogo Winerim de El Portón, mantener visible el legacy y conservar la conexión en `CATALOG_READY_PENDING_SALE`.

**Razón:** el catálogo, la cola y los endpoints de lectura pueden validarse sin riesgo, pero la activación definitiva exige comprobar en el restaurante el recorrido Agora -> historial Winerim para botella y copa.

**Riesgos controlados:** no se ejecuta sincronización periódica ni se descuenta stock antes de la prueba. Las guardas de inicio evitan procesar ventas anteriores al piloto.

**Alternativa descartada:** habilitar inmediatamente la conexión por haber publicado `173/173` variantes. Un catálogo correcto no demuestra todavía ventas, stock, horario ni aceptación del terminal.

**Rollback:** ocultar únicamente las ocho familias Winerim y sus productos. El catálogo anterior no se ha ocultado ni modificado.

## 2026-07-16 - Las auditorías de catálogo separan texto XML de diferencias comerciales

**Decisión:** un `NAME_MISMATCH` o `BUTTONTEXT_MISMATCH` solo se considera diferencia real después de decodificar entidades XML y normalizar espacios de control; IVA, precio, familia y flags de venta nunca se ignoran.

**Razón:** el runtime actual marca diferencias en apóstrofes codificados, tabuladores y espacios aunque el texto visible en Agora sea idéntico. Mezclar esos falsos positivos con precios o flags incorrectos genera tareas y alertas innecesarias.

**Riesgos controlados:** la normalización se limita a texto visible. No cambia IDs, precios, familias, preparación ni capacidad de venta.

**Alternativa descartada:** tratar todos los `DIFFERENT` como error real o ignorarlos todos. La primera opción crea ruido y reimportaciones; la segunda ocultaría fallos comerciales.

## 2026-07-16 - Ninguna conexión se etiqueta al 100% sin evidencia integral

**Decisión:** mantener la clasificación `CATALOG_READY`, `LIVE` y `100%_SIGNED_OFF`; el estado final exige pruebas recientes de alta, precio, botella, copa, stock activo/inactivo, idempotencia, recuperación, historial ERP y terminal.

**Razón:** la auditoría fresh de las `28` conexiones encontró instalaciones con catálogo correcto pero ventas sin firma, y otras con ventas activas pero diferencias de precio, familia, flags o deuda histórica.

**Riesgos controlados:** el informe distingue bloqueos actuales, deuda histórica y falsos positivos. No se desactiva una conexión sana únicamente por una tarea antigua.

**Alternativa descartada:** llamar “100%” a cualquier conexión habilitada que responda a `/api/`. La conectividad no prueba la integración completa.

## 2026-07-16 - De la O mantiene legacy y queda pendiente de venta real

**Decisión:** publicar las ocho familias Winerim y sus `87` variantes, conservar íntegramente el catálogo anterior y dejar la conexión desactivada en `CATALOG_READY_PENDING_SALE`.

**Razón:** catálogo, precios, mappings y estructura pueden verificarse mediante lectura fresh sin poner en marcha ventas históricas. La prueba real de botella y copa sigue siendo necesaria para validar el flujo Agora -> Winerim.

**Riesgos controlados:** el cursor y las guardas de stock empiezan el `2026-07-16`; el catálogo periódico y el auto-push siguen apagados. La comparación posterior confirmó `0` cambios en las `86` familias y `1.758` productos legacy.

**Alternativa descartada:** ocultar el legacy o activar directamente el cron por haber alcanzado `87/87`. Se descarta hasta la aceptación visual y la prueba operativa.

**Rollback:** usar el snapshot `docs/operations/agora-de-la-o-activation-2026-07-16T09-51-31-743Z/`, mantener la conexión desactivada y ocultar solo familias/productos Winerim.

## 2026-07-16 - De la O usa las rutas reales de sala, terraza y bodega

**Decisión:** escribir precios únicamente en los centros activos `2 · SALA` y `4 · TERRAZA`, usar almacén `2 · BODEGA`, IVA `3 / 10%` y preparación `1 / 1 · Barra / Bebidas`.

**Razón:** las listas `1` y `3` y sus centros están eliminados. La ruta `1 / 1` aparece en `876` de `877` productos legacy de vino, por lo que representa la operativa dominante y evita que las comandas de vino pierdan su destino de preparación.

**Alternativa descartada:** usar todos los centros/listas o `Almacén General` por defecto. Podría publicar precios en listas antiguas o separar el vino del almacén específico que ya utiliza el restaurante.

## 2026-07-16 - Los claims de ventas sobreviven al refresco de snapshots Agora

**Decisión:** antes de reemplazar `sales_line_items`, desenganchar `stock_sync_log.sales_line_item_id`, y cambiar la FK de `ON DELETE CASCADE` a `ON DELETE SET NULL`.

**Razón:** en El Bejeque, cada lectura intradía borraba el claim idempotente junto con la línea transitoria y permitía volver a registrar la misma venta cada cinco minutos.

**Riesgos controlados:** la idempotencia sigue resolviéndose por `sales_event_id + wine + variant` y por `idempotency_key`; la referencia a la línea pasa a ser opcional sin perder la evidencia duradera.

**Alternativa descartada:** no reemplazar snapshots o mantener líneas antiguas. Rompería la representación del ticket actual y complicaría cancelaciones/cambios.

**Rollback:** mantener los flags intradía apagados y volver al runtime anterior; no revertir la FK a `CASCADE`.

## 2026-07-16 - El histórico Agora se importa solo como venta y con matching conservador

**Decisión:** usar exclusivamente `POST /api/v2/sales/import`, `orderId` determinista y matching por mapping confirmado, nombre exacto único o alias manual auditado.

**Razón:** el usuario necesita analítica histórica sin alterar el inventario actual. El fuzzy matching automático podría atribuir una venta al vino o variante equivocados.

**Riesgos controlados:** dry-run obligatorio por defecto, `--apply --confirm-no-stock` para escribir, omisión de fracciones y de variantes sin stockId accesible, y filtro exacto por `orderId` para completar huecos sin solapar el tramo ya existente.

**Alternativas descartadas:** reactivar vinos inactivos para importar, usar `PUT /stock/*`, o aceptar la mejor coincidencia fuzzy sin revisión.

## 2026-07-16 - Los duplicados del 15/07 de El Bejeque se anulan tras un canary

**Decisión:** conservar una representación por venta real, anular `27` tarjetas repetidas y validar stock tras una primera anulación controlada.

**Razón:** Winerim mostraba `44` unidades frente a `15,5` unidades de Agora. La anulación canary confirmó que la operación también repone correctamente el stock activo.

**Riesgos controlados:** se guardaron los IDs conservados/anulados y los stocks antes/después. Cloe y el medio magnum se mantienen como excepciones explícitas, no se corrigen inventando datos.

**Alternativa descartada:** borrar filas directamente en base de datos o modificar stock sin limpiar el historial. Habría dejado ventas y stock incoherentes.

## 2026-07-16 - Un hotfix histórico se despliega desde el main actual, no desde su commit aislado

**Decisión:** redesplegar únicamente `agora-proxy` desde `main` `5906a93`, que ya contiene `b421584`, en vez de desplegar directamente el commit histórico.

**Razón:** una sonda fresh de El Portón confirmó que el runtime todavía devuelve cuatro falsos `NAME_MISMATCH` por entidades XML, aunque la fuente actual decodifica `Name` y `ButtonText` antes de normalizar espacios. Desplegar el commit antiguo de forma aislada podría retirar las correcciones posteriores de idempotencia de ventas de El Bejeque.

**Riesgos controlados:** no se cambian flags, `provider_config`, datos operativos ni colas; la comprobación posterior exige `173/173` variantes coincidentes y cero diferencias en El Portón.

**Alternativa descartada:** repetir literalmente la instrucción antigua dirigida al commit `b421584`. Es funcionalmente incompleta respecto al estado actual del proyecto.

## 2026-07-16 - Un flag encendido no sustituye al canary de idempotencia

**Decisión:** no dar por validado el modo intradía de El Bejeque aunque Lovable haya activado `open_tickets_sync_enabled`, `open_tickets_stock_sync_enabled` e `intraday_sales_sync_enabled`.

**Razón:** la corrección XML sí quedó confirmada en runtime con `173/173` productos coincidentes en El Portón, pero la activación de El Bejeque ocurrió de forma concurrente y contradijo la instrucción de no ejecutar activaciones. La protección antiduplicado requiere además confirmar la FK `ON DELETE SET NULL`, el helper de preservación de claims y dos ciclos idénticos sin una segunda escritura.

**Riesgos controlados:** no se procesaron colas ni se modificaron los flags durante la auditoría. Si el canary no se ejecuta inmediatamente, el estado seguro es devolver los tres flags a `false`.

**Alternativa descartada:** asumir que el despliegue correcto de la normalización XML demuestra también la idempotencia de ventas. Son rutas de código y riesgos independientes.

## 2026-07-16 - El núcleo intradía queda habilitado en toda conexión Agora activa

**Decisión:** mantener `open_tickets_sync_enabled` e `intraday_sales_sync_enabled` en las `15` conexiones activas; el permiso de escribir stock desde tickets abiertos se decide por conexión.

**Razón:** todas las activas exponen el endpoint y ya tienen los dos flags de captura. Cienvinos y Jardi necesitan reconciliación definitiva por factura antes de aceptar mutaciones provisionales.

**Riesgos controlados:** una conexión puede capturar actividad sin mover stock. Las `13` conexiones desactivadas siguen `NOT_ACTIVE` y no se activan como efecto secundario.

**Alternativa descartada:** imponer `open_tickets_stock_sync_enabled=true` a toda la flota. Confundiría disponibilidad técnica con seguridad operativa.

## 2026-07-16 - La aceptación antiduplicado exige ledger exacto y varios ciclos

**Decisión:** validar la idempotencia intradía mediante ausencia de `idempotency_key` repetidas en `stock_sync_log` y un canary que sobreviva a varios reemplazos de snapshot.

**Razón:** los agregados del ERP pueden contener deuda histórica, mientras que la clave exacta demuestra si el runtime actual emitió dos veces el mismo objetivo.

**Evidencia:** `1.808` escrituras `SUCCESS` con clave, `0` claves duplicadas; canaries de Sa Pedrera y Kava sin repetición y con `sales_line_item_id=null` tras el refresco.

**Alternativa descartada:** considerar una huella visual idéntica o una diferencia agregada como prueba automática de duplicación. Puede representar dos ventas legítimas o datos anteriores al runtime actual.

## 2026-07-16 - La conciliación histórica nunca ejecuta limpiezas automáticas

**Decisión:** los desajustes Agora frente a ERP se convierten en tareas de revisión por restaurante y documento; no autorizan anulaciones, imports ni cambios de stock automáticos.

**Razón:** las ventanas históricas mezclan ventas manuales, aliases, mappings antiguos, pilotos intradía y facturas definitivas. Una limpieza por suma podría borrar una venta real.

**Alternativa descartada:** igualar totales anulando cualquier excedente aparente. No preserva trazabilidad ni garantiza la variante correcta.

## 2026-07-16 - Ocho conexiones quedan live-ready sin ocultar legacy

**Decisión:** activar De la O, El Portón de Sorní, Ocean Club, Finca Eslava, Vinatea, Don Quijote Marbella, Abadía Yuste y El Higuerón con catálogo/precios automáticos y captura intradía, manteniendo todo el legacy visible.

**Razón:** las ocho superan conectividad, ocho familias, cobertura completa de formatos elegibles, mappings/tracking verificados y cola cero.

**Riesgos controlados:** guardas de inicio de stock, centros/listas explícitos, conexión desactivada durante staging, lotes pequeños y auditoría fresh posterior.

**Alternativa descartada:** ocultar legacy o declarar `100%_SIGNED_OFF` sin una venta real de botella y copa observada en el ERP.

**Rollback:** desactivar conexión/auto-push y ocultar únicamente familias/productos Winerim; no borrar trazabilidad ni tocar legacy.

## 2026-07-16 - Ownership exacto puede recuperarse sin adoptar legacy

**Decisión:** recuperar mapping/tracking únicamente cuando el ID determinista coincide, el catálogo fresh devuelve `MATCH` total y existe tracking previo `source=WINERIM` para el mismo vino/formato.

**Razón:** una verificación literal de tabs frente a espacios dejó productos correctamente importados sin ownership confirmado.

**Riesgos controlados:** cualquier diferencia de precio, familia, flags, preparación o texto normalizado sigue abortando; un producto sin tracking previo nunca se adopta.

**Alternativa descartada:** hacer matching por nombre o reimportar a ciegas un ID ocupado.

## 2026-07-16 - Qtomas pausa catálogo pero conserva ventas

**Decisión:** bloquear de forma reversible las `59` tareas de catálogo, apagar auto-push y mantener la conexión/lectura de ventas activas.

**Razón:** Qtomas devuelve `No route to host` desde backend y desde esta máquina; seguir generando tareas solo amplía la cola y las alertas.

**Riesgos controlados:** no se elimina ninguna tarea; cuando el POS vuelva, se hará master fresh y se reencolarán solo diferencias reales.

**Alternativa descartada:** procesar los `QUEUED/FAILED` antiguos sin conocer el estado actual de Agora.

## 2026-07-16 - Las activaciones grandes se evalúan en lotes de diez

**Decisión:** reducir `evaluate-auto-push` a lotes de `10` y validar catálogos grandes por bloques cuando sea necesario.

**Razón:** lotes de `50` y auditorías monolíticas agotaron el límite de CPU alojado en Abadía Yuste e Higuerón.

**Riesgos controlados:** la conexión permanece desactivada durante staging y la cola se drena de forma síncrona; el resultado comercial no cambia.

**Alternativa descartada:** aumentar concurrencia. Podría sobrecargar Agora/SQL Server y reproducir incidentes de saturación.

## 2026-07-16 - Una correccion de stock no puede crear otra venta

**Decisión:** despues de anular una tarjeta ERP incorrecta, compensar el inventario mediante `No, solo ajuste` y no mediante `PUT /api/v2/stock/{stockId}`.

**Razón:** Winerim documenta y confirma en runtime que bajar stock por `PUT /stock` registra una venta como efecto lateral. Usarlo durante una limpieza recrea una tarjeta tecnica con la hora de mantenimiento.

**Riesgos controlados:** se lee el stock despues de la anulacion y se resta solo la cantidad repuesta, preservando cualquier movimiento concurrente.

**Alternativa descartada:** restaurar un valor absoluto por API. Mantiene el numero de unidades, pero ensucia el historial.

## 2026-07-16 - La verificacion de productos conserva los estados ocultos

**Decisión:** `verify-products` clasifica como `HIDDEN` los productos de vinos inactivos o formatos sin precio cuando Agora los devuelve no vendibles; si siguen vendibles, los marca `FAILED`.

**Razón:** verificar existencia, nombre y precio no significa que una variante retirada deba volver a `VERIFIED`.

**Riesgos controlados:** la lectura fresh de `UseAsDirectSale` y `SaleableAsMain` distingue un oculto correcto de un producto retirado que aun se puede vender.

**Alternativa descartada:** reescribir todo mapping existente como `VERIFIED`; ocultaria regresiones de visibilidad y reabriria formatos retirados en tracking.

## 2026-07-16 - Katsu se firma como LIVE, no como 100% formal

**Decisión:** cerrar la deuda de ventas y catalogo de Katsu en estado `LIVE`, manteniendo pendiente la firma `100%_SIGNED_OFF`.

**Razón:** ventas, stock, idempotencia, catalogo y cola ya pasan; faltan una alta o cambio real de precio observado, confirmacion visual del cliente y 24 horas limpias.

**Alternativa descartada:** llamar 100% a la conexion solo por una auditoria tecnica puntual.

## 2026-07-16 - El histórico Agora se netea por ciclo documental firmado

**Decisión:** agrupar cada línea física de Agora y sumar ticket, abono/anulación
y factura definitiva antes de crear una venta histórica.

**Razón:** ignorar cantidades negativas importó dos veces cinco unidades del
06/05 y conservó cuatro ventas que habían sido anuladas.

**Riesgos controlados:** se conserva el `orderId` de la primera línea positiva,
se verifica el ERP contra la fecha real de `soldAt` y se exige una segunda
ejecución íntegramente `skipped`.

**Alternativa descartada:** importar solo líneas positivas de `Invoices`.
Confunde documentos intermedios con ventas netas.

## 2026-07-16 - Katsu importa solo histórico demostrable

**Decisión:** registrar `253` tarjetas / `366` unidades del 16/04 al 23/06 y
dejar fuera `118` unidades de vinos inactivos y `11` sin match fiable.

**Razón:** `sales/import` no puede acceder a variantes inactivas y un alias
aproximado podría atribuir una venta al vino o formato equivocado.

**Riesgos controlados:** aliases versionados con variante explícita, stock
invariable antes/después, seis tarjetas no canónicas anuladas y stock
restaurado con `No, solo ajuste`.

**Alternativa descartada:** reactivar temporalmente vinos o forzar Hunters y
Garnacha Tintorera a una referencia parecida.

## 2026-07-17 - Un replay de ventas cerradas se ejecuta solo tras demostrar un hueco exacto

**Decisión:** permitir un `save-sales` dirigido a una única conexión y día cuando una lectura fresh de Agora y el ERP Winerim demuestran una línea cerrada ausente; repetir inmediatamente la auditoría después del replay.

**Razón:** Katsu tenía las dos ventas correctamente mapeadas, pero la venta de dos copas de Sarmentero a las `22:38` no había llegado al ERP. El replay recuperó esa única venta y omitió por idempotencia la de Abalón ya registrada.

**Riesgos controlados:** alcance limitado por `connection_id` y `businessDay`, claves idempotentes sin duplicados, cero cambios de catálogo y segunda conciliación obligatoria de unidades, importes, horas y origen `TPV`.

**Alternativa descartada:** reimportar una ventana amplia o corregir el ERP manualmente. Ambas opciones aumentarían el riesgo de duplicados y perderían la trazabilidad con el documento Agora original.

## 2026-07-17 - Casa Esteban no oculta legacy sin túnel ni snapshot fresh

**Decisión:** crear la conexión en staging desactivado, pero aplazar toda escritura y ocultación hasta que ConnectManager vuelva a exponer el Agora y exista un snapshot fresh verificable.

**Razón:** la URL facilitada devuelve `tunnel_not_found`. Sin leer familias, productos, centros, preparación y flags actuales no se puede distinguir legacy de elementos operativos ni garantizar una reversión exacta.

**Riesgos controlados:** `enabled=false`, `PULL_ONLY`, `write_mode=NONE`, catálogo y auto-push apagados. El token Winerim se valida de forma independiente sin enviar nada al TPV.

**Alternativa descartada:** preparar importaciones u ocultar por datos cacheados/inferidos. Podría dejar al restaurante sin botones de vino o escribir precios en centros/listas equivocados.

## 2026-07-17 - La auditoria diaria de Agora nunca repara por efecto secundario

**Decision:** mantener la auditoria de las 19:00 estrictamente en lectura y
separar sus hallazgos de cualquier actualizacion, reactivacion de flags,
procesamiento de colas u ocultacion.

**Razon:** una diferencia fresh demuestra una deuda concreta, pero no autoriza
por si sola una escritura; Qtomas y Sa Vida muestran que el contexto de
recursos y flags importa incluso cuando el catalogo actual parece exacto.

**Riesgos controlados:** cada reparacion posterior exige alcance reducido,
snapshot, cola vacia y lectura fresh posterior. `updated_at` del cache Winerim
no se acepta como evidencia de un cambio comercial real.

**Alternativa descartada:** corregir automaticamente todo FAIL o reintentar
tareas bloqueadas desde el monitor. Podria repetir productos ya exactos,
reactivar una flota pausada o saturar el Agora del cliente.

## 2026-07-18 - Catalogo exacto no equivale a automatizacion operativa

**Decision:** clasificar como `FAIL` una conexion activa cuyo catalogo fresh
sea exacto si los flags que publican altas y cambios permanecen apagados.

**Razon:** Qtomas esta `1430/1430` hoy, pero no existe garantia de que el
siguiente cambio de Winerim llegue a Agora mientras catalog sync, create,
update y verified-ready sigan desactivados.

**Riesgos controlados:** la reactivacion no se hace desde el auditor; exige un
canary de una sola referencia, cola vacia, comprobacion de idempotencia y
lectura fresh posterior.

**Alternativa descartada:** marcar `PASS` solo por igualdad puntual. Ocultaria
una averia funcional hasta que el siguiente alta o cambio de precio quedase
sin publicar.

## 2026-07-18 - Retirados se validan por estado actual y ownership demostrado

**Decision:** detectar formatos retirados vendibles comparando elegibilidad
Winerim actual con flags vendibles del master fresh, y limitar ownership a
tracking `VERIFIED`, `HIDDEN` o `FAILED`.

**Razon:** `NOT_PUSHED` no demuestra que el middleware creara o controle el
producto; usarlo podria ocultar legacy ajeno. Sa Vida demuestra el caso
contrario: dos copas verificadas ya no tienen precio y siguen vendibles.

**Riesgos controlados:** la auditoria solo informa; cualquier ocultacion se
ejecuta de forma diferencial con snapshot y verificacion fresh.

**Alternativa descartada:** inferir ownership por nombre o por presencia en
una familia Winerim. Ambas senales pueden coincidir con productos legacy.

## 2026-07-20 - Un estado de tracking no sustituye al master fresh

**Decision:** para clasificar visibilidad, la saleability observada en el
master fresh prevalece sobre `winerim_push_tracking`. Un estado `HIDDEN` es
evidencia de intencion o de una verificacion pasada, no del estado actual.

**Razon:** Sa Vida conserva `23` botellas con tracking `HIDDEN` que el master
actual devuelve vendibles. Marcar el caso como correcto por el tracking
ocultaria una regresion real en el terminal.

**Riesgos controlados:** la auditoria solo informa. La correccion exige
snapshot, ownership demostrado, escritura diferencial y lectura fresh final.

**Alternativa descartada:** confiar en el ultimo estado almacenado sin releer
Agora. No detecta reactivaciones locales, rollbacks ni deriva de flags.

## 2026-07-20 - Un breaker expirado no demuestra recuperacion

**Decision:** no reanudar ni procesar colas por el mero vencimiento de
`circuit_breaker_paused_until`; se exige una sonda fresh satisfactoria y una
reconciliacion de cada tarea con el catalogo actual.

**Razon:** De la O y Jardi tienen breakers vencidos, pero ambos endpoints
siguen devolviendo `No route to host` y mantienen tareas antiguas en cola.

**Riesgos controlados:** al recuperar la ruta se relee el master y solo se
ejecutan diferencias que sigan vivas, evitando duplicados y carga innecesaria.

**Alternativa descartada:** replay automatico al expirar el breaker. Puede
golpear un POS aun caido o repetir cambios ya aplicados localmente.

## 2026-07-20 - Los dias Agora sin facturas tambien avanzan el cursor

**Decision:** `auto-sync-sales` avanza `last_business_day_synced` hasta el
ultimo dia cerrado leido correctamente aunque no contenga facturas. Si una
lectura falla, detiene el escaneo y deja el cursor antes del fallo.

**Razon:** Katsu no tuvo facturas el 19/07. El middleware lo comprobaba cada
ciclo, pero dejaba el cursor en el 18 y el monitor abria una alerta falsa de
ventas estancadas.

**Riesgos controlados:** el avance exige HTTP satisfactorio y parseo valido;
no crea `sales_events`, no llama a Winerim y no toca stock. Los fallos devuelven
`closed_day_scan_failed` para reintento. Cobertura: `97/97` tests, build y
bundle de la funcion.

**Alternativa descartada:** silenciar `sales_stale` por actividad intradia
reciente. Habria ocultado un atasco real de cierre como el fallo de scope que
dejo pendiente la venta de Sarmentero del 17/07.

## 2026-07-20 - Katsu se certifica por evidencia fresh y ERP

**Decision:** declarar Katsu `100% TECHNICAL PASS / LIVE_AUTOMATIC` al cumplir
catalogo exacto, estructura, legacy no vendible, retirados ocultos, cola cero,
ventas ERP conciliadas, stock activo/inactivo, idempotencia y alertas cero.

**Razon:** la auditoria final aporta evidencia directa de Agora, Lovable Cloud
y el ERP Winerim; no depende solo de flags o tracking almacenado.

**Riesgos controlados:** la aceptacion visual del terminal y una venta real de
magnum quedan explicitamente fuera de la certificacion tecnica hasta que exista
evidencia externa. No se creo un vino, no se cambio un precio y no se invento
una venta para cerrar el checklist.

**Alternativa descartada:** exigir un canary destructivo sobre catalogo ya
exacto o declarar un `100%` absoluto sin separar lo observable remotamente de
la pantalla fisica del local.

## 2026-07-20 - Las ventas de vino se clasifican por ownership, no por score generico

**Decision:** para conciliar ventas Agora se contabilizan como vino las lineas
con mapping o tracking confirmado, los IDs legacy del snapshot y las familias
de vino explicitas. `is_wine_candidate` no se usa como cifra comercial final.

**Razon:** su heuristica por rango de precio marco como candidatos platos,
cervezas y sake de Katsu. El sabado habia `150` candidatos heuristicos, pero
solo `3` ventas reales de vino con ownership demostrado.

**Riesgos controlados:** se anade una busqueda secundaria por familia y
prefijos `B` / `C` para detectar vinos sin mapping, y el snapshot legacy se
contrasta por ID exacto.

**Alternativa descartada:** sumar todas las lineas `is_wine_candidate=true`.
Habria informado `158` unidades falsas frente a las `3` ventas reales.

## 2026-07-20 - Routing de modelos por riesgo y tipo de trabajo

**Decision:** usar GPT-5.6 Sol `high` como orquestador y operador de produccion,
GPT-5.6 Terra `high` para auditorias independientes y GPT-5.6 Luna `medium`
para comunicaciones. Activar Fast mode en este repositorio.

**Razon:** la configuracion global era GPT-5.5 `xhigh`, que aplica profundidad
costosa tambien a tareas repetitivas. El middleware necesita maxima capacidad
en mutaciones, pero una gran parte del trabajo es lectura estructurada o
redaccion sobre hechos ya demostrados.

**Riesgos controlados:** Sol conserva todas las escrituras y el sign-off; los
auditores son read-only por instruccion, los agentes de comunicaciones no
tocan sistemas y el orquestador revisa resultados. Se limita a seis hijos y
una sola profundidad.

**Alternativa descartada:** cambiar el modelo global o usar Luna/Spark para
todo. Lo primero afectaria repositorios ajenos y lo segundo reduciria garantias
en operaciones de produccion.

## 2026-07-20 - Clasificacion de sake por familia explicita

**Decision:** en las auditorias de Katsu, identificar el sake principalmente
por la familia Agora `SAKE BAR` y contrastar tambien nombre y formato. No usar
la heuristica generica de candidatos a vino.

**Razon:** `Jarra grande Shirayuki Traditional 55` es sake aunque su nombre no
contenga esa palabra; la familia aporta la evidencia de catalogo correcta.

**Riesgos controlados:** el contraste secundario permite detectar productos
mal clasificados, pero no convierte automaticamente platos que mencionen sake
en bebidas vendidas como sake.

**Alternativa descartada:** filtrar solo por texto `sake` o por
`is_wine_candidate`, porque ambos criterios pueden omitir o incluir productos
incorrectos.

## 2026-07-20 - Ventas de comida de Katsu por familia CARTA

**Decision:** considerar comida lo registrado en la familia Agora `CARTA`,
excluyendo las familias de liquidos, sake, vinos, copas y cafes, y presentar el
resultado neto despues de devoluciones.

**Razon:** la estructura real de Katsu separa explicitamente esas familias y
permite una cifra reproducible sin inferir por nombre o precio.

**Riesgos controlados:** el informe identifica que `CARTA` tambien contiene
extras, conceptos `VARIOS`, `Para llevar`, `ALERGICO` y menus con maridaje; no
los oculta silenciosamente.

**Alternativa descartada:** clasificar cada producto por palabras del nombre o
sumar solo lineas positivas, lo que ignoraria la devolucion real del sabado y
sobrestimaria `4` unidades / `43,75 EUR`.

## 2026-07-20 - Un catalogo exacto no cierra el canary de ventas

**Decision:** mantener Ocean Club y Finca Eslava en
`LIVE_PENDING_SALE_CANARY` aunque sus catalogos sean respectivamente
`113/113` y `123/123`.

**Razon:** Ocean no registra ninguna venta por botones Winerim y Finca solo
registra una venta inmediatamente anulada. Ninguna demuestra el ciclo completo
de venta neta, historial ERP, stock y repeticion idempotente.

**Riesgos controlados:** no se oculta legacy ni se corrige stock sin comprobar
la operativa real. La botella de Emilio Moro descontada por una venta anulada
queda identificada como residuo pendiente, no como canary valido.

**Alternativa descartada:** declarar ambas al 100 % a partir de flags, tracking
y catalogo exacto, o considerar la factura anulada de Finca como prueba real.

## 2026-07-20 - Historico Ocean Club separado del stock vivo

**Decision:** fijar el historico inicial de Ocean Club en
`2026-04-16..2026-07-15` e importarlo, cuando el mapping este aprobado,
exclusivamente mediante `POST /api/v2/sales/import` con IDs deterministas.

**Razon:** el dry-run confirma disponibilidad completa de `91` dias y cero
errores, mientras la automatizacion viva comienza el `16/07`. El endpoint de
importacion registra historial sin tocar stock.

**Riesgos controlados:** no se aplica ningun resultado fuzzy, los formatos
grandes requieren variante explicita y las teclas genericas de copa quedan
fuera hasta identificar el vino real. Antes y despues de cada lote se compara
el stock y se repite la importacion para verificar idempotencia.

**Alternativa descartada:** importar todas las lineas de familias de vino por
parecido de nombre o tratar cualquier `GLS ...` como una copa Winerim. Podria
crear historiales irreversibles sobre referencias o variantes equivocadas.

## 2026-07-20 - El Higueron es el siguiente cierre despues de Katsu

**Decision:** priorizar El Higueron como siguiente conexion para completar el
checklist al 100 %, antes de Finca Eslava, Ocean Club, Casa Nene, Taberna de
Elia y Sa Pedrera.

**Razon:** tiene catalogo fresh `292/292`, publicacion real medida en `61`
segundos, ocho familias, botella real, cola limpia y cero duplicados exactos.
Solo quedan dos discrepancias de venta identificadas y una prueba de copa.

**Riesgos controlados:** las discrepancias se corregiran por documento e
identidad idempotente; no se haran compensaciones con PUT de stock ni
reprocesados diarios completos. Legacy permanece reversible hasta la firma.

**Alternativa descartada:** elegir Finca u Ocean solo porque su catalogo es
exacto. Ambas carecen todavia de canaries completos de botella/copa y Finca
tiene pendiente una cancelacion con stock no restaurado.

## 2026-07-20 - Mapping explicito autoritativo en ventas Agora

**Decision:** cuando una linea Agora tiene un `product_mapping` confirmado, el
mapping determina su elegibilidad como vino y no puede ser anulado por la
heuristica generica `is_wine_candidate`.

**Razon:** la factura `14401` de El Higueron estaba correctamente mapeada a
`Domaine Vacheron Sancerre Blanc`, pero la heuristica la excluia y omitia una
venta real.

**Riesgos controlados:** los mappings `REJECTED` siguen siendo bloqueos
explicitos y el aislamiento por `connection_id` no cambia. Se cubrio la
precedencia con pruebas estaticas y una segunda ejecucion idempotente.

**Alternativa descartada:** ampliar palabras clave de la heuristica. No
resolveria de forma determinista productos renombrados y podria clasificar
falsos positivos.

## 2026-07-20 - Restauracion stale troceada y fail-closed

**Decision:** consultar tickets y ventas definitivas en bloques de como maximo
100 IDs y abortar la restauracion si cualquier consulta devuelve error.

**Razon:** una consulta de cientos de IDs desbordo el header de PostgREST y el
error se interpreto como conjunto vacio, restaurando dos ventas definitivas.

**Riesgos controlados:** el fallo cerrado puede retrasar una restauracion, pero
nunca debe modificar stock con evidencia incompleta. Los dos ajustes erroneos
se revirtieron mediante `No, solo ajuste` y sus logs se conservaron como
`SKIPPED` correctivo.

**Alternativa descartada:** ignorar el error y continuar con los resultados
parciales. Podria volver a aumentar stock de ventas validas.

## 2026-07-20 - Cierre tecnico de El Higueron sin venta ficticia

**Decision:** considerar reconciliada la parte tecnica de El Higueron, pero
mantener `LIVE_PENDING_SALE_CANARY` hasta observar una copa real y confirmar la
frescura de tickets durante un servicio actual.

**Razon:** catalogo, ventas cerradas, ERP, stock, cola, alertas e idempotencia
estan a cero diferencias, pero no existe una copa Winerim reciente y la sonda
solo devolvio tickets antiguos.

**Riesgos controlados:** no se declara `100%_SIGNED_OFF` por ausencia de
evidencia ni se crea una venta de prueba que contamine la operativa del
cliente. Legacy permanece visible y reversible.

**Alternativa descartada:** cerrar al 100 % usando solo una botella y flags de
configuracion como prueba suficiente.

## 2026-07-20 - Tintorera permanece NOT_ACTIVE

**Decision:** mantener Tintorera desactivada, sin escritura ni automatismos,
hasta que `/api/` y el master de Agora respondan fresh desde Lovable Cloud.

**Razon:** el 20/07 el acceso directo volvio a terminar en timeout y la sonda
del backend no respondio en 120 segundos. La conexion no tiene master, ventas,
mappings, tracking ni sincronizaciones anteriores.

**Riesgos controlados:** no se encolan los 302 vinos Winerim ni se toca el
legacy sin poder verificar el resultado o ejecutar un rollback preciso.

**Alternativa descartada:** activar la conexion confiando en el catalogo
Winerim o en el DDNS resuelto. Resolver DNS no demuestra que Agora escuche ni
que el puerto externo sea alcanzable.

## 2026-07-20 - Escalado de red de Tintorera al operador del router

**Decision:** coordinar la siguiente comprobacion con el cliente u operador
que tenga acceso al router, manteniendo al SAT de Agora en la validacion local.

**Razon:** Diser Tic confirma que modulo, API HTTP e importacion estan activos,
pero no administra el router y considera probable que el servidor haya
cambiado de IP local. El timeout externo es compatible con una regla NAT que
apunta a la direccion anterior.

**Riesgos controlados:** se exige primero validar Agora en la LAN y despues
probar el mismo puerto desde una red externa. La IP final debe quedar fija o
reservada para evitar que el problema reaparezca.

**Alternativa descartada:** continuar intercambiando tokens o hacer una llamada
solo con Winerim y el SAT de Agora. Ninguna de esas acciones modifica la regla
NAT si no participa quien administra el router.

## 2026-07-20 - Casa Nene: separar automatizacion sana de duplicados historicos

**Decision:** mantener activos los automatismos actuales de Casa Nene y tratar
las `17` tarjetas incorrectas como una limpieza historica acotada, sin pausar
catalogo, intradia ni cierre diario.

**Razon:** el catalogo fresh esta `317/317`, el tracking queda `317 VERIFIED / 30
HIDDEN`, la cola y las alertas estan vacias y el patron duplicado no reaparece
desde el parche que preserva claims de stock. Los duplicados se concentran en
el piloto antiguo del 15/07 y una venta provisional cancelada del 17/07.

**Riesgos controlados:** antes de cualquier anulacion se guardaron IDs, horas,
facturas, stocks y deltas esperados. Bancales exige `No, solo ajuste` tras la
anulacion porque el middleware ya habia restaurado su unidad.

**Alternativa descartada:** reprocesar dias completos, sobrescribir stocks con
valores absolutos o pausar una integracion actualmente sana. Cualquiera de esas
acciones ampliaria el impacto y podria duplicar ventas nuevas.

## 2026-07-20 - El auditor debe leer los campos que compara

**Decision:** ampliar la consulta de `sales_line_items` del auditor intradia
para incluir nombre, precio unitario y timestamp proveedor con su fuente.

**Razon:** el informe usaba esos campos despues de seleccionar solo IDs,
cantidad, mapping y formato, por lo que podia mostrar ceros o nulos engañosos.

**Riesgos controlados:** es un cambio estrictamente read-only; no modifica
ventas, stock, catalogo ni el runtime de las Edge Functions.

**Alternativa descartada:** seguir interpretando los nulos como ausencia de
datos reales, porque podia generar correcciones operativas innecesarias.

## 2026-07-20 - Casa Nene separa visibilidad publica y venta interna por copa

**Decision:** permitir exclusivamente en Casa Nene que una variante `GLASS`
configurada siga vendible en Agora aunque la ficha este inactiva en la carta
publica de Winerim.

**Razon:** el restaurante necesita consultar y vender las copas desde el TPV,
pero no quiere ofrecerlas al cliente en la carta publica. Son dos superficies
con objetivos distintos y no deben compartir obligatoriamente el mismo flag.

**Riesgos controlados:** la excepcion exige flag por conexion, lista explicita
y precio positivo; no habilita botella ni magnum, no cambia Winerim y esta
cubierta en generacion XML, cola, verificacion, auditoria y reconciliacion. La
lista de 31 precios y el rollback quedan documentados.

**Alternativa descartada:** activar las 31 fichas publicas o relajar globalmente
el bloqueo de vinos inactivos. La primera contradice la operativa comercial de
Casa Nene y la segunda podria volver vendibles productos retirados de otros
restaurantes.

## 2026-07-20 - No publicar copas con un runtime anterior

**Decision:** no encolar las 31 copas hasta que Lovable Cloud ejecute el commit
`e10e1ac` y una sonda dry-run reconozca la excepcion.

**Razon:** tras guardar la configuracion, el runtime devolvio `no wines found`
para una referencia ausente del cache, demostrando que seguia desplegada la
version anterior.

**Riesgos controlados:** la configuracion nueva es inerte para el runtime
anterior; Agora no cambia y no se crean tareas que puedan procesarse con una
logica incompleta.

**Alternativa descartada:** encolar primero y confiar en que el despliegue se
produzca antes del dispatcher. Ese orden introduce una carrera evitable.

## 2026-07-20 - Publicacion controlada de las 31 copas internas de Casa Nene

**Decision:** publicar exclusivamente las 31 variantes `GLASS` configuradas en
Casa Nene, en lotes de cinco como maximo y con auditoria fresh obligatoria tras
cada lote.

**Razon:** el runtime `5d30421` confirmo que botella y magnum de esas fichas
inactivas siguen bloqueados y que las unicas diferencias reales eran 31 copas
ausentes. La ejecucion termino en `348/348 MATCH`, 31 mappings confirmados, 31
tracking verificados y cola vacia.

**Riesgos controlados:** la auditoria rechaza colisiones, diferencias sin
ownership y fallos de validacion; el proceso se detiene si un lote no converge.
La carta publica de Winerim no se modifica y el rollback oculta solo esos 31
productos `GLASS`.

**Alternativa descartada:** una importacion masiva sin verificaciones
intermedias o reactivar las fichas en la carta publica. Ambas opciones amplian
el impacto y la segunda contradice la peticion comercial del cliente.

## 2026-07-20 - Finca Eslava: corregir inventario sin inventar una venta

**Decision:** restaurar Emilio Moro de `82` a `83` mediante el ajuste manual
`No, solo ajuste`, despues de confirmar que la factura y su devolucion netean
cero y que no hubo otra venta posterior del producto.

**Razon:** la venta positiva ya habia creado una tarjeta TPV y descontado una
unidad; compensarla mediante `PUT /stock` habria creado otra venta y falseado
el historial. El ajuste sin venta repara exclusivamente el inventario.

**Riesgos controlados:** se guardaron factura, devolucion, stockId, stock antes
y despues y la instruccion de rollback. La lectura posterior confirma stock
`83`, catalogo `123/123 MATCH`, cola vacia e idempotencia sin duplicados.

**Alternativa descartada:** considerar la integracion al 100 % o borrar la
tarjeta TPV sin un endpoint de anulacion idempotente. El historial conserva una
diferencia conocida y Finca sigue pendiente de un canary real de botella y
copa.

## 2026-07-20 - Ocean Club debe mostrar Winerim y conservar legacy hasta el canary

**Decision:** activar `ShowInPos` solo en las ocho familias Winerim y restaurar
la visibilidad de las cinco familias legacy con producto, sin modificar
productos, precios, orden, mappings ni ventas.

**Razon:** el catalogo Winerim estaba `113/113 MATCH`, pero sus familias estaban
ocultas; el personal solo habia vendido con botones anteriores. Ademas, la
decision operativa era conservar legacy hasta validar ventas, y sus familias
tambien aparecian ocultas pese a conservar `162` productos vendibles.

**Riesgos controlados:** cada escritura reutilizo el XML completo de Agora y
fue verificada con una lectura fresh. Se guardaron los trece IDs y el estado
previo; catalogo, cola y alertas se comprobaron despues y siguen sanos.

**Alternativa descartada:** ocultar productos legacy o firmar el 100 % solo por
catalogo. Ocean aun no ha generado ninguna venta Winerim y no dispone de una
variante de copa con precio para ejecutar ese canary.

## 2026-07-20 - El auditor de Ocean usa el alias administrativo Oceans

**Decision:** asociar `Ocean Club` con los alias `Oceans` y `Ocean Club` en el
auditor read-only de historial.

**Razon:** el nombre de la conexion no coincide con el registro administrativo;
sin el alias el auditor devolvia una ambiguedad y no encontraba el menu `756`.

**Riesgos controlados:** el cambio solo afecta busqueda y lectura del ERP; no
escribe en Agora, Winerim ni Lovable Cloud.

**Alternativa descartada:** mantener una comprobacion manual recurrente, que
podria dejar pasar la ausencia de ventas en futuras auditorias.

## 2026-07-20 - Los tickets abiertos tienen prioridad sobre el cierre diario

**Decision:** despachar para Agora primero tickets abiertos, despues intradia y
por ultimo cierre diario; mientras exista un dia abierto reciente, el cursor de
cerrados no puede avanzar por encima del dia anterior.

**Razon:** Vinatea mantenia tickets del 19/07 despues de que el cursor hubiera
avanzado a ese mismo dia. Si el ticket se factura mas tarde, el proceso diario
podria empezar en el 20/07 y no volver a leer la factura tardia.

**Riesgos controlados:** el solapamiento conserva la idempotencia existente y
solo retrocede el cursor al ultimo dia cerrado seguro. El guard exige una sonda
reciente y satisfactoria de tickets, y expira por defecto a los 30 minutos.

**Alternativa descartada:** ampliar siempre el lookback varios dias. Aumenta la
carga sobre Agora y no distingue una mesa realmente abierta de un replay
historico.

## 2026-07-20 - Vinatea mapea legacy exacto mientras siga visible

**Decision:** crear `110` mappings legacy confirmados con metodo
`LEGACY_EXACT_20260720`, sin modificar productos ni familias.

**Razon:** Vinatea conserva botones anteriores vendibles y sus ventas no podian
resolverse. Las coincidencias son `105` nombres unicos de botella y cinco copas
revisadas individualmente.

**Riesgos controlados:** rollback por `connection_id + match_method`; no se
oculta legacy, no se cambia catalogo y los mappings Winerim existentes quedan
fuera del alcance.

**Alternativa descartada:** ocultar legacy sin validacion del cliente o usar
matching fuzzy para escribir. Ambas opciones pueden romper su operativa.

## 2026-07-20 - Pausar historicos de variantes ante inconsistencia de Winerim

**Decision:** no ejecutar mas importaciones historicas de copa/magnum ni
cancelar las nueve tarjetas de Vinatea hasta corregir `/api/v2/sales/import`.

**Razon:** el endpoint acepto `9` lineas / `16` copas y no altero stock, pero el
ERP las muestra como nueve botellas de cantidad uno. Los cinco stockIds se
confirmaron como `copa` con stock desactivado.

**Riesgos controlados:** la segunda pasada demostro idempotencia; se conserva
el snapshot sin stock cambiado y no se intentan compensaciones manuales.

**Alternativa descartada:** reenviar una fila por unidad o cancelar a ciegas.
La primera multiplicaria tarjetas con variante incorrecta y la segunda podria
modificar inventario.

## 2026-07-21 - Don Quijote conserva el botón oficial y absorbe el duplicado manual

**Decisión:** mantener como referencia operativa
`932976 - C Arzuaga Crianza`, crear un mapping confirmado y reversible desde
el producto manual `1153518` hacia el vino Winerim `232976 / GLASS`, recuperar
solo sus ventas del `19` y `20` de julio y ocultar únicamente el duplicado.

**Razón:** el precio de copa a `10 EUR` sí estaba publicado y el catálogo fresh
era exacto. El historial faltaba porque el personal vendió desde un producto
creado directamente en Agora, sin vínculo con Winerim.

**Riesgos controlados:** el producto oficial no se modificó; el mapping manual
no transfiere ownership; el stock estaba inactivo y permaneció en `0`; el
replay se limitó a dos días y una segunda pasada confirmó idempotencia. El
duplicado se ocultó mediante flags reversibles, sin borrarlo.

**Alternativa descartada:** eliminar el duplicado, reemplazar el producto
oficial o descontar stock manualmente. Cualquiera de esas opciones perdería
trazabilidad o introduciría un movimiento de inventario que no corresponde.

## 2026-07-21 - Ocean Club navega por categorías y conserva familias ocultas

**Decisión:** mantener las ocho familias Winerim con `ShowInPos=false` y usar
categorías como única capa visual de venta, después de que el SAT confirme el
mecanismo oficial de creación/asociación y el alcance por grupo de TPV.

**Razón:** Ocean Club necesita una navegación rápida y específica por zona. La
familia es uno-a-uno y sirve para informes; la categoría admite jerarquía,
varias pertenencias y restricción por grupo de TPV.

**Riesgos controlados:** la revisión fue de solo lectura; el catálogo permanece
`113/113 MATCH` y no se tocó ningún producto. La API estándar rechaza
`Categories`, por lo que no se usarán endpoints internos ni XML no documentado.
La primera categoría se validará como piloto reversible antes de ampliar.

**Alternativa descartada:** volver a mostrar las familias Winerim o asignar
manualmente cada alta nueva. La primera degrada la operativa de sala y la
segunda rompe el objetivo de automatización.

## 2026-07-21 - Finca Eslava no se firma mientras venda por botones genéricos

**Decisión:** conservar Finca Eslava en `LIVE_PENDING_SALE_CANARY`, mantener el
legacy visible hasta validar la operativa con el cliente y no mapear botones
genéricos como `COPA TINTO`, `COPA BLANCO` o `COPA FRIZANTE` a un vino Winerim.

**Razón:** la conexión, el catálogo `123/123`, la cola y la idempotencia están
sanos, pero la única venta procedente de un botón Winerim fue anulada. Los días
19 y 20 el restaurante siguió usando respectivamente 13 y 16 copas legacy sin
identidad de referencia, que no permiten registrar ni descontar el vino real.

**Riesgos controlados:** no se modifica catálogo ni inventario y no se oculta
ningún botón que el equipo siga necesitando. La ocultación futura se limitará a
productos con sustituto Winerim exacto y tendrá rollback.

**Alternativa descartada:** asignar todas las copas genéricas a un vino por
defecto. Esa regla produciría ventas y descuentos de stock falsos cuando el
camarero sirviera otra referencia.
## 2026-07-21 · Abadia Yuste permanece LIVE con legacy pendiente

- **Hecho**: el catalogo Winerim esta `281/281` y tres ventas reales de botella
  coinciden exactamente entre Agora, los logs duraderos y el ERP Winerim.
- **Decision**: clasificar la conexion como `LIVE / WARN_LEGACY`, sin firmarla
  al 100% hasta validar una copa Winerim, stock activo y propagacion de
  catalogo observada.
- **Razon**: entre el 17 y el 20 de julio se vendieron 28 unidades mediante
  botones legacy sin mapping; cuatro son copas genericas que no identifican el
  vino servido.
- **Alternativa descartada**: mapear automaticamente `Copa Rioja`, `Copa
  Ribera del Duero`, `Copa Vino extremeno` o `Copa semidulce`. Seria ambiguo y
  podria descontar una referencia incorrecta.
- **Rollback**: esta auditoria no ha escrito en Agora, Winerim ni Lovable
  Cloud. Se conserva todo el legacy intacto.

## 2026-07-21 - Las ventas que agotan stock importan solo el residual

**Decision:** cuando una venta supera el stock activo disponible, descontar
hasta cero mediante `PUT /stock/{id}` e importar por `sales/import` únicamente
la cantidad no cubierta por ese movimiento.

**Razon:** De la O vendio dos unidades de `Camarolos` con stock uno. El stock
bajo correctamente `1 -> 0`, pero el historial solo reflejo una unidad porque
el fallback anterior se ejecutaba unicamente cuando el stock no se movia.

**Riesgos controlados:** el calculo es `venta - movimiento real`, nunca
negativo; una venta normal totalmente cubierta no importa nada adicional, y
stock cero o inactivo conserva el comportamiento sales-only. Se mantienen los
order IDs deterministas y la idempotencia existente.

**Alternativa descartada:** importar siempre la cantidad completa despues del
PUT. Duplicaria en historial todas las unidades que Winerim ya registra al
descontar stock.

## 2026-07-21 - De la O no se firma con legacy activo

**Decision:** mantener De la O como `LIVE / WARN_LEGACY_AND_HISTORY` y no
ocultar ni mapear automaticamente sus botones antiguos durante la auditoria.

**Razon:** el catalogo Winerim esta `112/112`, pero entre el 16 y el 18 de julio
se vendieron al menos 56 unidades desde 14 botones legacy. Varios nombres son
ambiguos o no tienen hoy precio de copa en Winerim.

**Riesgos controlados:** se conserva la operativa actual y no se atribuye una
venta a una referencia incorrecta. Las dos diferencias historicas quedan
documentadas y no se compensan sin autorizacion.

**Alternativa descartada:** usar matching fuzzy y ocultar todo el legacy en una
sola pasada. Podria romper botones que el equipo sigue utilizando y descontar
el vino equivocado.

## 2026-07-21 - La factura definitiva prevalece sobre tickets abiertos

**Decision:** considerar la escritura de stock desde tickets abiertos no
reversible con la API actual y no firmar al 100 % una conexion que dependa de
ella hasta desactivar el write provisional o disponer de anulacion idempotente.

**Razon:** se localizaron 18 casos de riesgo en ocho conexiones. Restaurar
stock no elimina la venta creada por el descenso inicial, y la factura
definitiva puede crear una segunda tarjeta.

**Riesgos controlados:** no se cambiaron flags ni historiales durante la
auditoria. Se conserva la lectura de tickets y las facturas cerradas como
reconciliacion autoritaria.

**Alternativa descartada:** compensar con otro `PUT /stock` o enviar cantidad
negativa a `/sales/import`. La primera fabrica historial tecnico y la segunda
no esta admitida por la API.

## 2026-07-21 - Un mapping definitivo prevalece sobre clasificacion historica

**Decision:** en facturas definitivas, procesar toda linea con
`winerim_product_id` resuelto aunque un snapshot antiguo conserve
`is_wine_candidate=false`; para tickets abiertos se mantiene el gate de edad y
candidato.

**Razon:** Kava perdio tres copas de Pampaneando pese a tener mapping
confirmado, stockId de copa y factura cerrada.

**Riesgos controlados:** el cambio local no esta desplegado; compila con
esbuild y las aserciones estaticas pasan. No se reproceso ningun dia.

**Alternativa descartada:** corregir manualmente solo las tres filas. Dejaria
el mismo defecto latente en el resto de conexiones.

## 2026-07-21 - El estado de flota se firma con evidencia, no con salud tecnica

**Decision:** usar `docs/operations/agora-fleet-checklist-2026-07-21.md` como
corte operativo de las 30 conexiones y mantener `0` conexiones en
`100%_SIGNED_OFF` hasta completar todos los criterios aplicables.

**Razon:** varias instalaciones tienen catalogo fresh exacto, cola vacia y
breaker cerrado, pero venden por legacy, no tienen conciliacion ERP reciente o
conservan escritura provisional que puede dejar una tarjeta positiva tras una
cancelacion. Esos estados no son equivalentes a una integracion completa.

**Riesgos controlados:** la auditoria fue conservadora y no reactivo las ocho
conexiones deshabilitadas, no oculto legacy, no reasigno ownership ambiguo y no
compenso historial a ciegas. Cada bloqueo conserva evidencia y rollback en su
checklist individual.

**Alternativa descartada:** declarar al 100 % las conexiones con catalogo
exacto o sin cola activa. Ocultaria fallos de negocio que solo aparecen al
comparar Agora con el ERP Winerim y al probar cancelaciones o recuperacion.

## 2026-07-21 - Saddle permanece en solo lectura hasta modelar menus y armonias

**Decision:** no activar Saddle ni publicar familias Winerim hasta disponer de
catalogo/mappings Winerim y un snapshot versionado de la composicion de cada
menu y armonia procedente de tSpoonLab.

**Razon:** Agora entrega 129 facturas y 1.924 lineas en siete dias, pero las
ventas de menu no describen de forma suficiente qué vinos y formatos deben
consumirse. Solo una linea hija observada no permite inferir el resto.

**Riesgos controlados:** se mantiene `enabled=false`, `PULL_ONLY` y
`write_mode=NONE`; no se escribio en Agora ni Winerim. Las cancelaciones y
referencias de devolucion quedan disponibles para una conciliacion futura.

**Alternativa descartada:** descontar el menu como un producto unico o inferir
la armonia por nombre. Ambas opciones producirian consumos de vino falsos y
romperian la trazabilidad de variantes.

## 2026-07-21 - El Higueron usa orden alfabetico sin alterar la identidad tecnica

**Decision:** configurar exclusivamente El Higueron con orden alfabetico por
nombre dentro de cada familia Winerim y retirar `B/C/M` solo del
`ButtonText`. El `Name` interno conserva el prefijo tecnico.

**Razon:** el cliente necesita una navegacion alfabetica limpia, pero el nombre
tecnico distingue botella, copa y magnum y participa en matching, ventas y
trazabilidad. Eliminarlo de ambos campos introduciria colisiones y regresiones.

**Riesgos controlados:** el cambio queda detras de dos claves por conexion, usa
ocho IDs de familia exactos, bloquea etiquetas visibles duplicadas, conserva el
XML completo, verifica por lectura fresh y devuelve rollback. No se activo en
produccion mientras el runtime vivo siga devolviendo `Unknown action`.

**Alternativa descartada:** quitar globalmente los prefijos de `Name` o cambiar
el orden de toda la flota. Romperia el comportamiento ya validado de otras
instalaciones y podria volver ambiguas las variantes.

## 2026-07-21 - El Higueron resuelve colisiones visibles sin perder formato

**Decision:** aplicar la presentacion alfabetica a los `292` productos de las
ocho familias Winerim de El Higueron, manteniendo el prefijo tecnico en
`Product.Name` y usando abreviatura existente o sufijo distintivo cuando dos
`ButtonText` coinciden tras truncar a 20 caracteres.

**Razon:** el primer dry-run detecto dos colisiones reales: Juvé & Camps
Milesime/Milesime Rose y Conde de San Cristobal. Quitar B/C/M sin
desambiguacion habria dejado botones visualmente identicos. Ademas, Agora
recorta espacios finales y la verificacion debe normalizarlos igual.

**Riesgos controlados:** la operacion se ejecuto con snapshot XML, rollback
automatico y verificacion fresh. Dos intentos no idempotentes se revirtieron
antes de activar la configuracion definitiva. La aplicacion final verifico
`292/292`, y la segunda pasada devolvio `changed=0` y cero colisiones. Las tres
claves viven solo en `provider_config` de El Higueron.

**Alternativa descartada:** numerar siempre los botones repetidos o eliminar
el prefijo tambien de `Product.Name`. La primera opcion empeora la operativa y
la segunda rompe identidad de variante, matching y trazabilidad.

## 2026-07-21 - Kava conserva Pampaneando Winerim y no reactiva el boton legacy

**Decision:** mantener como productos operativos `747191 B Pampaneando` y
`947191 C Pampaneando`, y conservar oculto `83889 C. PAMPANEANDO TINTO` junto
con el resto de productos legacy sustituidos.

**Razon:** la lectura fresh confirma que botella y copa Winerim existen, son
vendibles y estan en familias visibles. El texto `Tinto` no aparece porque la
ficha canonica Winerim se llama `Pampaneando`; el boton que si lo incluia era
el legacy retirado.

**Riesgos controlados:** no se escribio en Agora, no se cambiaron precios,
stock, mappings ni flags. Cualquier cambio de etiqueta debe comenzar en
Winerim para que la automatizacion siga siendo la fuente de verdad.

**Alternativa descartada:** reactivar el boton legacy o renombrar solo en
Agora. Ambas opciones crearian dos rutas de venta o una diferencia que la
siguiente sincronizacion automatica podria revertir.

## 2026-07-21 - La retirada de legacy Agora se valida por producto y ownership

**Decision:** considerar legacy completamente oculto solo cuando la familia no
sea visible y cada producto sustituido tenga `SaleableAsMain=false` y
`UseAsDirectSale=false`. Antes de ocultar se exige cobertura Winerim fresh,
ownership o mapping confirmado, snapshot reversible y canary de venta.

**Razon:** `ShowInPos=false` oculta la familia de la navegacion, pero no impide
que sus productos sigan vendibles o aparezcan en el buscador. Ademas, las
familias mixtas y los productos `SIN_OWNERSHIP` no pueden clasificarse como
legacy solo por su nombre o ubicacion.

**Riesgos controlados:** la auditoria fue estrictamente de solo lectura y
separa legacy visible, producto buscable bajo familia oculta, ocultacion
completa, preservacion expresa y conexiones no auditables. Cualquier limpieza
futura sera diferencial y reversible; no se permite ocultacion masiva cuando
haya piloto, estructura especial, matching incompleto o uso legacy reciente.

**Alternativa descartada:** ocultar familias completas o todo producto sin
ownership. Podria retirar botones aun usados, productos de terceros o
referencias Winerim cuya trazabilidad todavia no esta normalizada.

## 2026-07-21 - El PASS de catalogo exige comprobar tambien formatos retirados

**Decision:** una conexion Agora solo puede clasificarse como catalogo `PASS`
cuando el catalogo fresh coincide para todos los formatos elegibles y, ademas,
ningun producto Winerim inactivo, sin precio o ya ausente sigue vendible.

**Razon:** la auditoria de productos activos puede devolver `N/N MATCH` aunque
queden botones antiguos accesibles por navegacion o buscador. Qtomas y
Restaurante Triana demostraron este caso en el corte de las 19:01.

**Riesgos controlados:** la auditoria programada no corrige ni procesa colas.
Las retiradas se haran solo sobre ownership Winerim demostrado, con lectura
fresh, snapshot, lotes pequenos, verificacion posterior y rollback.

**Alternativa descartada:** considerar suficiente el conteo de productos
activos o esconder solo la familia. Ambas opciones pueden dejar productos
vendibles y ventas fuera de la trazabilidad esperada.

## 2026-07-22 - El Bejeque escribe ventas solo desde facturas cerradas

**Decision:** mantener la lectura de tickets abiertos exclusivamente para
observabilidad, desactivar su escritura provisional de stock/ventas y usar las
facturas cerradas como unica fuente definitiva hacia Winerim.

**Razon:** una linea abierta ya generaba una tarjeta ERP; su cancelacion podia
restaurar stock, pero no retirar esa tarjeta de forma idempotente. Al cerrar la
factura se importaba otra tarjeta definitiva, produciendo seis duplicados
funcionales exactos en el historico.

**Riesgos controlados:** se repitieron dos lecturas de tickets y dos de facturas
sin datos nuevos y no aparecieron nuevas escrituras. Se conserva la lectura de
tickets para diagnostico, mientras el stock y el historial solo cambian con un
documento cerrado.

**Alternativa descartada:** seguir escribiendo provisionalmente y compensar
despues con ventas negativas. La API disponible no ofrece anulacion segura de
la tarjeta ERP y la compensacion podria restaurar stock dos veces.

## 2026-07-22 - La jerarquia visual Agora se implementa con familias padre

**Decision:** cuando un cliente necesite `VINOS > TINTOS WINERIM > producto`,
usar `ParentFamilyId` sobre las familias Winerim. En De la O la raiz existente
es `VINOS`, ID `4`; no se aplicara hasta validar la disposicion en terminal con
el cliente.

**Razon:** la Guia del Integrador documenta la jerarquia de familias y el
codigo ya soporta `familyParentId`. La entidad independiente `Categories` no
dispone de un flujo oficial de importacion/exportacion equivalente que el
middleware pueda mantener automaticamente.

**Riesgos controlados:** Agora admite solo dos niveles de familia. La familia
Winerim es la hija y el producto el destino; no se creara otra subfamilia bajo
ella. El cambio futuro sera por conexion, con snapshot y comprobacion visual.

**Alternativa descartada:** escribir categorias mediante endpoints no
documentados o asumir tres niveles de familias. Ambas opciones comprometen la
compatibilidad y la automatizacion futura.

## 2026-07-22 - Un timeout de la API Agora no autoriza reencolado ciego

**Decision:** si la portada del servidor responde pero `/api/export/` y
`/api/export-master/` agotan timeout, detener la reconciliacion y no reencolar
masivamente tareas fallidas. Tras recuperar la API se repetira una lectura
fresh y solo se republicaran diferencias reales.

**Razon:** en Chiquilla la cola estaba vacia y diez de once vinos con fallos
anteriores ya tenian un `SUCCESS` posterior. Reintentar todo mientras el
servicio de integracion no responde aumentaria carga sin aportar certeza.

**Riesgos controlados:** el fallo nuevo queda identificado por conexion, vino y
tarea; no se altera tracking, catalogo ni stock. La recuperacion se valida
antes de escribir.

**Alternativa descartada:** resetear todos los `FAILED` o forzar una
sincronizacion completa. Podria repetir escrituras ya verificadas y volver a
saturar el servidor Agora.

## 2026-07-22 - La firma Agora se concede por diez bloques y evidencia real

**Decision:** certificar una conexion como `100%_SIGNED_OFF` solo cuando pasan
con evidencia vigente conectividad, configuracion, catalogo, cambios
automaticos, estructura/legacy, ventas, stock, resiliencia, monitorizacion y
aceptacion final. Una ausencia de prueba es `WARN`, una discrepancia comprobada
es `FAIL` y una conexion deshabilitada es `NOT_ACTIVE`.

**Razon:** la auditoria de las 30 conexiones demostro que un catalogo exacto,
una cola vacia o un health HTTP verde pueden coexistir con ventas omitidas,
duplicados funcionales, legacy usado sin mapping, cursores bloqueados o stock
no conciliado. Solo una evaluacion completa representa el comportamiento que
ve el restaurante y el historial que recibe Winerim.

**Riesgos controlados:** la auditoria fue de solo lectura, las conexiones
deshabilitadas no se sondearon y los fallos se documentaron por documento,
variante o producto cuando existia evidencia. Las correcciones futuras seran
diferenciales, con snapshot, idempotencia, rollback y observacion posterior.

**Alternativa descartada:** considerar `N/N MATCH`, `READY`, breaker cerrado o
cero tareas pendientes como equivalente a una integracion completa. Esos
indicadores no detectan la integridad semantica de ventas, cancelaciones y
stock.

## 2026-07-22 - La conciliacion definitiva prevalece sobre la escritura provisional

**Decision:** priorizar factura/documento definitivo como fuente de escritura
de historial mientras Winerim no disponga de anulacion remota idempotente de
una venta provisional. Los tickets abiertos pueden usarse para observabilidad,
pero no deben crear una segunda tarjeta funcional sin una reversión completa.

**Razon:** Kava, PurOsushi, Qtomas, Taberna de Elia y Sa Vida muestran ciclos
provisional, restauracion y definitivo con claves distintas. La idempotencia
tecnica pasa, pero el historial ERP puede conservar dos tarjetas positivas.

**Riesgos controlados:** el cambio se aplicara por conexion despues de
conciliar su fuente real, sin borrar historial ni compensar por nombre. Se
validaran cancelacion, stock neto, tarjeta ERP unica y recuperacion antes de
extenderlo a la flota.

**Alternativa descartada:** mantener ambas fuentes escribiendo y confiar solo
en claves idempotentes exactas. No evita duplicados semanticos con IDs o fases
de documento diferentes.

## 2026-07-22 - Los artefactos superseded se cierran sin replay

**Decision:** normalizar una tarea terminal como objetivo satisfecho solo si el
catalogo fresh demuestra coincidencia exacta y ownership, no existe cola activa
y la tarea no necesita volver a ejecutarse. Los fallos de stock de referencias
retiradas se clasifican `SKIPPED`, no `SUCCESS`.

**Razon:** Chiquilla tenia una tarea `FAILED` cuyo producto ya estaba exacto;
Sa Vida conservaba 24 bloqueos de un rollback de canary aunque el catalogo
posterior era `1542/1542`; Sa Pedrera conservaba un 404 reciente de Albenc, ya
inactivo, rechazado y oculto. Reintentar cualquiera de ellos habria creado
riesgo sin cambiar el estado deseado.

**Riesgos controlados:** cada escritura se hizo por ID y estado esperado, con
snapshot `0600`, evidencia fresh, rollback automatico y verificacion posterior.
El estado y error originales quedaron dentro de los metadatos de resolucion.
No se tocaron productos, ventas, stock, mappings ni funciones compartidas.

**Alternativa descartada:** borrar registros, reencolar tareas o marcar Albenc
como descuento correcto. Las tres opciones falsearian trazabilidad o podrian
duplicar una operacion ya satisfecha o imposible.

## 2026-07-22 - Un ticket abierto huerfano no autoriza saltar ventas definitivas

**Decision:** mantener sin cambios los cursores de Abadia Yuste, El Higueron y
Finca Eslava mientras el primer dia definitivo pendiente contenga vinos legacy
sin mapping. No se desactiva el techo de tickets abiertos hasta que ese backlog
pueda procesarse cronologicamente y completo.

**Razon:** Agora devuelve facturas cerradas, pero tambien tickets abiertos de
dias antiguos. En Higueron y Finca el ticket mas antiguo fija exactamente el
techo actual; en Abadia aparecen tickets desde 2025. Retirar el guard permitiria
al cron avanzar sobre ventas legacy no resueltas y perder su descuento o
historial.

**Riesgos controlados:** se tomo snapshot fresh, se reprodujo la precedencia de
mappings de produccion y no se ejecuto `save-sales`, stock, cola, SQL ni cambio
de configuracion. Las tres conexiones conservan escritura provisional
desactivada y facturas cerradas accesibles.

**Alternativa descartada:** adelantar el cursor por SQL, importar solo las
lineas Winerim de una factura o mapear copas genericas por similitud. Las tres
opciones rompen integridad, idempotencia o trazabilidad.

## 2026-07-22 - Abadia solo escribe mappings legacy exactos y univocos

**Decision:** crear mappings de ventas legacy en Abadia unicamente cuando un
codigo/SKU exacto o el nombre normalizado mas variante resuelven una sola ficha
Winerim activa compatible. En el primer lote se aceptaron 16 mappings de
botella y se rechazaron 30 IDs sin igualdad exacta.

**Razon:** el cursor esta detenido por un backlog legacy real. Confirmar los
productos nominales exactos reduce el bloqueo sin inventar equivalencias; los
botones genericos de copa y los nombres ausentes o distintos necesitan una
decision humana.

**Riesgos controlados:** se fijo la conexion por ID y nombre, se reviso un hash
estable del dry-run, se guardo snapshot `0600` antes de la primera escritura y
se verificaron despues las 16 filas, el catalogo `281/281`, la cola vacia y el
breaker cerrado. No se tocaron ventas, stock, cursor, flags, tracking, alertas,
catalogo o legacy.

**Alternativa descartada:** fuzzy matching, mapear una copa generica a una
referencia concreta o procesar parcialmente las facturas. Cualquiera puede
atribuir ventas al vino equivocado o avanzar el cursor dejando lineas fuera.

## 2026-07-22 - Finca Eslava no recibe mappings sin identidad exacta

**Decision:** no crear ningun `product_mapping` para las ventas legacy de
Finca Eslava del 19 al 21 de julio porque la lectura fresh y el dry-run no
encontraron codigo/SKU exacto ni nombre+variante unica.

**Razon:** cuatro botones son genericos y las copas nominales `Málaga Virgen`,
`Tío Pepe` y `NPU` no existen como referencias exactas demostrables en el
catalogo Winerim actual. Una coincidencia aproximada atribuiria cantidades y
stock a un vino potencialmente incorrecto.

**Riesgos controlados:** snapshot `0600`, segunda auditoria fresh, catalogo
`123/123`, cola cero y breaker cerrado. No se escribieron mappings, ventas,
stock, cursor, flags, catalogo ni legacy; la alerta stale se mantuvo abierta.

**Alternativa descartada:** mapear por tipo de vino, familia, color o parecido
de nombre para desbloquear el cursor. Ganaria avance aparente a costa de perder
integridad de ventas e inventario.

## 2026-07-22 - Un mapping confirmado requiere aislamiento del procesador de ventas

**Decisión:** no insertar ni mantener mappings `CONFIRMED` en una conexión
activa cuando el alcance prohíbe procesar ventas, stock o cursor, salvo que
exista un bloqueo de mantenimiento por conexión comprobado y fail-closed. En El
Higuerón se revirtieron los 24 mappings exactos al detectar que el cron los
consumía automáticamente.

**Razón:** un write aislado en `product_mappings` no es operacionalmente
aislado. El dispatcher definitivo observa el nuevo mapping tras el commit y
puede empezar a procesar backlog antes de terminar la verificación. En esta
operación alcanzó 19 grupos de ventas cerradas de los días 16 y 17 de julio,
aunque no hubo una invocación manual de ventas ni stock.

**Riesgos controlados:** el rollback usó conexión, provider product, Winerim
ID, variante y `match_method` exactos; mappings y tracking volvieron a
`292/292`, el cursor permaneció en `2026-07-14` y la cola en cero. Se
conservaron logs e idempotency keys y no se intentó compensar stock o historial
sin conciliación por factura.

**Alternativa descartada:** dejar los mappings aplicados porque eran exactos o
restaurar stock globalmente. La primera opción incumplía el alcance y permitía
más procesamiento; la segunda podía duplicar o falsear ventas reales.

## 2026-07-22 - El cursor vivo pertenece solo al flujo automático completo

**Decisión:** `last_business_day_synced` solo puede avanzar desde la
sincronización automática después de persistir completamente evento, líneas y
stock/venta. Los guardados manuales y los históricos no lo modifican; todos los
writes son atómicos y monotónicos.

**Razón:** un guardado parcial o concurrente podía adelantar o retroceder el
cursor y hacer que el cron omitiera ventas o reabriera días ya procesados.

**Riesgos controlados:** el runtime aborta el día ante cualquier error de
persistencia y conserva el cursor para reintento idempotente. La validación
incluye `25/25` tests, bundle y comprobación TypeScript.

**Alternativa descartada:** permitir que cada acción mantenga el cursor por su
cuenta. Duplica ownership y hace imposible razonar sobre concurrencia y
recuperación.

## 2026-07-22 - El monitor con efectos requiere secreto; el botón es dry-run

**Decisión:** cualquier ejecución del monitor que persista estado o envíe
notificaciones exige `MONITOR_CRON_SECRET`. La interfaz solo puede lanzar
`dryRun=true` y nunca recibe el secreto.

**Razón:** una invocación pública con permisos internos permitiría generar o
resolver alertas y enviar correo sin autorización.

**Riesgos controlados:** el cron existente usa el helper seguro y el dry-run
postdespliegue comprobó `23` conexiones sin escrituras ni notificaciones.

**Alternativa descartada:** confiar en parámetros como `sendEmails=false` para
considerar inocua una ejecución sin autenticar; todavía podría modificar otros
estados internos.

## 2026-07-22 - El cierre RLS se hará por fases y no con un revoke inmediato

**Decisión:** mantener abiertos los cinco hallazgos críticos de RLS/Storage
hasta migrar primero las lecturas y mutaciones del frontend a una capa BFF/Edge
Function autenticada, y endurecer después las policies tabla por tabla con
tests y rollback.

**Razón:** los findings son reales y preexistentes, pero la interfaz actual
depende de acceso directo. Cortarlo de una vez puede dejar inoperativo el
middleware antes de disponer de una ruta segura equivalente.

**Riesgos controlados:** no se fuerza la publicación del frontend, no se
ignoran findings y no se aplican policies sin inventario de consumidores.

**Alternativa descartada:** publicar ignorando la deuda o revocar `anon` en
producción sin staging. La primera perpetúa exposición; la segunda puede romper
flujos activos sin recuperación inmediata.

## 2026-07-22 - El lease del dispatcher es el bloqueo de mantenimiento operativo

**Decisión:** reutilizar el lease `sales-stock` por conexión para aislar
operaciones de mapping en producción. La escritura debe comprobar ownership en
la misma operación, mantener invariantes bajo lock y liberar explícitamente.

**Razón:** la reaplicación de los 24 mappings de El Higuerón bajo ese protocolo
no generó ventas, stock, eventos, cola ni movimiento de cursor durante el lock
ni en el ciclo observado después de liberarlo.

**Riesgos controlados:** baseline y rebaseline idénticos, insert atómico,
verificación doble, release confirmado, `0` idempotency keys duplicadas y
ninguna compensación de los efectos anteriores.

**Alternativa descartada:** desactivar toda la conexión o insertar mappings sin
lease. La primera afecta catálogo y observabilidad innecesariamente; la segunda
ya demostró una carrera real con el cron.
# 2026-08-03 20:13 CEST - Fuente remota y dos runs de canary

- Solo `a80c9eb` publicado y congelado puede originar manifests del siguiente
  deploy rescue.
- El shadow es read-only y no comparte `run_id`, mensaje, idempotencia ni hash
  con el canary live.
- No desplegar manifests parciales. El orden es fence, executor, observer,
  consumer inerte, readiness, activacion, shadow y luego un run live nuevo.
- Albariza se carga por fases: familias, dos productos canary y solo despues
  el resto del catalogo; una venta que mueva stock requiere gate separado.
## 2026-09-03 - El aislamiento de flota se aplica dentro del lote por conexión

**Decisión:** no depender del autoscaling de Cloudflare Queues para aislar una
conexión lenta. El consumidor agrupa mensajes por `connectionId`, procesa cada
grupo en orden y permite como máximo dos grupos concurrentes.

**Razón:** la prueba remota inicial mostró que `max_concurrency=2` no abrió una
segunda invocación para dos mensajes de baja carga; el rápido esperó los 60 s
del lento. Con concurrencia dentro del lote, ambos comenzaron en el mismo
milisegundo y el rápido terminó en 25 ms.

**Límites:** no se ha desplegado a producción. El canary de venta real de Casa
Esteban se mantiene como último gate, después de terminar optimización,
SaleCenters y preparation routing.

## 2026-09-03 - Repositorios activos fuera de iCloud y esfuerzo por riesgo

**Decisión:** mantener fuera de iCloud únicamente repositorios y worktrees
activos que presenten placeholders dataless; documentos y tareas no se mueven
en bloque. Usar esfuerzo bajo/medio para supervisión, alto para desarrollo y
reservar esfuerzo máximo para gates productivos, pagos y seguridad.

**Razón:** los objetos Git dataless provocaron esperas de minutos, mientras el
clon local responde en centésimas. El contexto extenso y el esfuerzo máximo en
ciclos rutinarios consumen tokens sin una mejora proporcional.
