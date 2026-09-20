# Auditoría septiembre 2026 — Luruna y Restaurante Cienvinos Écija

Modo: **SOLO LECTURA**. No se ha importado historial, no se ha movido stock, no se ha
desplegado nada, no se han tocado cursores/claims ni la sincronización normal.
El GO previo era exclusivamente de Don Quijote y no se hereda. Don Quijote intacto.

Periodo: `[2026-09-01 00:00, 2026-09-20 00:00)` Europe/Madrid (días 1–19 completos).
Ejecución: 2026-09-20. Conexiones: Luruna `c9b23830-a00b-4786-a50b-43fe526c4d3c`,
Cienvinos Écija `21ee3345-1090-4e83-94f2-43126d6e7695`.

## 1. Cobertura de lectura

| Restaurante | Fuente TPV | Días respaldados | Historial Winerim |
|---|---|---|---|
| Cienvinos Écija | Relectura directa de Ágora (19/19 días, 6.734 documentos) | 01–19/09 completos | 1.278 apuntes (397 canal certificado + 881 legado), `includeLegacy=true`, paginación completa |
| Luruna | Captura local (sales_events) días 18 y 19 (350 documentos) | **solo 18 y 19/09** | 35 apuntes (7 certificados + 28 legado) |

**Bloqueo preciso (Luruna):** su TPV (`luruna.dyndns.biz:8984`) responde HTTP 200 con
cuerpo vacío para cualquier día pasado; solo sirve el día en curso. Un intento acotado
por día, sin bucles. Por eso los días **01–17/09 quedan SIN LECTURA DEL TPV**: no se
afirma que falten ventas ni que no haya ventas; simplemente no hay fuente comparable.
Los 36 apuntes de Winerim de esos días se marcan `SIN_LECTURA_TPV`, nunca "exceso".

**Limitación de stock (fechada 2026-09-20T08:27:14Z):** Winerim no expone movimientos ni
ajustes (`/stock/movements`, `/stock/history`, `/stock/adjustments` → 404). Solo se puede
leer el stock actual por vino. Stock no informado = **DESCONOCIDO**, nunca "no descontado".

## 2. Resultado por restaurante

### Cienvinos Écija
- Líneas económicas únicas: **1.676** (2.110 uds, **11.662,25 € netos de TPV**).
- Representaciones descartadas: 50 duplicadas (ticket↔factura), 55 sustituciones fiscales
  resueltas por linaje documental, 1 devolución (−14 €).
- Ya registradas en Winerim: **1.406 líneas**.
- **Faltantes probadas: 76 grupos vino/formato/día → 268 uds (2.423,80 € TPV)**
  (211 uds copa + 58 uds botella, aprox.).
- Ambiguas (no se proponen): 30 grupos / 101 uds — Winerim tiene ventas del mismo vino,
  formato y día pero sin clave original ni vínculo documental que pruebe la asignación.
- **Doble registro en Winerim: 106 uds** (misma línea de origen escrita dos veces con
  dos claves generadas distintas, concentrado los días 18 y 19).
- Exceso sin cobertura de TPV: 434 uds, concentrado en 17/09 (93) y 18/09 (261),
  coincidiendo con el cambio de writer: el canal legado y el certificado registraron
  las mismas copas. **Riesgo de doble descuento histórico — pendiente de decisión, no se toca.**

### Luruna
- Líneas económicas únicas legibles: 5 (6 uds, 129 €); 4 registradas.
- Faltante probada: 1 línea — 19/09, Vi De Glass Gewürztraminer, **copa, 2 uds, 16 €**.
- **Doble registro en Winerim: 3 uds** de 4 ventas de botella (18–19/09): la misma línea
  se escribió dos veces con claves distintas (p. ej. `agora:c9b23830:2026-09-18:156624:bot:qu4jfy`
  y `…:bot:1mtaslo`, ambas `sourceLineId=1`, mismo instante), ambas con `history`+`stock`.
- **Incidencia viva:** 360 registros `FAILED` en `stock_sync_log` con
  "did not apply stock for every line"; la respuesta real es `result=DUPLICATE`,
  `stockApplied=false`, `stock before=0 after=0`. El historial existe; el stock no se
  aplica porque el stock del vino está a 0, y el reintento se repite indefinidamente.
- Mapeo: 151 mapeos CONFIRMED, pero solo 10 de 1.366 líneas de vino del TPV llevan
  `winerim_product_id`; el resto usa IDs ausentes de `provider_products`. El alcance
  real auditable de Luruna es mínimo hasta resolver el mapeo.

**Alerta previa resuelta (Luruna):** la factura 44572 tiene **una sola** línea de vino
(Itsasmendi 156624, 1 botella, 29 €, 18/09 21:53:48). Las "45 filas idénticas" del CSV
anterior eran repetición del snapshot, no 46 ventas.

**Ejemplos pedidos (Cienvinos):**
- El Pacto 239321, 12/09 13:34:52, 1 botella 18 €: la StandardInvoice 186 sigue vigente
  y el ticket/factura T-26556 fue anulado por la devolución TD-224 (`ConvertToStandard`).
  No es neto cero: es sustitución fiscal. En Winerim aparecen 4 uds frente a 2 netas del TPV.
- Tomás Postigo 239870, 02/09 14:22:06, 1 botella 49 €: T-23187 anulado por TD-196 y
  sustituido por F-164; la línea económica válida es la de F-164, ya registrada (sale 169838).

## 3. Reglas aplicadas
El TPV es la verdad; solo claves originales almacenadas o vínculo documental (nunca claves
reconstruidas); ticket y factura de la misma venta = una sola línea; devoluciones aparte;
un apunte ya consumido no confirma dos ventas; importes = neto real del TPV, no catálogo del
receptor; copas las convierte Winerim (nunca restar botellas a mano); déficit de inventario aparte.

## 4. Entregables
- `auditoria-luruna-cienvinos-lineas-septiembre-2026.csv` — todas las líneas económicas con estado.
- `auditoria-luruna-cienvinos-grupos-septiembre-2026.csv` — propuesta exacta por vino/formato/día.
- `auditoria-luruna-cienvinos-septiembre-2026.csv` — líneas pendientes con evidencia y stock leído.

## 5. Pendiente de decisión de Goiko (sin GO, nada se ejecuta)
1. Importar las faltantes probadas (Cienvinos 268 uds / Luruna 2 uds) y con qué modo.
2. Qué hacer con el doble registro en Winerim (109 uds) y con el exceso de 17–18/09.
3. Confirmar con el restaurante si regularizó existencias (el stock previo es DESCONOCIDO).
4. Luruna: resolver el mapeo de productos y el bucle de reintentos con stock a 0.
