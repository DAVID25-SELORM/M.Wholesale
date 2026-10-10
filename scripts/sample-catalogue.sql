-- Sample catalogue for TESTING (idempotent: safe to run more than once).
--
-- Adds, to ONE organization (set the name below): manufacturers, categories, pharmaceutical identities,
-- products with pack levels (box/carton conversions), barcodes, aliases, suppliers and supplier price lists.
-- Run it in the Supabase SQL editor (or any superuser connection); it bypasses RLS on purpose because it
-- seeds data, so audit entries are attributed to "system".
--
-- * Barcodes use GS1 prefix "2" (reserved for in-store / restricted circulation) with valid check digits,
--   so they can never clash with a real manufacturer GTIN.
-- * Supplier names end with "(sample)"; deactivate them from Purchasing -> Suppliers when you are done.
-- * Costs are illustrative, not real prices.

do $sample$
declare
  v_org_name constant text := 'Neon Pharma Ltd';   -- <== change to the organization that should receive the data
  v_org uuid;
  r record;
  v_pid uuid;
  v_uid uuid;
  v_sid uuid;
  v_identity uuid;
  v_n int;
begin
  select id into v_org from public.organizations where name = v_org_name;
  if v_org is null then
    raise exception 'organization "%" not found - edit v_org_name at the top of this script', v_org_name;
  end if;

  -- EAN-13 helper: 12 digits in, 13 digits out (check digit appended)
  create or replace function pg_temp.gtin13(p12 text) returns text language sql as $f$
    select p12 || ((10 - coalesce(sum(substr(p12, i, 1)::int * case when i % 2 = 1 then 1 else 3 end), 0) % 10) % 10)::text
    from generate_series(1, 12) i
  $f$;

  -- ---- manufacturers -------------------------------------------------------------------------------
  insert into public.manufacturers (organization_id, name, country)
  select v_org, m ->> 0, m ->> 1
  from jsonb_array_elements('[
    ["GlaxoSmithKline","GB"],["Pfizer","US"],["Novartis","CH"],["Sanofi","FR"],
    ["Ernest Chemists","GH"],["Danadams Pharmaceutical Industry","GH"],["Kinapharma","GH"],
    ["Letap Pharmaceuticals","GH"],["M&G Pharmaceuticals","GH"],["Hartmann","DE"]]'::jsonb) m
  on conflict do nothing;

  -- ---- categories ----------------------------------------------------------------------------------
  insert into public.product_categories (organization_id, code, name)
  select v_org, c ->> 0, c ->> 1
  from jsonb_array_elements('[
    ["ANTIBIOTICS","Antibiotics"],["ANALGESICS","Analgesics & anti-inflammatories"],["ANTIMALARIALS","Antimalarials"],
    ["CARDIOVASCULAR","Cardiovascular"],["ANTIDIABETICS","Antidiabetics"],["VITAMINS","Vitamins & supplements"],
    ["GASTRO","Gastrointestinal"],["RESPIRATORY","Respiratory"],["DEVICES","Devices & consumables"]]'::jsonb) c
  on conflict do nothing;

  -- ---- canonical identities (generic + form + strength) ------------------------------------------------
  insert into public.product_identities (organization_id, generic_name, dosage_form_id, strength_text)
  select v_org, i ->> 0, (select id from public.dosage_forms where code = i ->> 1), i ->> 2
  from jsonb_array_elements('[
    ["Amoxicillin + Clavulanic acid","TABLET","500 mg + 125 mg"],
    ["Amoxicillin","CAPSULE","500 mg"],
    ["Paracetamol","TABLET","500 mg"],
    ["Paracetamol","SYRUP","120 mg / 5 ml"],
    ["Artemether + Lumefantrine","TABLET","20 mg + 120 mg"],
    ["Amlodipine","TABLET","5 mg"],
    ["Metformin","TABLET","500 mg"],
    ["Ibuprofen","TABLET","400 mg"],
    ["Omeprazole","CAPSULE","20 mg"],
    ["Salbutamol","INHALER","100 mcg per dose"],
    ["Ascorbic acid (Vitamin C)","EFFERVESCENT","1000 mg"],
    ["Diclofenac","INJECTION","75 mg / 3 ml"],
    ["Cefuroxime","TABLET","500 mg"]]'::jsonb) i
  on conflict do nothing;

  -- ---- products, pack levels, one barcode each ---------------------------------------------------------
  -- fields: sku, brand, identity [generic, form, strength] or null, manufacturer, category, class, base unit, packs [[unit, factor]...]
  for r in
    select e.value as p, e.ordinality as n
    from jsonb_array_elements('[
      {"sku":"AUG-625-14","brand":"Augmentin 625","id":["Amoxicillin + Clavulanic acid","TABLET","500 mg + 125 mg"],"mfr":"GlaxoSmithKline","cat":"ANTIBIOTICS","cls":"POM","base":"TABLET","packs":[["BOX",14],["CARTON",140]]},
      {"sku":"AMX-500-100","brand":"Amoxicillin 500 mg Capsules","id":["Amoxicillin","CAPSULE","500 mg"],"mfr":"Danadams Pharmaceutical Industry","cat":"ANTIBIOTICS","cls":"POM","base":"CAPSULE","packs":[["STRIP",10],["BOX",100]]},
      {"sku":"ZIN-500-10","brand":"Zinnat 500","id":["Cefuroxime","TABLET","500 mg"],"mfr":"GlaxoSmithKline","cat":"ANTIBIOTICS","cls":"POM","base":"TABLET","packs":[["BOX",10]]},
      {"sku":"PANADOL-500-100","brand":"Panadol 500 mg Tablets (100s)","id":["Paracetamol","TABLET","500 mg"],"mfr":"GlaxoSmithKline","cat":"ANALGESICS","cls":"GSL","base":"TABLET","packs":[["BOX",100]]},
      {"sku":"PANADOL-500-24","brand":"Panadol 500 mg Tablets (24s)","id":["Paracetamol","TABLET","500 mg"],"mfr":"GlaxoSmithKline","cat":"ANALGESICS","cls":"GSL","base":"TABLET","packs":[["BOX",24]]},
      {"sku":"PCM-ERN-500-100","brand":"Ernest Paracetamol 500 mg","id":["Paracetamol","TABLET","500 mg"],"mfr":"Ernest Chemists","cat":"ANALGESICS","cls":"GSL","base":"TABLET","packs":[["BOX",100]]},
      {"sku":"PCM-SYR-120-100ML","brand":"Ernest Paracetamol Syrup 120 mg/5 ml","id":["Paracetamol","SYRUP","120 mg / 5 ml"],"mfr":"Ernest Chemists","cat":"ANALGESICS","cls":"GSL","base":"BOTTLE","packs":[["CARTON",24]]},
      {"sku":"IBU-400-100","brand":"Ibuprofen 400 mg Tablets","id":["Ibuprofen","TABLET","400 mg"],"mfr":"M&G Pharmaceuticals","cat":"ANALGESICS","cls":"P","base":"TABLET","packs":[["BOX",100]]},
      {"sku":"DICLO-75-50","brand":"Diclofenac Injection 75 mg/3 ml","id":["Diclofenac","INJECTION","75 mg / 3 ml"],"mfr":"Kinapharma","cat":"ANALGESICS","cls":"POM","base":"AMPOULE","packs":[["BOX",50]]},
      {"sku":"COARTEM-20-120-24","brand":"Coartem 20/120","id":["Artemether + Lumefantrine","TABLET","20 mg + 120 mg"],"mfr":"Novartis","cat":"ANTIMALARIALS","cls":"POM","base":"TABLET","packs":[["BOX",24]]},
      {"sku":"AL-LETAP-20-120-24","brand":"Letap Artemether/Lumefantrine 20/120","id":["Artemether + Lumefantrine","TABLET","20 mg + 120 mg"],"mfr":"Letap Pharmaceuticals","cat":"ANTIMALARIALS","cls":"POM","base":"TABLET","packs":[["BOX",24]]},
      {"sku":"NORVASC-5-30","brand":"Norvasc 5 mg","id":["Amlodipine","TABLET","5 mg"],"mfr":"Pfizer","cat":"CARDIOVASCULAR","cls":"POM","base":"TABLET","packs":[["BOX",30]]},
      {"sku":"METF-500-100","brand":"Metformin 500 mg Tablets","id":["Metformin","TABLET","500 mg"],"mfr":"Kinapharma","cat":"ANTIDIABETICS","cls":"POM","base":"TABLET","packs":[["BOX",100]]},
      {"sku":"OMEZ-20-30","brand":"Omeprazole 20 mg Capsules","id":["Omeprazole","CAPSULE","20 mg"],"mfr":"Danadams Pharmaceutical Industry","cat":"GASTRO","cls":"POM","base":"CAPSULE","packs":[["BOX",30]]},
      {"sku":"VENTOLIN-EVO-200D","brand":"Ventolin Evohaler 100 mcg","id":["Salbutamol","INHALER","100 mcg per dose"],"mfr":"GlaxoSmithKline","cat":"RESPIRATORY","cls":"POM","base":"INHALER","packs":[["CARTON",12]]},
      {"sku":"VITC-1000-20","brand":"Vitamin C 1000 mg Effervescent","id":["Ascorbic acid (Vitamin C)","EFFERVESCENT","1000 mg"],"mfr":"Letap Pharmaceuticals","cat":"VITAMINS","cls":"SUPPLEMENT","base":"TABLET","packs":[["TUBE",20]]},
      {"sku":"GLOVES-M-100","brand":"Examination Gloves, Medium (box of 100)","id":null,"mfr":"Hartmann","cat":"DEVICES","cls":"CONSUMABLE","base":"PIECE","packs":[["BOX",100],["CARTON",1000]]},
      {"sku":"BPMON-DIGITAL","brand":"Digital Blood Pressure Monitor","id":null,"mfr":"Hartmann","cat":"DEVICES","cls":"MEDICAL_DEVICE","base":"PIECE","packs":[]}
    ]'::jsonb) with ordinality as e(value, ordinality)
  loop
    v_identity := null;
    if r.p -> 'id' <> 'null'::jsonb then
      select pi.id into v_identity
      from public.product_identities pi
      where pi.organization_id = v_org
        and pi.identity_key = private.normalize_text(r.p -> 'id' ->> 0) || '|' || (r.p -> 'id' ->> 1) || '|'
                              || private.normalize_text(r.p -> 'id' ->> 2);
      if v_identity is null then
        raise exception 'identity not found for product %', r.p ->> 'sku';
      end if;
    end if;

    insert into public.products (
      organization_id, sku, identity_id, brand_name, manufacturer_id, category_id, product_class,
      requires_prescription, is_controlled, base_unit_id, storage_condition, track_batches)
    values (
      v_org, r.p ->> 'sku', v_identity, r.p ->> 'brand',
      (select id from public.manufacturers where organization_id = v_org and lower(name) = lower(r.p ->> 'mfr')),
      (select id from public.product_categories where organization_id = v_org and code = r.p ->> 'cat'),
      r.p ->> 'cls', (r.p ->> 'cls') = 'POM', false,
      (select id from public.units_of_measure where code = r.p ->> 'base'),
      case when r.p ->> 'sku' = 'VENTOLIN-EVO-200D' then 'COOL' else 'AMBIENT' end,
      (r.p ->> 'cls') not in ('MEDICAL_DEVICE'))
    on conflict (organization_id, sku) do nothing;

    select id into v_pid from public.products where organization_id = v_org and sku = r.p ->> 'sku';

    -- pack levels (the base unit row is created automatically with the product)
    insert into public.product_units (organization_id, product_id, unit_id, factor_to_base)
    select v_org, v_pid, (select id from public.units_of_measure where code = u ->> 0), (u ->> 1)::numeric
    from jsonb_array_elements(r.p -> 'packs') u
    on conflict do nothing;

    -- one valid GTIN-13 on the first pack level (or on the base unit when there is none)
    select pu.id into v_uid
    from public.product_units pu
    join public.units_of_measure um on um.id = pu.unit_id
    where pu.product_id = v_pid
    order by (um.code = r.p -> 'packs' -> 0 ->> 0) desc, pu.is_base asc
    limit 1;

    insert into public.product_barcodes (organization_id, product_id, product_unit_id, barcode, barcode_type)
    values (v_org, v_pid, v_uid, pg_temp.gtin13('2000010' || lpad(r.n::text, 5, '0')), 'GTIN')
    on conflict do nothing;
  end loop;

  -- ---- aliases: the messy names people and suppliers actually use ------------------------------------------
  insert into public.product_aliases (organization_id, alias, product_id)
  select v_org, a ->> 1, (select id from public.products where organization_id = v_org and sku = a ->> 0)
  from jsonb_array_elements('[
    ["AUG-625-14","AUGMENTIN 625MG 14''S"],["AUG-625-14","Co-amoxiclav 625"],["AUG-625-14","Augmentin 500/125 tabs"],
    ["PANADOL-500-100","PANADOL 500MG TAB 100S"],["PANADOL-500-24","Panadol 500 24s"],
    ["COARTEM-20-120-24","COARTEM 20/120 24 TABS"],["NORVASC-5-30","NORVASC 5MG 30''S"],
    ["METF-500-100","Glucophage 500"],["IBU-400-100","Brufen 400"],["VENTOLIN-EVO-200D","Salbutamol inhaler 100mcg"]
  ]'::jsonb) a
  on conflict do nothing;

  -- an alias on the IDENTITY: every product of this medicine matches it
  insert into public.product_aliases (organization_id, alias, identity_id)
  select v_org, 'AL 20/120 tablets', pi.id
  from public.product_identities pi
  where pi.organization_id = v_org and pi.identity_key = private.normalize_text('Artemether + Lumefantrine') || '|TABLET|' || private.normalize_text('20 mg + 120 mg')
  on conflict do nothing;

  -- ---- suppliers (marked as samples) ------------------------------------------------------------------------
  insert into public.suppliers (organization_id, code, name, supplier_type, licence_number, licence_expiry,
                                payment_terms_days, contact_name, phone, email, city, region, country)
  select v_org, s ->> 0, s ->> 1, s ->> 2, s ->> 3, (s ->> 4)::date, (s ->> 5)::int, s ->> 6, s ->> 7, s ->> 8, s ->> 9, s ->> 10, 'GH'
  from jsonb_array_elements('[
    ["SMP-EMP","Emmanuel Pharma Ltd (sample)","DISTRIBUTOR","FDA/DIST/0412","2027-03-31",30,"Emmanuel Tetteh","0302000101","orders@emp.example","Accra","Greater Accra"],
    ["SMP-KOF","Kofi Medical Imports (sample)","IMPORTER","FDA/IMP/0099","2026-11-15",14,"Kofi Mensah","0302000202","sales@kof.example","Tema","Greater Accra"],
    ["SMP-ADW","Adwoa Wholesale Drugs (sample)","WHOLESALER","FDA/WHS/0777","2026-09-01",45,"Adwoa Boateng","0322000303","info@adw.example","Kumasi","Ashanti"]
  ]'::jsonb) s
  on conflict do nothing;

  -- ---- supplier price lists -------------------------------------------------------------------------------------
  -- fields: supplier code, product SKU, pack unit, cost, lead days, preferred, their code, their name
  for r in
    select e.value as p
    from jsonb_array_elements('[
      ["SMP-EMP","AUG-625-14","BOX",85.50,3,true,"EMP-AUG-14","AUGMENTIN 625 TAB 14S"],
      ["SMP-EMP","PANADOL-500-100","BOX",22.00,2,true,"EMP-PAN-100",null],
      ["SMP-EMP","METF-500-100","BOX",18.50,2,true,"EMP-MET-100","METFORMIN 500MG 100S"],
      ["SMP-EMP","IBU-400-100","BOX",16.00,2,true,null,null],
      ["SMP-KOF","AUG-625-14","BOX",88.00,5,false,"KOF-AMC-625","CO-AMOXICLAV 625 14S"],
      ["SMP-KOF","COARTEM-20-120-24","BOX",64.00,4,true,"KOF-COA-24","COARTEM 20/120 24S"],
      ["SMP-KOF","NORVASC-5-30","BOX",95.00,6,true,"KOF-NOR-30",null],
      ["SMP-KOF","VENTOLIN-EVO-200D","CARTON",1180.00,7,true,null,null],
      ["SMP-ADW","PCM-ERN-500-100","BOX",14.00,1,true,"ADW-PCM-100",null],
      ["SMP-ADW","GLOVES-M-100","BOX",38.00,2,true,"ADW-GLV-M",null],
      ["SMP-ADW","BPMON-DIGITAL","PIECE",145.00,3,true,"ADW-BP-01","DIGITAL BP MONITOR"],
      ["SMP-ADW","PANADOL-500-100","BOX",21.50,2,false,null,null]
    ]'::jsonb) as e(value)
  loop
    select id into v_sid from public.suppliers where organization_id = v_org and code = r.p ->> 0;
    select id into v_pid from public.products where organization_id = v_org and sku = r.p ->> 1;
    select pu.id into v_uid from public.product_units pu
      where pu.product_id = v_pid and pu.unit_id = (select id from public.units_of_measure where code = r.p ->> 2);
    if v_sid is not null and v_pid is not null and v_uid is not null then
      insert into public.supplier_products (organization_id, supplier_id, product_id, product_unit_id, last_cost, lead_time_days,
                                            is_preferred, supplier_sku, supplier_product_name)
      values (v_org, v_sid, v_pid, v_uid, (r.p ->> 3)::numeric, (r.p ->> 4)::int, (r.p ->> 5)::boolean,
              r.p ->> 6, r.p ->> 7)
      on conflict do nothing;
    end if;
  end loop;

  select count(*) into v_n from public.products where organization_id = v_org;
  raise notice 'sample catalogue ready for "%": % products in total', v_org_name, v_n;
end
$sample$;

-- quick summary of what the organization now has
select
  (select count(*) from public.manufacturers       where organization_id = o.id) as manufacturers,
  (select count(*) from public.product_categories  where organization_id = o.id) as categories,
  (select count(*) from public.product_identities  where organization_id = o.id) as identities,
  (select count(*) from public.products            where organization_id = o.id) as products,
  (select count(*) from public.product_units       where organization_id = o.id) as pack_levels,
  (select count(*) from public.product_barcodes    where organization_id = o.id) as barcodes,
  (select count(*) from public.product_aliases     where organization_id = o.id) as aliases,
  (select count(*) from public.suppliers           where organization_id = o.id) as suppliers,
  (select count(*) from public.supplier_products   where organization_id = o.id) as price_list_rows
from public.organizations o
where o.name = 'Neon Pharma Ltd';
