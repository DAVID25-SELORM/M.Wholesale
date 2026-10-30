
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  
  "public": {
          Tables: {
            expenses: { Row: { id: string; organization_id: string; branch_id: string; expense_date: string; payee: string; description: string; reference: string; expense_account_id: string; credit_account_id: string; amount: number; status: string; journal_id: string | null; requested_by: string; decided_by: string | null; decision_note: string | null; created_at: string }; Insert: never; Update: never; Relationships: [] }
            price_agreements: { Row: { id: string; organization_id: string; customer_id: string; product_unit_id: string; unit_price: number; valid_from: string; valid_until: string; reason: string; is_active: boolean; created_at: string; created_by: string }; Insert: never; Update: never; Relationships: [] }
            supplier_quotations: { Row: { id: string; organization_id: string; supplier_id: string; warehouse_id: string; branch_id: string; supplier_reference: string; valid_until: string; notes: string | null; lines: Json; status: string; purchase_order_id: string | null; created_at: string; created_by: string }; Insert: never; Update: never; Relationships: [] }
            purchase_requests: {
              Row: { id: string; organization_id: string; request_number: string; purchase_order_id: string | null; branch_id: string; warehouse_id: string | null; requested_by: string; needed_by: string | null; notes: string | null; lines: Json; status: string; decision_note: string | null; decided_by: string | null; decided_at: string | null; created_at: string; updated_at: string }
              Insert: never
              Update: never
              Relationships: []
            }
            recalls: {
              Row: { id: string; organization_id: string; recall_number: string; source: string; recall_class: string; title: string; instructions: string; status: string; opened_at: string; opened_by: string; closed_at: string | null; closed_by: string | null }
              Insert: never
              Update: never
              Relationships: []
            }
            recall_batch_scope: {
              Row: { id: string; organization_id: string; recall_id: string; batch_id: string; product_id: string; added_at: string; added_by: string; quarantined_at: string | null; released_at: string | null; release_reason: string | null }
              Insert: never
              Update: never
              Relationships: []
            }
            recall_recoveries: {
              Row: { id: string; organization_id: string; recall_batch_scope_id: string; sales_invoice_id: string; customer_id: string; batch_id: string; quantity: number; status: string; notes: string; created_at: string; created_by: string; updated_at: string; updated_by: string }
              Insert: never
              Update: never
              Relationships: []
            }
            "accounting_settings": {
                  Row: {
                    "go_live_date": string,"id": string,"locked_through": string | null,"organization_id": string,"started_at": string,"started_by": string | null,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "go_live_date": string,"id"?: string,"locked_through"?: string | null,"organization_id"?: string,"started_at"?: string,"started_by"?: string | null,"updated_at"?: string
                  }
                  Update: {
                    "go_live_date"?: string,"id"?: string,"locked_through"?: string | null,"organization_id"?: string,"started_at"?: string,"started_by"?: string | null,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "accounting_settings_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: true
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"audit_logs": {
                  Row: {
                    "action": string,"actor_user_id": string | null,"branch_id": string | null,"created_at": string,"entity_id": string | null,"entity_type": string,"id": string,"metadata": Json | null,"new_values": Json | null,"organization_id": string,"previous_values": Json | null,"reason": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "action": string,"actor_user_id"?: string | null,"branch_id"?: string | null,"created_at"?: string,"entity_id"?: string | null,"entity_type": string,"id"?: string,"metadata"?: Json | null,"new_values"?: Json | null,"organization_id": string,"previous_values"?: Json | null,"reason"?: string | null
                  }
                  Update: {
                    "action"?: string,"actor_user_id"?: string | null,"branch_id"?: string | null,"created_at"?: string,"entity_id"?: string | null,"entity_type"?: string,"id"?: string,"metadata"?: Json | null,"new_values"?: Json | null,"organization_id"?: string,"previous_values"?: Json | null,"reason"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "audit_logs_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"bank_accounts": {
                  Row: {
                    "account_ref": string | null,"bank_name": string | null,"created_at": string,"gl_account_id": string,"id": string,"is_active": boolean,"is_default": boolean,"name": string,"organization_id": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "account_ref"?: string | null,"bank_name"?: string | null,"created_at"?: string,"gl_account_id": string,"id"?: string,"is_active"?: boolean,"is_default"?: boolean,"name": string,"organization_id"?: string,"updated_at"?: string
                  }
                  Update: {
                    "account_ref"?: string | null,"bank_name"?: string | null,"created_at"?: string,"gl_account_id"?: string,"id"?: string,"is_active"?: boolean,"is_default"?: boolean,"name"?: string,"organization_id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "bank_accounts_gl_fk"
      columns: ["gl_account_id","organization_id"]
isOneToOne: false
      referencedRelation: "gl_accounts"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "bank_accounts_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"bank_matches": {
                  Row: {
                    "bank_account_id": string,"id": string,"journal_line_id": string,"matched_at": string,"matched_by": string | null,"note": string | null,"organization_id": string,"statement_line_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "bank_account_id": string,"id"?: string,"journal_line_id": string,"matched_at"?: string,"matched_by"?: string | null,"note"?: string | null,"organization_id"?: string,"statement_line_id"?: string | null
                  }
                  Update: {
                    "bank_account_id"?: string,"id"?: string,"journal_line_id"?: string,"matched_at"?: string,"matched_by"?: string | null,"note"?: string | null,"organization_id"?: string,"statement_line_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "bank_matches_account_fk"
      columns: ["bank_account_id","organization_id"]
isOneToOne: false
      referencedRelation: "bank_accounts"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "bank_matches_journal_line_fk"
      columns: ["journal_line_id","organization_id"]
isOneToOne: false
      referencedRelation: "gl_journal_lines"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "bank_matches_statement_line_fk"
      columns: ["statement_line_id","organization_id"]
isOneToOne: false
      referencedRelation: "bank_statement_lines"
      referencedColumns: ["id","organization_id"]
    }
                  ]
                },"bank_statement_lines": {
                  Row: {
                    "amount": number,"bank_account_id": string,"created_at": string,"description": string | null,"id": string,"line_no": number,"matched": boolean,"organization_id": string,"reference": string | null,"statement_id": string,"txn_date": string
                  }
                  ComputedFields: never
                  Insert: {
                    "amount": number,"bank_account_id": string,"created_at"?: string,"description"?: string | null,"id"?: string,"line_no": number,"matched"?: boolean,"organization_id"?: string,"reference"?: string | null,"statement_id": string,"txn_date": string
                  }
                  Update: {
                    "amount"?: number,"bank_account_id"?: string,"created_at"?: string,"description"?: string | null,"id"?: string,"line_no"?: number,"matched"?: boolean,"organization_id"?: string,"reference"?: string | null,"statement_id"?: string,"txn_date"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "bank_statement_lines_statement_fk"
      columns: ["statement_id","organization_id"]
isOneToOne: false
      referencedRelation: "bank_statements"
      referencedColumns: ["id","organization_id"]
    }
                  ]
                },"bank_statements": {
                  Row: {
                    "bank_account_id": string,"closing_balance": number,"file_name": string | null,"id": string,"imported_at": string,"imported_by": string | null,"opening_balance": number,"organization_id": string,"period_from": string,"period_to": string,"reconciled_at": string | null,"reconciled_by": string | null,"status": string
                  }
                  ComputedFields: never
                  Insert: {
                    "bank_account_id": string,"closing_balance": number,"file_name"?: string | null,"id"?: string,"imported_at"?: string,"imported_by"?: string | null,"opening_balance": number,"organization_id"?: string,"period_from": string,"period_to": string,"reconciled_at"?: string | null,"reconciled_by"?: string | null,"status"?: string
                  }
                  Update: {
                    "bank_account_id"?: string,"closing_balance"?: number,"file_name"?: string | null,"id"?: string,"imported_at"?: string,"imported_by"?: string | null,"opening_balance"?: number,"organization_id"?: string,"period_from"?: string,"period_to"?: string,"reconciled_at"?: string | null,"reconciled_by"?: string | null,"status"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "bank_statements_account_fk"
      columns: ["bank_account_id","organization_id"]
isOneToOne: false
      referencedRelation: "bank_accounts"
      referencedColumns: ["id","organization_id"]
    }
                  ]
                },"batch_costs": {
                  Row: {
                    "batch_id": string,"created_at": string,"organization_id": string,"unit_cost_base": number
                  }
                  ComputedFields: never
                  Insert: {
                    "batch_id": string,"created_at"?: string,"organization_id": string,"unit_cost_base": number
                  }
                  Update: {
                    "batch_id"?: string,"created_at"?: string,"organization_id"?: string,"unit_cost_base"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "batch_costs_batch_fk"
      columns: ["batch_id","organization_id"]
isOneToOne: false
      referencedRelation: "batches"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "batch_costs_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"batches": {
                  Row: {
                    "batch_number": string,"created_at": string,"created_by": string | null,"expiry_date": string,"id": string,"manufacture_date": string | null,"organization_id": string,"product_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "batch_number": string,"created_at"?: string,"created_by"?: string | null,"expiry_date": string,"id"?: string,"manufacture_date"?: string | null,"organization_id"?: string,"product_id": string
                  }
                  Update: {
                    "batch_number"?: string,"created_at"?: string,"created_by"?: string | null,"expiry_date"?: string,"id"?: string,"manufacture_date"?: string | null,"organization_id"?: string,"product_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "batches_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "batches_product_fk"
      columns: ["product_id","organization_id"]
isOneToOne: false
      referencedRelation: "products"
      referencedColumns: ["id","organization_id"]
    }
                  ]
                },"branches": {
                  Row: {
                    "address": string | null,"city": string | null,"code": string,"created_at": string,"email": string | null,"id": string,"is_active": boolean,"is_head_office": boolean,"name": string,"organization_id": string,"phone": string | null,"region": string | null,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "address"?: string | null,"city"?: string | null,"code": string,"created_at"?: string,"email"?: string | null,"id"?: string,"is_active"?: boolean,"is_head_office"?: boolean,"name": string,"organization_id"?: string,"phone"?: string | null,"region"?: string | null,"updated_at"?: string
                  }
                  Update: {
                    "address"?: string | null,"city"?: string | null,"code"?: string,"created_at"?: string,"email"?: string | null,"id"?: string,"is_active"?: boolean,"is_head_office"?: boolean,"name"?: string,"organization_id"?: string,"phone"?: string | null,"region"?: string | null,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "branches_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"client_errors": {
                  Row: {
                    "app_version": string | null,"created_at": string,"id": string,"message": string,"organization_id": string,"page_path": string | null,"source": string,"stack": string | null,"user_agent": string | null,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "app_version"?: string | null,"created_at"?: string,"id"?: string,"message": string,"organization_id": string,"page_path"?: string | null,"source": string,"stack"?: string | null,"user_agent"?: string | null,"user_id": string
                  }
                  Update: {
                    "app_version"?: string | null,"created_at"?: string,"id"?: string,"message"?: string,"organization_id"?: string,"page_path"?: string | null,"source"?: string,"stack"?: string | null,"user_agent"?: string | null,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "client_errors_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"controlled_adjustments": {
                  Row: {
                    "branch_id": string,"created_at": string,"decided_at": string | null,"decided_by": string | null,"decision_note": string | null,"id": string,"lines": NonNullable<Json>,"notes": string,"organization_id": string,"reason_code": string,"request_number": string,"requested_at": string,"requested_by": string,"status": string,"stock_document_id": string | null,"updated_at": string,"warehouse_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "branch_id": string,"created_at"?: string,"decided_at"?: string | null,"decided_by"?: string | null,"decision_note"?: string | null,"id"?: string,"lines": NonNullable<Json>,"notes": string,"organization_id"?: string,"reason_code": string,"request_number": string,"requested_at"?: string,"requested_by"?: string,"status"?: string,"stock_document_id"?: string | null,"updated_at"?: string,"warehouse_id": string
                  }
                  Update: {
                    "branch_id"?: string,"created_at"?: string,"decided_at"?: string | null,"decided_by"?: string | null,"decision_note"?: string | null,"id"?: string,"lines"?: NonNullable<Json>,"notes"?: string,"organization_id"?: string,"reason_code"?: string,"request_number"?: string,"requested_at"?: string,"requested_by"?: string,"status"?: string,"stock_document_id"?: string | null,"updated_at"?: string,"warehouse_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "controlled_adjustments_branch_fk"
      columns: ["branch_id","organization_id"]
isOneToOne: false
      referencedRelation: "branches"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "controlled_adjustments_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "controlled_adjustments_stock_document_id_fkey"
      columns: ["stock_document_id"]
isOneToOne: false
      referencedRelation: "stock_documents"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "controlled_adjustments_warehouse_fk"
      columns: ["warehouse_id","organization_id"]
isOneToOne: false
      referencedRelation: "warehouses"
      referencedColumns: ["id","organization_id"]
    }
                  ]
                },"credit_note_allocations": {
                  Row: {
                    "amount": number,"branch_id": string,"created_at": string,"credit_note_id": string,"id": string,"is_reversed": boolean,"organization_id": string,"sales_invoice_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "amount": number,"branch_id": string,"created_at"?: string,"credit_note_id": string,"id"?: string,"is_reversed"?: boolean,"organization_id": string,"sales_invoice_id": string
                  }
                  Update: {
                    "amount"?: number,"branch_id"?: string,"created_at"?: string,"credit_note_id"?: string,"id"?: string,"is_reversed"?: boolean,"organization_id"?: string,"sales_invoice_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "credit_note_allocations_credit_note_fk"
      columns: ["credit_note_id","organization_id"]
isOneToOne: false
      referencedRelation: "sales_credit_notes"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "credit_note_allocations_invoice_fk"
      columns: ["sales_invoice_id","organization_id"]
isOneToOne: false
      referencedRelation: "sales_invoices"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "credit_note_allocations_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"customer_receipts": {
                  Row: {
                    "allocated_amount": number,"amount": number,"branch_id": string,"created_at": string,"customer_id": string,"id": string,"method": string,"notes": string | null,"organization_id": string,"receipt_date": string,"receipt_number": string,"received_by": string | null,"reference": string | null,"refunded_amount": number,"status": string,"unallocated_amount": number | null,"void_reason": string | null,"voided_at": string | null,"voided_by": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "allocated_amount"?: number,"amount": number,"branch_id": string,"created_at"?: string,"customer_id": string,"id"?: string,"method": string,"notes"?: string | null,"organization_id": string,"receipt_date": string,"receipt_number": string,"received_by"?: string | null,"reference"?: string | null,"refunded_amount"?: number,"status"?: string,"unallocated_amount"?: never,"void_reason"?: string | null,"voided_at"?: string | null,"voided_by"?: string | null
                  }
                  Update: {
                    "allocated_amount"?: number,"amount"?: number,"branch_id"?: string,"created_at"?: string,"customer_id"?: string,"id"?: string,"method"?: string,"notes"?: string | null,"organization_id"?: string,"receipt_date"?: string,"receipt_number"?: string,"received_by"?: string | null,"reference"?: string | null,"refunded_amount"?: number,"status"?: string,"unallocated_amount"?: never,"void_reason"?: string | null,"voided_at"?: string | null,"voided_by"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "customer_receipts_branch_fk"
      columns: ["branch_id","organization_id"]
isOneToOne: false
      referencedRelation: "branches"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "customer_receipts_customer_fk"
      columns: ["customer_id","organization_id"]
isOneToOne: false
      referencedRelation: "customers"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "customer_receipts_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"customer_refunds": {
                  Row: {
                    "amount": number,"branch_id": string,"created_at": string,"credit_note_id": string | null,"customer_id": string,"id": string,"method": string,"notes": string | null,"organization_id": string,"pos_session_id": string | null,"receipt_id": string | null,"reference": string | null,"refund_date": string,"refund_number": string,"refunded_by": string | null,"source_type": string
                  }
                  ComputedFields: never
                  Insert: {
                    "amount": number,"branch_id": string,"created_at"?: string,"credit_note_id"?: string | null,"customer_id": string,"id"?: string,"method": string,"notes"?: string | null,"organization_id": string,"pos_session_id"?: string | null,"receipt_id"?: string | null,"reference"?: string | null,"refund_date": string,"refund_number": string,"refunded_by"?: string | null,"source_type": string
                  }
                  Update: {
                    "amount"?: number,"branch_id"?: string,"created_at"?: string,"credit_note_id"?: string | null,"customer_id"?: string,"id"?: string,"method"?: string,"notes"?: string | null,"organization_id"?: string,"pos_session_id"?: string | null,"receipt_id"?: string | null,"reference"?: string | null,"refund_date"?: string,"refund_number"?: string,"refunded_by"?: string | null,"source_type"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "customer_refunds_branch_fk"
      columns: ["branch_id","organization_id"]
isOneToOne: false
      referencedRelation: "branches"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "customer_refunds_credit_note_fk"
      columns: ["credit_note_id","organization_id"]
isOneToOne: false
      referencedRelation: "sales_credit_notes"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "customer_refunds_customer_fk"
      columns: ["customer_id","organization_id"]
isOneToOne: false
      referencedRelation: "customers"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "customer_refunds_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "customer_refunds_receipt_fk"
      columns: ["receipt_id","organization_id"]
isOneToOne: false
      referencedRelation: "customer_receipts"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "customer_refunds_session_fk"
      columns: ["pos_session_id","organization_id"]
isOneToOne: false
      referencedRelation: "pos_sessions"
      referencedColumns: ["id","organization_id"]
    }
                  ]
                },"customers": {
                  Row: {
                    "address": string | null,"city": string | null,"code": string,"contact_name": string | null,"controlled_drugs_authorised": boolean,"country": string | null,"created_at": string,"credit_limit": number,"customer_type": string,"email": string | null,"hold_reason": string | null,"id": string,"is_active": boolean,"is_walk_in": boolean,"licence_expiry": string | null,"licence_number": string | null,"min_shelf_life_days": number,"name": string,"notes": string | null,"on_hold": boolean,"organization_id": string,"payment_terms_days": number,"phone": string | null,"price_list_id": string | null,"region": string | null,"registered_pharmacist": string | null,"tax_number": string | null,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "address"?: string | null,"city"?: string | null,"code": string,"contact_name"?: string | null,"controlled_drugs_authorised"?: boolean,"country"?: string | null,"created_at"?: string,"credit_limit"?: number,"customer_type"?: string,"email"?: string | null,"hold_reason"?: string | null,"id"?: string,"is_active"?: boolean,"is_walk_in"?: boolean,"licence_expiry"?: string | null,"licence_number"?: string | null,"min_shelf_life_days"?: number,"name": string,"notes"?: string | null,"on_hold"?: boolean,"organization_id"?: string,"payment_terms_days"?: number,"phone"?: string | null,"price_list_id"?: string | null,"region"?: string | null,"registered_pharmacist"?: string | null,"tax_number"?: string | null,"updated_at"?: string
                  }
                  Update: {
                    "address"?: string | null,"city"?: string | null,"code"?: string,"contact_name"?: string | null,"controlled_drugs_authorised"?: boolean,"country"?: string | null,"created_at"?: string,"credit_limit"?: number,"customer_type"?: string,"email"?: string | null,"hold_reason"?: string | null,"id"?: string,"is_active"?: boolean,"is_walk_in"?: boolean,"licence_expiry"?: string | null,"licence_number"?: string | null,"min_shelf_life_days"?: number,"name"?: string,"notes"?: string | null,"on_hold"?: boolean,"organization_id"?: string,"payment_terms_days"?: number,"phone"?: string | null,"price_list_id"?: string | null,"region"?: string | null,"registered_pharmacist"?: string | null,"tax_number"?: string | null,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "customers_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "customers_price_list_fk"
      columns: ["price_list_id","organization_id"]
isOneToOne: false
      referencedRelation: "price_lists"
      referencedColumns: ["id","organization_id"]
    }
                  ]
                },"delivery_notes": {
                  Row: {
                    "branch_id": string,"contact_name": string | null,"contact_phone": string | null,"created_at": string,"customer_id": string,"delivered_at": string | null,"delivery_address": string | null,"dispatched_at": string | null,"dispatched_by": string | null,"driver_name": string | null,"id": string,"note_number": string,"notes": string | null,"organization_id": string,"packages": number,"prepared_at": string,"prepared_by": string | null,"received_by_name": string | null,"sales_invoice_id": string,"status": string,"status_reason": string | null,"updated_at": string,"vehicle_number": string | null,"warehouse_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "branch_id": string,"contact_name"?: string | null,"contact_phone"?: string | null,"created_at"?: string,"customer_id": string,"delivered_at"?: string | null,"delivery_address"?: string | null,"dispatched_at"?: string | null,"dispatched_by"?: string | null,"driver_name"?: string | null,"id"?: string,"note_number": string,"notes"?: string | null,"organization_id"?: string,"packages"?: number,"prepared_at"?: string,"prepared_by"?: string | null,"received_by_name"?: string | null,"sales_invoice_id": string,"status"?: string,"status_reason"?: string | null,"updated_at"?: string,"vehicle_number"?: string | null,"warehouse_id": string
                  }
                  Update: {
                    "branch_id"?: string,"contact_name"?: string | null,"contact_phone"?: string | null,"created_at"?: string,"customer_id"?: string,"delivered_at"?: string | null,"delivery_address"?: string | null,"dispatched_at"?: string | null,"dispatched_by"?: string | null,"driver_name"?: string | null,"id"?: string,"note_number"?: string,"notes"?: string | null,"organization_id"?: string,"packages"?: number,"prepared_at"?: string,"prepared_by"?: string | null,"received_by_name"?: string | null,"sales_invoice_id"?: string,"status"?: string,"status_reason"?: string | null,"updated_at"?: string,"vehicle_number"?: string | null,"warehouse_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "delivery_notes_branch_fk"
      columns: ["branch_id","organization_id"]
isOneToOne: false
      referencedRelation: "branches"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "delivery_notes_customer_fk"
      columns: ["customer_id","organization_id"]
isOneToOne: false
      referencedRelation: "customers"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "delivery_notes_invoice_fk"
      columns: ["sales_invoice_id","organization_id"]
isOneToOne: false
      referencedRelation: "sales_invoices"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "delivery_notes_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "delivery_notes_warehouse_fk"
      columns: ["warehouse_id","organization_id"]
isOneToOne: false
      referencedRelation: "warehouses"
      referencedColumns: ["id","organization_id"]
    }
                  ]
                },"dosage_forms": {
                  Row: {
                    "code": string,"id": string,"is_active": boolean,"name": string
                  }
                  ComputedFields: never
                  Insert: {
                    "code": string,"id"?: string,"is_active"?: boolean,"name": string
                  }
                  Update: {
                    "code"?: string,"id"?: string,"is_active"?: boolean,"name"?: string
                  }
                  Relationships: [
                    
                  ]
                },"drivers": {
                  Row: {
                    "branch_id": string,"code": string,"created_at": string,"id": string,"is_active": boolean,"licence_class": string | null,"licence_expiry": string | null,"licence_number": string | null,"name": string,"notes": string | null,"organization_id": string,"phone": string | null,"profile_id": string | null,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "branch_id": string,"code": string,"created_at"?: string,"id"?: string,"is_active"?: boolean,"licence_class"?: string | null,"licence_expiry"?: string | null,"licence_number"?: string | null,"name": string,"notes"?: string | null,"organization_id"?: string,"phone"?: string | null,"profile_id"?: string | null,"updated_at"?: string
                  }
                  Update: {
                    "branch_id"?: string,"code"?: string,"created_at"?: string,"id"?: string,"is_active"?: boolean,"licence_class"?: string | null,"licence_expiry"?: string | null,"licence_number"?: string | null,"name"?: string,"notes"?: string | null,"organization_id"?: string,"phone"?: string | null,"profile_id"?: string | null,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "drivers_branch_fk"
      columns: ["branch_id","organization_id"]
isOneToOne: false
      referencedRelation: "branches"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "drivers_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "drivers_profile_fk"
      columns: ["profile_id","organization_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id","organization_id"]
    }
                  ]
                },"fulfilment_exceptions": {
                  Row: {
                    "branch_id": string,"created_at": string,"decision": string | null,"fulfilment_order_id": string,"id": string,"kind": string,"organization_id": string,"pick_line_id": string,"raised_at": string,"raised_by": string | null,"reason": string,"resolution_reason": string | null,"resolved_at": string | null,"resolved_by": string | null,"short_quantity": number,"status": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "branch_id": string,"created_at"?: string,"decision"?: string | null,"fulfilment_order_id": string,"id"?: string,"kind"?: string,"organization_id"?: string,"pick_line_id": string,"raised_at"?: string,"raised_by"?: string | null,"reason": string,"resolution_reason"?: string | null,"resolved_at"?: string | null,"resolved_by"?: string | null,"short_quantity": number,"status"?: string,"updated_at"?: string
                  }
                  Update: {
                    "branch_id"?: string,"created_at"?: string,"decision"?: string | null,"fulfilment_order_id"?: string,"id"?: string,"kind"?: string,"organization_id"?: string,"pick_line_id"?: string,"raised_at"?: string,"raised_by"?: string | null,"reason"?: string,"resolution_reason"?: string | null,"resolved_at"?: string | null,"resolved_by"?: string | null,"short_quantity"?: number,"status"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "fulfilment_exceptions_branch_fk"
      columns: ["branch_id","organization_id"]
isOneToOne: false
      referencedRelation: "branches"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "fulfilment_exceptions_line_fk"
      columns: ["pick_line_id","organization_id"]
isOneToOne: false
      referencedRelation: "pick_lines"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "fulfilment_exceptions_order_fk"
      columns: ["fulfilment_order_id","organization_id"]
isOneToOne: false
      referencedRelation: "fulfilment_orders"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "fulfilment_exceptions_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"fulfilment_orders": {
                  Row: {
                    "branch_id": string,"cancel_reason": string | null,"cancelled_at": string | null,"created_at": string,"customer_id": string,"id": string,"notes": string | null,"order_number": string,"organization_id": string,"picked_at": string | null,"picker_id": string | null,"picking_started_at": string | null,"priority": number,"released_at": string,"released_by": string | null,"required_by": string | null,"sales_invoice_id": string,"status": string,"updated_at": string,"warehouse_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "branch_id": string,"cancel_reason"?: string | null,"cancelled_at"?: string | null,"created_at"?: string,"customer_id": string,"id"?: string,"notes"?: string | null,"order_number": string,"organization_id"?: string,"picked_at"?: string | null,"picker_id"?: string | null,"picking_started_at"?: string | null,"priority"?: number,"released_at"?: string,"released_by"?: string | null,"required_by"?: string | null,"sales_invoice_id": string,"status"?: string,"updated_at"?: string,"warehouse_id": string
                  }
                  Update: {
                    "branch_id"?: string,"cancel_reason"?: string | null,"cancelled_at"?: string | null,"created_at"?: string,"customer_id"?: string,"id"?: string,"notes"?: string | null,"order_number"?: string,"organization_id"?: string,"picked_at"?: string | null,"picker_id"?: string | null,"picking_started_at"?: string | null,"priority"?: number,"released_at"?: string,"released_by"?: string | null,"required_by"?: string | null,"sales_invoice_id"?: string,"status"?: string,"updated_at"?: string,"warehouse_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "fulfilment_orders_branch_fk"
      columns: ["branch_id","organization_id"]
isOneToOne: false
      referencedRelation: "branches"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "fulfilment_orders_customer_fk"
      columns: ["customer_id","organization_id"]
isOneToOne: false
      referencedRelation: "customers"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "fulfilment_orders_invoice_fk"
      columns: ["sales_invoice_id","organization_id"]
isOneToOne: false
      referencedRelation: "sales_invoices"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "fulfilment_orders_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "fulfilment_orders_picker_fk"
      columns: ["picker_id","organization_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "fulfilment_orders_warehouse_fk"
      columns: ["warehouse_id","organization_id"]
isOneToOne: false
      referencedRelation: "warehouses"
      referencedColumns: ["id","organization_id"]
    }
                  ]
                },"gl_accounts": {
                  Row: {
                    "account_type": string,"allow_manual": boolean,"code": string,"created_at": string,"id": string,"is_active": boolean,"is_system": boolean,"name": string,"normal_side": string,"organization_id": string,"system_key": string | null,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "account_type": string,"allow_manual"?: boolean,"code": string,"created_at"?: string,"id"?: string,"is_active"?: boolean,"is_system"?: boolean,"name": string,"normal_side": string,"organization_id"?: string,"system_key"?: string | null,"updated_at"?: string
                  }
                  Update: {
                    "account_type"?: string,"allow_manual"?: boolean,"code"?: string,"created_at"?: string,"id"?: string,"is_active"?: boolean,"is_system"?: boolean,"name"?: string,"normal_side"?: string,"organization_id"?: string,"system_key"?: string | null,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "gl_accounts_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"gl_journal_lines": {
                  Row: {
                    "account_id": string,"branch_id": string | null,"credit": number,"debit": number,"id": string,"journal_date": string,"journal_id": string,"line_no": number,"memo": string | null,"organization_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "account_id": string,"branch_id"?: string | null,"credit"?: number,"debit"?: number,"id"?: string,"journal_date": string,"journal_id": string,"line_no": number,"memo"?: string | null,"organization_id": string
                  }
                  Update: {
                    "account_id"?: string,"branch_id"?: string | null,"credit"?: number,"debit"?: number,"id"?: string,"journal_date"?: string,"journal_id"?: string,"line_no"?: number,"memo"?: string | null,"organization_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "gl_journal_lines_account_fk"
      columns: ["account_id","organization_id"]
isOneToOne: false
      referencedRelation: "gl_accounts"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "gl_journal_lines_branch_fk"
      columns: ["branch_id","organization_id"]
isOneToOne: false
      referencedRelation: "branches"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "gl_journal_lines_journal_fk"
      columns: ["journal_id","organization_id"]
isOneToOne: false
      referencedRelation: "gl_journals"
      referencedColumns: ["id","organization_id"]
    }
                  ]
                },"gl_journals": {
                  Row: {
                    "branch_id": string | null,"created_at": string,"created_by": string | null,"description": string,"event": string,"id": string,"journal_date": string,"journal_number": string,"organization_id": string,"reason": string | null,"reverses_journal_id": string | null,"source_id": string | null,"source_type": string
                  }
                  ComputedFields: never
                  Insert: {
                    "branch_id"?: string | null,"created_at"?: string,"created_by"?: string | null,"description": string,"event"?: string,"id"?: string,"journal_date": string,"journal_number": string,"organization_id": string,"reason"?: string | null,"reverses_journal_id"?: string | null,"source_id"?: string | null,"source_type": string
                  }
                  Update: {
                    "branch_id"?: string | null,"created_at"?: string,"created_by"?: string | null,"description"?: string,"event"?: string,"id"?: string,"journal_date"?: string,"journal_number"?: string,"organization_id"?: string,"reason"?: string | null,"reverses_journal_id"?: string | null,"source_id"?: string | null,"source_type"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "gl_journals_branch_fk"
      columns: ["branch_id","organization_id"]
isOneToOne: false
      referencedRelation: "branches"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "gl_journals_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "gl_journals_reverses_fk"
      columns: ["reverses_journal_id","organization_id"]
isOneToOne: false
      referencedRelation: "gl_journals"
      referencedColumns: ["id","organization_id"]
    }
                  ]
                },"goods_receipt_lines": {
                  Row: {
                    "batch_id": string | null,"branch_id": string,"goods_receipt_id": string,"id": string,"line_no": number,"location_id": string | null,"organization_id": string,"po_line_id": string,"product_id": string,"product_unit_id": string,"quantity_received": number,"received_base": number,"stock_status": string,"unit_cost_base": number
                  }
                  ComputedFields: never
                  Insert: {
                    "batch_id"?: string | null,"branch_id": string,"goods_receipt_id": string,"id"?: string,"line_no": number,"location_id"?: string | null,"organization_id": string,"po_line_id": string,"product_id": string,"product_unit_id": string,"quantity_received": number,"received_base": number,"stock_status": string,"unit_cost_base": number
                  }
                  Update: {
                    "batch_id"?: string | null,"branch_id"?: string,"goods_receipt_id"?: string,"id"?: string,"line_no"?: number,"location_id"?: string | null,"organization_id"?: string,"po_line_id"?: string,"product_id"?: string,"product_unit_id"?: string,"quantity_received"?: number,"received_base"?: number,"stock_status"?: string,"unit_cost_base"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "goods_receipt_lines_batch_fk"
      columns: ["batch_id","product_id","organization_id"]
isOneToOne: false
      referencedRelation: "batches"
      referencedColumns: ["id","product_id","organization_id"]
    },{
      foreignKeyName: "goods_receipt_lines_gr_fk"
      columns: ["goods_receipt_id","organization_id"]
isOneToOne: false
      referencedRelation: "goods_receipts"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "goods_receipt_lines_location_id_fkey"
      columns: ["location_id"]
isOneToOne: false
      referencedRelation: "warehouse_locations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "goods_receipt_lines_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "goods_receipt_lines_po_line_fk"
      columns: ["po_line_id","organization_id"]
isOneToOne: false
      referencedRelation: "purchase_order_lines"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "goods_receipt_lines_product_fk"
      columns: ["product_id","organization_id"]
isOneToOne: false
      referencedRelation: "products"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "goods_receipt_lines_unit_fk"
      columns: ["product_unit_id","product_id","organization_id"]
isOneToOne: false
      referencedRelation: "product_units"
      referencedColumns: ["id","product_id","organization_id"]
    }
                  ]
                },"goods_receipts": {
                  Row: {
                    "branch_id": string,"delivery_note": string | null,"grn_number": string,"id": string,"line_count": number,"notes": string | null,"organization_id": string,"purchase_order_id": string,"received_at": string,"received_by": string | null,"stock_document_id": string,"supplier_id": string,"warehouse_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "branch_id": string,"delivery_note"?: string | null,"grn_number": string,"id"?: string,"line_count": number,"notes"?: string | null,"organization_id": string,"purchase_order_id": string,"received_at"?: string,"received_by"?: string | null,"stock_document_id": string,"supplier_id": string,"warehouse_id": string
                  }
                  Update: {
                    "branch_id"?: string,"delivery_note"?: string | null,"grn_number"?: string,"id"?: string,"line_count"?: number,"notes"?: string | null,"organization_id"?: string,"purchase_order_id"?: string,"received_at"?: string,"received_by"?: string | null,"stock_document_id"?: string,"supplier_id"?: string,"warehouse_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "goods_receipts_branch_fk"
      columns: ["branch_id","organization_id"]
isOneToOne: false
      referencedRelation: "branches"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "goods_receipts_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "goods_receipts_po_fk"
      columns: ["purchase_order_id","organization_id"]
isOneToOne: false
      referencedRelation: "purchase_orders"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "goods_receipts_stock_document_fk"
      columns: ["stock_document_id","organization_id"]
isOneToOne: false
      referencedRelation: "stock_documents"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "goods_receipts_supplier_fk"
      columns: ["supplier_id","organization_id"]
isOneToOne: false
      referencedRelation: "suppliers"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "goods_receipts_warehouse_fk"
      columns: ["warehouse_id","organization_id"]
isOneToOne: false
      referencedRelation: "warehouses"
      referencedColumns: ["id","organization_id"]
    }
                  ]
                },"manufacturers": {
                  Row: {
                    "country": string | null,"created_at": string,"id": string,"is_active": boolean,"name": string,"notes": string | null,"organization_id": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "country"?: string | null,"created_at"?: string,"id"?: string,"is_active"?: boolean,"name": string,"notes"?: string | null,"organization_id"?: string,"updated_at"?: string
                  }
                  Update: {
                    "country"?: string | null,"created_at"?: string,"id"?: string,"is_active"?: boolean,"name"?: string,"notes"?: string | null,"organization_id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "manufacturers_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"number_sequences": {
                  Row: {
                    "branch_id": string | null,"created_at": string,"current_period": string,"document_type": string,"id": string,"next_number": number,"organization_id": string,"padding": number,"prefix": string,"reset_period": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "branch_id"?: string | null,"created_at"?: string,"current_period"?: string,"document_type": string,"id"?: string,"next_number"?: number,"organization_id": string,"padding"?: number,"prefix": string,"reset_period"?: string,"updated_at"?: string
                  }
                  Update: {
                    "branch_id"?: string | null,"created_at"?: string,"current_period"?: string,"document_type"?: string,"id"?: string,"next_number"?: number,"organization_id"?: string,"padding"?: number,"prefix"?: string,"reset_period"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "number_sequences_branch_fk"
      columns: ["branch_id","organization_id"]
isOneToOne: false
      referencedRelation: "branches"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "number_sequences_org_fk"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"organizations": {
                  Row: {
                    "address": string | null,"city": string | null,"country": string,"created_at": string,"currency_code": string,"email": string | null,"id": string,"is_active": boolean,"legal_name": string | null,"logo_url": string | null,"name": string,"phone": string | null,"region": string | null,"registration_number": string | null,"tax_number": string | null,"timezone": string,"trading_name": string | null,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "address"?: string | null,"city"?: string | null,"country"?: string,"created_at"?: string,"currency_code"?: string,"email"?: string | null,"id"?: string,"is_active"?: boolean,"legal_name"?: string | null,"logo_url"?: string | null,"name": string,"phone"?: string | null,"region"?: string | null,"registration_number"?: string | null,"tax_number"?: string | null,"timezone"?: string,"trading_name"?: string | null,"updated_at"?: string
                  }
                  Update: {
                    "address"?: string | null,"city"?: string | null,"country"?: string,"created_at"?: string,"currency_code"?: string,"email"?: string | null,"id"?: string,"is_active"?: boolean,"legal_name"?: string | null,"logo_url"?: string | null,"name"?: string,"phone"?: string | null,"region"?: string | null,"registration_number"?: string | null,"tax_number"?: string | null,"timezone"?: string,"trading_name"?: string | null,"updated_at"?: string
                  }
                  Relationships: [
                    
                  ]
                },"payment_reminders": {
                  Row: {
                    "channel": string,"customer_id": string,"id": string,"invoice_ids": (string)[],"level": number,"message": string,"organization_id": string,"overdue_amount": number,"sent_at": string,"sent_by": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "channel": string,"customer_id": string,"id"?: string,"invoice_ids": (string)[],"level": number,"message": string,"organization_id"?: string,"overdue_amount": number,"sent_at"?: string,"sent_by"?: string | null
                  }
                  Update: {
                    "channel"?: string,"customer_id"?: string,"id"?: string,"invoice_ids"?: (string)[],"level"?: number,"message"?: string,"organization_id"?: string,"overdue_amount"?: number,"sent_at"?: string,"sent_by"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "payment_reminders_customer_fk"
      columns: ["customer_id","organization_id"]
isOneToOne: false
      referencedRelation: "customers"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "payment_reminders_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"permissions": {
                  Row: {
                    "action": string,"code": string,"description": string,"id": string,"module": string
                  }
                  ComputedFields: never
                  Insert: {
                    "action": string,"code": string,"description": string,"id"?: string,"module": string
                  }
                  Update: {
                    "action"?: string,"code"?: string,"description"?: string,"id"?: string,"module"?: string
                  }
                  Relationships: [
                    
                  ]
                },"pick_lines": {
                  Row: {
                    "allocation_id": string,"batch_id": string | null,"branch_id": string,"created_at": string,"expected_quantity": number,"fulfilment_order_id": string,"id": string,"line_no": number,"location_id": string | null,"organization_id": string,"picked_at": string | null,"picked_by": string | null,"picked_quantity": number | null,"product_id": string,"short_note": string | null,"short_reason": string | null,"status": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "allocation_id": string,"batch_id"?: string | null,"branch_id": string,"created_at"?: string,"expected_quantity": number,"fulfilment_order_id": string,"id"?: string,"line_no": number,"location_id"?: string | null,"organization_id"?: string,"picked_at"?: string | null,"picked_by"?: string | null,"picked_quantity"?: number | null,"product_id": string,"short_note"?: string | null,"short_reason"?: string | null,"status"?: string,"updated_at"?: string
                  }
                  Update: {
                    "allocation_id"?: string,"batch_id"?: string | null,"branch_id"?: string,"created_at"?: string,"expected_quantity"?: number,"fulfilment_order_id"?: string,"id"?: string,"line_no"?: number,"location_id"?: string | null,"organization_id"?: string,"picked_at"?: string | null,"picked_by"?: string | null,"picked_quantity"?: number | null,"product_id"?: string,"short_note"?: string | null,"short_reason"?: string | null,"status"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "pick_lines_allocation_id_fkey"
      columns: ["allocation_id"]
isOneToOne: false
      referencedRelation: "sales_invoice_allocations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "pick_lines_batch_fk"
      columns: ["batch_id","product_id","organization_id"]
isOneToOne: false
      referencedRelation: "batches"
      referencedColumns: ["id","product_id","organization_id"]
    },{
      foreignKeyName: "pick_lines_branch_fk"
      columns: ["branch_id","organization_id"]
isOneToOne: false
      referencedRelation: "branches"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "pick_lines_location_id_fkey"
      columns: ["location_id"]
isOneToOne: false
      referencedRelation: "warehouse_locations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "pick_lines_order_fk"
      columns: ["fulfilment_order_id","organization_id"]
isOneToOne: false
      referencedRelation: "fulfilment_orders"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "pick_lines_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "pick_lines_picker_fk"
      columns: ["picked_by","organization_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id","organization_id"]
    }
                  ]
                },"pos_sale_payments": {
                  Row: {
                    "amount": number,"branch_id": string,"cashier_id": string,"id": string,"method": string,"organization_id": string,"pos_sale_id": string,"pos_session_id": string,"receipt_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "amount": number,"branch_id": string,"cashier_id": string,"id"?: string,"method": string,"organization_id": string,"pos_sale_id": string,"pos_session_id": string,"receipt_id": string
                  }
                  Update: {
                    "amount"?: number,"branch_id"?: string,"cashier_id"?: string,"id"?: string,"method"?: string,"organization_id"?: string,"pos_sale_id"?: string,"pos_session_id"?: string,"receipt_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "pos_sale_payments_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "pos_sale_payments_receipt_fk"
      columns: ["receipt_id","organization_id"]
isOneToOne: false
      referencedRelation: "customer_receipts"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "pos_sale_payments_sale_fk"
      columns: ["pos_sale_id","organization_id"]
isOneToOne: false
      referencedRelation: "pos_sales"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "pos_sale_payments_session_fk"
      columns: ["pos_session_id","organization_id"]
isOneToOne: false
      referencedRelation: "pos_sessions"
      referencedColumns: ["id","organization_id"]
    }
                  ]
                },"pos_sales": {
                  Row: {
                    "branch_id": string,"cash_tendered": number,"cashier_id": string,"change_given": number,"created_at": string,"customer_id": string,"id": string,"organization_id": string,"pos_session_id": string,"sales_invoice_id": string,"total_amount": number
                  }
                  ComputedFields: never
                  Insert: {
                    "branch_id": string,"cash_tendered"?: number,"cashier_id": string,"change_given"?: number,"created_at"?: string,"customer_id": string,"id"?: string,"organization_id": string,"pos_session_id": string,"sales_invoice_id": string,"total_amount": number
                  }
                  Update: {
                    "branch_id"?: string,"cash_tendered"?: number,"cashier_id"?: string,"change_given"?: number,"created_at"?: string,"customer_id"?: string,"id"?: string,"organization_id"?: string,"pos_session_id"?: string,"sales_invoice_id"?: string,"total_amount"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "pos_sales_customer_fk"
      columns: ["customer_id","organization_id"]
isOneToOne: false
      referencedRelation: "customers"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "pos_sales_invoice_fk"
      columns: ["sales_invoice_id","organization_id"]
isOneToOne: false
      referencedRelation: "sales_invoices"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "pos_sales_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "pos_sales_session_fk"
      columns: ["pos_session_id","organization_id"]
isOneToOne: false
      referencedRelation: "pos_sessions"
      referencedColumns: ["id","organization_id"]
    }
                  ]
                },"pos_sessions": {
                  Row: {
                    "branch_id": string,"cashier_id": string,"close_notes": string | null,"closed_at": string | null,"closed_by": string | null,"counted_cash": number | null,"expected_cash": number | null,"id": string,"opened_at": string,"opening_float": number,"organization_id": string,"sales_count": number | null,"sales_total": number | null,"session_number": string,"status": string,"variance": number | null,"warehouse_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "branch_id": string,"cashier_id"?: string,"close_notes"?: string | null,"closed_at"?: string | null,"closed_by"?: string | null,"counted_cash"?: number | null,"expected_cash"?: number | null,"id"?: string,"opened_at"?: string,"opening_float"?: number,"organization_id"?: string,"sales_count"?: number | null,"sales_total"?: number | null,"session_number": string,"status"?: string,"variance"?: never,"warehouse_id": string
                  }
                  Update: {
                    "branch_id"?: string,"cashier_id"?: string,"close_notes"?: string | null,"closed_at"?: string | null,"closed_by"?: string | null,"counted_cash"?: number | null,"expected_cash"?: number | null,"id"?: string,"opened_at"?: string,"opening_float"?: number,"organization_id"?: string,"sales_count"?: number | null,"sales_total"?: number | null,"session_number"?: string,"status"?: string,"variance"?: never,"warehouse_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "pos_sessions_branch_fk"
      columns: ["branch_id","organization_id"]
isOneToOne: false
      referencedRelation: "branches"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "pos_sessions_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "pos_sessions_warehouse_fk"
      columns: ["warehouse_id","organization_id"]
isOneToOne: false
      referencedRelation: "warehouses"
      referencedColumns: ["id","organization_id"]
    }
                  ]
                },"price_list_items": {
                  Row: {
                    "created_at": string,"id": string,"is_active": boolean,"organization_id": string,"price_list_id": string,"product_id": string,"product_unit_id": string,"unit_price": number,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"id"?: string,"is_active"?: boolean,"organization_id"?: string,"price_list_id": string,"product_id": string,"product_unit_id": string,"unit_price": number,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"is_active"?: boolean,"organization_id"?: string,"price_list_id"?: string,"product_id"?: string,"product_unit_id"?: string,"unit_price"?: number,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "price_list_items_list_fk"
      columns: ["price_list_id","organization_id"]
isOneToOne: false
      referencedRelation: "price_lists"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "price_list_items_unit_fk"
      columns: ["product_unit_id","product_id","organization_id"]
isOneToOne: false
      referencedRelation: "product_units"
      referencedColumns: ["id","product_id","organization_id"]
    }
                  ]
                },"price_lists": {
                  Row: {
                    "code": string,"created_at": string,"id": string,"is_active": boolean,"is_default": boolean,"name": string,"notes": string | null,"organization_id": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "code": string,"created_at"?: string,"id"?: string,"is_active"?: boolean,"is_default"?: boolean,"name": string,"notes"?: string | null,"organization_id"?: string,"updated_at"?: string
                  }
                  Update: {
                    "code"?: string,"created_at"?: string,"id"?: string,"is_active"?: boolean,"is_default"?: boolean,"name"?: string,"notes"?: string | null,"organization_id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "price_lists_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"product_aliases": {
                  Row: {
                    "alias": string,"created_at": string,"id": string,"identity_id": string | null,"is_active": boolean,"normalized_alias": string,"organization_id": string,"product_id": string | null,"source": string,"supplier_id": string | null,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "alias": string,"created_at"?: string,"id"?: string,"identity_id"?: string | null,"is_active"?: boolean,"normalized_alias"?: string,"organization_id"?: string,"product_id"?: string | null,"source"?: string,"supplier_id"?: string | null,"updated_at"?: string
                  }
                  Update: {
                    "alias"?: string,"created_at"?: string,"id"?: string,"identity_id"?: string | null,"is_active"?: boolean,"normalized_alias"?: string,"organization_id"?: string,"product_id"?: string | null,"source"?: string,"supplier_id"?: string | null,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "product_aliases_identity_fk"
      columns: ["identity_id","organization_id"]
isOneToOne: false
      referencedRelation: "product_identities"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "product_aliases_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "product_aliases_product_fk"
      columns: ["product_id","organization_id"]
isOneToOne: false
      referencedRelation: "products"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "product_aliases_supplier_fk"
      columns: ["supplier_id","organization_id"]
isOneToOne: false
      referencedRelation: "suppliers"
      referencedColumns: ["id","organization_id"]
    }
                  ]
                },"product_barcodes": {
                  Row: {
                    "barcode": string,"barcode_type": string,"created_at": string,"id": string,"is_active": boolean,"organization_id": string,"product_id": string,"product_unit_id": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "barcode": string,"barcode_type"?: string,"created_at"?: string,"id"?: string,"is_active"?: boolean,"organization_id"?: string,"product_id": string,"product_unit_id": string,"updated_at"?: string
                  }
                  Update: {
                    "barcode"?: string,"barcode_type"?: string,"created_at"?: string,"id"?: string,"is_active"?: boolean,"organization_id"?: string,"product_id"?: string,"product_unit_id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "product_barcodes_unit_fk"
      columns: ["product_unit_id","product_id","organization_id"]
isOneToOne: false
      referencedRelation: "product_units"
      referencedColumns: ["id","product_id","organization_id"]
    }
                  ]
                },"product_categories": {
                  Row: {
                    "code": string,"created_at": string,"id": string,"is_active": boolean,"name": string,"organization_id": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "code": string,"created_at"?: string,"id"?: string,"is_active"?: boolean,"name": string,"organization_id"?: string,"updated_at"?: string
                  }
                  Update: {
                    "code"?: string,"created_at"?: string,"id"?: string,"is_active"?: boolean,"name"?: string,"organization_id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "product_categories_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"product_identities": {
                  Row: {
                    "created_at": string,"dosage_form_id": string,"generic_name": string,"id": string,"identity_key": string,"is_active": boolean,"notes": string | null,"organization_id": string,"strength_text": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"dosage_form_id": string,"generic_name": string,"id"?: string,"identity_key"?: string,"is_active"?: boolean,"notes"?: string | null,"organization_id"?: string,"strength_text": string,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"dosage_form_id"?: string,"generic_name"?: string,"id"?: string,"identity_key"?: string,"is_active"?: boolean,"notes"?: string | null,"organization_id"?: string,"strength_text"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "product_identities_dosage_form_id_fkey"
      columns: ["dosage_form_id"]
isOneToOne: false
      referencedRelation: "dosage_forms"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "product_identities_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"product_units": {
                  Row: {
                    "created_at": string,"factor_to_base": number,"id": string,"is_active": boolean,"is_base": boolean,"is_purchasable": boolean,"is_sellable": boolean,"organization_id": string,"product_id": string,"unit_id": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"factor_to_base": number,"id"?: string,"is_active"?: boolean,"is_base"?: boolean,"is_purchasable"?: boolean,"is_sellable"?: boolean,"organization_id"?: string,"product_id": string,"unit_id": string,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"factor_to_base"?: number,"id"?: string,"is_active"?: boolean,"is_base"?: boolean,"is_purchasable"?: boolean,"is_sellable"?: boolean,"organization_id"?: string,"product_id"?: string,"unit_id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "product_units_product_fk"
      columns: ["product_id","organization_id"]
isOneToOne: false
      referencedRelation: "products"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "product_units_unit_id_fkey"
      columns: ["unit_id"]
isOneToOne: false
      referencedRelation: "units_of_measure"
      referencedColumns: ["id"]
    }
                  ]
                },"products": {
                  Row: {
                    "base_unit_id": string,"brand_name": string,"category_id": string | null,"created_at": string,"description": string | null,"fda_registration_expiry": string | null,"fda_registration_number": string | null,"id": string,"identity_id": string | null,"is_active": boolean,"is_controlled": boolean,"manufacturer_id": string | null,"organization_id": string,"product_class": string,"requires_prescription": boolean,"search_key": string,"sku": string,"storage_condition": string,"tax_code_id": string | null,"track_batches": boolean,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "base_unit_id": string,"brand_name": string,"category_id"?: string | null,"created_at"?: string,"description"?: string | null,"fda_registration_expiry"?: string | null,"fda_registration_number"?: string | null,"id"?: string,"identity_id"?: string | null,"is_active"?: boolean,"is_controlled"?: boolean,"manufacturer_id"?: string | null,"organization_id"?: string,"product_class"?: string,"requires_prescription"?: boolean,"search_key"?: string,"sku": string,"storage_condition"?: string,"tax_code_id"?: string | null,"track_batches"?: boolean,"updated_at"?: string
                  }
                  Update: {
                    "base_unit_id"?: string,"brand_name"?: string,"category_id"?: string | null,"created_at"?: string,"description"?: string | null,"fda_registration_expiry"?: string | null,"fda_registration_number"?: string | null,"id"?: string,"identity_id"?: string | null,"is_active"?: boolean,"is_controlled"?: boolean,"manufacturer_id"?: string | null,"organization_id"?: string,"product_class"?: string,"requires_prescription"?: boolean,"search_key"?: string,"sku"?: string,"storage_condition"?: string,"tax_code_id"?: string | null,"track_batches"?: boolean,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "products_base_unit_id_fkey"
      columns: ["base_unit_id"]
isOneToOne: false
      referencedRelation: "units_of_measure"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "products_category_fk"
      columns: ["category_id","organization_id"]
isOneToOne: false
      referencedRelation: "product_categories"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "products_identity_fk"
      columns: ["identity_id","organization_id"]
isOneToOne: false
      referencedRelation: "product_identities"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "products_manufacturer_fk"
      columns: ["manufacturer_id","organization_id"]
isOneToOne: false
      referencedRelation: "manufacturers"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "products_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "products_tax_code_fk"
      columns: ["tax_code_id","organization_id"]
isOneToOne: false
      referencedRelation: "tax_codes"
      referencedColumns: ["id","organization_id"]
    }
                  ]
                },"profiles": {
                  Row: {
                    "created_at": string,"default_branch_id": string | null,"display_name": string | null,"email": string | null,"employee_code": string | null,"first_name": string,"id": string,"is_active": boolean,"job_title": string | null,"last_name": string,"organization_id": string,"phone": string | null,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"default_branch_id"?: string | null,"display_name"?: string | null,"email"?: string | null,"employee_code"?: string | null,"first_name": string,"id": string,"is_active"?: boolean,"job_title"?: string | null,"last_name": string,"organization_id": string,"phone"?: string | null,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"default_branch_id"?: string | null,"display_name"?: string | null,"email"?: string | null,"employee_code"?: string | null,"first_name"?: string,"id"?: string,"is_active"?: boolean,"job_title"?: string | null,"last_name"?: string,"organization_id"?: string,"phone"?: string | null,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "profiles_default_branch_fk"
      columns: ["default_branch_id","organization_id"]
isOneToOne: false
      referencedRelation: "branches"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "profiles_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"purchase_order_lines": {
                  Row: {
                    "branch_id": string,"id": string,"line_no": number,"line_total": number | null,"ordered_base": number,"organization_id": string,"product_id": string,"product_unit_id": string,"purchase_order_id": string,"quantity_ordered": number,"received_base": number,"unit_cost": number
                  }
                  ComputedFields: never
                  Insert: {
                    "branch_id": string,"id"?: string,"line_no": number,"line_total"?: never,"ordered_base": number,"organization_id"?: string,"product_id": string,"product_unit_id": string,"purchase_order_id": string,"quantity_ordered": number,"received_base"?: number,"unit_cost": number
                  }
                  Update: {
                    "branch_id"?: string,"id"?: string,"line_no"?: number,"line_total"?: never,"ordered_base"?: number,"organization_id"?: string,"product_id"?: string,"product_unit_id"?: string,"purchase_order_id"?: string,"quantity_ordered"?: number,"received_base"?: number,"unit_cost"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "purchase_order_lines_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "purchase_order_lines_po_fk"
      columns: ["purchase_order_id","organization_id"]
isOneToOne: false
      referencedRelation: "purchase_orders"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "purchase_order_lines_product_fk"
      columns: ["product_id","organization_id"]
isOneToOne: false
      referencedRelation: "products"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "purchase_order_lines_unit_fk"
      columns: ["product_unit_id","product_id","organization_id"]
isOneToOne: false
      referencedRelation: "product_units"
      referencedColumns: ["id","product_id","organization_id"]
    }
                  ]
                },"purchase_orders": {
                  Row: {
                    "approved_at": string | null,"approved_by": string | null,"branch_id": string,"created_at": string,"created_by": string | null,"currency_code": string,"expected_date": string | null,"id": string,"notes": string | null,"order_date": string,"organization_id": string,"payment_terms_days": number,"po_number": string,"status": string,"status_reason": string | null,"submitted_at": string | null,"supplier_id": string,"total_amount": number,"updated_at": string,"warehouse_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "approved_at"?: string | null,"approved_by"?: string | null,"branch_id": string,"created_at"?: string,"created_by"?: string | null,"currency_code": string,"expected_date"?: string | null,"id"?: string,"notes"?: string | null,"order_date"?: string,"organization_id"?: string,"payment_terms_days"?: number,"po_number": string,"status"?: string,"status_reason"?: string | null,"submitted_at"?: string | null,"supplier_id": string,"total_amount"?: number,"updated_at"?: string,"warehouse_id": string
                  }
                  Update: {
                    "approved_at"?: string | null,"approved_by"?: string | null,"branch_id"?: string,"created_at"?: string,"created_by"?: string | null,"currency_code"?: string,"expected_date"?: string | null,"id"?: string,"notes"?: string | null,"order_date"?: string,"organization_id"?: string,"payment_terms_days"?: number,"po_number"?: string,"status"?: string,"status_reason"?: string | null,"submitted_at"?: string | null,"supplier_id"?: string,"total_amount"?: number,"updated_at"?: string,"warehouse_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "purchase_orders_branch_fk"
      columns: ["branch_id","organization_id"]
isOneToOne: false
      referencedRelation: "branches"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "purchase_orders_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "purchase_orders_supplier_fk"
      columns: ["supplier_id","organization_id"]
isOneToOne: false
      referencedRelation: "suppliers"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "purchase_orders_warehouse_fk"
      columns: ["warehouse_id","organization_id"]
isOneToOne: false
      referencedRelation: "warehouses"
      referencedColumns: ["id","organization_id"]
    }
                  ]
                },"purchase_return_lines": {
                  Row: {
                    "batch_id": string | null,"branch_id": string,"id": string,"line_no": number,"location_id": string | null,"organization_id": string,"product_id": string,"product_unit_id": string,"purchase_return_id": string,"quantity_returned": number,"returned_base": number,"stock_status": string,"unit_cost_base": number | null
                  }
                  ComputedFields: never
                  Insert: {
                    "batch_id"?: string | null,"branch_id": string,"id"?: string,"line_no": number,"location_id"?: string | null,"organization_id": string,"product_id": string,"product_unit_id": string,"purchase_return_id": string,"quantity_returned": number,"returned_base": number,"stock_status": string,"unit_cost_base"?: number | null
                  }
                  Update: {
                    "batch_id"?: string | null,"branch_id"?: string,"id"?: string,"line_no"?: number,"location_id"?: string | null,"organization_id"?: string,"product_id"?: string,"product_unit_id"?: string,"purchase_return_id"?: string,"quantity_returned"?: number,"returned_base"?: number,"stock_status"?: string,"unit_cost_base"?: number | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "purchase_return_lines_batch_fk"
      columns: ["batch_id","product_id","organization_id"]
isOneToOne: false
      referencedRelation: "batches"
      referencedColumns: ["id","product_id","organization_id"]
    },{
      foreignKeyName: "purchase_return_lines_location_id_fkey"
      columns: ["location_id"]
isOneToOne: false
      referencedRelation: "warehouse_locations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "purchase_return_lines_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "purchase_return_lines_product_fk"
      columns: ["product_id","organization_id"]
isOneToOne: false
      referencedRelation: "products"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "purchase_return_lines_return_fk"
      columns: ["purchase_return_id","organization_id"]
isOneToOne: false
      referencedRelation: "purchase_returns"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "purchase_return_lines_unit_fk"
      columns: ["product_unit_id","product_id","organization_id"]
isOneToOne: false
      referencedRelation: "product_units"
      referencedColumns: ["id","product_id","organization_id"]
    }
                  ]
                },"purchase_returns": {
                  Row: {
                    "branch_id": string,"credit_amount": number | null,"credit_note_number": string | null,"credit_status": string,"credited_at": string | null,"credited_by": string | null,"expected_credit": number,"id": string,"line_count": number,"notes": string | null,"organization_id": string,"purchase_order_id": string | null,"reason": string,"return_number": string,"returned_at": string,"returned_by": string | null,"stock_document_id": string,"supplier_id": string,"warehouse_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "branch_id": string,"credit_amount"?: number | null,"credit_note_number"?: string | null,"credit_status"?: string,"credited_at"?: string | null,"credited_by"?: string | null,"expected_credit"?: number,"id"?: string,"line_count": number,"notes"?: string | null,"organization_id": string,"purchase_order_id"?: string | null,"reason": string,"return_number": string,"returned_at"?: string,"returned_by"?: string | null,"stock_document_id": string,"supplier_id": string,"warehouse_id": string
                  }
                  Update: {
                    "branch_id"?: string,"credit_amount"?: number | null,"credit_note_number"?: string | null,"credit_status"?: string,"credited_at"?: string | null,"credited_by"?: string | null,"expected_credit"?: number,"id"?: string,"line_count"?: number,"notes"?: string | null,"organization_id"?: string,"purchase_order_id"?: string | null,"reason"?: string,"return_number"?: string,"returned_at"?: string,"returned_by"?: string | null,"stock_document_id"?: string,"supplier_id"?: string,"warehouse_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "purchase_returns_branch_fk"
      columns: ["branch_id","organization_id"]
isOneToOne: false
      referencedRelation: "branches"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "purchase_returns_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "purchase_returns_po_fk"
      columns: ["purchase_order_id","organization_id"]
isOneToOne: false
      referencedRelation: "purchase_orders"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "purchase_returns_stock_document_fk"
      columns: ["stock_document_id","organization_id"]
isOneToOne: false
      referencedRelation: "stock_documents"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "purchase_returns_supplier_fk"
      columns: ["supplier_id","organization_id"]
isOneToOne: false
      referencedRelation: "suppliers"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "purchase_returns_warehouse_fk"
      columns: ["warehouse_id","organization_id"]
isOneToOne: false
      referencedRelation: "warehouses"
      referencedColumns: ["id","organization_id"]
    }
                  ]
                },"receipt_allocations": {
                  Row: {
                    "amount": number,"branch_id": string,"created_at": string,"id": string,"is_voided": boolean,"organization_id": string,"receipt_id": string,"sales_invoice_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "amount": number,"branch_id": string,"created_at"?: string,"id"?: string,"is_voided"?: boolean,"organization_id": string,"receipt_id": string,"sales_invoice_id": string
                  }
                  Update: {
                    "amount"?: number,"branch_id"?: string,"created_at"?: string,"id"?: string,"is_voided"?: boolean,"organization_id"?: string,"receipt_id"?: string,"sales_invoice_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "receipt_allocations_invoice_fk"
      columns: ["sales_invoice_id","organization_id"]
isOneToOne: false
      referencedRelation: "sales_invoices"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "receipt_allocations_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "receipt_allocations_receipt_fk"
      columns: ["receipt_id","organization_id"]
isOneToOne: false
      referencedRelation: "customer_receipts"
      referencedColumns: ["id","organization_id"]
    }
                  ]
                },"role_permissions": {
                  Row: {
                    "permission_id": string,"role_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "permission_id": string,"role_id": string
                  }
                  Update: {
                    "permission_id"?: string,"role_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "role_permissions_permission_id_fkey"
      columns: ["permission_id"]
isOneToOne: false
      referencedRelation: "permissions"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "role_permissions_role_id_fkey"
      columns: ["role_id"]
isOneToOne: false
      referencedRelation: "roles"
      referencedColumns: ["id"]
    }
                  ]
                },"roles": {
                  Row: {
                    "code": string,"created_at": string,"description": string | null,"id": string,"is_active": boolean,"is_system_role": boolean,"name": string,"organization_id": string | null,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "code": string,"created_at"?: string,"description"?: string | null,"id"?: string,"is_active"?: boolean,"is_system_role"?: boolean,"name": string,"organization_id"?: string | null,"updated_at"?: string
                  }
                  Update: {
                    "code"?: string,"created_at"?: string,"description"?: string | null,"id"?: string,"is_active"?: boolean,"is_system_role"?: boolean,"name"?: string,"organization_id"?: string | null,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "roles_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"sales_credit_note_lines": {
                  Row: {
                    "base_quantity": number | null,"batch_id": string | null,"branch_id": string,"credit_note_id": string,"description": string | null,"id": string,"invoice_line_id": string,"line_net": number,"line_no": number,"line_tax": number,"line_total": number,"line_type": string,"organization_id": string,"product_id": string,"product_unit_id": string,"quantity": number | null,"return_condition": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "base_quantity"?: number | null,"batch_id"?: string | null,"branch_id": string,"credit_note_id": string,"description"?: string | null,"id"?: string,"invoice_line_id": string,"line_net": number,"line_no": number,"line_tax": number,"line_total": number,"line_type": string,"organization_id"?: string,"product_id": string,"product_unit_id": string,"quantity"?: number | null,"return_condition"?: string | null
                  }
                  Update: {
                    "base_quantity"?: number | null,"batch_id"?: string | null,"branch_id"?: string,"credit_note_id"?: string,"description"?: string | null,"id"?: string,"invoice_line_id"?: string,"line_net"?: number,"line_no"?: number,"line_tax"?: number,"line_total"?: number,"line_type"?: string,"organization_id"?: string,"product_id"?: string,"product_unit_id"?: string,"quantity"?: number | null,"return_condition"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "sales_credit_note_lines_batch_fk"
      columns: ["batch_id","product_id","organization_id"]
isOneToOne: false
      referencedRelation: "batches"
      referencedColumns: ["id","product_id","organization_id"]
    },{
      foreignKeyName: "sales_credit_note_lines_credit_note_fk"
      columns: ["credit_note_id","organization_id"]
isOneToOne: false
      referencedRelation: "sales_credit_notes"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "sales_credit_note_lines_invoice_line_fk"
      columns: ["invoice_line_id","organization_id"]
isOneToOne: false
      referencedRelation: "sales_invoice_lines"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "sales_credit_note_lines_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "sales_credit_note_lines_product_fk"
      columns: ["product_id","organization_id"]
isOneToOne: false
      referencedRelation: "products"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "sales_credit_note_lines_unit_fk"
      columns: ["product_unit_id","product_id","organization_id"]
isOneToOne: false
      referencedRelation: "product_units"
      referencedColumns: ["id","product_id","organization_id"]
    }
                  ]
                },"sales_credit_note_returns": {
                  Row: {
                    "base_quantity": number,"batch_id": string | null,"branch_id": string,"credit_note_id": string,"credit_note_line_id": string,"id": string,"invoice_allocation_id": string,"location_id": string | null,"organization_id": string,"product_id": string,"return_condition": string
                  }
                  ComputedFields: never
                  Insert: {
                    "base_quantity": number,"batch_id"?: string | null,"branch_id": string,"credit_note_id": string,"credit_note_line_id": string,"id"?: string,"invoice_allocation_id": string,"location_id"?: string | null,"organization_id": string,"product_id": string,"return_condition": string
                  }
                  Update: {
                    "base_quantity"?: number,"batch_id"?: string | null,"branch_id"?: string,"credit_note_id"?: string,"credit_note_line_id"?: string,"id"?: string,"invoice_allocation_id"?: string,"location_id"?: string | null,"organization_id"?: string,"product_id"?: string,"return_condition"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "sales_credit_note_returns_allocation_fk"
      columns: ["invoice_allocation_id","organization_id"]
isOneToOne: false
      referencedRelation: "sales_invoice_allocations"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "sales_credit_note_returns_batch_fk"
      columns: ["batch_id","product_id","organization_id"]
isOneToOne: false
      referencedRelation: "batches"
      referencedColumns: ["id","product_id","organization_id"]
    },{
      foreignKeyName: "sales_credit_note_returns_credit_note_fk"
      columns: ["credit_note_id","organization_id"]
isOneToOne: false
      referencedRelation: "sales_credit_notes"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "sales_credit_note_returns_line_fk"
      columns: ["credit_note_line_id","organization_id"]
isOneToOne: false
      referencedRelation: "sales_credit_note_lines"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "sales_credit_note_returns_location_id_fkey"
      columns: ["location_id"]
isOneToOne: false
      referencedRelation: "warehouse_locations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "sales_credit_note_returns_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"sales_credit_notes": {
                  Row: {
                    "applied_amount": number,"branch_id": string,"created_at": string,"created_by": string | null,"credit_date": string,"credit_note_number": string | null,"currency_code": string,"customer_id": string,"id": string,"notes": string | null,"organization_id": string,"posted_at": string | null,"posted_by": string | null,"reason_code": string,"refunded_amount": number,"reversal_document_id": string | null,"reversal_reason": string | null,"reversed_at": string | null,"reversed_by": string | null,"sales_invoice_id": string,"status": string,"status_reason": string | null,"stock_document_id": string | null,"subtotal": number,"tax_total": number,"total_amount": number,"unapplied_amount": number | null,"updated_at": string,"warehouse_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "applied_amount"?: number,"branch_id": string,"created_at"?: string,"created_by"?: string | null,"credit_date": string,"credit_note_number"?: string | null,"currency_code": string,"customer_id": string,"id"?: string,"notes"?: string | null,"organization_id"?: string,"posted_at"?: string | null,"posted_by"?: string | null,"reason_code": string,"refunded_amount"?: number,"reversal_document_id"?: string | null,"reversal_reason"?: string | null,"reversed_at"?: string | null,"reversed_by"?: string | null,"sales_invoice_id": string,"status"?: string,"status_reason"?: string | null,"stock_document_id"?: string | null,"subtotal"?: number,"tax_total"?: number,"total_amount"?: number,"unapplied_amount"?: never,"updated_at"?: string,"warehouse_id": string
                  }
                  Update: {
                    "applied_amount"?: number,"branch_id"?: string,"created_at"?: string,"created_by"?: string | null,"credit_date"?: string,"credit_note_number"?: string | null,"currency_code"?: string,"customer_id"?: string,"id"?: string,"notes"?: string | null,"organization_id"?: string,"posted_at"?: string | null,"posted_by"?: string | null,"reason_code"?: string,"refunded_amount"?: number,"reversal_document_id"?: string | null,"reversal_reason"?: string | null,"reversed_at"?: string | null,"reversed_by"?: string | null,"sales_invoice_id"?: string,"status"?: string,"status_reason"?: string | null,"stock_document_id"?: string | null,"subtotal"?: number,"tax_total"?: number,"total_amount"?: number,"unapplied_amount"?: never,"updated_at"?: string,"warehouse_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "sales_credit_notes_branch_fk"
      columns: ["branch_id","organization_id"]
isOneToOne: false
      referencedRelation: "branches"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "sales_credit_notes_customer_fk"
      columns: ["customer_id","organization_id"]
isOneToOne: false
      referencedRelation: "customers"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "sales_credit_notes_invoice_fk"
      columns: ["sales_invoice_id","organization_id"]
isOneToOne: false
      referencedRelation: "sales_invoices"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "sales_credit_notes_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "sales_credit_notes_reversal_document_fk"
      columns: ["reversal_document_id","organization_id"]
isOneToOne: false
      referencedRelation: "stock_documents"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "sales_credit_notes_stock_document_fk"
      columns: ["stock_document_id","organization_id"]
isOneToOne: false
      referencedRelation: "stock_documents"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "sales_credit_notes_warehouse_fk"
      columns: ["warehouse_id","organization_id"]
isOneToOne: false
      referencedRelation: "warehouses"
      referencedColumns: ["id","organization_id"]
    }
                  ]
                },"sales_invoice_allocations": {
                  Row: {
                    "base_quantity": number,"batch_id": string | null,"branch_id": string,"id": string,"location_id": string | null,"organization_id": string,"product_id": string,"sales_invoice_id": string,"sales_invoice_line_id": string,"unit_cost_base": number | null
                  }
                  ComputedFields: never
                  Insert: {
                    "base_quantity": number,"batch_id"?: string | null,"branch_id": string,"id"?: string,"location_id"?: string | null,"organization_id": string,"product_id": string,"sales_invoice_id": string,"sales_invoice_line_id": string,"unit_cost_base"?: number | null
                  }
                  Update: {
                    "base_quantity"?: number,"batch_id"?: string | null,"branch_id"?: string,"id"?: string,"location_id"?: string | null,"organization_id"?: string,"product_id"?: string,"sales_invoice_id"?: string,"sales_invoice_line_id"?: string,"unit_cost_base"?: number | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "sales_invoice_allocations_batch_fk"
      columns: ["batch_id","product_id","organization_id"]
isOneToOne: false
      referencedRelation: "batches"
      referencedColumns: ["id","product_id","organization_id"]
    },{
      foreignKeyName: "sales_invoice_allocations_invoice_fk"
      columns: ["sales_invoice_id","organization_id"]
isOneToOne: false
      referencedRelation: "sales_invoices"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "sales_invoice_allocations_line_fk"
      columns: ["sales_invoice_line_id","organization_id"]
isOneToOne: false
      referencedRelation: "sales_invoice_lines"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "sales_invoice_allocations_location_id_fkey"
      columns: ["location_id"]
isOneToOne: false
      referencedRelation: "warehouse_locations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "sales_invoice_allocations_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"sales_invoice_lines": {
                  Row: {
                    "base_quantity": number,"branch_id": string,"discount_percent": number,"id": string,"line_net": number,"line_no": number,"line_tax": number,"line_total": number,"list_price": number | null,"organization_id": string,"product_id": string,"product_unit_id": string,"quantity": number,"sales_invoice_id": string,"sales_order_line_id": string | null,"tax_code_id": string | null,"tax_rate": number,"unit_price": number
                  }
                  ComputedFields: never
                  Insert: {
                    "base_quantity": number,"branch_id": string,"discount_percent"?: number,"id"?: string,"line_net": number,"line_no": number,"line_tax": number,"line_total": number,"list_price"?: number | null,"organization_id"?: string,"product_id": string,"product_unit_id": string,"quantity": number,"sales_invoice_id": string,"sales_order_line_id"?: string | null,"tax_code_id"?: string | null,"tax_rate"?: number,"unit_price": number
                  }
                  Update: {
                    "base_quantity"?: number,"branch_id"?: string,"discount_percent"?: number,"id"?: string,"line_net"?: number,"line_no"?: number,"line_tax"?: number,"line_total"?: number,"list_price"?: number | null,"organization_id"?: string,"product_id"?: string,"product_unit_id"?: string,"quantity"?: number,"sales_invoice_id"?: string,"sales_order_line_id"?: string | null,"tax_code_id"?: string | null,"tax_rate"?: number,"unit_price"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "sales_invoice_lines_invoice_fk"
      columns: ["sales_invoice_id","organization_id"]
isOneToOne: false
      referencedRelation: "sales_invoices"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "sales_invoice_lines_order_line_fk"
      columns: ["sales_order_line_id","organization_id"]
isOneToOne: false
      referencedRelation: "sales_order_lines"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "sales_invoice_lines_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "sales_invoice_lines_product_fk"
      columns: ["product_id","organization_id"]
isOneToOne: false
      referencedRelation: "products"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "sales_invoice_lines_tax_fk"
      columns: ["tax_code_id","organization_id"]
isOneToOne: false
      referencedRelation: "tax_codes"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "sales_invoice_lines_unit_fk"
      columns: ["product_unit_id","product_id","organization_id"]
isOneToOne: false
      referencedRelation: "product_units"
      referencedColumns: ["id","product_id","organization_id"]
    }
                  ]
                },"sales_invoices": {
                  Row: {
                    "amount_credited": number,"amount_paid": number,"balance_due": number | null,"branch_id": string,"created_at": string,"created_by": string | null,"currency_code": string,"customer_id": string,"customer_reference": string | null,"discount_total": number,"due_date": string | null,"id": string,"invoice_date": string,"invoice_number": string | null,"is_opening": boolean,"notes": string | null,"organization_id": string,"override_reason": string | null,"payment_terms_days": number,"posted_at": string | null,"posted_by": string | null,"reversal_document_id": string | null,"reversal_reason": string | null,"reversed_at": string | null,"reversed_by": string | null,"sales_order_id": string | null,"status": string,"status_reason": string | null,"stock_document_id": string | null,"subtotal": number,"tax_total": number,"total_amount": number,"updated_at": string,"warehouse_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "amount_credited"?: number,"amount_paid"?: number,"balance_due"?: never,"branch_id": string,"created_at"?: string,"created_by"?: string | null,"currency_code": string,"customer_id": string,"customer_reference"?: string | null,"discount_total"?: number,"due_date"?: string | null,"id"?: string,"invoice_date": string,"invoice_number"?: string | null,"is_opening"?: boolean,"notes"?: string | null,"organization_id"?: string,"override_reason"?: string | null,"payment_terms_days"?: number,"posted_at"?: string | null,"posted_by"?: string | null,"reversal_document_id"?: string | null,"reversal_reason"?: string | null,"reversed_at"?: string | null,"reversed_by"?: string | null,"sales_order_id"?: string | null,"status"?: string,"status_reason"?: string | null,"stock_document_id"?: string | null,"subtotal"?: number,"tax_total"?: number,"total_amount"?: number,"updated_at"?: string,"warehouse_id": string
                  }
                  Update: {
                    "amount_credited"?: number,"amount_paid"?: number,"balance_due"?: never,"branch_id"?: string,"created_at"?: string,"created_by"?: string | null,"currency_code"?: string,"customer_id"?: string,"customer_reference"?: string | null,"discount_total"?: number,"due_date"?: string | null,"id"?: string,"invoice_date"?: string,"invoice_number"?: string | null,"is_opening"?: boolean,"notes"?: string | null,"organization_id"?: string,"override_reason"?: string | null,"payment_terms_days"?: number,"posted_at"?: string | null,"posted_by"?: string | null,"reversal_document_id"?: string | null,"reversal_reason"?: string | null,"reversed_at"?: string | null,"reversed_by"?: string | null,"sales_order_id"?: string | null,"status"?: string,"status_reason"?: string | null,"stock_document_id"?: string | null,"subtotal"?: number,"tax_total"?: number,"total_amount"?: number,"updated_at"?: string,"warehouse_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "sales_invoices_branch_fk"
      columns: ["branch_id","organization_id"]
isOneToOne: false
      referencedRelation: "branches"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "sales_invoices_customer_fk"
      columns: ["customer_id","organization_id"]
isOneToOne: false
      referencedRelation: "customers"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "sales_invoices_order_fk"
      columns: ["sales_order_id","organization_id"]
isOneToOne: false
      referencedRelation: "sales_orders"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "sales_invoices_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "sales_invoices_reversal_document_fk"
      columns: ["reversal_document_id","organization_id"]
isOneToOne: false
      referencedRelation: "stock_documents"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "sales_invoices_stock_document_fk"
      columns: ["stock_document_id","organization_id"]
isOneToOne: false
      referencedRelation: "stock_documents"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "sales_invoices_warehouse_fk"
      columns: ["warehouse_id","organization_id"]
isOneToOne: false
      referencedRelation: "warehouses"
      referencedColumns: ["id","organization_id"]
    }
                  ]
                },"sales_order_lines": {
                  Row: {
                    "base_quantity": number,"branch_id": string,"discount_percent": number,"id": string,"line_net": number,"line_no": number,"line_tax": number,"line_total": number,"list_price": number | null,"organization_id": string,"product_id": string,"product_unit_id": string,"quantity": number,"sales_order_id": string,"tax_code_id": string | null,"tax_rate": number,"unit_price": number
                  }
                  ComputedFields: never
                  Insert: {
                    "base_quantity": number,"branch_id": string,"discount_percent"?: number,"id"?: string,"line_net": number,"line_no": number,"line_tax": number,"line_total": number,"list_price"?: number | null,"organization_id"?: string,"product_id": string,"product_unit_id": string,"quantity": number,"sales_order_id": string,"tax_code_id"?: string | null,"tax_rate"?: number,"unit_price": number
                  }
                  Update: {
                    "base_quantity"?: number,"branch_id"?: string,"discount_percent"?: number,"id"?: string,"line_net"?: number,"line_no"?: number,"line_tax"?: number,"line_total"?: number,"list_price"?: number | null,"organization_id"?: string,"product_id"?: string,"product_unit_id"?: string,"quantity"?: number,"sales_order_id"?: string,"tax_code_id"?: string | null,"tax_rate"?: number,"unit_price"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "sales_order_lines_order_fk"
      columns: ["sales_order_id","organization_id"]
isOneToOne: false
      referencedRelation: "sales_orders"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "sales_order_lines_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "sales_order_lines_product_fk"
      columns: ["product_id","organization_id"]
isOneToOne: false
      referencedRelation: "products"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "sales_order_lines_tax_fk"
      columns: ["tax_code_id","organization_id"]
isOneToOne: false
      referencedRelation: "tax_codes"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "sales_order_lines_unit_fk"
      columns: ["product_unit_id","product_id","organization_id"]
isOneToOne: false
      referencedRelation: "product_units"
      referencedColumns: ["id","product_id","organization_id"]
    }
                  ]
                },"sales_orders": {
                  Row: {
                    "branch_id": string,"confirmed_at": string | null,"confirmed_by": string | null,"created_at": string,"created_by": string | null,"currency_code": string,"customer_id": string,"customer_reference": string | null,"discount_total": number,"id": string,"notes": string | null,"order_date": string,"order_number": string | null,"organization_id": string,"quotation_id": string | null,"required_date": string | null,"reserved_until": string | null,"status": string,"status_reason": string | null,"subtotal": number,"tax_total": number,"total_amount": number,"updated_at": string,"warehouse_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "branch_id": string,"confirmed_at"?: string | null,"confirmed_by"?: string | null,"created_at"?: string,"created_by"?: string | null,"currency_code": string,"customer_id": string,"customer_reference"?: string | null,"discount_total"?: number,"id"?: string,"notes"?: string | null,"order_date": string,"order_number"?: string | null,"organization_id"?: string,"quotation_id"?: string | null,"required_date"?: string | null,"reserved_until"?: string | null,"status"?: string,"status_reason"?: string | null,"subtotal"?: number,"tax_total"?: number,"total_amount"?: number,"updated_at"?: string,"warehouse_id": string
                  }
                  Update: {
                    "branch_id"?: string,"confirmed_at"?: string | null,"confirmed_by"?: string | null,"created_at"?: string,"created_by"?: string | null,"currency_code"?: string,"customer_id"?: string,"customer_reference"?: string | null,"discount_total"?: number,"id"?: string,"notes"?: string | null,"order_date"?: string,"order_number"?: string | null,"organization_id"?: string,"quotation_id"?: string | null,"required_date"?: string | null,"reserved_until"?: string | null,"status"?: string,"status_reason"?: string | null,"subtotal"?: number,"tax_total"?: number,"total_amount"?: number,"updated_at"?: string,"warehouse_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "sales_orders_branch_fk"
      columns: ["branch_id","organization_id"]
isOneToOne: false
      referencedRelation: "branches"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "sales_orders_customer_fk"
      columns: ["customer_id","organization_id"]
isOneToOne: false
      referencedRelation: "customers"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "sales_orders_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "sales_orders_quotation_fk"
      columns: ["quotation_id","organization_id"]
isOneToOne: false
      referencedRelation: "sales_quotations"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "sales_orders_warehouse_fk"
      columns: ["warehouse_id","organization_id"]
isOneToOne: false
      referencedRelation: "warehouses"
      referencedColumns: ["id","organization_id"]
    }
                  ]
                },"sales_quotation_lines": {
                  Row: {
                    "base_quantity": number,"branch_id": string,"discount_percent": number,"id": string,"line_net": number,"line_no": number,"line_tax": number,"line_total": number,"list_price": number | null,"organization_id": string,"product_id": string,"product_unit_id": string,"quantity": number,"quotation_id": string,"tax_code_id": string | null,"tax_rate": number,"unit_price": number
                  }
                  ComputedFields: never
                  Insert: {
                    "base_quantity": number,"branch_id": string,"discount_percent"?: number,"id"?: string,"line_net": number,"line_no": number,"line_tax": number,"line_total": number,"list_price"?: number | null,"organization_id"?: string,"product_id": string,"product_unit_id": string,"quantity": number,"quotation_id": string,"tax_code_id"?: string | null,"tax_rate"?: number,"unit_price": number
                  }
                  Update: {
                    "base_quantity"?: number,"branch_id"?: string,"discount_percent"?: number,"id"?: string,"line_net"?: number,"line_no"?: number,"line_tax"?: number,"line_total"?: number,"list_price"?: number | null,"organization_id"?: string,"product_id"?: string,"product_unit_id"?: string,"quantity"?: number,"quotation_id"?: string,"tax_code_id"?: string | null,"tax_rate"?: number,"unit_price"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "sales_quotation_lines_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "sales_quotation_lines_product_fk"
      columns: ["product_id","organization_id"]
isOneToOne: false
      referencedRelation: "products"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "sales_quotation_lines_quotation_fk"
      columns: ["quotation_id","organization_id"]
isOneToOne: false
      referencedRelation: "sales_quotations"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "sales_quotation_lines_tax_fk"
      columns: ["tax_code_id","organization_id"]
isOneToOne: false
      referencedRelation: "tax_codes"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "sales_quotation_lines_unit_fk"
      columns: ["product_unit_id","product_id","organization_id"]
isOneToOne: false
      referencedRelation: "product_units"
      referencedColumns: ["id","product_id","organization_id"]
    }
                  ]
                },"sales_quotations": {
                  Row: {
                    "branch_id": string,"converted_order_id": string | null,"created_at": string,"created_by": string | null,"currency_code": string,"customer_id": string,"customer_reference": string | null,"discount_total": number,"id": string,"notes": string | null,"organization_id": string,"quotation_date": string,"quotation_number": string | null,"sent_at": string | null,"status": string,"status_reason": string | null,"subtotal": number,"tax_total": number,"total_amount": number,"updated_at": string,"valid_until": string,"warehouse_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "branch_id": string,"converted_order_id"?: string | null,"created_at"?: string,"created_by"?: string | null,"currency_code": string,"customer_id": string,"customer_reference"?: string | null,"discount_total"?: number,"id"?: string,"notes"?: string | null,"organization_id"?: string,"quotation_date": string,"quotation_number"?: string | null,"sent_at"?: string | null,"status"?: string,"status_reason"?: string | null,"subtotal"?: number,"tax_total"?: number,"total_amount"?: number,"updated_at"?: string,"valid_until": string,"warehouse_id": string
                  }
                  Update: {
                    "branch_id"?: string,"converted_order_id"?: string | null,"created_at"?: string,"created_by"?: string | null,"currency_code"?: string,"customer_id"?: string,"customer_reference"?: string | null,"discount_total"?: number,"id"?: string,"notes"?: string | null,"organization_id"?: string,"quotation_date"?: string,"quotation_number"?: string | null,"sent_at"?: string | null,"status"?: string,"status_reason"?: string | null,"subtotal"?: number,"tax_total"?: number,"total_amount"?: number,"updated_at"?: string,"valid_until"?: string,"warehouse_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "sales_quotations_branch_fk"
      columns: ["branch_id","organization_id"]
isOneToOne: false
      referencedRelation: "branches"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "sales_quotations_customer_fk"
      columns: ["customer_id","organization_id"]
isOneToOne: false
      referencedRelation: "customers"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "sales_quotations_order_fk"
      columns: ["converted_order_id","organization_id"]
isOneToOne: false
      referencedRelation: "sales_orders"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "sales_quotations_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "sales_quotations_warehouse_fk"
      columns: ["warehouse_id","organization_id"]
isOneToOne: false
      referencedRelation: "warehouses"
      referencedColumns: ["id","organization_id"]
    }
                  ]
                },"stock_balances": {
                  Row: {
                    "batch_id": string | null,"id": string,"location_id": string | null,"organization_id": string,"product_id": string,"quantity": number,"stock_status": string,"updated_at": string,"warehouse_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "batch_id"?: string | null,"id"?: string,"location_id"?: string | null,"organization_id": string,"product_id": string,"quantity": number,"stock_status": string,"updated_at"?: string,"warehouse_id": string
                  }
                  Update: {
                    "batch_id"?: string | null,"id"?: string,"location_id"?: string | null,"organization_id"?: string,"product_id"?: string,"quantity"?: number,"stock_status"?: string,"updated_at"?: string,"warehouse_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "stock_balances_batch_fk"
      columns: ["batch_id","product_id","organization_id"]
isOneToOne: false
      referencedRelation: "batches"
      referencedColumns: ["id","product_id","organization_id"]
    },{
      foreignKeyName: "stock_balances_location_fk"
      columns: ["location_id","warehouse_id"]
isOneToOne: false
      referencedRelation: "warehouse_locations"
      referencedColumns: ["id","warehouse_id"]
    },{
      foreignKeyName: "stock_balances_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "stock_balances_product_fk"
      columns: ["product_id","organization_id"]
isOneToOne: false
      referencedRelation: "products"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "stock_balances_warehouse_fk"
      columns: ["warehouse_id","organization_id"]
isOneToOne: false
      referencedRelation: "warehouses"
      referencedColumns: ["id","organization_id"]
    }
                  ]
                },"stock_count_lines": {
                  Row: {
                    "batch_id": string | null,"branch_id": string,"counted_at": string | null,"counted_by": string | null,"counted_quantity": number | null,"id": string,"line_no": number,"location_id": string | null,"organization_id": string,"product_id": string,"stock_count_id": string,"stock_status": string,"system_quantity": number
                  }
                  ComputedFields: never
                  Insert: {
                    "batch_id"?: string | null,"branch_id": string,"counted_at"?: string | null,"counted_by"?: string | null,"counted_quantity"?: number | null,"id"?: string,"line_no": number,"location_id"?: string | null,"organization_id"?: string,"product_id": string,"stock_count_id": string,"stock_status": string,"system_quantity": number
                  }
                  Update: {
                    "batch_id"?: string | null,"branch_id"?: string,"counted_at"?: string | null,"counted_by"?: string | null,"counted_quantity"?: number | null,"id"?: string,"line_no"?: number,"location_id"?: string | null,"organization_id"?: string,"product_id"?: string,"stock_count_id"?: string,"stock_status"?: string,"system_quantity"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "stock_count_lines_batch_fk"
      columns: ["batch_id","product_id","organization_id"]
isOneToOne: false
      referencedRelation: "batches"
      referencedColumns: ["id","product_id","organization_id"]
    },{
      foreignKeyName: "stock_count_lines_count_fk"
      columns: ["stock_count_id","organization_id"]
isOneToOne: false
      referencedRelation: "stock_counts"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "stock_count_lines_location_id_fkey"
      columns: ["location_id"]
isOneToOne: false
      referencedRelation: "warehouse_locations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "stock_count_lines_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "stock_count_lines_product_fk"
      columns: ["product_id","organization_id"]
isOneToOne: false
      referencedRelation: "products"
      referencedColumns: ["id","organization_id"]
    }
                  ]
                },"stock_counts": {
                  Row: {
                    "adjustment_document_id": string | null,"approved_at": string | null,"approved_by": string | null,"branch_id": string,"count_number": string,"created_at": string,"created_by": string | null,"id": string,"line_count": number,"location_id": string | null,"notes": string | null,"organization_id": string,"status": string,"status_reason": string | null,"submitted_at": string | null,"submitted_by": string | null,"updated_at": string,"warehouse_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "adjustment_document_id"?: string | null,"approved_at"?: string | null,"approved_by"?: string | null,"branch_id": string,"count_number": string,"created_at"?: string,"created_by"?: string | null,"id"?: string,"line_count": number,"location_id"?: string | null,"notes"?: string | null,"organization_id"?: string,"status"?: string,"status_reason"?: string | null,"submitted_at"?: string | null,"submitted_by"?: string | null,"updated_at"?: string,"warehouse_id": string
                  }
                  Update: {
                    "adjustment_document_id"?: string | null,"approved_at"?: string | null,"approved_by"?: string | null,"branch_id"?: string,"count_number"?: string,"created_at"?: string,"created_by"?: string | null,"id"?: string,"line_count"?: number,"location_id"?: string | null,"notes"?: string | null,"organization_id"?: string,"status"?: string,"status_reason"?: string | null,"submitted_at"?: string | null,"submitted_by"?: string | null,"updated_at"?: string,"warehouse_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "stock_counts_adjustment_fk"
      columns: ["adjustment_document_id","organization_id"]
isOneToOne: false
      referencedRelation: "stock_documents"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "stock_counts_branch_fk"
      columns: ["branch_id","organization_id"]
isOneToOne: false
      referencedRelation: "branches"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "stock_counts_location_id_fkey"
      columns: ["location_id"]
isOneToOne: false
      referencedRelation: "warehouse_locations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "stock_counts_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "stock_counts_warehouse_fk"
      columns: ["warehouse_id","organization_id"]
isOneToOne: false
      referencedRelation: "warehouses"
      referencedColumns: ["id","organization_id"]
    }
                  ]
                },"stock_documents": {
                  Row: {
                    "branch_id": string,"document_number": string,"document_type": string,"id": string,"line_count": number,"notes": string | null,"organization_id": string,"posted_at": string,"posted_by": string | null,"reason_code": string | null,"source_id": string | null,"source_type": string | null,"to_warehouse_id": string | null,"warehouse_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "branch_id": string,"document_number": string,"document_type": string,"id"?: string,"line_count": number,"notes"?: string | null,"organization_id"?: string,"posted_at"?: string,"posted_by"?: string | null,"reason_code"?: string | null,"source_id"?: string | null,"source_type"?: string | null,"to_warehouse_id"?: string | null,"warehouse_id": string
                  }
                  Update: {
                    "branch_id"?: string,"document_number"?: string,"document_type"?: string,"id"?: string,"line_count"?: number,"notes"?: string | null,"organization_id"?: string,"posted_at"?: string,"posted_by"?: string | null,"reason_code"?: string | null,"source_id"?: string | null,"source_type"?: string | null,"to_warehouse_id"?: string | null,"warehouse_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "stock_documents_branch_fk"
      columns: ["branch_id","organization_id"]
isOneToOne: false
      referencedRelation: "branches"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "stock_documents_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "stock_documents_to_warehouse_fk"
      columns: ["to_warehouse_id","organization_id"]
isOneToOne: false
      referencedRelation: "warehouses"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "stock_documents_warehouse_fk"
      columns: ["warehouse_id","organization_id"]
isOneToOne: false
      referencedRelation: "warehouses"
      referencedColumns: ["id","organization_id"]
    }
                  ]
                },"stock_movements": {
                  Row: {
                    "batch_id": string | null,"document_id": string,"entered_quantity": number | null,"entered_unit_id": string | null,"id": string,"line_no": number,"location_id": string | null,"movement_type": string,"organization_id": string,"posted_at": string,"product_id": string,"quantity": number,"seq": number,"stock_status": string,"warehouse_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "batch_id"?: string | null,"document_id": string,"entered_quantity"?: number | null,"entered_unit_id"?: string | null,"id"?: string,"line_no": number,"location_id"?: string | null,"movement_type": string,"organization_id": string,"posted_at"?: string,"product_id": string,"quantity": number,"seq"?: never,"stock_status": string,"warehouse_id": string
                  }
                  Update: {
                    "batch_id"?: string | null,"document_id"?: string,"entered_quantity"?: number | null,"entered_unit_id"?: string | null,"id"?: string,"line_no"?: number,"location_id"?: string | null,"movement_type"?: string,"organization_id"?: string,"posted_at"?: string,"product_id"?: string,"quantity"?: number,"seq"?: never,"stock_status"?: string,"warehouse_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "stock_movements_batch_fk"
      columns: ["batch_id","product_id","organization_id"]
isOneToOne: false
      referencedRelation: "batches"
      referencedColumns: ["id","product_id","organization_id"]
    },{
      foreignKeyName: "stock_movements_document_fk"
      columns: ["document_id","organization_id"]
isOneToOne: false
      referencedRelation: "stock_documents"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "stock_movements_location_fk"
      columns: ["location_id","warehouse_id"]
isOneToOne: false
      referencedRelation: "warehouse_locations"
      referencedColumns: ["id","warehouse_id"]
    },{
      foreignKeyName: "stock_movements_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "stock_movements_product_fk"
      columns: ["product_id","organization_id"]
isOneToOne: false
      referencedRelation: "products"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "stock_movements_unit_fk"
      columns: ["entered_unit_id","product_id","organization_id"]
isOneToOne: false
      referencedRelation: "product_units"
      referencedColumns: ["id","product_id","organization_id"]
    },{
      foreignKeyName: "stock_movements_warehouse_fk"
      columns: ["warehouse_id","organization_id"]
isOneToOne: false
      referencedRelation: "warehouses"
      referencedColumns: ["id","organization_id"]
    }
                  ]
                },"stock_transfer_lines": {
                  Row: {
                    "batch_id": string | null,"dispatched_base": number,"from_branch_id": string,"id": string,"line_no": number,"organization_id": string,"product_id": string,"product_unit_id": string,"received_base": number,"returned_base": number,"short_base": number,"source_location_id": string | null,"source_status": string,"stock_transfer_id": string,"to_branch_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "batch_id"?: string | null,"dispatched_base": number,"from_branch_id": string,"id"?: string,"line_no": number,"organization_id": string,"product_id": string,"product_unit_id": string,"received_base"?: number,"returned_base"?: number,"short_base"?: number,"source_location_id"?: string | null,"source_status": string,"stock_transfer_id": string,"to_branch_id": string
                  }
                  Update: {
                    "batch_id"?: string | null,"dispatched_base"?: number,"from_branch_id"?: string,"id"?: string,"line_no"?: number,"organization_id"?: string,"product_id"?: string,"product_unit_id"?: string,"received_base"?: number,"returned_base"?: number,"short_base"?: number,"source_location_id"?: string | null,"source_status"?: string,"stock_transfer_id"?: string,"to_branch_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "stock_transfer_lines_batch_fk"
      columns: ["batch_id","product_id","organization_id"]
isOneToOne: false
      referencedRelation: "batches"
      referencedColumns: ["id","product_id","organization_id"]
    },{
      foreignKeyName: "stock_transfer_lines_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "stock_transfer_lines_product_fk"
      columns: ["product_id","organization_id"]
isOneToOne: false
      referencedRelation: "products"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "stock_transfer_lines_source_location_id_fkey"
      columns: ["source_location_id"]
isOneToOne: false
      referencedRelation: "warehouse_locations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "stock_transfer_lines_transfer_fk"
      columns: ["stock_transfer_id","organization_id"]
isOneToOne: false
      referencedRelation: "stock_transfers"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "stock_transfer_lines_unit_fk"
      columns: ["product_unit_id","product_id","organization_id"]
isOneToOne: false
      referencedRelation: "product_units"
      referencedColumns: ["id","product_id","organization_id"]
    }
                  ]
                },"stock_transfers": {
                  Row: {
                    "dispatch_document_id": string,"dispatched_at": string,"dispatched_by": string | null,"from_branch_id": string,"from_warehouse_id": string,"id": string,"line_count": number,"notes": string | null,"organization_id": string,"status": string,"status_reason": string | null,"to_branch_id": string,"to_warehouse_id": string,"transfer_number": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "dispatch_document_id": string,"dispatched_at"?: string,"dispatched_by"?: string | null,"from_branch_id": string,"from_warehouse_id": string,"id"?: string,"line_count": number,"notes"?: string | null,"organization_id": string,"status"?: string,"status_reason"?: string | null,"to_branch_id": string,"to_warehouse_id": string,"transfer_number": string,"updated_at"?: string
                  }
                  Update: {
                    "dispatch_document_id"?: string,"dispatched_at"?: string,"dispatched_by"?: string | null,"from_branch_id"?: string,"from_warehouse_id"?: string,"id"?: string,"line_count"?: number,"notes"?: string | null,"organization_id"?: string,"status"?: string,"status_reason"?: string | null,"to_branch_id"?: string,"to_warehouse_id"?: string,"transfer_number"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "stock_transfers_dispatch_doc_fk"
      columns: ["dispatch_document_id","organization_id"]
isOneToOne: false
      referencedRelation: "stock_documents"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "stock_transfers_from_branch_fk"
      columns: ["from_branch_id","organization_id"]
isOneToOne: false
      referencedRelation: "branches"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "stock_transfers_from_wh_fk"
      columns: ["from_warehouse_id","organization_id"]
isOneToOne: false
      referencedRelation: "warehouses"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "stock_transfers_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "stock_transfers_to_branch_fk"
      columns: ["to_branch_id","organization_id"]
isOneToOne: false
      referencedRelation: "branches"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "stock_transfers_to_wh_fk"
      columns: ["to_warehouse_id","organization_id"]
isOneToOne: false
      referencedRelation: "warehouses"
      referencedColumns: ["id","organization_id"]
    }
                  ]
                },"supplier_invoice_lines": {
                  Row: {
                    "allowed_quantity": number,"branch_id": string,"id": string,"line_no": number,"line_total": number | null,"match_status": string,"organization_id": string,"po_line_id": string,"po_unit_cost": number,"product_id": string,"quantity": number,"supplier_invoice_id": string,"unit_price": number
                  }
                  ComputedFields: never
                  Insert: {
                    "allowed_quantity": number,"branch_id": string,"id"?: string,"line_no": number,"line_total"?: never,"match_status": string,"organization_id"?: string,"po_line_id": string,"po_unit_cost": number,"product_id": string,"quantity": number,"supplier_invoice_id": string,"unit_price": number
                  }
                  Update: {
                    "allowed_quantity"?: number,"branch_id"?: string,"id"?: string,"line_no"?: number,"line_total"?: never,"match_status"?: string,"organization_id"?: string,"po_line_id"?: string,"po_unit_cost"?: number,"product_id"?: string,"quantity"?: number,"supplier_invoice_id"?: string,"unit_price"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "supplier_invoice_lines_invoice_fk"
      columns: ["supplier_invoice_id","organization_id"]
isOneToOne: false
      referencedRelation: "supplier_invoices"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "supplier_invoice_lines_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "supplier_invoice_lines_po_line_fk"
      columns: ["po_line_id","organization_id"]
isOneToOne: false
      referencedRelation: "purchase_order_lines"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "supplier_invoice_lines_product_fk"
      columns: ["product_id","organization_id"]
isOneToOne: false
      referencedRelation: "products"
      referencedColumns: ["id","organization_id"]
    }
                  ]
                },"supplier_invoices": {
                  Row: {
                    "approved_at": string | null,"approved_by": string | null,"branch_id": string,"created_at": string,"created_by": string | null,"currency_code": string,"due_date": string,"id": string,"invoice_date": string,"invoice_number": string,"is_opening": boolean,"notes": string | null,"organization_id": string,"paid_by": string | null,"paid_on": string | null,"payment_reference": string | null,"purchase_order_id": string | null,"status": string,"status_reason": string | null,"subtotal": number,"supplier_id": string,"supplier_invoice_number": string,"tax_amount": number,"total_amount": number,"updated_at": string,"variance_reason": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "approved_at"?: string | null,"approved_by"?: string | null,"branch_id": string,"created_at"?: string,"created_by"?: string | null,"currency_code": string,"due_date": string,"id"?: string,"invoice_date": string,"invoice_number": string,"is_opening"?: boolean,"notes"?: string | null,"organization_id"?: string,"paid_by"?: string | null,"paid_on"?: string | null,"payment_reference"?: string | null,"purchase_order_id"?: string | null,"status"?: string,"status_reason"?: string | null,"subtotal"?: number,"supplier_id": string,"supplier_invoice_number": string,"tax_amount"?: number,"total_amount"?: number,"updated_at"?: string,"variance_reason"?: string | null
                  }
                  Update: {
                    "approved_at"?: string | null,"approved_by"?: string | null,"branch_id"?: string,"created_at"?: string,"created_by"?: string | null,"currency_code"?: string,"due_date"?: string,"id"?: string,"invoice_date"?: string,"invoice_number"?: string,"is_opening"?: boolean,"notes"?: string | null,"organization_id"?: string,"paid_by"?: string | null,"paid_on"?: string | null,"payment_reference"?: string | null,"purchase_order_id"?: string | null,"status"?: string,"status_reason"?: string | null,"subtotal"?: number,"supplier_id"?: string,"supplier_invoice_number"?: string,"tax_amount"?: number,"total_amount"?: number,"updated_at"?: string,"variance_reason"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "supplier_invoices_branch_fk"
      columns: ["branch_id","organization_id"]
isOneToOne: false
      referencedRelation: "branches"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "supplier_invoices_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "supplier_invoices_po_fk"
      columns: ["purchase_order_id","organization_id"]
isOneToOne: false
      referencedRelation: "purchase_orders"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "supplier_invoices_supplier_fk"
      columns: ["supplier_id","organization_id"]
isOneToOne: false
      referencedRelation: "suppliers"
      referencedColumns: ["id","organization_id"]
    }
                  ]
                },"supplier_products": {
                  Row: {
                    "created_at": string,"id": string,"is_active": boolean,"is_preferred": boolean,"last_cost": number | null,"last_cost_at": string | null,"lead_time_days": number | null,"min_order_quantity": number | null,"organization_id": string,"product_id": string,"product_unit_id": string,"supplier_id": string,"supplier_product_name": string | null,"supplier_sku": string | null,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"id"?: string,"is_active"?: boolean,"is_preferred"?: boolean,"last_cost"?: number | null,"last_cost_at"?: string | null,"lead_time_days"?: number | null,"min_order_quantity"?: number | null,"organization_id"?: string,"product_id": string,"product_unit_id": string,"supplier_id": string,"supplier_product_name"?: string | null,"supplier_sku"?: string | null,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"is_active"?: boolean,"is_preferred"?: boolean,"last_cost"?: number | null,"last_cost_at"?: string | null,"lead_time_days"?: number | null,"min_order_quantity"?: number | null,"organization_id"?: string,"product_id"?: string,"product_unit_id"?: string,"supplier_id"?: string,"supplier_product_name"?: string | null,"supplier_sku"?: string | null,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "supplier_products_supplier_fk"
      columns: ["supplier_id","organization_id"]
isOneToOne: false
      referencedRelation: "suppliers"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "supplier_products_unit_fk"
      columns: ["product_unit_id","product_id","organization_id"]
isOneToOne: false
      referencedRelation: "product_units"
      referencedColumns: ["id","product_id","organization_id"]
    }
                  ]
                },"suppliers": {
                  Row: {
                    "address": string | null,"city": string | null,"code": string,"contact_name": string | null,"country": string | null,"created_at": string,"currency_code": string | null,"email": string | null,"id": string,"is_active": boolean,"licence_expiry": string | null,"licence_number": string | null,"name": string,"notes": string | null,"organization_id": string,"payment_terms_days": number,"phone": string | null,"region": string | null,"registration_number": string | null,"supplier_type": string,"tax_number": string | null,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "address"?: string | null,"city"?: string | null,"code": string,"contact_name"?: string | null,"country"?: string | null,"created_at"?: string,"currency_code"?: string | null,"email"?: string | null,"id"?: string,"is_active"?: boolean,"licence_expiry"?: string | null,"licence_number"?: string | null,"name": string,"notes"?: string | null,"organization_id"?: string,"payment_terms_days"?: number,"phone"?: string | null,"region"?: string | null,"registration_number"?: string | null,"supplier_type"?: string,"tax_number"?: string | null,"updated_at"?: string
                  }
                  Update: {
                    "address"?: string | null,"city"?: string | null,"code"?: string,"contact_name"?: string | null,"country"?: string | null,"created_at"?: string,"currency_code"?: string | null,"email"?: string | null,"id"?: string,"is_active"?: boolean,"licence_expiry"?: string | null,"licence_number"?: string | null,"name"?: string,"notes"?: string | null,"organization_id"?: string,"payment_terms_days"?: number,"phone"?: string | null,"region"?: string | null,"registration_number"?: string | null,"supplier_type"?: string,"tax_number"?: string | null,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "suppliers_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"system_settings": {
                  Row: {
                    "branch_id": string | null,"category": string,"created_at": string,"description": string | null,"id": string,"key": string,"organization_id": string,"updated_at": string,"updated_by": string | null,"value": NonNullable<Json>
                  }
                  ComputedFields: never
                  Insert: {
                    "branch_id"?: string | null,"category": string,"created_at"?: string,"description"?: string | null,"id"?: string,"key": string,"organization_id"?: string,"updated_at"?: string,"updated_by"?: string | null,"value": NonNullable<Json>
                  }
                  Update: {
                    "branch_id"?: string | null,"category"?: string,"created_at"?: string,"description"?: string | null,"id"?: string,"key"?: string,"organization_id"?: string,"updated_at"?: string,"updated_by"?: string | null,"value"?: NonNullable<Json>
                  }
                  Relationships: [
                    {
      foreignKeyName: "system_settings_branch_fk"
      columns: ["branch_id","organization_id"]
isOneToOne: false
      referencedRelation: "branches"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "system_settings_org_fk"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"tax_codes": {
                  Row: {
                    "code": string,"created_at": string,"id": string,"is_active": boolean,"is_default": boolean,"name": string,"organization_id": string,"rate": number,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "code": string,"created_at"?: string,"id"?: string,"is_active"?: boolean,"is_default"?: boolean,"name": string,"organization_id"?: string,"rate": number,"updated_at"?: string
                  }
                  Update: {
                    "code"?: string,"created_at"?: string,"id"?: string,"is_active"?: boolean,"is_default"?: boolean,"name"?: string,"organization_id"?: string,"rate"?: number,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "tax_codes_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"units_of_measure": {
                  Row: {
                    "code": string,"id": string,"is_active": boolean,"kind": string,"name": string
                  }
                  ComputedFields: never
                  Insert: {
                    "code": string,"id"?: string,"is_active"?: boolean,"kind": string,"name": string
                  }
                  Update: {
                    "code"?: string,"id"?: string,"is_active"?: boolean,"kind"?: string,"name"?: string
                  }
                  Relationships: [
                    
                  ]
                },"user_roles": {
                  Row: {
                    "branch_id": string | null,"created_at": string,"created_by": string | null,"id": string,"organization_id": string,"role_id": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "branch_id"?: string | null,"created_at"?: string,"created_by"?: string | null,"id"?: string,"organization_id": string,"role_id": string,"user_id": string
                  }
                  Update: {
                    "branch_id"?: string | null,"created_at"?: string,"created_by"?: string | null,"id"?: string,"organization_id"?: string,"role_id"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "user_roles_branch_fk"
      columns: ["branch_id","organization_id"]
isOneToOne: false
      referencedRelation: "branches"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "user_roles_profile_fk"
      columns: ["user_id","organization_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "user_roles_role_id_fkey"
      columns: ["role_id"]
isOneToOne: false
      referencedRelation: "roles"
      referencedColumns: ["id"]
    }
                  ]
                },"vehicles": {
                  Row: {
                    "branch_id": string,"capacity_kg": number | null,"capacity_packages": number | null,"created_at": string,"id": string,"insurance_expiry": string | null,"is_active": boolean,"name": string | null,"notes": string | null,"organization_id": string,"refrigerated": boolean,"registration_number": string,"roadworthy_expiry": string | null,"updated_at": string,"vehicle_type": string
                  }
                  ComputedFields: never
                  Insert: {
                    "branch_id": string,"capacity_kg"?: number | null,"capacity_packages"?: number | null,"created_at"?: string,"id"?: string,"insurance_expiry"?: string | null,"is_active"?: boolean,"name"?: string | null,"notes"?: string | null,"organization_id"?: string,"refrigerated"?: boolean,"registration_number": string,"roadworthy_expiry"?: string | null,"updated_at"?: string,"vehicle_type"?: string
                  }
                  Update: {
                    "branch_id"?: string,"capacity_kg"?: number | null,"capacity_packages"?: number | null,"created_at"?: string,"id"?: string,"insurance_expiry"?: string | null,"is_active"?: boolean,"name"?: string | null,"notes"?: string | null,"organization_id"?: string,"refrigerated"?: boolean,"registration_number"?: string,"roadworthy_expiry"?: string | null,"updated_at"?: string,"vehicle_type"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "vehicles_branch_fk"
      columns: ["branch_id","organization_id"]
isOneToOne: false
      referencedRelation: "branches"
      referencedColumns: ["id","organization_id"]
    },{
      foreignKeyName: "vehicles_organization_id_fkey"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"warehouse_locations": {
                  Row: {
                    "aisle": string | null,"bin": string | null,"code": string,"created_at": string,"description": string | null,"id": string,"is_active": boolean,"organization_id": string,"picking_sequence": number,"rack": string | null,"shelf": string | null,"updated_at": string,"warehouse_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "aisle"?: string | null,"bin"?: string | null,"code": string,"created_at"?: string,"description"?: string | null,"id"?: string,"is_active"?: boolean,"organization_id"?: string,"picking_sequence"?: number,"rack"?: string | null,"shelf"?: string | null,"updated_at"?: string,"warehouse_id": string
                  }
                  Update: {
                    "aisle"?: string | null,"bin"?: string | null,"code"?: string,"created_at"?: string,"description"?: string | null,"id"?: string,"is_active"?: boolean,"organization_id"?: string,"picking_sequence"?: number,"rack"?: string | null,"shelf"?: string | null,"updated_at"?: string,"warehouse_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "warehouse_locations_warehouse_fk"
      columns: ["warehouse_id","organization_id"]
isOneToOne: false
      referencedRelation: "warehouses"
      referencedColumns: ["id","organization_id"]
    }
                  ]
                },"warehouses": {
                  Row: {
                    "branch_id": string,"code": string,"created_at": string,"description": string | null,"id": string,"is_active": boolean,"name": string,"organization_id": string,"updated_at": string,"warehouse_type": Database["public"]['Enums']["warehouse_type"]
                  }
                  ComputedFields: never
                  Insert: {
                    "branch_id": string,"code": string,"created_at"?: string,"description"?: string | null,"id"?: string,"is_active"?: boolean,"name": string,"organization_id"?: string,"updated_at"?: string,"warehouse_type"?: Database["public"]['Enums']["warehouse_type"]
                  }
                  Update: {
                    "branch_id"?: string,"code"?: string,"created_at"?: string,"description"?: string | null,"id"?: string,"is_active"?: boolean,"name"?: string,"organization_id"?: string,"updated_at"?: string,"warehouse_type"?: Database["public"]['Enums']["warehouse_type"]
                  }
                  Relationships: [
                    {
      foreignKeyName: "warehouses_branch_fk"
      columns: ["branch_id","organization_id"]
isOneToOne: false
      referencedRelation: "branches"
      referencedColumns: ["id","organization_id"]
    }
                  ]
                }
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            platform_operator_access: { Args: Record<string, never>; Returns: boolean }
            platform_tenants: { Args: { p_page?: number }; Returns: { id: string; name: string; is_active: boolean; currency_code: string; country: string; created_at: string }[] }
            onboard_tenant: { Args: { p_request_id: string; p_owner_user_id: string; p_first_name: string; p_last_name: string; p_name: string; p_currency?: string; p_timezone?: string; p_country?: string }; Returns: string }
            submit_expense: { Args: { p_branch: string; p_date: string; p_payee: string; p_description: string; p_reference: string; p_expense_account: string; p_credit_account: string; p_amount: number }; Returns: string }
            decide_expense: { Args: { p_id: string; p_action: string; p_note: string }; Returns: string | null }
            create_price_agreement: { Args: { p_customer: string; p_unit: string; p_price: number; p_from: string; p_until: string; p_reason: string }; Returns: string }
            cancel_price_agreement: { Args: { p_id: string; p_reason: string }; Returns: undefined }
            record_supplier_quotation: { Args: { p_supplier: string; p_warehouse: string; p_reference: string; p_valid_until: string; p_notes: string; p_lines: Json }; Returns: string }
            convert_supplier_quotation: { Args: { p_id: string }; Returns: string }
            cancel_supplier_quotation: { Args: { p_id: string }; Returns: undefined }
            procurement_insights: { Args: { p_from: string; p_to: string; p_branch: string | null }; Returns: { supplier_id: string; supplier_name: string; currency_code: string; orders: number; ordered_value: number; open_orders: number; overdue_orders: number }[] }
            crm_workspace: { Args: { p_kind: string; p_page: number }; Returns: Json }
            save_crm_record: { Args: { p_kind: string; p_id: string | null; p_data: Json }; Returns: string }
            create_purchase_request: { Args: { p_branch_id: string; p_warehouse_id: string | null; p_needed_by: string | null; p_notes: string; p_lines: Json }; Returns: string }
            submit_purchase_request: { Args: { p_id: string }; Returns: undefined }
            decide_purchase_request: { Args: { p_id: string; p_approve: boolean; p_note: string }; Returns: undefined }
            convert_purchase_request: { Args: { p_id: string; p_supplier: string; p_warehouse: string; p_costs: Json }; Returns: string }
            cancel_purchase_request: { Args: { p_id: string; p_note: string }; Returns: undefined }
            recall_customer_exposure: {
              Args: { p_recall_id: string }
              Returns: { invoice_id: string; invoice_number: string; customer_id: string; customer_name: string; contact_name: string | null; phone: string | null; email: string | null; batch_id: string; batch_number: string; product_name: string; quantity: number; source: string; delivery_status: string }[]
            }
            submit_batch_substitution: {
              Args: { p_exception_id: string; p_substitute_batch_id: string; p_reason: string; p_stock_balance_id?: string }
              Returns: string
            }
            create_recall: { Args: { p_source: string; p_class: string; p_title: string; p_instructions: string }; Returns: string }
            close_recall: { Args: { p_recall_id: string }; Returns: undefined }
            cancel_recall: { Args: { p_recall_id: string; p_reason: string }; Returns: undefined }
            release_recall_batch: { Args: { p_scope_id: string; p_reason: string }; Returns: Json }
            record_recall_recovery: { Args: { p_scope_id: string; p_invoice_id: string; p_quantity: number; p_status: string; p_notes: string }; Returns: string }
            add_recall_batch: { Args: { p_recall_id: string; p_batch_id: string }; Returns: string }
            quarantine_recall_batch: { Args: { p_scope_id: string; p_reason: string }; Returns: Json }
            recall_batch_options: { Args: Record<string, never>; Returns: { id: string; batch_number: string; product_name: string; sku: string; expiry_date: string }[] }
            create_delivery_run: { Args: { p_branch_id: string; p_driver_id: string; p_vehicle_id: string; p_date: string }; Returns: string },
            add_run_stop: { Args: { p_run_id: string; p_note_id: string; p_weight_kg: number }; Returns: string },
            remove_run_stop: { Args: { p_id: string; p_reason: string }; Returns: undefined },
            reorder_run_stops: { Args: { p_id: string; p_stops: string[] }; Returns: undefined },
            start_run_loading: { Args: { p_id: string }; Returns: undefined },
            load_run_stop: { Args: { p_id: string; p_packages: number }; Returns: undefined },
            dispatch_delivery_run: { Args: { p_id: string }; Returns: undefined },
            record_run_outcome: { Args: { p_id: string; p_delivered: boolean; p_receiver: string; p_reason: string }; Returns: undefined },
            return_run_stop: { Args: { p_id: string }; Returns: undefined },
            cancel_delivery_run: { Args: { p_id: string; p_reason: string }; Returns: undefined },
            delivery_run_list: { Args: Record<PropertyKey, never>; Returns: Json },
            delivery_run_detail: { Args: { p_id: string }; Returns: Json },
            run_planning_options: { Args: { p_branch_id: string }; Returns: Json },
            link_driver_profile: { Args: { p_driver_id: string; p_profile_id: string | null }; Returns: undefined },
            driver_profile_options: { Args: { p_driver_id: string }; Returns: { id: string; name: string }[] },
            start_packing: { Args: { p_id: string }; Returns: undefined },
            create_package: { Args: { p_id: string; p_kind: string; p_cold_chain?: boolean; p_fragile?: boolean }; Returns: string },
            pack_line: { Args: { p_package_id: string; p_line_id: string; p_quantity: number; p_batch_id?: string }; Returns: undefined },
            void_package: { Args: { p_id: string; p_reason: string }; Returns: undefined },
            verify_packed_line: { Args: { p_id: string }; Returns: undefined },
            finish_packing: { Args: { p_id: string }; Returns: undefined },
            packing_detail: { Args: { p_id: string }; Returns: Json },
            packed_dispatch_queue: { Args: Record<PropertyKey, never>; Returns: { id: string }[] },
            prepare_packed_delivery: { Args: { p_id: string; p_address: string; p_contact_name: string; p_contact_phone: string; p_notes: string }; Returns: string },
            ship_short_fulfilment_order: { Args: { p_exception_id: string; p_reason: string }; Returns: string },
            hold_fulfilment_order: { Args: { p_id: string; p_reason: string }; Returns: undefined },
            release_fulfilment_hold: { Args: { p_id: string }; Returns: undefined },
            substitution_batch_options: { Args: { p_exception_id: string }; Returns: { id: string; batch_number: string; expiry_date: string; available_quantity: number; is_controlled: boolean; stock_balance_id: string; location_code: string }[] },
            request_controlled_batch_substitution: { Args: { p_reason: string; p_substitution_id: string }; Returns: string },
            request_batch_substitution: { Args: { p_exception_id: string; p_substitute_batch_id: string; p_reason: string }; Returns: string },
            approve_batch_substitution: { Args: { p_id: string }; Returns: Json },
            "account_ledger":
{ Args: { "p_account_id": string,"p_branch_id"?: string,"p_from": string,"p_limit"?: number,"p_to": string }; Returns: {
              "credit": number,"debit": number,"description": string,"journal_date": string,"journal_id": string,"journal_number": string,"line_id": string,"memo": string,"running": number
            }[]
                           },
"accounting_checks":
{ Args: Record<PropertyKey, never>; Returns: {
              "check_code": string,"difference": number,"label": string,"ledger": number,"operational": number
            }[]
                           },
"allocate_receipt":
{ Args: { "p_allocations"?: Json,"p_receipt_id": string }; Returns: Json
                           },
"app_settings":
{ Args: { "p_branch_id"?: string }; Returns: Json
                           },
"apply_credit_note":
{ Args: { "p_allocations"?: Json,"p_id": string }; Returns: Json
                           },
"approve_controlled_adjustment":
{ Args: { "p_id": string }; Returns: Json
                           },
"approve_purchase_order":
{ Args: { "p_id": string }; Returns: undefined
                           },
"approve_stock_count":
{ Args: { "p_id": string }; Returns: Json
                           },
"approve_supplier_invoice":
{ Args: { "p_id": string,"p_variance_reason"?: string }; Returns: undefined
                           },
"assign_picker":
{ Args: { "p_id": string,"p_user": string }; Returns: undefined
                           },
"assign_user_role":
{ Args: { "p_branch_id"?: string,"p_reason"?: string,"p_role_id": string,"p_user_id": string }; Returns: string
                           },
"auto_match_statement":
{ Args: { "p_statement_id": string }; Returns: number
                           },
"balance_sheet":
{ Args: { "p_as_of": string,"p_branch_id"?: string }; Returns: {
              "account_id": string,"amount": number,"code": string,"name": string,"section": string
            }[]
                           },
"bank_ledger_lines":
{ Args: { "p_bank_account_id": string,"p_from"?: string,"p_only_open"?: boolean,"p_to"?: string }; Returns: {
              "amount": number,"cleared": boolean,"description": string,"journal_date": string,"journal_id": string,"journal_line_id": string,"journal_number": string,"memo": string,"note": string
            }[]
                           },
"bank_reconciliation":
{ Args: { "p_statement_id": string }; Returns: {
              "amount": number,"item": string,"label": string
            }[]
                           },
"cancel_controlled_adjustment":
{ Args: { "p_id": string }; Returns: undefined
                           },
"cancel_credit_note":
{ Args: { "p_id": string,"p_reason": string }; Returns: undefined
                           },
"cancel_delivery_note":
{ Args: { "p_id": string,"p_reason": string }; Returns: undefined
                           },
"cancel_fulfilment_order":
{ Args: { "p_id": string,"p_reason": string }; Returns: undefined
                           },
"cancel_purchase_order":
{ Args: { "p_id": string,"p_reason": string }; Returns: undefined
                           },
"cancel_quotation":
{ Args: { "p_id": string,"p_reason": string }; Returns: undefined
                           },
"cancel_sales_invoice":
{ Args: { "p_id": string,"p_reason": string }; Returns: undefined
                           },
"cancel_sales_order":
{ Args: { "p_id": string,"p_reason": string }; Returns: undefined
                           },
"cancel_stock_count":
{ Args: { "p_id": string,"p_reason": string }; Returns: undefined
                           },
"cancel_supplier_invoice":
{ Args: { "p_id": string,"p_reason": string }; Returns: undefined
                           },
"cancel_transfer":
{ Args: { "p_id": string,"p_reason": string }; Returns: Json
                           },
"claim_fulfilment_order":
{ Args: { "p_id": string }; Returns: undefined
                           },
"clear_ledger_lines":
{ Args: { "p_bank_account_id": string,"p_journal_line_ids": (string)[],"p_note": string }; Returns: number
                           },
"close_pos_session":
{ Args: { "p_counted_cash": number,"p_id": string,"p_notes"?: string }; Returns: Json
                           },
"close_purchase_order":
{ Args: { "p_id": string,"p_reason": string }; Returns: undefined
                           },
"close_sales_order":
{ Args: { "p_id": string,"p_reason": string }; Returns: undefined
                           },
"close_transfer":
{ Args: { "p_id": string,"p_reason": string }; Returns: undefined
                           },
"complete_invitation":
{ Args: { "p_actor_id": string,"p_branch_id"?: string,"p_first_name": string,"p_job_title"?: string,"p_last_name": string,"p_organization_id": string,"p_role_id": string,"p_user_id": string }; Returns: undefined
                           },
"configure_document_numbering":
{ Args: { "p_document_type": string,"p_padding": number,"p_prefix": string,"p_reset_period": string }; Returns: undefined
                           },
"confirm_delivery":
{ Args: { "p_id": string,"p_notes"?: string,"p_received_by_name": string }; Returns: undefined
                           },
"confirm_pick_line":
{ Args: { "p_line_id": string,"p_quantity": number,"p_scanned_barcode"?: string,"p_scanned_batch"?: string,"p_short_note"?: string,"p_short_reason"?: string }; Returns: Json
                           },
"confirm_sales_order":
{ Args: { "p_id": string }; Returns: Json
                           },
"controlled_drug_register":
{ Args: { "p_from": string,"p_product_id": string,"p_to": string,"p_warehouse_id"?: string }; Returns: {
              "balance": number,"batch_number": string,"counterparty": string,"document_number": string,"document_type": string,"expiry_date": string,"is_opening": boolean,"licence_number": string,"line_no": number,"movement_type": string,"notes": string,"posted_at": string,"posted_by_name": string,"quantity": number,"reference": string,"stock_status": string,"warehouse_name": string
            }[]
                           },
"controlled_drug_summary":
{ Args: { "p_from": string,"p_to": string,"p_warehouse_id"?: string }; Returns: {
              "adjusted": number,"closing": number,"issued": number,"opening": number,"product_id": string,"product_name": string,"received": number,"sku": string
            }[]
                           },
"convert_quotation_to_order":
{ Args: { "p_id": string }; Returns: string
                           },
"create_bank_account":
{ Args: { "p_account_ref"?: string,"p_bank_name"?: string,"p_name": string }; Returns: string
                           },
"customer_credit":
{ Args: { "p_customer_id": string }; Returns: {
              "available": number,"credit_held": number,"credit_limit": number,"on_hold": boolean,"outstanding": number,"overdue": number
            }[]
                           },
"customer_statement":
{ Args: { "p_customer_id": string,"p_from"?: string }; Returns: {
              "balance": number,"credit": number,"debit": number,"description": string,"entry_date": string,"entry_type": string,"reference": string
            }[]
                           },
"delivery_pick_list":
{ Args: { "p_id": string }; Returns: {
              "base_quantity": number,"base_unit": string,"batch_number": string,"expiry_date": string,"line_no": number,"line_quantity": number,"line_unit": string,"location_code": string,"picking_sequence": number,"product_name": string,"sku": string
            }[]
                           },
"dispatch_delivery_note":
{ Args: { "p_driver_name": string,"p_id": string,"p_vehicle_number": string }; Returns: undefined
                           },
"dispatch_transfer":
{ Args: { "p_from_warehouse_id": string,"p_lines": Json,"p_notes"?: string,"p_to_warehouse_id": string }; Returns: Json
                           },
"expiring_stock":
{ Args: { "p_warehouse_id"?: string,"p_within_days"?: number }; Returns: {
              "batch_id": string,"batch_number": string,"brand_name": string,"days_to_expiry": number,"expiry_date": string,"location_id": string,"product_id": string,"quantity": number,"sku": string,"stock_status": string,"warehouse_id": string,"warehouse_name": string
            }[]
                           },
"expiry_risk":
{ Args: { "p_history_days"?: number,"p_horizon_days"?: number,"p_warehouse_id"?: string }; Returns: {
              "at_risk_qty": number,"avg_daily": number,"batch_number": string,"days_left": number,"expected_sales": number,"expiry_date": string,"product_id": string,"product_name": string,"quantity": number,"sku": string,"value_at_risk": number
            }[]
                           },
"fail_delivery":
{ Args: { "p_id": string,"p_reason": string }; Returns: undefined
                           },
"finalize_reconciliation":
{ Args: { "p_statement_id": string }; Returns: undefined
                           },
"fulfilment_pick_list":
{ Args: { "p_id": string }; Returns: {
              "base_unit": string,"batch_number": string,"exception_id": string,"exception_status": string,"expected_quantity": number,"expiry_date": string,"line_id": string,"line_no": number,"location_code": string,"picked_quantity": number,"picking_sequence": number,"product_name": string,"short_note": string,"short_reason": string,"sku": string,"status": string
            }[]
                           },
"fulfilment_queue":
{ Args: { "p_mine"?: boolean,"p_status"?: string }; Returns: {
              "branch_id": string,"branch_name": string,"customer_name": string,"id": string,"invoice_id": string,"invoice_number": string,"line_count": number,"lines_done": number,"open_exceptions": number,"order_number": string,"picker_id": string,"picker_name": string,"priority": number,"released_at": string,"required_by": string,"status": string,"warehouse_name": string
            }[]
                           },
"get_session_context":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"import_bank_statement":
{ Args: { "p_bank_account_id": string,"p_closing": number,"p_file_name"?: string,"p_lines": Json,"p_opening": number,"p_period_from": string,"p_period_to": string }; Returns: string
                           },
"import_customers":
{ Args: { "p_dry_run"?: boolean,"p_rows": Json }; Returns: Json
                           },
"import_opening_payables":
{ Args: { "p_dry_run"?: boolean,"p_rows": Json }; Returns: Json
                           },
"import_opening_receivables":
{ Args: { "p_dry_run"?: boolean,"p_rows": Json }; Returns: Json
                           },
"import_products":
{ Args: { "p_dry_run"?: boolean,"p_rows": Json }; Returns: Json
                           },
"import_suppliers":
{ Args: { "p_dry_run"?: boolean,"p_rows": Json }; Returns: Json
                           },
"income_statement":
{ Args: { "p_branch_id"?: string,"p_from": string,"p_to": string }; Returns: {
              "account_id": string,"account_type": string,"amount": number,"code": string,"name": string
            }[]
                           },
"invoice_creditable":
{ Args: { "p_invoice_id": string }; Returns: {
              "credited_net": number,"credited_tax": number,"invoice_line_id": string,"line_net": number,"line_no": number,"line_tax": number,"quantity": number,"remaining_net": number,"remaining_quantity": number,"remaining_tax": number,"returned_quantity": number
            }[]
                           },
"invoice_sales_order":
{ Args: { "p_lines"?: Json,"p_order_id": string }; Returns: string
                           },
"match_bank_line":
{ Args: { "p_journal_line_ids": (string)[],"p_statement_line_id": string }; Returns: undefined
                           },
"numbering_overview":
{ Args: Record<PropertyKey, never>; Returns: {
              "configured": boolean,"document_type": string,"in_use": boolean,"next_number": number,"padding": number,"prefix": string,"reset_period": string
            }[]
                           },
"open_pos_session":
{ Args: { "p_opening_float"?: number,"p_warehouse_id": string }; Returns: string
                           },
"order_progress":
{ Args: { "p_order_id": string }; Returns: {
              "in_draft": number,"invoiced": number,"line_no": number,"order_line_id": string,"quantity": number,"remaining": number,"reserved_base": number
            }[]
                           },
"overdue_customers":
{ Args: { "p_min_days"?: number }; Returns: {
              "contact_name": string,"customer_id": string,"customer_name": string,"email": string,"invoices": number,"last_level": number,"last_reminder_at": string,"oldest_days": number,"on_hold": boolean,"overdue_amount": number,"phone": string,"suggested_level": number
            }[]
                           },
"pay_supplier_invoice":
{ Args: { "p_id": string,"p_paid_on": string,"p_reference": string }; Returns: undefined
                           },
"payables_summary":
{ Args: Record<PropertyKey, never>; Returns: {
              "awaiting_approval": number,"credit_expected": number,"currency_code": string,"not_due": number,"outstanding": number,"overdue_1_30": number,"overdue_31_60": number,"overdue_61_90": number,"overdue_over_90": number,"supplier_id": string,"supplier_name": string
            }[]
                           },
"picker_options":
{ Args: { "p_branch_id": string }; Returns: {
              "id": string,"name": string
            }[]
                           },
"pos_checkout":
{ Args: { "p_customer_id": string,"p_lines": Json,"p_override_reason"?: string,"p_payments": Json,"p_session_id": string }; Returns: Json
                           },
"pos_session_summary":
{ Args: { "p_session_id": string }; Returns: Json
                           },
"post_bank_entry":
{ Args: { "p_account_id": string,"p_description"?: string,"p_statement_line_id": string }; Returns: string
                           },
"post_credit_note":
{ Args: { "p_id": string }; Returns: Json
                           },
"post_manual_journal":
{ Args: { "p_branch_id"?: string,"p_date": string,"p_description": string,"p_lines": Json,"p_reason"?: string }; Returns: string
                           },
"post_purchase_return":
{ Args: { "p_lines": Json,"p_notes"?: string,"p_purchase_order_id"?: string,"p_reason": string,"p_supplier_id": string,"p_warehouse_id": string }; Returns: Json
                           },
"post_sales_invoice":
{ Args: { "p_id": string,"p_override_reason"?: string,"p_payment"?: Json }; Returns: Json
                           },
"post_stock_document":
{ Args: { "p_document_type": string,"p_lines": Json,"p_notes"?: string,"p_reason_code"?: string,"p_to_warehouse_id"?: string,"p_warehouse_id": string }; Returns: Json
                           },
"prepare_delivery_note":
{ Args: { "p_address": string,"p_contact_name": string,"p_contact_phone": string,"p_invoice_id": string,"p_notes": string,"p_packages": number }; Returns: string
                           },
"prepare_invitation":
{ Args: { "p_branch_id"?: string,"p_role_id": string }; Returns: Json
                           },
"prepare_resend":
{ Args: { "p_user_id": string }; Returns: Json
                           },
"provision_organization":
{ Args: { "p_branch_code"?: string,"p_branch_name"?: string,"p_country"?: string,"p_currency_code"?: string,"p_first_name": string,"p_last_name": string,"p_legal_name"?: string,"p_name": string,"p_timezone"?: string,"p_user_id": string }; Returns: string
                           },
"provision_user":
{ Args: { "p_branch_id"?: string,"p_first_name": string,"p_last_name": string,"p_organization_id": string,"p_role_code": string,"p_user_id": string }; Returns: undefined
                           },
"receivables_summary":
{ Args: Record<PropertyKey, never>; Returns: {
              "credit_held": number,"credit_limit": number,"currency_code": string,"customer_id": string,"customer_name": string,"not_due": number,"on_hold": boolean,"outstanding": number,"overdue_1_30": number,"overdue_31_60": number,"overdue_61_90": number,"overdue_over_90": number
            }[]
                           },
"receive_goods":
{ Args: { "p_delivery_note"?: string,"p_lines": Json,"p_notes"?: string,"p_purchase_order_id": string }; Returns: Json
                           },
"receive_transfer":
{ Args: { "p_id": string,"p_lines": Json,"p_notes"?: string }; Returns: Json
                           },
"record_payment_reminder":
{ Args: { "p_channel": string,"p_customer_id": string,"p_invoice_ids": (string)[],"p_level": number,"p_message": string }; Returns: string
                           },
"record_receipt":
{ Args: { "p_allocations"?: Json,"p_amount": number,"p_branch_id": string,"p_customer_id": string,"p_method": string,"p_notes"?: string,"p_reference"?: string }; Returns: Json
                           },
"record_return_credit":
{ Args: { "p_amount": number,"p_credit_note_number": string,"p_id": string }; Returns: undefined
                           },
"record_supplier_invoice":
{ Args: { "p_id": string,"p_invoice_date": string,"p_lines": Json,"p_notes": string,"p_purchase_order_id": string,"p_supplier_invoice_number": string,"p_tax_amount": number }; Returns: string
                           },
"refund_customer":
{ Args: { "p_amount": number,"p_method": string,"p_notes"?: string,"p_pos_session_id"?: string,"p_reference": string,"p_source_id": string,"p_source_type": string }; Returns: Json
                           },
"reject_controlled_adjustment":
{ Args: { "p_id": string,"p_reason": string }; Returns: undefined
                           },
"reject_purchase_order":
{ Args: { "p_id": string,"p_reason": string }; Returns: undefined
                           },
"reject_quotation":
{ Args: { "p_id": string,"p_reason": string }; Returns: undefined
                           },
"release_fulfilment_claim":
{ Args: { "p_id": string }; Returns: undefined
                           },
"release_to_warehouse":
{ Args: { "p_invoice_id": string,"p_notes"?: string,"p_priority"?: number,"p_required_by"?: string }; Returns: string
                           },
"remove_opening_balance":
{ Args: { "p_id": string,"p_kind": string,"p_reason": string }; Returns: undefined
                           },
"reorder_suggestions":
{ Args: { "p_cover_days"?: number,"p_history_days"?: number,"p_warehouse_id"?: string }; Returns: {
              "avg_daily": number,"base_unit": string,"days_cover": number,"free": number,"lead_time_days": number,"on_hand": number,"on_order": number,"product_id": string,"product_name": string,"reserved": number,"sku": string,"suggested_qty": number,"supplier_name": string,"target_stock": number
            }[]
                           },
"report_client_error":
{ Args: { "p_app_version"?: string,"p_message": string,"p_page_path"?: string,"p_source": string,"p_stack"?: string,"p_user_agent"?: string }; Returns: undefined
                           },
"request_controlled_adjustment":
{ Args: { "p_lines": Json,"p_notes": string,"p_reason_code": string,"p_warehouse_id": string }; Returns: Json
                           },
"reset_pick_line":
{ Args: { "p_line_id": string,"p_reason": string }; Returns: undefined
                           },
"resolve_price":
{ Args: { "p_customer_id": string,"p_product_unit_id": string }; Returns: number
                           },
"resolve_short_pick":
{ Args: { "p_exception_id": string,"p_reason": string }; Returns: string
                           },
"return_stock_count":
{ Args: { "p_id": string,"p_reason": string }; Returns: undefined
                           },
"reverse_credit_note":
{ Args: { "p_id": string,"p_reason": string }; Returns: Json
                           },
"reverse_journal":
{ Args: { "p_journal_id": string,"p_reason": string }; Returns: string
                           },
"reverse_sales_invoice":
{ Args: { "p_id": string,"p_reason": string }; Returns: Json
                           },
"revoke_user_role":
{ Args: { "p_reason"?: string,"p_user_role_id": string }; Returns: undefined
                           },
"sales_report":
{ Args: { "p_branch_id"?: string,"p_from": string,"p_group"?: string,"p_to": string }; Returns: {
              "cost": number,"credits": number,"group_key": string,"group_label": string,"invoices": number,"margin": number,"margin_pct": number,"net_sales": number,"sales": number,"tax": number,"uncosted_lines": number,"units": number
            }[]
                           },
"save_bank_account":
{ Args: { "p_account_ref": string,"p_bank_name": string,"p_id": string,"p_is_active"?: boolean,"p_make_default"?: boolean,"p_name": string }; Returns: string
                           },
"save_count_entries":
{ Args: { "p_entries": Json,"p_id": string }; Returns: number
                           },
"save_credit_note":
{ Args: { "p_id": string,"p_invoice_id": string,"p_lines": Json,"p_notes": string,"p_reason_code": string,"p_warehouse_id": string }; Returns: string
                           },
"save_gl_account":
{ Args: { "p_account_type": string,"p_code": string,"p_id": string,"p_is_active"?: boolean,"p_name": string }; Returns: string
                           },
"save_purchase_order":
{ Args: { "p_expected_date": string,"p_id": string,"p_lines": Json,"p_notes": string,"p_payment_terms_days"?: number,"p_supplier_id": string,"p_warehouse_id": string }; Returns: string
                           },
"save_quotation":
{ Args: { "p_customer_id": string,"p_customer_reference": string,"p_id": string,"p_lines": Json,"p_notes": string,"p_valid_until": string,"p_warehouse_id": string }; Returns: string
                           },
"save_sales_invoice":
{ Args: { "p_customer_id": string,"p_customer_reference": string,"p_id": string,"p_lines": Json,"p_notes": string,"p_warehouse_id": string }; Returns: string
                           },
"save_sales_order":
{ Args: { "p_customer_id": string,"p_customer_reference": string,"p_id": string,"p_lines": Json,"p_notes": string,"p_required_date": string,"p_reserved_until": string,"p_warehouse_id": string }; Returns: string
                           },
"save_setting":
{ Args: { "p_branch_id"?: string,"p_category": string,"p_key": string,"p_reason"?: string,"p_value": Json }; Returns: undefined
                           },
"search_products":
{ Args: { "p_limit"?: number,"p_offset"?: number,"p_query": string }; Returns: {
              "brand_name": string,"dosage_form": string,"generic_name": string,"is_active": boolean,"manufacturer_name": string,"matched_on": string,"product_class": string,"product_id": string,"sku": string,"strength_text": string
            }[]
                           },
"send_quotation":
{ Args: { "p_id": string }; Returns: string
                           },
"set_period_lock":
{ Args: { "p_reason"?: string,"p_through": string }; Returns: string
                           },
"set_user_active":
{ Args: { "p_is_active": boolean,"p_reason"?: string,"p_user_id": string }; Returns: undefined
                           },
"settings_overview":
{ Args: { "p_branch_id"?: string }; Returns: {
              "branch_scoped": boolean,"category": string,"default_value": Json,"key": string,"kind": string,"max_len": number,"max_num": number,"min_nonzero": number,"min_num": number,"sensitive": boolean,"source": string,"updated_at": string,"value": Json
            }[]
                           },
"slow_moving_stock":
{ Args: { "p_days"?: number }; Returns: {
              "base_unit": string,"days_since_sale": number,"earliest_expiry": string,"last_sale_date": string,"on_hand": number,"product_id": string,"product_name": string,"sku": string,"stock_value": number
            }[]
                           },
"start_accounting":
{ Args: { "p_go_live": string,"p_opening": Json }; Returns: string
                           },
"start_stock_count":
{ Args: { "p_location_id"?: string,"p_notes"?: string,"p_product_ids"?: (string)[],"p_warehouse_id": string }; Returns: string
                           },
"stock_availability":
{ Args: { "p_product_id": string,"p_warehouse_id": string }; Returns: {
              "free": number,"on_hand": number,"reserved": number
            }[]
                           },
"stock_summary":
{ Args: { "p_limit"?: number,"p_near_days"?: number,"p_offset"?: number,"p_query"?: string,"p_warehouse_id"?: string }; Returns: {
              "available": number,"base_unit": string,"brand_name": string,"damaged": number,"earliest_expiry": string,"expired_status": number,"expired_unsold": number,"generic_name": string,"near_expiry": number,"product_id": string,"quarantine": number,"sku": string,"strength_text": string,"total_count": number
            }[]
                           },
"stock_valuation":
{ Args: { "p_warehouse_id"?: string }; Returns: {
              "base_unit": string,"brand_name": string,"good_quantity": number,"other_quantity": number,"product_id": string,"sku": string,"total_count": number,"uncosted_quantity": number,"value": number
            }[]
                           },
"submit_purchase_order":
{ Args: { "p_id": string }; Returns: undefined
                           },
"submit_stock_count":
{ Args: { "p_id": string }; Returns: undefined
                           },
"suggest_bank_matches":
{ Args: { "p_statement_id": string }; Returns: {
              "amount": number,"description": string,"journal_date": string,"journal_line_id": string,"journal_number": string,"score": number,"statement_line_id": string
            }[]
                           },
"suggest_fefo_allocation":
{ Args: { "p_min_shelf_life_days"?: number,"p_product_id": string,"p_quantity": number,"p_warehouse_id": string }; Returns: {
              "allocate": number,"batch_id": string,"batch_number": string,"expiry_date": string,"location_id": string,"on_hand": number
            }[]
                           },
"suggest_opening_balances":
{ Args: Record<PropertyKey, never>; Returns: {
              "account_id": string,"basis": string,"code": string,"name": string,"suggested": number
            }[]
                           },
"trial_balance":
{ Args: { "p_branch_id"?: string,"p_from": string,"p_to": string }; Returns: {
              "account_id": string,"account_type": string,"closing": number,"code": string,"name": string,"normal_side": string,"opening": number,"period_credit": number,"period_debit": number
            }[]
                           },
"unclear_ledger_line":
{ Args: { "p_journal_line_id": string }; Returns: undefined
                           },
"unmatch_bank_line":
{ Args: { "p_statement_line_id": string }; Returns: undefined
                           },
"vat_report":
{ Args: { "p_branch_id"?: string,"p_from": string,"p_to": string }; Returns: {
              "rate": number,"section": string,"tax": number,"tax_code": string,"tax_name": string,"taxable": number
            }[]
                           },
"void_receipt":
{ Args: { "p_id": string,"p_reason": string }; Returns: undefined
                           }
          }
          Enums: {
            "warehouse_type": "MAIN"|"RETURNS"|"QUARANTINE"|"DAMAGED"|"TRANSIT"|"OTHER"
          }
          CompositeTypes: {
            [_ in never]: never
          }
        }
}

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
  ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
      Row: infer R
    }
    ? R
    : never
  : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Insert: infer I
    }
    ? I
    : never
  : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Update: infer U
    }
    ? U
    : never
  : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
  ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
  : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
  ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
  : never

export const Constants = {
  "public": {
          Enums: {
            "warehouse_type": ["MAIN", "RETURNS", "QUARANTINE", "DAMAGED", "TRANSIT", "OTHER"]
          }
        }
} as const
