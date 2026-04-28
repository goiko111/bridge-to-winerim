
-- Make Luruna fully automatic, like Sa Vida
UPDATE pos_connections
SET auto_push_verified_ready = true,
    auto_push_on_create = true,
    auto_push_on_update = true,
    require_manual_review_before_push = false,
    auto_create_families = true,
    sync_frequency_minutes = 5
WHERE id = 'c9b23830-a00b-4786-a50b-43fe526c4d3c';

-- Enable auto-create families for Sa Vida too (so new wine types don't get stuck)
UPDATE pos_connections
SET auto_create_families = true
WHERE id = 'e5b988f1-8471-4336-a1f7-a5c1626deab1';
