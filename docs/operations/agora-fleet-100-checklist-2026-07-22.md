# Auditoría integral de la flota Agora - 2026-07-22

## Resultado ejecutivo

Se han auditado las `30` conexiones Agora registradas aplicando el checklist
universal de diez bloques. La auditoría ha sido estrictamente de solo lectura:
no se han modificado productos, precios, flags, mappings, tracking, colas,
legacy, stock ni historial.

- Conexiones activas: `23`.
- Conexiones deshabilitadas: `7`.
- Conexiones con los diez bloques firmados: `0`.
- Activas sin un `FAIL` demostrado en los bloques 1-9, pero pendientes de
  evidencias o cierres: `6`.
- Activas con al menos una incidencia funcional demostrada: `17`.

Esto no significa que las 23 activas estén caídas. Todas responden y muchas
tienen catálogo exacto. Significa que ninguna tiene todavía evidencia completa
de catálogo, ventas, variantes, stock, cancelación, recuperación,
monitorización y aceptación final a la vez.

## Leyenda

- `PASS`: requisito comprobado con evidencia real y vigente.
- `WARN`: funciona parcialmente o falta una prueba obligatoria; no se ha
  demostrado un fallo.
- `FAIL`: existe una discrepancia o bloqueo funcional comprobado.
- `NOT_ACTIVE`: conexión deshabilitada; no se ha sondeado.

Abreviaturas: `CON` conectividad, `CFG` configuración, `CAT` catálogo, `AUT`
cambios automáticos, `LEG` estructura/legacy, `VEN` ventas, `STK` stock,
`RES` resiliencia, `MON` monitorización y `SIG` firma final.

## Matriz completa

| Restaurante | CON | CFG | CAT | AUT | LEG | VEN | STK | RES | MON | SIG |
|---|---|---|---|---|---|---|---|---|---|---|
| Abadía Yuste | PASS | PASS | PASS | WARN | WARN | WARN | WARN | WARN | WARN | FAIL |
| Baco Getafe | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE |
| Casa Esteban | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE |
| Casa Nene | PASS | PASS | PASS | WARN | PASS | WARN | WARN | WARN | WARN | FAIL |
| Chiquilla | PASS | PASS | PASS | PASS | PASS | PASS | WARN | PASS | WARN | FAIL |
| De la O | PASS | WARN | PASS | WARN | WARN | FAIL | WARN | PASS | PASS | WARN |
| Don Bernardo Ponzano | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE |
| Don Bernardo Santander | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE |
| Don Quijote Marbella | PASS | WARN | PASS | WARN | WARN | WARN | WARN | WARN | PASS | WARN |
| El Bejeque | PASS | PASS | PASS | WARN | PASS | FAIL | WARN | PASS | PASS | WARN |
| El Higuerón | PASS | WARN | PASS | WARN | PASS | WARN | WARN | WARN | FAIL | WARN |
| El Portón de Sorni | PASS | PASS | PASS | WARN | FAIL | WARN | PASS | WARN | PASS | FAIL |
| Finca Eslava | PASS | WARN | PASS | WARN | FAIL | FAIL | WARN | FAIL | FAIL | FAIL |
| Katsu Izakaya | PASS | WARN | PASS | WARN | PASS | WARN | PASS | WARN | PASS | WARN |
| Kava | PASS | WARN | PASS | WARN | WARN | FAIL | WARN | FAIL | WARN | FAIL |
| La Candela de Triana | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE |
| Luruna | PASS | WARN | PASS | WARN | FAIL | FAIL | FAIL | WARN | WARN | FAIL |
| O Bistro | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE |
| Ocean Club | PASS | WARN | PASS | WARN | WARN | WARN | WARN | WARN | PASS | WARN |
| PurOsushi | PASS | WARN | FAIL | FAIL | WARN | FAIL | FAIL | FAIL | FAIL | FAIL |
| Restaurante Cienvinos Écija | PASS | PASS | PASS | PASS | WARN | FAIL | FAIL | PASS | WARN | FAIL |
| Restaurante Jardi | PASS | WARN | WARN | WARN | WARN | FAIL | WARN | PASS | FAIL | FAIL |
| Restaurante Qtomas | PASS | FAIL | WARN | FAIL | FAIL | FAIL | FAIL | WARN | FAIL | FAIL |
| Restaurante Triana | PASS | FAIL | FAIL | FAIL | FAIL | FAIL | FAIL | WARN | FAIL | FAIL |
| Sa Pedrera | PASS | WARN | FAIL | WARN | WARN | FAIL | FAIL | WARN | FAIL | FAIL |
| Sa Vida | PASS | FAIL | FAIL | FAIL | WARN | FAIL | WARN | WARN | WARN | FAIL |
| Saddle | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE |
| Taberna de Elia | PASS | FAIL | PASS | WARN | WARN | FAIL | WARN | WARN | FAIL | FAIL |
| Tintorera | PASS | PASS | PASS | WARN | WARN | WARN | WARN | WARN | FAIL | FAIL |
| Vinatea | PASS | FAIL | PASS | WARN | FAIL | FAIL | FAIL | FAIL | FAIL | FAIL |

## Cobertura de las 23 activas

| Bloque | PASS | Lectura |
|---|---:|---|
| Conectividad | 23/23 | Todos los TPV activos respondieron en el corte. |
| Configuración | 7/23 | Hay flags contradictorios, frecuencias de 15 min o automatismos desactivados. |
| Catálogo | 17/23 | Cuatro tienen diferencias reales y dos deuda de tracking. |
| Cambios automáticos | 2/23 | Solo Chiquilla y Cienvinos tienen propagación real menor de 5 min demostrada. |
| Estructura / legacy | 5/23 | En muchas conexiones el legacy sigue vendible, buscable o usado por sala. |
| Ventas | 1/23 | Solo Chiquilla pasa estrictamente botella+copa; varias funcionan pero carecen de canaries o no concilian. |
| Stock | 2/23 | El Portón y Katsu tienen stock activo y sales-only demostrados; el resto tiene pruebas incompletas o incidencias. |
| Resiliencia | 5/23 | Faltan canaries de caída, cancelación y recuperación o existe duplicación semántica. |
| Monitorización | 6/23 | Hay cursores stale, alertas obsoletas o monitores que no detectan divergencias funcionales. |
| Firma final | 0/23 | Ninguna cumple todavía todos los controles aplicables. |

## Más próximas a firma

Estas conexiones no presentan un `FAIL` demostrado en los bloques 1-9, pero
siguen sin poder firmarse:

1. **Chiquilla:** catálogo `73/73`, botella, copa y propagación de `0,9-3,5`
   min comprobadas. Falta corregir una cancelación que permanece positiva en
   ERP, normalizar nueve trackings y cerrar una alerta ya obsoleta.
2. **Casa Nene:** catálogo `372/372` y legacy oculto. Falta canary real de
   copa, sales-only, reconciliar dos riesgos provisional/definitivo y corregir
   el cursor `sales_stale`.
3. **Katsu Izakaya:** catálogo `157/157`, legacy no buscable y stock activo/
   sales-only probados. Las dos copas más recientes tardaron `39-49 min`; falta
   cancelación segura y los canaries completos de catálogo.
4. **Don Quijote Marbella:** catálogo `114/114`. Faltan canaries reales de
   ventas, stock, cancelación, recuperación y decisión sobre `147` candidatos
   legacy aún vendibles/buscables.
5. **Ocean Club:** catálogo `113/113` y monitor limpio. No existe todavía una
   venta real desde botón Winerim; queda cerrar la estrategia de categorías y
   `162` productos legacy vendibles.
6. **Abadía Yuste:** catálogo `281/281` y botella sales-only comprobada. Falta
   copa, magnum, stock activo, cancelación, recovery y retirar/mapear legacy
   que tuvo `28` unidades vendidas sin llegar a Winerim.

## Incidencias funcionales demostradas

1. **De la O:** dos discrepancias históricas de ventas y riesgo activo de
   provisional+definitiva; legacy buscable.
2. **El Bejeque:** siete discrepancias históricas, incluidas duplicaciones
   funcionales y un magnum fraccional; el flujo futuro ya usa factura cerrada.
3. **El Higuerón:** catálogo correcto, pero monitor `sales_stale`; faltan copa
   y sales-only reales y cerrar contradicciones de configuración.
4. **El Portón de Sorni:** ventas reales por legacy sin mapping; una copa tardó
   más de una hora.
5. **Finca Eslava:** una venta cancelada permanece positiva en ERP y hay `139`
   productos legacy buscables con uso real.
6. **Kava:** faltan tres copas de Pampaneando y existe una botella duplicada;
   la autoridad sigue siendo factura post-cierre.
7. **Luruna:** cuatro vinos legacy vendidos sin mapping ni llegada a Winerim;
   además existe un `404` de stock vivo.
8. **PurOsushi:** dos diferencias de precio y duplicaciones funcionales reales
   por provisional+reversión+definitiva; cursor de ventas obsoleto.
9. **Cienvinos Écija:** catálogo y cambios automáticos pasan, pero Agora,
   ledger y ERP no concilian; hay `14` fallos de stock/importación recientes.
10. **Jardi:** frecuencia de `15 min`, cursor definitivo parado y alerta
    `sales_stale`; falta cobertura suficiente de mapping de ventas.
11. **Qtomas:** automatismos apagados, legacy masivo vendible y duplicaciones
    funcionales demostradas.
12. **Restaurante Triana:** todas las ventas observadas pasan por legacy y
    ninguna llega a Winerim; copa automática apagada y dos retirados vendibles.
13. **Sa Pedrera:** una diferencia de precio, cursor bloqueado, `404` de Albenc,
    divergencias ERP y dos alertas activas.
14. **Sa Vida:** nueve diferencias fresh de catálogo, verified-ready apagado,
    propagaciones de `29 min` y `5 h 08 min` y riesgo de duplicación funcional.
15. **Taberna de Elia:** catálogo exacto, pero provisional y factura definitiva
    duplican historial; configuración y monitor no están cerrados.
16. **Tintorera:** catálogo exacto, pero falta toda prueba real de venta; hay
    `521` candidatos legacy y una alerta de cola activa.
17. **Vinatea:** `174` productos legacy vendibles, copas registradas como
    botella y cursor de ventas bloqueado.

## Conexiones deshabilitadas

- **Baco Getafe:** rollback deliberado a legacy; requiere autorización y
  onboarding nuevo.
- **Casa Esteban:** staging sin catálogo Winerim cargado.
- **Don Bernardo Ponzano:** pull-only, sin mappings ni tracking.
- **Don Bernardo Santander:** pull-only, sin mappings ni tracking.
- **La Candela de Triana:** deshabilitada; debe resolverse su identidad frente
  a Restaurante Triana antes de reactivar.
- **O Bistro:** URL de red privada, inaccesible desde Lovable Cloud.
- **Saddle:** pendiente del diseño funcional de menús/armonías y tSpoonLab.

## Orden recomendado de trabajo

1. Detener la duplicación funcional: Kava, PurOsushi, Qtomas, Taberna de Elia,
   Sa Vida y los casos históricos de De la O/El Bejeque.
2. Recuperar ventas omitidas o no mapeadas: Luruna, Restaurante Triana,
   Cienvinos, Sa Pedrera, Jardi y Vinatea.
3. Corregir divergencias de catálogo: Sa Vida, PurOsushi, Sa Pedrera y la deuda
   de tracking de Jardi/Qtomas.
4. Ejecutar canaries reales y medidos en las seis conexiones más próximas a
   firma.
5. Resolver legacy por snapshot reversible, sustituto exacto y validación del
   cliente; nunca ocultarlo masivamente sin comprobar uso real.
6. Reactivar las siete `NOT_ACTIVE` solo como nuevos onboardings controlados.

## Informes de evidencia

- `docs/operations/agora-100-checklist-batch-1-2026-07-22.md`
- `docs/operations/agora-100-checklist-batch-2-2026-07-22.md`
- `docs/operations/agora-100-checklist-batch-3-2026-07-22.md`
- `docs/operations/agora-100-checklist-batch-4-2026-07-22.md`
- `docs/operations/agora-100-checklist-batch-4-verification-2026-07-22.md`
- `docs/operations/agora-100-checklist-batch-5-2026-07-22.md`
- `docs/operations/agora-100-checklist-batch-6-2026-07-22.md`
