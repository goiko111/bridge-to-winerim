
create or replace function public.review_mapped_products(
  p_connection_id uuid,
  p_search text default null,
  p_format text default null,
  p_state text default null,
  p_days integer default 30,
  p_limit integer default 25,
  p_offset integer default 0
)
returns table(
  provider_product_id text,
  provider_product_name text,
  format_key text,
  family text,
  agora_price numeric,
  winerim_wine_id text,
  winerim_wine_name text,
  winerim_price numeric,
  winerim_active boolean,
  match_method text,
  mapped_at timestamp with time zone,
  last_synced_at timestamp with time zone,
  units_recent numeric,
  mapped_state text,
  comparison text,
  total_count bigint
)
language sql
stable
security definer
set search_path = public
as $$
with guard as (select public.can_access_connection(p_connection_id) as ok),
base as (
  select m.provider_product_id,
         coalesce(m.provider_product_name, pp.name) as provider_product_name,
         coalesce(nullif(m.format_type, ''), 'UNKNOWN') as format_key,
         pp.family,
         pp.price as agora_price,
         m.winerim_wine_id,
         coalesce(w.name, m.winerim_wine_name) as winerim_wine_name,
         v.sale_price as winerim_price,
         w.is_active as winerim_active,
         (w.winerim_id is not null) as wine_found,
         m.match_method,
         m.updated_at as mapped_at,
         m.last_synced_at
  from product_mappings m
  left join provider_products pp
    on pp.connection_id = m.connection_id and pp.provider_product_id = m.provider_product_id
  left join winerim_wines w
    on w.connection_id = m.connection_id and w.winerim_id = m.winerim_wine_id
  left join review_winerim_variants v
    on v.connection_id = m.connection_id
   and v.winerim_id = m.winerim_wine_id
   and v.format_key = coalesce(nullif(m.format_type, ''), 'UNKNOWN')
  where m.connection_id = p_connection_id
    and m.status = 'CONFIRMED'
    and m.winerim_wine_id is not null
    and (select ok from guard)
),
sales as (
  select li.provider_product_id, sum(li.quantity) as units
  from sales_line_items li
  where li.connection_id = p_connection_id
    and li.created_at >= now() - make_interval(days => greatest(coalesce(p_days, 30), 1))
    and li.provider_product_id is not null
  group by li.provider_product_id
),
classified as (
  select b.*,
         coalesce(s.units, 0) as units_recent,
         case
           when not b.wine_found then 'WINE_MISSING'
           when b.winerim_active is false then 'WINE_INACTIVE'
           when b.winerim_price is null or b.agora_price is null then 'NO_PRICE_REF'
           when abs(b.winerim_price - b.agora_price) > 0.005 then 'PRICE_MISMATCH'
           else 'OK'
         end as mapped_state
  from base b
  left join sales s on s.provider_product_id = b.provider_product_id
),
filtered as (
  select c.*
  from classified c
  where (p_format is null or c.format_key = p_format)
    and (p_state is null or c.mapped_state = p_state)
    and (
      p_search is null or p_search = ''
      or c.provider_product_id ilike '%' || p_search || '%'
      or coalesce(c.provider_product_name, '') ilike '%' || p_search || '%'
      or coalesce(c.winerim_wine_id, '') ilike '%' || p_search || '%'
      or coalesce(c.winerim_wine_name, '') ilike '%' || p_search || '%'
    )
)
select f.provider_product_id,
       f.provider_product_name,
       f.format_key,
       f.family,
       f.agora_price,
       f.winerim_wine_id,
       f.winerim_wine_name,
       f.winerim_price,
       f.winerim_active,
       f.match_method,
       f.mapped_at,
       f.last_synced_at,
       f.units_recent,
       f.mapped_state,
       case f.mapped_state
         when 'OK' then 'Precio igual en ambos lados'
         when 'PRICE_MISMATCH' then 'Winerim ' || to_char(f.winerim_price, 'FM999999990.00') || ' € vs Ágora ' || to_char(f.agora_price, 'FM999999990.00') || ' €'
         when 'NO_PRICE_REF' then 'Falta precio en uno de los dos lados'
         when 'WINE_INACTIVE' then 'El vino está inactivo en Winerim'
         else 'El vino ya no aparece en el catálogo de Winerim'
       end as comparison,
       count(*) over () as total_count
from filtered f
order by f.units_recent desc, f.provider_product_name nulls last
limit greatest(coalesce(p_limit, 25), 1)
offset greatest(coalesce(p_offset, 0), 0)
$$;

create or replace function public.review_mapped_summary(
  p_connection_id uuid,
  p_days integer default 30
)
returns table(
  mapped_total bigint,
  state_ok bigint,
  price_mismatch bigint,
  no_price_ref bigint,
  wine_inactive bigint,
  wine_missing bigint,
  bottle_count bigint,
  glass_count bigint,
  other_format_count bigint,
  units_recent numeric
)
language sql
stable
security definer
set search_path = public
as $$
with rows as (
  select * from public.review_mapped_products(p_connection_id, null, null, null, p_days, 1000000, 0)
)
select count(*),
       count(*) filter (where mapped_state = 'OK'),
       count(*) filter (where mapped_state = 'PRICE_MISMATCH'),
       count(*) filter (where mapped_state = 'NO_PRICE_REF'),
       count(*) filter (where mapped_state = 'WINE_INACTIVE'),
       count(*) filter (where mapped_state = 'WINE_MISSING'),
       count(*) filter (where format_key = 'BOTTLE'),
       count(*) filter (where format_key = 'GLASS'),
       count(*) filter (where format_key not in ('BOTTLE', 'GLASS')),
       coalesce(sum(units_recent), 0)
from rows
$$;

grant execute on function public.review_mapped_products(uuid, text, text, text, integer, integer, integer) to authenticated;
grant execute on function public.review_mapped_summary(uuid, integer) to authenticated;
