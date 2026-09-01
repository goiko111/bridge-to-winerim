\set ON_ERROR_STOP on

BEGIN;

CREATE TABLE IF NOT EXISTS public.runtime_connection_credentials (
  connection_id uuid NOT NULL REFERENCES public.pos_connections(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider = 'agora'),
  credential_kind text NOT NULL CHECK (credential_kind IN ('agora', 'winerim')),
  algorithm text NOT NULL DEFAULT 'AES-256-GCM' CHECK (algorithm = 'AES-256-GCM'),
  key_version text NOT NULL CHECK (key_version ~ '^[A-Za-z0-9._-]{1,64}$'),
  aad_version smallint NOT NULL DEFAULT 1 CHECK (aad_version = 1),
  ciphertext bytea NOT NULL CHECK (octet_length(ciphertext) > 16 AND octet_length(ciphertext) <= 16384),
  nonce bytea NOT NULL CHECK (octet_length(nonce) = 12),
  active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, credential_kind)
);

CREATE INDEX IF NOT EXISTS idx_runtime_connection_credentials_active
  ON public.runtime_connection_credentials(connection_id, credential_kind)
  WHERE active = true;

DROP TRIGGER IF EXISTS update_runtime_connection_credentials_updated_at
  ON public.runtime_connection_credentials;
CREATE TRIGGER update_runtime_connection_credentials_updated_at
  BEFORE UPDATE ON public.runtime_connection_credentials
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.runtime_connection_credentials ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS middleware_runtime_select_active
  ON public.runtime_connection_credentials;
CREATE POLICY middleware_runtime_select_active
  ON public.runtime_connection_credentials
  FOR SELECT TO middleware_runtime
  USING (active = true);

REVOKE ALL ON public.runtime_connection_credentials
  FROM PUBLIC, authenticated, service_role, middleware_api, middleware_readonly, middleware_runtime;
GRANT SELECT ON public.runtime_connection_credentials TO middleware_runtime;

COMMENT ON TABLE public.runtime_connection_credentials IS
  'Connection-scoped ciphertext only. AES-GCM key material stays outside PostgreSQL and is injected through a private Worker binding.';
COMMENT ON COLUMN public.runtime_connection_credentials.ciphertext IS
  'AES-256-GCM ciphertext including authentication tag; never plaintext.';

COMMIT;
