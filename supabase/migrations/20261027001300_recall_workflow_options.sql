create function public.recall_batch_options()
returns table(id uuid,batch_number text,product_name text,sku text,expiry_date date)
language sql stable security definer set search_path='' as $$
 select b.id,b.batch_number,p.brand_name::text,p.sku::text,b.expiry_date
 from public.batches b join public.products p on p.id=b.product_id and p.organization_id=b.organization_id
 where b.organization_id=private.current_organization_id() and private.has_permission('recalls.manage') and b.expiry_date>=current_date
 order by b.expiry_date,b.batch_number
$$;
revoke all on function public.recall_batch_options() from public,anon;
grant execute on function public.recall_batch_options() to authenticated;
