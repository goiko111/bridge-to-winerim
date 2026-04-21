
-- Link provider_products to winerim_wines for Kava (and any connection) using winerim_push_tracking
UPDATE provider_products pp
SET winerim_wine_id = wpt.winerim_wine_id,
    sync_status = 'SYNCED',
    last_synced_at = now()
FROM winerim_push_tracking wpt
WHERE pp.connection_id = wpt.connection_id
  AND pp.provider_product_id = wpt.agora_product_id
  AND wpt.sync_status = 'VERIFIED'
  AND pp.winerim_wine_id IS NULL;

-- Also resolve sales_line_items that match the now-linked provider_products
UPDATE sales_line_items sli
SET winerim_product_id = pp.winerim_wine_id,
    mapped = true,
    is_wine_candidate = true
FROM provider_products pp
WHERE sli.connection_id = pp.connection_id
  AND sli.provider_product_id = pp.provider_product_id
  AND pp.winerim_wine_id IS NOT NULL
  AND sli.winerim_product_id IS NULL;
