# Cienvinos Écija — duplicados del 17/09/2026 (ajuste preparado, NO aplicado)

Conexión: 21ee3345-1090-4e83-94f2-43126d6e7695
Fuente: export Winerim `Sales_18-09-2026_15-59-36.csv` (filtrado `Tipo de venta = api_tpv`) vs ventas del TPV Agora del 17/09.
Estado: **solo lectura**. Nada aplicado. Requiere autorización explícita para ejecutar.

## Resumen

- TPV Agora 17/09: 29 botellas de vino (más 203 copas, que no aparecen duplicadas).
- Winerim, mismo día, escritas vía api_tpv: 51 botellas.
- Sobrante a devolver al stock: **23 unidades** (10 vinos). Neto frente al TPV: +22 (1 botella de Bollinger nunca llegó a escribirse).
- Causa: el sistema anterior ya había escrito el día 17 y el backfill certificado lo repitió, por lo que el stock se descontó dos veces.

## Ajuste propuesto (stock en positivo, formato botella)

| Vino | Winerim ID | stockId botella | Unidades a devolver |
|---|---|---|---|
| Manzanilla Gabriela | 239957 | 275378 | +5 |
| Yllera 5.5 Frizzante | 239943 | 275359 | +4 |
| SoHo'S Fino Spritz | 239938 | 275353 | +3 |
| Finca Resalso | 239335 | 274688 | +3 |
| Dominio de Greda | 369795 | 415220 | +2 |
| Ramón Bilbao | 242177 | 277880 | +2 |
| Árabe Sauvignon Blanc | 239886 | 275293 | +1 |
| Arzuaga Crianza | 239280 | 274634 | +1 |
| Pago de Los Capellanes Roble | 239845 | 275247 | +1 |
| Protos Roble | 239858 | 275262 | +1 |
| **Total** | | | **+23** |

Método previsto al autorizar: lectura del stock actual de cada stockId y escritura absoluta `stock_actual + unidades` (una sola pasada, con verificación posterior). No se borra ni modifica ninguna línea del histórico de ventas.

## Sobras menores — NO incluidas en el ajuste

Diferencias que no proceden del canal certificado (escritas por el sistema anterior). Recomendación: revisarlas/borrarlas en Winerim, no ajustarlas desde aquí.

| Vino | Día | Sobrante |
|---|---|---|
| Viña Caeira | 11/09 | +12 |
| Viña Caeira | 13/09 | +1 |
| El Pacto Crianza | 12/09 | +2 |
| Dominio del Pidio | 15/09 | +2 |
| Excellens Sauvignon Blanc | 14/09 | +1 |
| Heritage Reserva Convento Las Claras | 14/09 | +1 |
| Marqués de Vizhoja | 16/09 | +1 |

## Notas

- Días 9, 10, 13 y 16: cuadran exactos. Días 1–8: sistema anterior.
- Día 18: las diferencias son mesas abiertas en curso, no duplicados.
- Pendientes previos de Cienvinos: 5 copas de hidromiel Moncalvillo (NOT_APPLICABLE) y 1 botella de Bollinger Special Cuvée (vino inexistente en Winerim).
