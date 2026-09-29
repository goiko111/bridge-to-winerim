-- Rollback of the Clinic-only AUDIT_ONLY scheduler (job reconciliation-v2-clinic-daily-audit).
-- Never deletes historical evidence (runs, results, scheduler_state, checkpoints).

-- 1) Stop the job
select cron.unschedule('reconciliation-v2-clinic-daily-audit');

-- 2) Revoke the service identity (the edge functions reject it immediately)
update public.reconciliation_v2_scheduler_identities set revoked_at = now() where label = 'clinic-scheduler-v1' and revoked_at is null;
-- optional: remove the plaintext from Vault
-- delete from vault.secrets where name = 'reconciliation_scheduler_key_v1';

-- 3) Release only the scheduler lock (TTL 900 s also recovers it automatically)
delete from public.reconciliation_v2_locks where connection_id = '1c5177f1-9459-4ee9-8b6e-4780f8b6b96b' and stream = 'scheduler:daily';

-- Rotation: create vault secret 'reconciliation_scheduler_key_v2' + insert its sha256 into
-- reconciliation_v2_scheduler_identities, re-schedule the job pointing at v2, then revoke v1.
-- Unblock after BLOCKED (human review): update reconciliation_v2_scheduler_state set status='FAILED' where status='BLOCKED' and <día revisado>;
