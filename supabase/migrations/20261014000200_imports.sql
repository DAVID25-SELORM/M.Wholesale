-- Phase 5 / 03: bulk import of products and suppliers (Excel / CSV files are read in the browser; these functions do the writing)
--
-- Both functions take up to 500 rows at a time and return one result per row. Every row is processed in its own sub-transaction, so a bad row
-- never spoils the good ones, and a DRY RUN (p_dry_run = true, the default) runs the real code on each row and then undoes it, so what
-- "Check file" reports is exactly what "Import" will do.
--   * Create-only: a row whose SKU / supplier code already exists is reported as EXISTS and left unchanged.
--   * Everything is created through the normal tables, so every constraint, trigger and audit entry applies as usual.
--   * Needs products.create (products) or suppliers.create (suppliers) for the WHOLE organization: catalogue data is shared master data.

create function private.parse_bool(p_text text, p_default boolean)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v text := lower(btrim(coalesce(p_text, '')));
begin
  if v = '' then return p_default; end if;
  if v in ('y', 'yes', 'true', '1') then return true; end if;
  if v in ('n', 'no', 'false', '0') then return false; end if;
  raise exception '"%" is not yes or no', p_text using errcode = '22023';
end;
$$;

-- Turns a database error into something a person filling in a spreadsheet can act on.
create function private.friendly_error(p_state text, p_constraint text, p_message text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_constraint = 'product_barcodes_org_barcode_key' then 'that barcode is already used by another product'
    when p_constraint = 'suppliers_org_name_key' then 'a supplier with that name already exists'
    when p_constraint = 'suppliers_org_code_key' then 'that supplier code is already used'
    when p_constraint = 'products_org_sku_key' then 'that SKU already exists'
    when p_constraint = 'products_identity_required' then 'a medicine needs a generic name, dosage form and strength'
    when p_constraint = 'products_org_brand_idx' then 'a product with that name already exists'
    when p_state in ('22007', '22008') then 'a date is not valid (use YYYY-MM-DD)'
    when p_state = '22P02' then 'a number or value is not valid'
    when p_state = '22003' then 'a number is out of range'
    when p_state = '23502' then 'a required value is missing'
    else p_message
  end
$$;

-- ---------------------------------------------------------------------------------------------------------
-- products
-- ---------------------------------------------------------------------------------------------------------
-- row keys (all text): sku*, brand_name*, base_unit*, product_class, generic_name, dosage_form, strength, manufacturer, category,
--   pack_unit, pack_size, pack2_unit, pack2_size, barcode, storage, requires_prescription, track_batches, fda_registration_number, aliases ("a; b; c")
create function public.import_products(p_rows jsonb, p_dry_run boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org     uuid := private.current_organization_id();
  v_out     jsonb := '[]'::jsonb;
  v_row     jsonb;
  v_n       integer := 0;
  v_seen    text[] := '{}';
  v_sku     text;
  v_status  text;
  v_msg     text;
  v_class   text;
  v_generic text;
  v_form    text;
  v_strength text;
  v_form_id uuid;
  v_form_code text;
  v_ident   uuid;
  v_mfr_name text;
  v_mfr     uuid;
  v_cat_name text;
  v_cat     uuid;
  v_rx      boolean;
  v_base    uuid;
  v_pid     uuid;
  v_pack    uuid;
  v_unit    uuid;
  v_size    numeric;
  v_barcode text;
  v_target  uuid;
  v_alias   text;
  v_code    text;
  v_i       integer;
  v_constraint text;
  v_created integer := 0;
  v_exists  integer := 0;
  v_errors  integer := 0;
begin
  if v_org is null or not private.has_permission('products.create') then
    raise exception 'insufficient privilege to import products' using errcode = '42501';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'no rows to import' using errcode = '22023';
  end if;
  if jsonb_array_length(p_rows) > 500 then
    raise exception 'import at most 500 rows at a time' using errcode = '22023';
  end if;

  for v_row in select value from jsonb_array_elements(p_rows) loop
    v_n := v_n + 1;
    v_status := null; v_msg := null;
    v_sku := upper(btrim(coalesce(v_row ->> 'sku', '')));
    begin
      if jsonb_typeof(v_row) <> 'object' then
        raise exception 'this row is not valid';
      end if;
      if v_sku !~ '^[A-Z0-9][A-Z0-9._-]{0,63}$' then
        raise exception 'the SKU is missing or not valid (letters, numbers and . _ - only, up to 64 characters)';
      end if;
      if v_sku = any (v_seen) then
        raise exception 'the same SKU appears more than once in this file';
      end if;
      v_seen := v_seen || v_sku;

      if exists (select 1 from public.products p where p.organization_id = v_org and p.sku = v_sku) then
        v_status := 'EXISTS';
        v_msg := 'already in the catalogue - left unchanged';
      else
        if btrim(coalesce(v_row ->> 'brand_name', '')) = '' then
          raise exception 'the product name is missing';
        end if;
        v_class := upper(btrim(coalesce(nullif(v_row ->> 'product_class', ''), 'POM')));
        if v_class not in ('POM', 'P', 'GSL', 'CONTROLLED', 'MEDICAL_DEVICE', 'CONSUMABLE', 'SUPPLEMENT', 'COSMETIC', 'OTHER') then
          raise exception 'unknown class "%" (use POM, P, GSL, CONTROLLED, MEDICAL_DEVICE, CONSUMABLE, SUPPLEMENT, COSMETIC or OTHER)', v_class;
        end if;

        -- base unit
        select u.id into v_base from public.units_of_measure u
         where u.is_active and (u.code = upper(btrim(coalesce(v_row ->> 'base_unit', ''))) or lower(u.name) = lower(btrim(coalesce(v_row ->> 'base_unit', ''))));
        if v_base is null then
          raise exception 'the base unit "%" is not recognised (for example TABLET, CAPSULE, BOTTLE, PIECE)', coalesce(v_row ->> 'base_unit', '');
        end if;

        -- identity (generic + form + strength)
        v_generic := btrim(coalesce(v_row ->> 'generic_name', ''));
        v_form := btrim(coalesce(v_row ->> 'dosage_form', ''));
        v_strength := btrim(coalesce(v_row ->> 'strength', ''));
        v_ident := null;
        if v_class in ('POM', 'P', 'GSL', 'CONTROLLED') and (v_generic = '' or v_form = '' or v_strength = '') then
          raise exception 'a medicine needs a generic name, a dosage form and a strength';
        end if;
        if (v_generic <> '' or v_form <> '' or v_strength <> '') then
          if v_generic = '' or v_form = '' or v_strength = '' then
            raise exception 'give the generic name, dosage form and strength together (or none of them)';
          end if;
          select d.id, d.code into v_form_id, v_form_code from public.dosage_forms d
           where d.is_active and (d.code = upper(v_form) or lower(d.name) = lower(v_form));
          if v_form_id is null then
            raise exception 'the dosage form "%" is not recognised (for example TABLET, CAPSULE, SYRUP, INJECTION)', v_form;
          end if;
          select i.id into v_ident from public.product_identities i
           where i.organization_id = v_org
             and i.identity_key = private.normalize_text(v_generic) || '|' || v_form_code || '|' || private.normalize_text(v_strength);
          if v_ident is null then
            insert into public.product_identities (organization_id, generic_name, dosage_form_id, strength_text)
            values (v_org, v_generic, v_form_id, v_strength) returning id into v_ident;
          end if;
        end if;

        -- manufacturer and category are found by name, or created
        v_mfr := null;
        v_mfr_name := btrim(coalesce(v_row ->> 'manufacturer', ''));
        if v_mfr_name <> '' then
          select m.id into v_mfr from public.manufacturers m where m.organization_id = v_org and lower(m.name) = lower(v_mfr_name);
          if v_mfr is null then
            insert into public.manufacturers (organization_id, name) values (v_org, v_mfr_name) returning id into v_mfr;
          end if;
        end if;
        v_cat := null;
        v_cat_name := btrim(coalesce(v_row ->> 'category', ''));
        if v_cat_name <> '' then
          select c.id into v_cat from public.product_categories c
           where c.organization_id = v_org and (lower(c.name) = lower(v_cat_name) or c.code = upper(v_cat_name));
          if v_cat is null then
            v_code := left(trim(both '-' from regexp_replace(upper(v_cat_name), '[^A-Z0-9]+', '-', 'g')), 28);
            if v_code = '' then
              raise exception 'the category name is not valid';
            end if;
            v_i := 1;
            while exists (select 1 from public.product_categories c where c.organization_id = v_org and c.code = v_code) loop
              v_i := v_i + 1;
              v_code := left(trim(both '-' from regexp_replace(upper(v_cat_name), '[^A-Z0-9]+', '-', 'g')), 26) || '-' || v_i;
            end loop;
            insert into public.product_categories (organization_id, code, name) values (v_org, v_code, v_cat_name) returning id into v_cat;
          end if;
        end if;

        if upper(btrim(coalesce(nullif(v_row ->> 'storage', ''), 'AMBIENT'))) not in ('AMBIENT', 'COOL', 'REFRIGERATED', 'FROZEN') then
          raise exception 'storage must be AMBIENT, COOL, REFRIGERATED or FROZEN';
        end if;

        v_rx := private.parse_bool(v_row ->> 'requires_prescription', false);   -- always validated, whatever the class
        v_rx := v_rx or v_class in ('POM', 'CONTROLLED');
        insert into public.products (
          organization_id, sku, identity_id, brand_name, manufacturer_id, category_id, product_class, storage_condition,
          requires_prescription, is_controlled, fda_registration_number, base_unit_id, track_batches)
        values (
          v_org, v_sku, v_ident, btrim(v_row ->> 'brand_name'), v_mfr, v_cat, v_class,
          upper(btrim(coalesce(nullif(v_row ->> 'storage', ''), 'AMBIENT'))),
          v_rx,
          v_class = 'CONTROLLED', nullif(btrim(coalesce(v_row ->> 'fda_registration_number', '')), ''), v_base,
          private.parse_bool(v_row ->> 'track_batches', true))
        returning id into v_pid;

        -- pack levels (the base unit row was created with the product)
        v_target := (select u.id from public.product_units u where u.product_id = v_pid and u.is_base);
        for v_i in 1..2 loop
          v_unit := null;
          if btrim(coalesce(v_row ->> case v_i when 1 then 'pack_unit' else 'pack2_unit' end, '')) <> '' then
            select u.id into v_unit from public.units_of_measure u
             where u.is_active
               and (u.code = upper(btrim(v_row ->> case v_i when 1 then 'pack_unit' else 'pack2_unit' end))
                    or lower(u.name) = lower(btrim(v_row ->> case v_i when 1 then 'pack_unit' else 'pack2_unit' end)));
            if v_unit is null then
              raise exception 'the pack unit "%" is not recognised (for example BOX, CARTON, STRIP)', v_row ->> case v_i when 1 then 'pack_unit' else 'pack2_unit' end;
            end if;
            if v_unit = v_base then
              raise exception 'the pack unit must differ from the base unit';
            end if;
            begin
              v_size := (v_row ->> case v_i when 1 then 'pack_size' else 'pack2_size' end)::numeric;
            exception when others then
              raise exception 'the pack size must be a number';
            end;
            if v_size is null or v_size <= 1 then
              raise exception 'the pack size must be a number greater than 1 (how many base units it holds)';
            end if;
            insert into public.product_units (organization_id, product_id, unit_id, factor_to_base)
            values (v_org, v_pid, v_unit, v_size) returning id into v_pack;
            if v_i = 1 then
              v_target := v_pack;
            end if;
          end if;
        end loop;

        -- barcode: on the first pack level, or the base unit when there is none
        v_barcode := btrim(coalesce(v_row ->> 'barcode', ''));
        if v_barcode <> '' then
          insert into public.product_barcodes (organization_id, product_id, product_unit_id, barcode, barcode_type)
          values (v_org, v_pid, v_target, v_barcode, case when v_barcode ~ '^([0-9]{8}|[0-9]{12,14})$' then 'GTIN' else 'INTERNAL' end);
        end if;

        -- aliases: "name one; name two"
        for v_alias in select btrim(a) from unnest(string_to_array(coalesce(v_row ->> 'aliases', ''), ';')) as a loop
          if v_alias <> '' then
            insert into public.product_aliases (organization_id, alias, product_id, source)
            values (v_org, v_alias, v_pid, 'IMPORT') on conflict do nothing;
          end if;
        end loop;

        v_status := case when p_dry_run then 'VALID' else 'CREATED' end;
        if p_dry_run then
          raise exception using errcode = 'DRYRN', message = 'dry run';
        end if;
      end if;
    exception
      when sqlstate 'DRYRN' then
        null;                                   -- the row was fine; its changes are undone by this block
      when others then
        get stacked diagnostics v_constraint = constraint_name;
        v_status := 'ERROR';
        v_msg := private.friendly_error(sqlstate, v_constraint, sqlerrm);
    end;
    if v_status = 'CREATED' then v_created := v_created + 1;
    elsif v_status = 'EXISTS' then v_exists := v_exists + 1;
    elsif v_status = 'ERROR' then v_errors := v_errors + 1;
    end if;
    v_out := v_out || jsonb_build_array(jsonb_build_object('row', v_n, 'key', v_sku, 'status', v_status, 'message', v_msg));
  end loop;

  if not p_dry_run then
    perform private.write_audit(v_org, 'product.imported', 'product_import', null, null, null,
      jsonb_build_object('rows', v_n, 'created', v_created, 'existing', v_exists, 'errors', v_errors), null, null);
  end if;
  return v_out;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- suppliers
-- ---------------------------------------------------------------------------------------------------------
-- row keys (all text): code*, name*, supplier_type, registration_number, tax_number, licence_number, licence_expiry (YYYY-MM-DD),
--   payment_terms_days, currency_code, contact_name, phone, email, address, city, region, country (2 letters), notes
create function public.import_suppliers(p_rows jsonb, p_dry_run boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org    uuid := private.current_organization_id();
  v_out    jsonb := '[]'::jsonb;
  v_row    jsonb;
  v_n      integer := 0;
  v_seen   text[] := '{}';
  v_code   text;
  v_status text;
  v_msg    text;
  v_type   text;
  v_constraint text;
  v_created integer := 0;
  v_exists  integer := 0;
  v_errors  integer := 0;
begin
  if v_org is null or not private.has_permission('suppliers.create') then
    raise exception 'insufficient privilege to import suppliers' using errcode = '42501';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'no rows to import' using errcode = '22023';
  end if;
  if jsonb_array_length(p_rows) > 500 then
    raise exception 'import at most 500 rows at a time' using errcode = '22023';
  end if;

  for v_row in select value from jsonb_array_elements(p_rows) loop
    v_n := v_n + 1;
    v_status := null; v_msg := null;
    v_code := upper(btrim(coalesce(v_row ->> 'code', '')));
    begin
      if jsonb_typeof(v_row) <> 'object' then
        raise exception 'this row is not valid';
      end if;
      if v_code !~ '^[A-Z0-9][A-Z0-9_-]{0,31}$' then
        raise exception 'the supplier code is missing or not valid (letters, numbers, - and _ only, up to 32)';
      end if;
      if v_code = any (v_seen) then
        raise exception 'the same supplier code appears more than once in this file';
      end if;
      v_seen := v_seen || v_code;

      if exists (select 1 from public.suppliers s where s.organization_id = v_org and s.code = v_code) then
        v_status := 'EXISTS';
        v_msg := 'already on file - left unchanged';
      else
        if btrim(coalesce(v_row ->> 'name', '')) = '' then
          raise exception 'the supplier name is missing';
        end if;
        v_type := upper(btrim(coalesce(nullif(v_row ->> 'supplier_type', ''), 'DISTRIBUTOR')));
        if v_type not in ('MANUFACTURER', 'IMPORTER', 'DISTRIBUTOR', 'WHOLESALER', 'OTHER') then
          raise exception 'unknown supplier type "%" (use MANUFACTURER, IMPORTER, DISTRIBUTOR, WHOLESALER or OTHER)', v_type;
        end if;
        insert into public.suppliers (
          organization_id, code, name, supplier_type, registration_number, tax_number, licence_number, licence_expiry,
          payment_terms_days, currency_code, contact_name, phone, email, address, city, region, country, notes)
        values (
          v_org, v_code, btrim(v_row ->> 'name'), v_type,
          nullif(btrim(coalesce(v_row ->> 'registration_number', '')), ''), nullif(btrim(coalesce(v_row ->> 'tax_number', '')), ''),
          nullif(btrim(coalesce(v_row ->> 'licence_number', '')), ''), nullif(btrim(coalesce(v_row ->> 'licence_expiry', '')), '')::date,
          coalesce(nullif(btrim(coalesce(v_row ->> 'payment_terms_days', '')), '')::integer, 30),
          nullif(upper(btrim(coalesce(v_row ->> 'currency_code', ''))), ''), nullif(btrim(coalesce(v_row ->> 'contact_name', '')), ''),
          nullif(btrim(coalesce(v_row ->> 'phone', '')), ''), nullif(btrim(coalesce(v_row ->> 'email', '')), ''),
          nullif(btrim(coalesce(v_row ->> 'address', '')), ''), nullif(btrim(coalesce(v_row ->> 'city', '')), ''),
          nullif(btrim(coalesce(v_row ->> 'region', '')), ''), nullif(upper(btrim(coalesce(v_row ->> 'country', ''))), ''),
          nullif(btrim(coalesce(v_row ->> 'notes', '')), ''));
        v_status := case when p_dry_run then 'VALID' else 'CREATED' end;
        if p_dry_run then
          raise exception using errcode = 'DRYRN', message = 'dry run';
        end if;
      end if;
    exception
      when sqlstate 'DRYRN' then
        null;
      when others then
        get stacked diagnostics v_constraint = constraint_name;
        v_status := 'ERROR';
        v_msg := private.friendly_error(sqlstate, v_constraint, sqlerrm);
    end;
    if v_status = 'CREATED' then v_created := v_created + 1;
    elsif v_status = 'EXISTS' then v_exists := v_exists + 1;
    elsif v_status = 'ERROR' then v_errors := v_errors + 1;
    end if;
    v_out := v_out || jsonb_build_array(jsonb_build_object('row', v_n, 'key', v_code, 'status', v_status, 'message', v_msg));
  end loop;

  if not p_dry_run then
    perform private.write_audit(v_org, 'supplier.imported', 'supplier_import', null, null, null,
      jsonb_build_object('rows', v_n, 'created', v_created, 'existing', v_exists, 'errors', v_errors), null, null);
  end if;
  return v_out;
end;
$$;

revoke all on function private.parse_bool(text, boolean) from public, anon, authenticated;
revoke all on function private.friendly_error(text, text, text) from public, anon, authenticated;
revoke all on function public.import_products(jsonb, boolean) from public, anon;
revoke all on function public.import_suppliers(jsonb, boolean) from public, anon;
grant execute on function public.import_products(jsonb, boolean) to authenticated;
grant execute on function public.import_suppliers(jsonb, boolean) to authenticated;
