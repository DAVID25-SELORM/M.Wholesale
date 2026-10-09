# Phase 1 — Product master, pharmaceutical identity, units and suppliers

Migrations: `20261010000100_catalog_permissions`, `…0200_suppliers`, `…0300_catalog`.
Everything follows the Phase 0 rules: tenant-scoped (`organization_id` never client-writable, composite FKs), RLS on
every table, explicit column grants, no deletes (`is_active`), audit triggers, and no stock quantities anywhere.

## The identity model

```
product_identities   WHAT it is      Amoxicillin + Clavulanic acid | TABLET | 500 mg + 125 mg      (one per organization)
        ▲
products             WHICH SKU       AUG-625-14  "Augmentin 625"  GSK  POM          (brand / pack / manufacturer)
   │  │  │
   │  │  └── product_aliases        "AUGMENTIN 625MG 14'S", "Co-amoxiclav 625"     (messy names → this SKU or identity)
   │  └───── product_barcodes       6001087000017 (GTIN, scans the BOX)
   └──────── product_units          Tablet (base, ×1) · Box (×14) · Carton (×140)
suppliers ── supplier_products ──►  which pack a supplier sells, their code/name, last cost, lead time, preferred
```

* **Identity** = normalised generic name + dosage form + normalised strength (`identity_key`, unique per organization).
  "500 mg", "500MG" and "500-mg" are the same; "Cefixime 200 mg" and "CEFIXIME 200MG" collide (they are one identity).
  An identity already used by products cannot change meaning (create a new one); display-only edits are allowed and
  refresh dependent search keys.
* **Product (SKU)** = a brand or pack variant. Different pack sizes ("14's" vs "10's") and different brands of the same
  medicine are sibling SKUs sharing one identity. Medicines (POM, P, GSL, CONTROLLED) *must* have an identity; devices,
  consumables, cosmetics and supplements need not. `CONTROLLED` ⇔ `is_controlled`; POM/CONTROLLED ⇒ prescription.
  **SKU and base unit are immutable** (documents and stock will reference them).
* **Units**: every quantity will be stored in the product's *base unit*; `product_units` records how many base units a
  pack level holds. The base row is created automatically with the product (factor 1), cannot be deactivated, and
  conversions never change afterwards (history-bearing). Units and dosage forms are global read-only reference data.
* **Barcodes** attach to a pack level; GTIN-8/12/13/14 check digits are verified in the database; unique per organization;
  immutable apart from `is_active`.
* **Aliases** are normalised (`private.normalize_text`: lower-case, digits split from letters, punctuation collapsed) and
  unique per organization, so the same alias can never point at two things. An alias targets exactly one SKU or one identity.

## Search

`public.search_products(query, limit, offset)` is the single entry point (UI list, pickers, future imports/POS). It is
`SECURITY INVOKER` — the caller's RLS applies — and matches when **every word** is found in the product's name / SKU /
generic name / strength **or** in one of its aliases; an exact barcode always matches. Results report why they matched
(`barcode`, `sku`, `name`, `match`) and rank barcode > SKU > name prefix > rest. Trigram GIN indexes keep it fast at tens of
thousands of products.

## Permissions

| Permission | Granted to (highlights) |
|---|---|
| `products.view` / `suppliers.view` | almost every operational role; AUDITOR; READ_ONLY |
| `products.create` | OWNER, SUPER_ADMIN, GENERAL_MANAGER, PROCUREMENT_MANAGER, PROCUREMENT_OFFICER |
| `products.edit` | the above except PROCUREMENT_OFFICER; plus PHARMACIST (regulatory data) |
| `suppliers.create` / `suppliers.edit` | OWNER, SUPER_ADMIN, GENERAL_MANAGER, PROCUREMENT_MANAGER, PROCUREMENT_OFFICER |

Catalogue and supplier data are **organization-level master data**: reading needs the permission in *any* scope (branch staff
must see products to work); writing needs it **organization-wide**. The supplier price list carries costs, so it needs
`suppliers.view` (a cashier sees products but not suppliers or costs). Creating a product/identity/manufacturer/category
= `products.create`; adding units, barcodes and aliases = `products.edit`.

## Audit
Every table audits create/update/activate/deactivate with the actor and only the changed columns (including supplier cost
changes: previous → new). The audit page filters by the new entity types.

## UI
* **Products** (`/catalog/products`): search (name, generic, strength, SKU, barcode, alias), class and status filters,
  create; **detail page** with Packaging & units, Barcodes, Aliases and Suppliers tabs.
* **Catalogue setup** (`/catalog/setup`): pharmaceutical identities, manufacturers, categories.
* **Suppliers** (`/purchasing/suppliers`): list/search/sort, licence-expiry badges (expired / expires within 60 days),
  create/edit/deactivate, and a **price list** per supplier (product picker, pack level, cost, their code/name, lead time,
  preferred flag, "update cost").

## Deliberately not here yet
Stock, batches and expiry per batch, purchase orders, VAT/tax categories on products, price lists for selling, structured
multi-ingredient strengths, bulk import (Excel), product images/leaflets, supplier contacts beyond the primary contact,
barcode scanning hardware integration. The model leaves room for each (see `docs/02-database-design.md`).
