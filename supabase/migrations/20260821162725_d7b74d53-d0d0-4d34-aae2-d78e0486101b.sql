DROP POLICY IF EXISTS "tmp_seed_sandbox_exec" ON public.agora_sales_variant_mappings;
DO $guard$ DECLARE p int; s int; BEGIN
 SELECT count(*) INTO p FROM public.agora_sales_variant_mappings WHERE connection_id='a700d425-9194-4758-95ff-7fee86419e14'::uuid AND status='CONFIRMED';
 SELECT count(*) INTO s FROM public.agora_sales_variant_mappings WHERE connection_id='79280cb8-0fe7-4a57-93a4-04172205ac70'::uuid AND status='CONFIRMED';
 IF p<>119 OR s<>187 THEN RAISE EXCEPTION 'DON_BERNARDO_COMPOUND_MAPPING_COUNT_MISMATCH p=% s=%',p,s; END IF;
END $guard$;