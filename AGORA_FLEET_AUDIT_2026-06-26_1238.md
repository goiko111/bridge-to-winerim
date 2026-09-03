# AGORA_FLEET_AUDIT_2026-06-26_1238

> Auditoria viva ejecutada el 2026-06-26 12:30-12:38 CEST contra Lovable Cloud y Winerim API v2. No se imprimen ni documentan tokens.

## Hechos

- Se revisaron las 12 conexiones Agora registradas.
- La auditoria fue observacional para POS/Agora: no se ejecuto `fetch-catalog` masivo, no se reintento cola y no se escribio en Agora.
- Si se ejecuto backfill controlado en Winerim con `POST /api/v2/sales/import` para ventas ya marcadas `stock_sync_log.SUCCESS` donde el stock no se habia movido (`previousStock === newStock`).
- El backfill no modifica stock; solo registra historial de venta en Winerim con `orderId` determinista.
- Se anotaron los logs corregidos con `winerim_response.salesImportBackfill`.

## Resumen operativo

| Conexion | Estado | Sonda | Ventas | Stock / historial | Catalogo Winerim -> Agora | Cola | Accion |
|---|---|---|---|---|---|---|---|
| Baco Getafe | READ_ONLY/LEGACY | OK | Sin ventas recientes | No aplica | Auto-push off | Limpia | Mantener apagado salvo nueva autorizacion. |
| Casa Nene | OPERATIVA PARCIAL | OK | Hasta 2026-06-25 | 84 `SUCCESS`; backfill 10 filas 0->0 completado | 307/307 formatos publicables | 1 `FAILED` | Validar/reactivar intradia si el parche total-diario esta desplegado. |
| Don Bernardo Ponzano | READ_ONLY | OK | Historico analitico | No descuenta por decision | No publicado | Limpia | Mantener read-only hasta validar mappings/familias. |
| Don Bernardo Santander | READ_ONLY | OK | Historico analitico | No descuenta por decision | No publicado | Limpia | Mantener read-only hasta validar mappings/familias. |
| Katsu Izakaya | OPERATIVA | OK | Hasta 2026-06-25 | 6 `SUCCESS`; ventas nuevas ya muestran `salesImport` cuando 0->0 | 137/137 formatos publicables | Limpia | Mantener intradia; no reactivar auto-update hasta corregir bucle. |
| Kava | OPERATIVA CON DEUDA | OK | Hasta 2026-06-25 | 45 `SUCCESS`; backfill 29 filas 0->0 completado | 204/221, faltan 17 | 7 `FAILED` / 9 `BLOCKED` | Revisar faltantes y deuda historica. |
| La Candela de Triana | NO DESCUENTA | OK | Hasta 2026-06-25 | 0 mapeadas / 0 stock | 78/78 formatos publicables | Limpia | Confirmar si venden legacy; hacer mapping o cambiar operativa a botones Winerim. |
| Luruna | NO DESCUENTA | OK | Hasta 2026-06-25 | 0 mapeadas / 0 stock | 124/126, faltan 2 | 10 `FAILED` / 58 `BLOCKED` | Confirmar venta desde legacy y resolver mappings/cola. |
| Restaurante Cienvinos Ecija | OPERATIVA | OK | Hasta 2026-06-25 | 34 `SUCCESS`; backfill y verificacion visual ya OK | 499/499 formatos publicables | 3 `FAILED` / 7 `BLOCKED` | Revisar deuda menor; probar venta nueva con stock 0. |
| Restaurante Jardi | OPERATIVA PARCIAL | OK | Hasta 2026-06-25 | 22 `SUCCESS`; backfill 9 filas 0->0 completado | 173/180, faltan 7 copas | 3 `FAILED` | Revisar copas faltantes y cola menor. |
| Sa Pedrera | DEUDA ALTA | OK | Ultimo dia 2026-06-19 | 90 `SUCCESS`, 31 `FAILED`; backfill parcial | 465/465 formatos publicables | 310 `FAILED` / 12609 `BLOCKED` | No reintentar en bloque; resolver stockIds/variantes antiguas y cursor. |
| Sa Vida | BLOQUEADA | 401 | Sin ventas recientes | Sin stock reciente | 429/976 por bloqueo API | 4208 `FAILED` / 2030 `BLOCKED` | Corregir API token/401 antes de tocar cola. |

## Backfill de historial Winerim 0->0

| Conexion | Filas candidatas | Grupos | Importadas | Skipped idempotente | Fallidas | Resultado |
|---|---:|---:|---:|---:|---:|---|
| Casa Nene | 10 | 8 | 7 | 1 | 0 | Completo; una ya habia entrado antes del reintento. |
| Katsu Izakaya | 1 | 1 | 1 | 0 | 0 | Completo. |
| Kava | 29 | 14 | 14 | 0 | 0 | Completo. |
| Restaurante Jardi | 9 | 9 | 9 | 0 | 0 | Completo. |
| Sa Pedrera | 79 | 63 | 52 | 0 | 13 grupos iniciales; 2 recuperados con stockId actual | Parcial: 19 filas siguen sin backfill porque Winerim no expone ya la misma variante o el vino devuelve 404. |
| Restaurante Cienvinos Ecija | 0 nuevos | 0 | 0 | 0 | 0 | Ya estaba completo de la intervencion anterior. |

## Sa Pedrera pendiente tras backfill

Quedan 19 filas `SUCCESS` con `0->0` sin historial importado porque no es seguro forzarlas:

- `C B345- Bico da Ran [copa]` (`284165`): Winerim expone solo botella actual, no copa.
- `C T 33 -Arrocal Joven Roble [copa]` (`148271`): Winerim expone solo botella actual, no copa.
- `C B310- Albenc [copa]` (`284166`): Winerim expone solo botella actual, no copa.
- `C T1 - Iamontanum Garnacha - Isla de Menorca [copa]` (`95501`): Winerim expone solo botella actual, no copa.
- `C T45-Pago de Carraovejas [copa]` (`9804`): Winerim expone solo botella actual, no copa.
- `C T 75-Tobia Seleccion de Autor [copa]` (`40391`): `GET /stock/wine/{id}` devuelve 404.
- `B T39-San Roman [botella]` (`9803`): `GET /stock/wine/{id}` devuelve 404.
- `B E522-Andre Clouet Grande Reserve [botella]` (`9905`): Winerim expone copa actual, no botella.

Se recuperaron con stockId actual de la misma variante:

- `C E508- Cygnus Sador Brut Nature Reserva [copa]`: stockId antiguo `330722`, nuevo `340357`, importado OK.
- `C B321- EL Perro Verde [copa]`: stockId antiguo `327364`, nuevo `340370`, importado OK.

## Catalogo automatico

- Completos: `Casa Nene`, `Katsu Izakaya`, `Cienvinos`, `Sa Pedrera`, `La Candela`.
- Casi completos: `Kava` (`17` faltantes), `Jardi` (`7` copas faltantes), `Luruna` (`2` faltantes).
- Bloqueado/no fiable: `Sa Vida` por 401.
- Read-only/no publicado: `Baco`, `Don Bernardo Ponzano`, `Don Bernardo Santander`.

## Riesgos

- `La Candela` y `Luruna` responden y reciben ventas, pero no descuentan porque las lineas no resuelven a Winerim.
- `Sa Pedrera` tiene deuda historica muy alta; reintentar en bloque puede romper o saturar Agora.
- `Sa Vida` no debe tocarse hasta corregir el 401.
- `auto_push_on_update=false` en `Katsu`, `Cienvinos` y `Jardi` significa altas nuevas si, cambios de precio/nombre existentes no garantizados automaticamente hasta corregir idempotencia de updates.

## Tareas recomendadas

1. Sa Vida: corregir 401 de Agora antes de cualquier retry.
2. La Candela y Luruna: comprobar tablet/ventas reales y decidir mapping legacy o uso obligatorio de familias Winerim.
3. Sa Pedrera: resolver los 19 pendientes por variante/stockId y clasificar cola antes de reintentar.
4. Jardi: revisar 7 copas faltantes.
5. Kava: revisar 17 formatos faltantes y deuda de cola.
6. Casa Nene: validar intradia por total diario y reactivar si no descuenta duplicado.
7. Katsu/Cienvinos/Jardi: corregir idempotencia de `auto_push_on_update` antes de encender updates permanentes.
