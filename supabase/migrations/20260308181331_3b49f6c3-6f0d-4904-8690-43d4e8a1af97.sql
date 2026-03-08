INSERT INTO storage.buckets (id, name, public) VALUES ('hiopos-imports', 'hiopos-imports', false) ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Allow all select on hiopos-imports" ON storage.objects FOR SELECT USING (bucket_id = 'hiopos-imports');
CREATE POLICY "Allow all insert on hiopos-imports" ON storage.objects FOR INSERT WITH CHECK (bucket_id = 'hiopos-imports');
CREATE POLICY "Allow all delete on hiopos-imports" ON storage.objects FOR DELETE USING (bucket_id = 'hiopos-imports');