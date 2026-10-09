
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  
  "public": {
          Tables: {
            "audit_logs": {
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
            "assign_user_role":
{ Args: { "p_branch_id"?: string,"p_reason"?: string,"p_role_id": string,"p_user_id": string }; Returns: string
                           },
"complete_invitation":
{ Args: { "p_actor_id": string,"p_branch_id"?: string,"p_first_name": string,"p_job_title"?: string,"p_last_name": string,"p_organization_id": string,"p_role_id": string,"p_user_id": string }; Returns: undefined
                           },
"get_session_context":
{ Args: Record<PropertyKey, never>; Returns: Json
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
"revoke_user_role":
{ Args: { "p_reason"?: string,"p_user_role_id": string }; Returns: undefined
                           },
"set_user_active":
{ Args: { "p_is_active": boolean,"p_reason"?: string,"p_user_id": string }; Returns: undefined
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
