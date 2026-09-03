
-- Drop existing restrictive policies
DROP POLICY IF EXISTS "Authenticated users can delete connections" ON public.pos_connections;
DROP POLICY IF EXISTS "Authenticated users can insert connections" ON public.pos_connections;
DROP POLICY IF EXISTS "Authenticated users can update connections" ON public.pos_connections;
DROP POLICY IF EXISTS "Authenticated users can view connections" ON public.pos_connections;

-- Create permissive policies (allow all for now, until auth is added)
CREATE POLICY "Allow all select" ON public.pos_connections FOR SELECT USING (true);
CREATE POLICY "Allow all insert" ON public.pos_connections FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow all update" ON public.pos_connections FOR UPDATE USING (true);
CREATE POLICY "Allow all delete" ON public.pos_connections FOR DELETE USING (true);
