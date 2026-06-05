# Sa Pedrera · `DULCES WINERIM` altas nuevas D710/D716 · 2026-06-05

## Resumen

Sa Pedrera confirmó que el orden visual de `DULCES WINERIM` ya era correcto, pero los vinos activados o añadidos en Winerim no aparecían en Agora.

Diagnóstico:

- El piloto anterior estaba limitado a `D701-D709`.
- Sa Pedrera tiene `auto_push_on_create=true` y `auto_push_on_update=true`, pero `auto_push_verified_ready=false`; por tanto el auto-push general está bloqueado.
- Las reglas generales de routing de Sa Pedrera siguen enviando postres botella a la familia legacy `Vino Dulce` y copas a `Copa Vino Postre`; no reproducen la pantalla validada `DULCES WINERIM`.

## Corrección aplicada en vivo

Se reimportó la familia `DULCES WINERIM` (`903925`) con todos los vinos activos Winerim `D###` de tipo postre/dulce:

| Código | Agora product id | Formato | Nombre | Precio |
| --- | --- | --- | --- | --- |
| D701 | `903701` | GLASS | `C D701- Moscatel de la Marina` | 6 |
| D702 | `903702` | GLASS | `C D702-East India Solera` | 8 |
| D703 | `903703` | GLASS | `C D703 -Spínola Delicado` | 8 |
| D704 | `903704` | GLASS | `C D704 -Jordi Miró Naturalment Pansificat` | 8 |
| D705 | `903705` | GLASS | `C D705-El Sequé Dulce` | 8 |
| D706 | `903706` | GLASS | `C D706-Niepoort LBV` | 8 |
| D707 | `903707` | BOTTLE | `B D707- Valverán Sidra de Hielo` | 65 |
| D708 | `903708` | BOTTLE | `B D708- Tokaji Aszú 3 Puttonyos` | 60 |
| D709 | `903709` | BOTTLE | `B D709- Petracs` | 94 |
| D710 | `903710` | BOTTLE | `B D710- Don PX 1993 Tº Albalá` | 95 |
| D716 | `903716` | BOTTLE | `B D716-Lions de Suduiraut` | 58 |

Excluidos por estar inactivos en Winerim:

- `D715-Pancaliente`
- `D705-(MR) Mountain Wine`

## Verificación

- 11/11 productos esperados verificados por `export-master`.
- Todos quedan en `FamilyId=903925`.
- Todos quedan `SaleableAsMain=true`.
- Todos quedan `UseAsDirectSale=false`.
- `product_mappings` y `winerim_push_tracking` actualizados a los IDs `9037xx` visibles.
- Master data refrescado en Lovable Cloud: `1270` productos, `73` familias, sin truncation warnings.

Backup local sin secretos:

- `.codex-backups/sa-pedrera-dulces-before-2026-06-05T2026-06-05T09-52-24-486Z.json`

## Código preparado

`agora-proxy` queda preparado para que la acción controlada `sa-pedrera-dulces-winerim-trial` lea todos los `D###` activos de postre/dulce, no solo `D701-D709`.

Además, el generador automático identifica Sa Pedrera + vino postre/dulce + código `D###` y usa:

- familia `903925` (`DULCES WINERIM`);
- product id `903000 + código`, por ejemplo `D716` -> `903716`;
- una única variante visible por código: copa si Winerim la marca activa, botella si no.

## Riesgos / pendiente

- No reactivar `auto_push_verified_ready` hasta confirmar que Lovable Cloud está ejecutando esta versión de `agora-proxy` y `winerim-proxy`.
- Si se activa el gate con runtime antiguo, el auto-push podría volver a usar IDs derivados de `winerim_id` o familias legacy y romper el orden visual validado.
- Prueba post-push: Lovable Cloud sigue devolviendo `{"error":"Unknown action"}` para `sa-pedrera-dulces-winerim-trial`, por lo que aún no hay redeploy efectivo.
- Pendiente: repetir el dry-run tras redeploy y confirmar que devuelve `D710`/`D716` antes de dejar el automático general activo.
