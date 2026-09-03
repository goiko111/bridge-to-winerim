# Agora - remediacion de conexiones deshabilitadas

Fecha: 2026-07-22
Alcance: Baco Getafe, Casa Esteban, Don Bernardo Ponzano, Don Bernardo
Santander, La Candela de Triana, O Bistro y Saddle.
Modo: diagnostico fresh y remediacion exclusivamente por conexion. No se han
habilitado conexiones, procesado colas, escrito en Agora, modificado ventas o
stock Winerim, ni tocado codigo compartido.

## Resumen

| Restaurante | Veredicto | Conectividad fresh | Motivo exacto |
|---|---|---|---|
| Baco Getafe | `PASS / ROLLBACK_LEGACY` | API, maestros y tickets HTTP 200 | El estado correcto es seguir deshabilitada por el rollback solicitado. Se normalizaron solo metadatos de rollback. |
| Casa Esteban | `BLOCKED` | Transporte recuperado: API, maestros y tickets HTTP 200 | Cero master data persistida, vinos cacheados, mappings y tracking. La conectividad ya no bloquea, pero no existe ownership que permita publicar u ocultar con seguridad. |
| Don Bernardo Ponzano | `BLOCKED` | API, maestros y tickets HTTP 200 | Onboarding autorizado solo en lectura; `128/128` formatos Winerim faltan en Agora y no existen mappings/tracking. Falta aprobar estructura y legacy antes de escribir. |
| Don Bernardo Santander | `BLOCKED` | API, maestros y tickets HTTP 200 | Onboarding autorizado solo en lectura; `192/192` formatos Winerim faltan en Agora y no existen mappings/tracking. El token Winerim ya devuelve 148 vinos frente a 147 cacheados, por lo que antes debe refrescarse el catalogo. |
| La Candela de Triana | `BLOCKED` | API, maestros y tickets HTTP 200 | Pausa explicita por posible emparejamiento incorrecto con Restaurante Triana. Hay 90 productos propiedad de Winerim, pero los 90 difieren del estado publicable y queda una tarea antigua bloqueada. |
| O Bistro | `BLOCKED` | Sin ruta desde Lovable Cloud; tickets terminan en abort/timeout | La URL configurada es privada. SAT/cliente debe facilitar DDNS, IP publica con NAT o VPN/tunel accesible desde Lovable Cloud. |
| Saddle | `BLOCKED` | Maestros HTTP 200 desde esta maquina; tickets desde Lovable Cloud terminan en abort/timeout | Falta conectividad demostrada desde Lovable Cloud y, funcionalmente, credencial tSpoonLab, composiciones versionadas de menus/armonias y mappings explicitos. |

No existe ninguna conexion que pueda reactivarse de forma segura solo por
responder a una sonda. Casa Esteban ha recuperado el transporte, pero sigue en
staging de onboarding.

## 1. Baco Getafe - `PASS / ROLLBACK_LEGACY`

### Hechos fresh

- La conexion sigue `enabled=false`; catalogo y auto-push estan apagados.
- Agora responde, expone 48 familias y cinco tickets abiertos.
- El token Winerim es valido y devuelve 74 vinos actuales.
- Los 118 formatos publicados anteriormente siguen presentes y con ownership
  exacto, pero los 118 tienen `SaleableAsMain` desactivado. Es el estado
  esperado del rollback, no una discrepancia a republicar.
- Hay cero tareas activas, cero tareas fallidas/bloqueadas y cero alertas
  abiertas.

### Remediacion aplicada

- `pos_connections.write_mode`: `XML_IMPORT` -> `NONE`.
- Los 118 registros `WINERIM/VERIFIED` se normalizaron a `HIDDEN`.
- Se conservaron los 118 mappings `CONFIRMED/XML_IMPORT` como trazabilidad.
- No se modificaron productos, familias, ventas, stock ni legacy en Agora.
- Verificacion posterior: conexion deshabilitada, `write_mode=NONE`, 118
  tracking `HIDDEN`, 167 `NOT_PUSHED`, 118 mappings y cero cola activa.

### Rollback

Restaurar `write_mode=XML_IMPORT` y los 118 IDs de tracking del snapshot a
`VERIFIED`. Este rollback solo revierte metadatos; no requiere escribir en
Agora.

### Bloqueo de reactivacion

Requiere una nueva autorizacion explicita del cliente. La decision vigente es
conservar legacy y mantener Winerim fuera de venta.

## 2. Casa Esteban - `BLOCKED`

### Hechos fresh

- El bloqueo historico `STAGING_BLOCKED_TUNNEL` ya no describe el transporte:
  facturas, tickets y maestros responden HTTP 200.
- El token Winerim es valido y devuelve 261 vinos.
- Agora expone 12 familias, cuatro IVA, tres tarifas y 91 productos en el
  snapshot previo.
- Persistencia del middleware: cero `agora_master_data`, cero
  `winerim_wines`, cero mappings, cero tracking, cero eventos y cero logs.
- No hay cola ni alertas abiertas porque la conexion nunca se activo.

### Por que no se reactivo

No existe ownership con el que distinguir productos Winerim de productos del
cliente, ni snapshot fresh de legacy que permita ocultar de forma reversible.
Activar escritura ahora seria una publicacion inicial sin dry-run verificable.

### Condicion de desbloqueo

1. Persistir lectura inicial de Winerim y master data Agora sin habilitar la
   conexion.
2. Presentar estructura, familias, centros, tarifas, preparacion y legacy al
   cliente.
3. Ejecutar piloto de una familia con snapshot y rollback.
4. Confirmar ownership fresh y canary real antes de activar automatizacion.

## 3. Don Bernardo Ponzano - `BLOCKED`

### Hechos fresh

- Agora responde: 150 familias, tres tarifas y dos tickets abiertos.
- El token Winerim devuelve 95 vinos; el cache contiene 95.
- La auditoria fresh espera 128 formatos y encuentra `0 MATCH / 128 MISSING`.
- Hay 3.400 eventos analiticos historicos, pero cero mappings, tracking y logs
  de stock/venta operativa.
- Cero tareas activas, fallidas o bloqueadas; cero alertas abiertas.

### Bloqueo

La decision vigente es `read_only_onboarding=true`. Falta aprobacion del
cliente sobre estructura y tratamiento del legacy antes de crear ownership y
publicar. Los datos historicos no autorizan escritura de catalogo ni stock.

## 4. Don Bernardo Santander - `BLOCKED`

### Hechos fresh

- Agora responde: 126 familias, dos tarifas y 34 tickets accesibles.
- El token Winerim devuelve 148 vinos; el cache contiene 147 y debe
  refrescarse antes de calcular el alcance final.
- La auditoria fresh espera 192 formatos y encuentra `0 MATCH / 192 MISSING`.
- Hay 6.883 eventos analiticos historicos, pero cero mappings, tracking y logs
  de stock/venta operativa.
- Cero tareas activas, fallidas o bloqueadas; cero alertas abiertas.

### Bloqueo

La decision vigente es solo lectura. Falta aprobar estructura/legacy y hacer
onboarding diferencial. El `BOOT_ERROR` observado en una primera sonda fue
transitorio: la repeticion aislada devolvio HTTP 200 y 34 tickets.

## 5. La Candela de Triana - `BLOCKED`

### Hechos fresh

- La conexion sigue deshabilitada y conserva la pausa explicita:
  `Possible wrong Agora/Winerim pairing`.
- Identidades que no se pueden mezclar: La Candela usa menu Winerim 956;
  Restaurante Triana usa menu 896.
- Agora responde: 57 familias, cuatro tarifas y cuatro tickets abiertos.
- El token Winerim devuelve 90 vinos y el cache contiene 90.
- Los 90 formatos esperados existen y tienen ownership, pero los 90 difieren
  del estado publicable; no se forzo ninguna republicacion.
- Queda una tarea `AGORA_HIDE_PRODUCT` bloqueada desde el 30/06 por XML
  truncado. No se reencolo.
- Las 11 alertas historicas estan resueltas; no hay alerta abierta.

### Bloqueo externo

El cliente debe confirmar que el servidor/API actual corresponde realmente a
La Candela y no a Restaurante Triana, y aprobar la estructura que debe quedar
visible. Solo despues procede un snapshot fresh, auditoria de los 90 cambios y
republicacion diferencial.

## 6. O Bistro - `BLOCKED`

### Hechos fresh

- El token Winerim es valido y devuelve 102 vinos.
- La URL configurada es una IP privada; no hay master data, catalogo cacheado,
  mappings, tracking, eventos ni logs.
- La sonda de tickets desde Lovable Cloud termina en `502` por aborto de red y
  la sonda general agota timeout.
- Cero cola y alertas no demuestran salud: no existe operacion activa.

### Bloqueo externo exacto

SAT/cliente debe proporcionar una URL publica/DDNS con puerto 8984 accesible,
o una VPN/tunel con ruta desde Lovable Cloud. Despues deben validarse Families,
Products, Invoices y tickets antes del onboarding.

## 7. Saddle - `BLOCKED`

### Hechos fresh

- El token Winerim es valido y devuelve 2.432 vinos.
- El maestro ligero de Agora responde desde esta maquina: 14 familias, tres
  tarifas, nueve tipos y 14 ordenes de preparacion.
- Las dos sondas de tickets desde Lovable Cloud terminaron en `502` por aborto
  de red; la sonda general no devolvio dentro de 30 segundos.
- No hay master data persistida, vinos cacheados, mappings, tracking, eventos
  operativos ni stock logs.
- Cero cola y alertas no constituyen prueba de salud al estar deshabilitada.

### Bloqueos externos exactos

1. SAT debe demostrar una ruta estable desde Lovable Cloud al servidor Agora.
2. tSpoonLab debe facilitar credencial tecnica, centro y codigos compartidos.
3. Cliente/tSpoonLab debe aportar la composicion versionada de cada menu y
   armonia, incluido formato y cantidad por vino.
4. El jefe sommelier debe validar mappings y canaries de vino directo, menu,
   armonia y anulacion.

Sin esas piezas, una tecla de menu no identifica de forma determinista los
vinos consumidos y no se puede activar stock ni historial.

## Evidencias

- `outputs/agora-remediation-disabled-2026-07-22/fresh-evidence.json`
- `outputs/agora-remediation-disabled-2026-07-22/identity-and-queues.json`
- `outputs/agora-remediation-disabled-2026-07-22/queues-master-capabilities.json`
- `outputs/agora-remediation-disabled-2026-07-22/retry-probes.json`
- `outputs/agora-remediation-disabled-2026-07-22/baco-dry-run.json`
- `outputs/agora-remediation-disabled-2026-07-22/baco-before-and-rollback.json`
- `outputs/agora-remediation-disabled-2026-07-22/baco-applied-and-verified.json`
- `outputs/agora-remediation-disabled-2026-07-22/baco-fresh-post-verification.json`

Todas las evidencias estan sanitizadas; no contienen tokens ni credenciales.
