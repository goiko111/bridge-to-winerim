# Finca Eslava - checklist 100 % 2026-07-20

Fecha de cierre tecnico: 2026-07-20 17:25 CEST

Conexion: `d15af3ec-1225-4438-bb95-af672da43512`

Menu Winerim: `1108`

Estado: `LIVE_PENDING_SALE_CANARY`

## Resultado

| Control | Estado | Evidencia |
|---|---|---|
| Conexion Agora | PASS | API HTTP y tickets abiertos responden HTTP 200; breaker cerrado y `consecutive_failures=0`. |
| Frecuencia | PASS | Catalogo y ventas configurados cada cinco minutos. |
| Catalogo | PASS | Lectura fresh `123/123 MATCH`, cero ausentes, diferentes o sin ownership. |
| Tracking y mappings | PASS | `123 VERIFIED` y `123 CONFIRMED/XML_IMPORT`. |
| Cola | PASS | Cero `QUEUED`, `RUNNING`, `FAILED` o `BLOCKED`. |
| Alertas | PASS | Cero alertas abiertas. |
| Intradia | PASS tecnico | Tickets abiertos, stock intradia y dia actual activos; edad minima dos minutos. |
| Idempotencia | PASS | Cero claves idempotentes exactas repetidas en siete dias. |
| Stock Emilio Moro | PASS | La devolucion neta se contrasto y el stock se ajusto de `82` a `83` sin crear venta. |
| Historial Emilio Moro | WARN | Agora netea `+1/-1 = 0`; Winerim conserva una tarjeta TPV positiva de una unidad. |
| Botella real | PENDIENTE | Falta una venta real Winerim no anulada y su comprobacion en ERP. |
| Copa real | PENDIENTE | Falta una venta real Winerim no anulada y su comprobacion en ERP. |
| Legacy | DECISION CLIENTE | Permanece visible hasta validar las ventas y decidir su ocultacion reversible. |

## Incidencia corregida

1. Agora factura `T-27681`: `B Emilio Moro`, una botella, `30 EUR`,
   `2026-07-17 15:42:43`.
2. Agora devolucion `TD-930`: la misma botella, `-1`, `-30 EUR`, un minuto
   despues.
3. El middleware habia registrado la venta positiva y reducido el stock de
   `83` a `82`, pero la devolucion definitiva no genero restauracion.
4. La lectura fresh del 17 al 20 de julio confirmo que no existia otra venta
   de Emilio Moro que justificara el `82`.
5. Se aplico `No, solo ajuste` para devolver el stock a `83` y se verifico por
   API. Las tarjetas de historial quedaron intactas.

## Limite conocido

El runtime restaura correctamente tickets provisionales cancelados, pero no
puede retirar por si solo una tarjeta de historial generada por una devolucion
de factura definitiva. `POST /sales/import` solo crea historial y `PUT /stock`
crearia otra venta; ninguno es una anulacion valida. Hasta disponer de un
endpoint de anulacion idempotente en Winerim, estos casos requieren conciliacion
y ajuste manual sin venta.

## Cierre con el cliente

1. Marcar una botella desde una familia Winerim y no anularla.
2. Marcar una copa desde `COPAS WINERIM` y no anularla.
3. Comprobar en menos de cinco minutos que ambas aparecen como `TPV`, con hora
   real, cantidad y variante correctas.
4. Verificar que stock activo descuenta la variante y stock inactivo registra
   solo historial.
5. Repetir el ciclo y confirmar que no se duplica ninguna tarjeta.
6. Decidir si se oculta el legacy de forma reversible.

## Rollback de la correccion

Si apareciera evidencia de un ajuste o consumo de Emilio Moro no visible en
Agora, devolver `stockId 328484` de `83` a `82` mediante `No, solo ajuste`.
Nunca usar `PUT /stock` para ese rollback, porque generaria una venta nueva.
