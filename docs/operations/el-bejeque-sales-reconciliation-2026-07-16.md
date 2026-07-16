# El Bejeque - Reconciliacion de ventas

Fecha: 2026-07-16

## Alcance

- Reconciliar las ventas Agora del 2026-07-15 contra el historial Winerim.
- Corregir duplicados y stock afectado.
- Importar ventas historicas desde 2026-04-15 hasta 2026-07-14 sin descontar stock.
- Dejar una ruta de rollback y excepciones explicitas.

## Incidente del 15/07

Antes:

- Agora: 8 facturas cerradas.
- Winerim: 35 tarjetas, 44 unidades y 1.286 EUR.
- Patron: la misma venta reaparecia cada cinco minutos.

Causa:

- `sales_line_items` se reemplazaba en cada snapshot.
- La FK de `stock_sync_log.sales_line_item_id` usaba `ON DELETE CASCADE`.
- El claim idempotente desaparecia con la linea y el siguiente ciclo repetia la venta.

Despues:

- Winerim: 8 tarjetas y 15 unidades enteras.
- Agora: 15 unidades enteras y 0,5 magnum adicional.
- Cloe copa no se pudo registrar porque el vino esta inactivo e inaccesible en Winerim.
- Winerim valora esas tarjetas en 267 EUR y Agora en 248,50 EUR. La diferencia
  procede del redondeo del medio magnum y de la copa de Cloe ausente.

## Tarjetas conservadas

- `140892` - Mondalon Tinto botella, 1.
- `140994` - Bozeto de Exopto botella, 1.
- `140806` - Malpastor magnum, 2.
- `140840` - Vulcano Dolce copa, 6.
- `140650` - Celeste Roble copa, 1.
- `140620` - Dosterras Vermell botella, 1.
- `140590` - Mondalon Tinto botella, 1.
- `140609` - Mondalon Tinto copa, 2.

## Tarjetas anuladas

- Canary: `140912`.
- Bozeto: `140908`, `140905`, `140902`, `140919`.
- Mondalon botella: `140903`, `140899`, `140893`, `140587`, `140584`, `140581`, `140577`, `140571`, `140906`.
- Malpastor magnum: `140836`, `140629`, `140628`, `140626`, `140621`, `140617`, `140612`, `140605`, `140631`, `140643`.
- Dosterras botella: `140616`, `140610`, `140603`.

## Stock verificado

| Variante | Antes de limpiar | Despues |
|---|---:|---:|
| Bozeto botella | 0 | 5 |
| Mondalon botella | 0 | 9 |
| Malpastor magnum | 1 | 13 |
| Dosterras botella | 2 | 5 |

La anulacion canary de Bozeto repuso exactamente una unidad antes de continuar.

## Historico importado

- Rango solicitado: 2026-04-15 a 2026-07-14.
- Dias consultados: 91.
- Facturas Agora: 413.
- Lineas de restaurante examinadas: 3.899.
- Lineas nuevas importadas: 286.
- Unidades nuevas registradas: 414.
- Primera fecha visible importada: 2026-04-17.
- Segunda ejecucion masiva: 0 importadas y 285 omitidas por idempotencia.

El endpoint utilizado fue exclusivamente `POST /api/v2/sales/import`.
No se llamo a ningun endpoint de stock. Una muestra de nueve variantes activas
e inactivas mantuvo exactamente el mismo stock antes y despues.

Limitacion: `sales/import` registra la venta con el PVP actual de la variante
Winerim; no acepta el importe historico facturado por Agora. Cantidades, vino,
variante y hora se conservan, pero el total monetario puede no reproducir el
ticket antiguo si el precio cambio.

## Alias manuales aprobados

- `R.BILBAO GARNACHA ED. LIM` -> `RAMON BILBAO GARNACHA ED. LIM`.
- `KLOOF STREET CHENIN BLANC` -> `Kloof Street Old Vine Chenin Blanc`.
- `KLOOF STREET ROUGE` -> `Kloof Street Swartland Rouge`.
- `COPA VULCANO` -> `Vulcano Dolce`.
- `RATAFIA CHAVOST` -> `Ratafia Champenoise-Champagne Chavost`.
- `BALANCINES TINTO` -> `Balancines Garnacha y Garnacha`.

## Excepciones no importadas

- Cloe: 6 unidades en el historico hasta el 2026-07-14, mas 1 copa del
  2026-07-15. El vino Winerim `57683` esta inactivo y sus stockIds de
  botella/copa devuelven 404.
- `ABAD DOM BUENO GODELLO`: 2 unidades; no se confirma que sea
  `Abad Dom Bueno Esencia`.
- Pazo das Bruxas copa, Brezo copa y Natureo copa: no existe una variante copa
  accesible en Winerim.
- Bhilar Biodinamico y Dosterras Blanc: no hay equivalente actual inequívoco.

## Proteccion y rollback

- Mientras el runtime no incorpore el fix:
  - `open_tickets_sync_enabled=false`;
  - `open_tickets_stock_sync_enabled=false`;
  - `intraday_sales_sync_enabled=false`.
- No reactivar esos flags antes de:
  1. desplegar `agora-proxy`;
  2. aplicar la migracion FK a `ON DELETE SET NULL`;
  3. ejecutar dos veces el mismo snapshot;
  4. comprobar que la segunda vuelta no crea venta ni mueve stock.
- Si hubiera que reconstruir una tarjeta anulada, usar la factura Agora original
  y el endpoint idempotente de ventas. No insertar filas directamente ni
  modificar stock sin reconciliar ambas capas.
