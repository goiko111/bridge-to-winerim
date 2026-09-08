-- Contacts for operational alerts per POS connection.
-- This table intentionally has RLS enabled without public anon/authenticated
-- policies. Contact emails/phones are sensitive operational data and should be
-- exposed through a secure backend/Worker endpoint, not directly to the browser.

CREATE TABLE IF NOT EXISTS public.connection_notification_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES public.pos_connections(id) ON DELETE CASCADE,
  contact_type text NOT NULL CHECK (contact_type IN ('internal', 'client', 'sat')),
  display_name text,
  email text,
  phone text,
  notify_on_health_failure boolean NOT NULL DEFAULT true,
  notify_on_stock_failure boolean NOT NULL DEFAULT true,
  notify_on_catalog_failure boolean NOT NULL DEFAULT true,
  enabled boolean NOT NULL DEFAULT true,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT connection_notification_contacts_has_channel
    CHECK (nullif(trim(coalesce(email, '')), '') IS NOT NULL OR nullif(trim(coalesce(phone, '')), '') IS NOT NULL)
);

ALTER TABLE public.connection_notification_contacts ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON public.connection_notification_contacts TO service_role;

CREATE INDEX IF NOT EXISTS idx_connection_notification_contacts_connection
  ON public.connection_notification_contacts(connection_id)
  WHERE enabled = true;

CREATE INDEX IF NOT EXISTS idx_connection_notification_contacts_type
  ON public.connection_notification_contacts(contact_type)
  WHERE enabled = true;

DROP TRIGGER IF EXISTS update_connection_notification_contacts_updated_at
  ON public.connection_notification_contacts;

CREATE TRIGGER update_connection_notification_contacts_updated_at
  BEFORE UPDATE ON public.connection_notification_contacts
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

COMMENT ON TABLE public.connection_notification_contacts IS
  'Operational notification contacts for POS connection health/stock/catalog alerts. RLS protected; expose through backend only.';
