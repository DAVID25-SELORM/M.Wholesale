import { toCsv } from './csv'

export type ImportKind = 'products' | 'suppliers' | 'opening_stock'

export interface ColumnSpec {
  key: string
  label: string
  required?: boolean
  /** other header spellings people use; compared ignoring case, spaces and punctuation */
  aliases?: string[]
  hint: string
  example: string
}

export interface ImportSpec {
  kind: ImportKind
  title: string
  summary: string
  /** the column that identifies a row in messages (SKU, supplier code) */
  keyColumn: string
  columns: ColumnSpec[]
  /** second example row for the template */
  example2: Record<string, string>
}

export const SPECS: Record<ImportKind, ImportSpec> = {
  products: {
    kind: 'products',
    title: 'Products',
    summary: 'Your product list: one row per SKU, with its generic identity, units, pack sizes and barcode. Existing SKUs are left unchanged.',
    keyColumn: 'sku',
    columns: [
      { key: 'sku', label: 'SKU', required: true, aliases: ['productcode', 'itemcode', 'code'], hint: 'Your own unique product code: letters, numbers and . _ -', example: 'AUG-625-14' },
      { key: 'brand_name', label: 'Product name', required: true, aliases: ['name', 'product', 'productname', 'brand', 'brandname', 'description'], hint: 'The name on the pack', example: 'Augmentin 625' },
      { key: 'base_unit', label: 'Base unit', required: true, aliases: ['unit', 'baseunit', 'uom'], hint: 'What you count in: TABLET, CAPSULE, BOTTLE, PIECE …', example: 'TABLET' },
      { key: 'product_class', label: 'Class', aliases: ['class', 'type', 'category_class'], hint: 'POM, P, GSL, CONTROLLED, MEDICAL_DEVICE, CONSUMABLE, SUPPLEMENT, COSMETIC or OTHER (default POM)', example: 'POM' },
      { key: 'generic_name', label: 'Generic name', aliases: ['generic', 'activeingredient', 'inn'], hint: 'Required for medicines', example: 'Amoxicillin + Clavulanic acid' },
      { key: 'dosage_form', label: 'Dosage form', aliases: ['form', 'dosageform'], hint: 'TABLET, CAPSULE, SYRUP, INJECTION … (required for medicines)', example: 'TABLET' },
      { key: 'strength', label: 'Strength', aliases: ['potency'], hint: 'For example 500 mg + 125 mg (required for medicines)', example: '500 mg + 125 mg' },
      { key: 'manufacturer', label: 'Manufacturer', aliases: ['maker', 'mfr', 'manufacturername'], hint: 'Created if new', example: 'GlaxoSmithKline' },
      { key: 'category', label: 'Category', aliases: ['productcategory', 'group'], hint: 'Created if new', example: 'Antibiotics' },
      { key: 'pack_unit', label: 'Pack unit', aliases: ['pack', 'packunit', 'packtype'], hint: 'BOX, CARTON, STRIP …', example: 'BOX' },
      { key: 'pack_size', label: 'Pack size', aliases: ['packsize', 'qtyperpack', 'unitsperpack'], hint: 'How many base units one pack holds', example: '14' },
      { key: 'pack2_unit', label: 'Second pack unit', aliases: ['pack2', 'pack2unit'], hint: 'Optional, for example CARTON', example: 'CARTON' },
      { key: 'pack2_size', label: 'Second pack size', aliases: ['pack2size'], hint: 'Base units in the second pack', example: '140' },
      { key: 'barcode', label: 'Barcode', aliases: ['gtin', 'ean', 'upc'], hint: 'On the first pack level; GTIN check digits are verified', example: '6001087000017' },
      { key: 'storage', label: 'Storage', aliases: ['storagecondition'], hint: 'AMBIENT, COOL, REFRIGERATED or FROZEN (default AMBIENT)', example: 'AMBIENT' },
      { key: 'requires_prescription', label: 'Needs prescription', aliases: ['rx', 'prescription'], hint: 'yes / no (POM is always yes)', example: 'yes' },
      { key: 'track_batches', label: 'Track batches', aliases: ['batchtracked', 'batches'], hint: 'yes / no (default yes)', example: 'yes' },
      { key: 'fda_registration_number', label: 'FDA registration no.', aliases: ['fda', 'fdanumber', 'fdaregistration'], hint: '', example: 'FDA/ABC/1234' },
      { key: 'aliases', label: 'Other names', aliases: ['alias', 'othernames', 'synonyms'], hint: 'Separate several with ;', example: "AUGMENTIN 625MG 14'S; Co-amoxiclav 625" },
    ],
    example2: { sku: 'GLOVES-M-100', brand_name: 'Examination gloves, medium (100)', base_unit: 'PIECE', product_class: 'CONSUMABLE', pack_unit: 'BOX', pack_size: '100', category: 'Devices & consumables', track_batches: 'no' },
  },
  suppliers: {
    kind: 'suppliers',
    title: 'Suppliers',
    summary: 'Your suppliers with their regulatory licence and payment terms. Existing supplier codes are left unchanged.',
    keyColumn: 'code',
    columns: [
      { key: 'code', label: 'Supplier code', required: true, aliases: ['suppliercode', 'id'], hint: 'Your short unique code: letters, numbers, - and _', example: 'EMP' },
      { key: 'name', label: 'Name', required: true, aliases: ['suppliername', 'company'], hint: 'Must be unique', example: 'Emmanuel Pharma Ltd' },
      { key: 'supplier_type', label: 'Type', aliases: ['type'], hint: 'MANUFACTURER, IMPORTER, DISTRIBUTOR, WHOLESALER or OTHER (default DISTRIBUTOR)', example: 'DISTRIBUTOR' },
      { key: 'licence_number', label: 'Licence number', aliases: ['licence', 'license', 'licensenumber', 'fdalicence'], hint: 'FDA / Pharmacy Council licence', example: 'FDA/DIST/0412' },
      { key: 'licence_expiry', label: 'Licence expiry', aliases: ['licenceexpiry', 'licenseexpiry', 'expiry'], hint: 'YYYY-MM-DD. An expired licence blocks new purchase orders', example: '2027-03-31' },
      { key: 'payment_terms_days', label: 'Payment terms (days)', aliases: ['terms', 'paymentterms', 'creditdays'], hint: '0 to 365 (default 30)', example: '30' },
      { key: 'currency_code', label: 'Currency', aliases: ['currency'], hint: 'Three letters, for example GHS; blank = your own currency', example: 'GHS' },
      { key: 'contact_name', label: 'Contact person', aliases: ['contact'], hint: '', example: 'Emmanuel Tetteh' },
      { key: 'phone', label: 'Phone', aliases: ['telephone', 'mobile', 'tel'], hint: '', example: '0302123456' },
      { key: 'email', label: 'Email', aliases: ['emailaddress'], hint: '', example: 'orders@emp.example' },
      { key: 'address', label: 'Address', aliases: [], hint: '', example: '12 Ring Road' },
      { key: 'city', label: 'City', aliases: ['town'], hint: '', example: 'Accra' },
      { key: 'region', label: 'Region', aliases: [], hint: '', example: 'Greater Accra' },
      { key: 'country', label: 'Country', aliases: [], hint: 'Two letters, for example GH', example: 'GH' },
      { key: 'registration_number', label: 'Registration no.', aliases: ['registration', 'regno'], hint: '', example: '' },
      { key: 'tax_number', label: 'Tax no.', aliases: ['tin', 'taxid', 'vatnumber'], hint: '', example: '' },
      { key: 'notes', label: 'Notes', aliases: ['remarks'], hint: '', example: '' },
    ],
    example2: { code: 'KOF', name: 'Kofi Medical Imports', supplier_type: 'IMPORTER', payment_terms_days: '14', city: 'Tema', country: 'GH' },
  },
  opening_stock: {
    kind: 'opening_stock',
    title: 'Opening stock',
    summary: 'What you hold today, by batch and expiry. Products and warehouses must already exist (import products first). Each row adds to stock, so import a file only once.',
    keyColumn: 'sku',
    columns: [
      { key: 'sku', label: 'SKU', required: true, aliases: ['productcode', 'itemcode', 'code'], hint: 'An existing product', example: 'AUG-625-14' },
      { key: 'warehouse', label: 'Warehouse code', required: true, aliases: ['warehousecode', 'store', 'storecode'], hint: 'An existing warehouse code, for example MAIN-HQ', example: 'MAIN-HQ' },
      { key: 'batch_number', label: 'Batch number', aliases: ['batch', 'lot', 'lotnumber'], hint: 'Required for batch-tracked products', example: 'AUG2601' },
      { key: 'expiry_date', label: 'Expiry date', aliases: ['expiry', 'expirydate', 'exp'], hint: 'YYYY-MM-DD or DD/MM/YYYY; required for batch-tracked products', example: '2028-04-30' },
      { key: 'quantity', label: 'Quantity', required: true, aliases: ['qty', 'onhand', 'stock'], hint: 'In the unit below (base unit if blank)', example: '20' },
      { key: 'unit', label: 'Unit', aliases: ['packunit', 'uom'], hint: 'A pack level of the product, for example BOX; blank = the base unit', example: 'BOX' },
      { key: 'unit_cost', label: 'Cost per unit', aliases: ['cost', 'costprice', 'unitcost'], hint: 'What one of the unit above cost (optional)', example: '84.00' },
      { key: 'location', label: 'Location code', aliases: ['locationcode', 'bin', 'shelf'], hint: 'Optional, an existing location in that warehouse', example: 'HQ-A1-1' },
      { key: 'manufacture_date', label: 'Manufacture date', aliases: ['mfg', 'mfgdate', 'manufactured'], hint: 'Optional', example: '2026-04-30' },
      { key: 'status', label: 'Status', aliases: ['stockstatus', 'condition'], hint: 'AVAILABLE (default), QUARANTINE, DAMAGED or EXPIRED', example: 'AVAILABLE' },
    ],
    example2: { sku: 'PANADOL-500-100', warehouse: 'MAIN-HQ', batch_number: 'PN-7731', expiry_date: '2027-12-31', quantity: '5000', unit_cost: '0.21' },
  },
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '')

export interface HeaderMatch {
  /** column index in the file -> spec key */
  mapping: Map<number, string>
  /** headers in the file we did not recognise (ignored) */
  unrecognised: string[]
  /** required columns the file does not have */
  missing: ColumnSpec[]
}

export function matchHeaders(headers: string[], spec: ImportSpec): HeaderMatch {
  const byName = new Map<string, string>()
  for (const c of spec.columns) {
    byName.set(norm(c.key), c.key)
    byName.set(norm(c.label), c.key)
    for (const a of c.aliases ?? []) if (!byName.has(norm(a))) byName.set(norm(a), c.key)
  }
  const mapping = new Map<number, string>()
  const taken = new Set<string>()
  const unrecognised: string[] = []
  headers.forEach((h, i) => {
    if (h.trim() === '') return
    const key = byName.get(norm(h))
    if (key && !taken.has(key)) { mapping.set(i, key); taken.add(key) } else unrecognised.push(h.trim())
  })
  return { mapping, unrecognised, missing: spec.columns.filter((c) => c.required && !taken.has(c.key)) }
}

export interface ImportRow {
  /** the row number as the person sees it in their spreadsheet (header = row 1) */
  line: number
  values: Record<string, string>
}

export function toImportRows(table: string[][], mapping: Map<number, string>): ImportRow[] {
  return table.slice(1).map((cells, i) => {
    const values: Record<string, string> = {}
    for (const [idx, key] of mapping) values[key] = (cells[idx] ?? '').trim()
    return { line: i + 2, values }
  }).filter((r) => Object.values(r.values).some((v) => v !== ''))
}

export function templateCsv(spec: ImportSpec): string {
  const keys = spec.columns.map((c) => c.key)
  const first = spec.columns.map((c) => c.example)
  const second = spec.columns.map((c) => spec.example2[c.key] ?? '')
  return toCsv([keys, first, second])
}
