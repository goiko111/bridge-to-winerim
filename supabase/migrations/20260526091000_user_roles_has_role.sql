-- Base auth primitive required by PROJECT_CONTEXT.md.
-- This is additive only: existing policies are not tightened in this migration.

CREATE TABLE IF NOT EXISTS public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  role TEXT NOT NULL,
  connection_id UUID REFERENCES public.pos_connections(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role TEXT)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles
    WHERE user_id = _user_id
      AND role = _role
  );
$$;

CREATE INDEX IF NOT EXISTS idx_user_roles_user_role
  ON public.user_roles(user_id, role);

CREATE INDEX IF NOT EXISTS idx_user_roles_connection
  ON public.user_roles(connection_id)
  WHERE connection_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_roles_global_unique
  ON public.user_roles(user_id, role)
  WHERE connection_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_roles_connection_unique
  ON public.user_roles(user_id, role, connection_id)
  WHERE connection_id IS NOT NULL;
