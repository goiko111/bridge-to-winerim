
-- Marcar capacidades de escritura como verificadas para las 4 conexiones Agora activas
-- Insert si no existe la fila, update si ya existe
INSERT INTO provider_capabilities (connection_id, provider, can_read_sales, can_read_catalog, can_write_products, write_mode, write_endpoint, readiness_status, last_verified_at)
SELECT id, 'AGORA', true, true, 'YES', 'XML_IMPORT', '/api/import/', 'READY', now()
FROM pos_connections
WHERE provider='agora' AND id IN (
  'f1ce42a4-ffe2-44ea-bb3d-e22b306b1d8c', -- Kava
  'c9b23830-a00b-4786-a50b-43fe526c4d3c'  -- Luruna
)
AND NOT EXISTS (SELECT 1 FROM provider_capabilities pc WHERE pc.connection_id = pos_connections.id);

UPDATE provider_capabilities
SET can_write_products='YES', write_mode='XML_IMPORT', readiness_status='READY', last_verified_at=now(), updated_at=now()
WHERE connection_id IN (
  SELECT id FROM pos_connections WHERE provider='agora' AND location_name IN ('Sa Vida','Sa Pedrera','Luruna','Kava')
);

-- Activar auto_push_bottle en Kava y Sa Vida (las que estaban en false)
UPDATE pos_connections
SET auto_push_bottle = true, updated_at = now()
WHERE provider='agora' AND location_name IN ('Sa Vida','Kava');

-- Resetear push_tracking para que el próximo ciclo re-evalúe todos los vinos
UPDATE winerim_push_tracking
SET sync_status='NOT_PUSHED', updated_at=now()
WHERE connection_id IN (
  SELECT id FROM pos_connections WHERE provider='agora' AND location_name IN ('Sa Vida','Sa Pedrera','Luruna','Kava')
);
