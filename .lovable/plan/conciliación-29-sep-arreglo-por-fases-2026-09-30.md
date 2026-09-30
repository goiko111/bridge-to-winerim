# Conciliación 29-sep: arreglo por fases

Regla general: nada se escribe en Winerim sin tu OK. Cada paso lleva pruebas, simulación y comprobación posterior.

## Fase A — Conciliación (solo lectura, hoy)

1. **Una sola versión por ticket.** Si existe la factura, se descarta la foto de ticket abierto de ese ticket. Se emparejan por el vínculo que da Ágora (ticket origen → factura). Si no lo hay, por producto + hora + mesa. Objetivo: que desaparezcan los 296 de 314 OPEN duplicados del 29-sep.
2. **Comparar sumas, no ventas.** La clave pasa a ser (día, vino Winerim, formato), y se suman las unidades de Ágora frente a las de Winerim (`sales/records → lines[].qty`). El estado del día sale de esa suma. El detalle línea a línea queda solo como explicación, y la hora de la copa ya no bloquea (se acaba el problema de «Botella en uso» a la hora de la primera copa).
3. **Columna Formato.** Mostrar el formato real (Botella/Copa…), no el nombre del vino (Q Tomas, Triana, Luruna).
4. **Don Bernardo Ponzano y Santander.** Explicar qué lectura de Ágora falla (conexión, páginas, cursor) con la evidencia de la revisión.
5. **Excel 29-sep rehecho** con estas reglas, cuadrado contra tus cifras: Don Quijote 36→36, Portón 23→23, Clinic 15→15, Cienvinos 66→66, Casa Nene 48→30, Sa Vida 59,5→45, Higuerón 81→72. Si alguna no cuadra, se explica por qué.

Se despliegan solo las funciones de conciliación y lectura de resultados, y se ajusta la pantalla. La revisión automática sigue en modo AUDIT_ONLY.

## Fase B — Diagnóstico (solo lectura, informe)

6. Qué hora envía el puente por cada copa: payload de 2 copas de Cienvinos del 29-sep (Convento San Francisco, todas a las 12:46:09).
7. Por qué no llegan ciertos productos:
   - Casa Nene: Quinta de Couselo (19), Cillar de Silos (4), Bancales (2) y Pizarras (1).
   - Higuerón: Valdelainos copa (6).
   - Sa Pedrera: Iamontanum copa sale como Caus Lubis botella.
   - Albariza: Luthier Clarete / Vidueños frente a Remelluri / Río Negro.
8. Quién borró 419 ventas de Albariza el 30-sep entre 08:28 y 10:00, con qué herramienta y qué efecto tuvo en stock. Se revisan los registros de envío, las anulaciones y los accesos.
9. Qué locales tienen activados los tickets abiertos y el stock de tickets abiertos, y qué pasa hoy cuando llega la factura de un ticket que ya descontó stock como abierto.

## Fase C — Diseño del motor de convergencia (documento, sin desplegar)

10. **Motor.** Compara lo que debería haber (facturas + abiertos de más de 2 min, por día, vino y formato) con lo que hay en Winerim por identificador estable, y envía solo la diferencia:
    - diferencia positiva → venta `history_and_stock` con un id por unidad;
    - diferencia negativa → anulación de las últimas.

    Sustituye a los tickets abiertos, a la restauración de stock caducado y a las demás vías de stock. Incluye tope por ciclo, un solo proceso a la vez con lease y fence, modo simulación, y trabaja solo con el día en curso.
11. **Modo «comprobar»** en D+1 a las 06:00 y en D+2:
    - desvío pequeño → se corrige solo, con tope;
    - sin mapeo, formato sin configurar, lectura incompleta o desvío grande → alerta.

    Semáforo diario por local, por email.
12. **Pruebas:** reenviar un ciclo no crea nada; abrir y cerrar un ticket = 0 envíos extra; borrar una línea abierta = 1 anulación; un ticket abierto a medianoche cuenta en su día.

## Detalles técnicos

- Deduplicación y agregación por (business_day, winerim_wine_id, format) en el motor normal y en `historicalReconcile.ts`, con fixtures del 29-sep. Nuevo estado agregado por grupo: MATCHED, SHORT o EXCESS.
- Formato: resolver desde `winerim_wine_formats` y el mapping, nunca desde el nombre.
- Fase B: consultas a `stock_sync_log`, `winerim_cancel_requests`, `winerim_sale_deletions`, `outbound_tasks` y `pos_connections`.
- Fase C: se entrega como documento en DECISIONS_LOG / NEXT_STEPS. No se escribe código de envío.
