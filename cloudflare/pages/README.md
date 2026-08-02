# Cloudflare Pages setup

## Objetivo
Publicar la interfaz operativa del middleware en Cloudflare Pages sin mover todavia clientes productivos fuera de Lovable Cloud.

## Proyecto recomendado
- Produccion: `middleware.winerim.wine`
- Staging: `staging.middleware.winerim.wine`
- Framework preset: Vite
- Build command: `npm run build`
- Output directory: `dist`
- Node version: 22

## Variables de entorno

Referencia local sin secretos: `cloudflare/pages/env.example`.

### Staging
```txt
VITE_MIDDLEWARE_API_URL=https://api-staging.middleware.winerim.wine
```

### Produccion
```txt
VITE_MIDDLEWARE_API_URL=https://api.middleware.winerim.wine
```

## Cloudflare Access
Antes de exponer Pages al equipo:
- Activar Cloudflare Access sobre `staging.middleware.winerim.wine`.
- Permitir solo usuarios internos de Winerim.
- Activar logs de acceso.

## Validacion inicial
1. Desplegar solo staging.
2. Abrir `/onboarding`.
3. Probar una conexion Agora de pruebas.
4. Probar una conexion REVO de pruebas con:
   - tenant;
   - access token;
   - client-token;
   - token Winerim.
5. Confirmar que el endpoint solo devuelve semaforos y no crea conexiones ni guarda tokens.

## Rollback
- Si staging falla, eliminar la ruta Pages o desactivar Access.
- Si produccion falla en el futuro, devolver DNS a Lovable Cloud o pausar la ruta Pages.
- No hay rollback de datos en esta fase porque Pages/Worker inicial no escribe en base de datos ni POS.
