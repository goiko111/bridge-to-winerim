# Backfill de ventas no registradas por falta de stock — 2026-09-10

## Contexto
El ajuste absoluto de stock (`newStock = max(0, previousStock - soldQty)`) sólo importaba la venta al historial de Winerim
cuando el stock no se movía. Con stock parcial (p. ej. stock 1 y venta de 3) se aplicaba 1 unidad y se perdían 2 en el historial.

## Cambio de código (ya desplegado)
- `supabase/functions/_shared/stockSyncUtils.ts`: `salesImportQtyForUnappliedStock`, `isStockShortfallSalesImportEnabled`.
- `supabase/functions/agora-proxy/index.ts`: `importWinerimSaleIfStockDidNotMove(..., recordStockShortfallSales)` en las 3 rutas de sync.
- Flag `provider_config.record_stock_shortfall_sales = true` activado en las 29 conexiones `provider='agora'`.
- El stock nunca queda negativo: el ajuste absoluto lo deja en 0 y los envíos a `/sales/import` van con `stockApplied=false`.

## Backfill histórico (90 días)
Conjunto correcto (sólo casos parciales `prev <> new` y `sold > prev-new`): **36 grupos / 69 unidades**.

Resultado final:
- **33 grupos / 66 unidades** importados correctamente (`status: imported`, `stockApplied: false`).
- 3 grupos / 3 unidades **no importables**:
  - El Bejeque — `B Phincas [botella]` 2026-07-25 — stockId 73314: `Stock not found or not accessible`.
  - Sa Pedrera — `B B310- Albenc [botella]` 2026-08-07 — stockId 327370: `Stock not found or not accessible`.
  - Finca Eslava — `B Toubes [botella]` 2026-08-12 — la conexión no tiene token de Winerim configurado.

## INCIDENCIA: envío inicial demasiado amplio (duplicados)
Un primer cálculo incluyó por error casos `prev = new` (ya importados por la lógica anterior) y se enviaron 552 peticiones.
Winerim devolvió 508 × 503 (saturación), 10 sin respuesta y 44 × 200. De las aceptadas, **42 apuntes (51 unidades) son duplicados**
del historial y 1 era legítima. No se alteró stock (todas con `stockApplied=false`), ni TPV, ni precios.

No existe endpoint de borrado/anulación de ventas en la API de Winerim v2 usada por el middleware, por lo que estos duplicados
deben eliminarse manualmente en Winerim con esta lista (`orderId` identifica el apunte exacto):

```
local;producto;fecha;unidades;stockId;orderId
Abadía Yuste;B Habla de Ti Sauvignon Blanc [botella];2026-07-17;1;161790;agora:6402cc37:2026-07-17:138884:bot:sfbf1
Abadía Yuste;B Laurent-Perrier Cuvée Rosé [botella];2026-07-19;1;161566;agora:6402cc37:2026-07-19:138651:bot:sfbf1
Casa Nene;B San Vicente [botella];2026-06-13;1;298957;agora:e3cb6dbb:2026-06-13:260550:bot:sfbf1
Chiquilla;B Don Zoilo Palo Cortado 15 Años [botella];2026-08-04;1;302481;agora:332a6c90:2026-08-04:263507:bot:sfbf1
Restaurante Jardi;B Algars Blanc [botella];2026-07-04;1;304541;agora:2ef2b6f1:2026-07-04:265280:bot:sfbf1
Restaurante Jardi;B Algars Blanc [botella];2026-07-15;1;304541;agora:2ef2b6f1:2026-07-15:265280:bot:sfbf1
Restaurante Jardi;B Algars Blanc [botella];2026-07-16;1;304541;agora:2ef2b6f1:2026-07-16:265280:bot:sfbf1
Restaurante Jardi;B Algars Negre [botella];2026-06-22;2;304542;agora:2ef2b6f1:2026-06-22:265281:bot:sfbf1
Restaurante Jardi;B Algars Negre [botella];2026-09-08;1;304542;agora:2ef2b6f1:2026-09-08:265281:bot:sfbf1
Restaurante Jardi;B Algars Rosat [botella];2026-07-06;1;304540;agora:2ef2b6f1:2026-07-06:265279:bot:sfbf1
Restaurante Jardi;B Algars Rosat [botella];2026-07-17;1;304540;agora:2ef2b6f1:2026-07-17:265279:bot:sfbf1
Restaurante Jardi;B Anais Blanc Organic [botella];2026-07-04;1;332133;agora:2ef2b6f1:2026-07-04:288350:bot:sfbf1
Restaurante Jardi;B Anais Blanc Organic [botella];2026-07-23;1;332133;agora:2ef2b6f1:2026-07-23:288350:bot:sfbf1
Restaurante Jardi;B Bàrbara Forés Rosat [botella];2026-07-06;1;303785;agora:2ef2b6f1:2026-07-06:264600:bot:sfbf1
Restaurante Jardi;B Bàrbara Forés Rosat [botella];2026-07-30;2;303785;agora:2ef2b6f1:2026-07-30:264600:bot:sfbf1
Restaurante Jardi;B Gramona Imperial Brut [botella];2026-07-27;1;303837;agora:2ef2b6f1:2026-07-27:264651:bot:sfbf1
Restaurante Jardi;B Raventós i Blanc de Nit [botella];2026-07-25;2;303824;agora:2ef2b6f1:2026-07-25:264639:bot:sfbf1
Restaurante Jardi;B Rotllan Torra Selecció [botella];2026-06-28;1;332785;agora:2ef2b6f1:2026-06-28:288947:bot:sfbf1
Restaurante Jardi;B Terrers Brut Nature Gran Reserva [botella];2026-07-24;3;303828;agora:2ef2b6f1:2026-07-24:264643:bot:sfbf1
Sa Pedrera;B B301-Quíbia (Falanis) [botella];2026-06-22;1;10278;agora:e2f6ce27:2026-06-22:9647:bot:sfbf1
Sa Pedrera;B B301-Quíbia (Falanis) [botella];2026-06-29;1;10278;agora:e2f6ce27:2026-06-29:9647:bot:sfbf1
Sa Pedrera;B B341-Do Ferreiro Albariño [botella];2026-06-29;1;108107;agora:e2f6ce27:2026-06-29:91969:bot:sfbf1
Sa Pedrera;B B352-Viña de Martin Os Pasás [botella];2026-06-29;2;111124;agora:e2f6ce27:2026-06-29:94437:bot:sfbf1
Sa Pedrera;B B357-Tras da Viña Albariño [botella];2026-06-29;1;111178;agora:e2f6ce27:2026-06-29:94398:bot:sfbf1
Sa Pedrera;B T1 - Iamontanum Garnacha - Isla de Menorca [botella];2026-06-29;1;112241;agora:e2f6ce27:2026-06-29:95501:bot:sfbf1
Sa Pedrera;B T1 - Iamontanum Garnacha - Isla de Menorca [botella];2026-06-30;1;112241;agora:e2f6ce27:2026-06-30:95501:bot:sfbf1
Sa Pedrera;Godeval Cepas Vellas [botella];2026-06-15;2;111979;agora:e2f6ce27:2026-06-15:95249:bot:sfbf1
Sa Pedrera;Godeval Cepas Vellas [botella];2026-06-16;1;111979;agora:e2f6ce27:2026-06-16:95249:bot:sfbf1
Sa Pedrera;M MAGNUM 22 - Izadi Crianza [magnum];2026-08-28;1;112928;agora:e2f6ce27:2026-08-28:96211:mag:sfbf1
Taberna de Elia;B Aalto [botella];2026-08-28;1;208873;agora:ae599bfb:2026-08-28:180951:bot:sfbf1
Taberna de Elia;B El Prohibido by Raúl Pérez [botella];2026-07-14;1;227318;agora:ae599bfb:2026-07-14:197845:bot:sfbf1
Taberna de Elia;B Licinia [botella];2026-07-31;1;208953;agora:ae599bfb:2026-07-31:181030:bot:sfbf1
Taberna de Elia;B Licinia [botella];2026-08-28;1;208953;agora:ae599bfb:2026-08-28:181030:bot:sfbf1
Taberna de Elia;B Mauro [botella];2026-07-15;1;208947;agora:ae599bfb:2026-07-15:181024:bot:sfbf1
Taberna de Elia;B Muga Crianza [botella];2026-08-09;1;208889;agora:ae599bfb:2026-08-09:180967:bot:sfbf1
Taberna de Elia;B Muga Crianza [botella];2026-08-28;1;208889;agora:ae599bfb:2026-08-28:180967:bot:sfbf1
Taberna de Elia;B Predicador [botella];2026-07-15;1;208906;agora:ae599bfb:2026-07-15:180984:bot:sfbf1
Taberna de Elia;B Predicador [botella];2026-07-16;1;208906;agora:ae599bfb:2026-07-16:180984:bot:sfbf1
Taberna de Elia;M 100 Aniversario [magnum];2026-09-03;1;208884;agora:ae599bfb:2026-09-03:180962:mag:sfbf1
Tintorera;B Château Beaumont Haut-Médoc [botella];2026-07-26;1;285044;agora:1efe95c0:2026-07-26:248222:bot:sfbf1
Tintorera;B Domaine Nathalie et Gilles Fevre Chablis Vieilles Vignes [botella];2026-08-29;1;284759;agora:1efe95c0:2026-08-29:247959:bot:sfbf1
Tintorera;B Pago de Tharsys Rosé Brut Nature Gran Reserva Ceramica [botella];2026-07-23;1;305491;agora:1efe95c0:2026-07-23:266205:bot:sfbf1
```
