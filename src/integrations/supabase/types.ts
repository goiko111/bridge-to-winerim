export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.1"
  }
  public: {
    Tables: {
      classification_config: {
        Row: {
          connection_id: string
          created_at: string
          format_whitelist: string[]
          id: string
          max_wine_price: number
          min_wine_price: number
          non_wine_families_blacklist: string[]
          non_wine_keywords_blacklist: string[]
          score_threshold_not_wine: number
          score_threshold_wine: number
          updated_at: string
          wine_families_whitelist: string[]
          wine_keywords_whitelist: string[]
        }
        Insert: {
          connection_id: string
          created_at?: string
          format_whitelist?: string[]
          id?: string
          max_wine_price?: number
          min_wine_price?: number
          non_wine_families_blacklist?: string[]
          non_wine_keywords_blacklist?: string[]
          score_threshold_not_wine?: number
          score_threshold_wine?: number
          updated_at?: string
          wine_families_whitelist?: string[]
          wine_keywords_whitelist?: string[]
        }
        Update: {
          connection_id?: string
          created_at?: string
          format_whitelist?: string[]
          id?: string
          max_wine_price?: number
          min_wine_price?: number
          non_wine_families_blacklist?: string[]
          non_wine_keywords_blacklist?: string[]
          score_threshold_not_wine?: number
          score_threshold_wine?: number
          updated_at?: string
          wine_families_whitelist?: string[]
          wine_keywords_whitelist?: string[]
        }
        Relationships: [
          {
            foreignKeyName: "classification_config_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: true
            referencedRelation: "pos_connections"
            referencedColumns: ["id"]
          },
        ]
      }
      pos_connections: {
        Row: {
          api_token: string
          backfill_days: number
          base_url: string
          catalog_endpoint: string | null
          catalog_product_count: number | null
          catalog_sync_enabled: boolean | null
          catalog_wine_candidate_count: number | null
          created_at: string
          enabled: boolean
          id: string
          last_business_day_synced: string | null
          last_catalog_sync_at: string | null
          last_sync_at: string | null
          location_name: string
          provider: string
          sync_frequency_minutes: number
          sync_mode: string
          updated_at: string
          winerim_api_token: string | null
        }
        Insert: {
          api_token: string
          backfill_days?: number
          base_url: string
          catalog_endpoint?: string | null
          catalog_product_count?: number | null
          catalog_sync_enabled?: boolean | null
          catalog_wine_candidate_count?: number | null
          created_at?: string
          enabled?: boolean
          id?: string
          last_business_day_synced?: string | null
          last_catalog_sync_at?: string | null
          last_sync_at?: string | null
          location_name: string
          provider?: string
          sync_frequency_minutes?: number
          sync_mode?: string
          updated_at?: string
          winerim_api_token?: string | null
        }
        Update: {
          api_token?: string
          backfill_days?: number
          base_url?: string
          catalog_endpoint?: string | null
          catalog_product_count?: number | null
          catalog_sync_enabled?: boolean | null
          catalog_wine_candidate_count?: number | null
          created_at?: string
          enabled?: boolean
          id?: string
          last_business_day_synced?: string | null
          last_catalog_sync_at?: string | null
          last_sync_at?: string | null
          location_name?: string
          provider?: string
          sync_frequency_minutes?: number
          sync_mode?: string
          updated_at?: string
          winerim_api_token?: string | null
        }
        Relationships: []
      }
      provider_products: {
        Row: {
          classification_override: string
          connection_id: string
          created_at: string
          family: string | null
          id: string
          is_wine_candidate: boolean | null
          last_reasons: string[] | null
          last_score: number | null
          name: string
          price: number | null
          provider_product_id: string
          provider_updated_at: string | null
          raw_payload: Json | null
          sale_format: string | null
          updated_at: string
          vat_rate: number | null
          wine_reasons: string[] | null
          wine_score: number | null
        }
        Insert: {
          classification_override?: string
          connection_id: string
          created_at?: string
          family?: string | null
          id?: string
          is_wine_candidate?: boolean | null
          last_reasons?: string[] | null
          last_score?: number | null
          name: string
          price?: number | null
          provider_product_id: string
          provider_updated_at?: string | null
          raw_payload?: Json | null
          sale_format?: string | null
          updated_at?: string
          vat_rate?: number | null
          wine_reasons?: string[] | null
          wine_score?: number | null
        }
        Update: {
          classification_override?: string
          connection_id?: string
          created_at?: string
          family?: string | null
          id?: string
          is_wine_candidate?: boolean | null
          last_reasons?: string[] | null
          last_score?: number | null
          name?: string
          price?: number | null
          provider_product_id?: string
          provider_updated_at?: string | null
          raw_payload?: Json | null
          sale_format?: string | null
          updated_at?: string
          vat_rate?: number | null
          wine_reasons?: string[] | null
          wine_score?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "provider_products_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "pos_connections"
            referencedColumns: ["id"]
          },
        ]
      }
      sales_events: {
        Row: {
          business_day: string
          connection_id: string
          created_at: string
          doc_type: string
          id: string
          line_count: number
          provider_doc_id: string
          raw_json: Json | null
          total_amount: number
          total_net: number
          total_tax: number
        }
        Insert: {
          business_day: string
          connection_id: string
          created_at?: string
          doc_type?: string
          id?: string
          line_count?: number
          provider_doc_id: string
          raw_json?: Json | null
          total_amount?: number
          total_net?: number
          total_tax?: number
        }
        Update: {
          business_day?: string
          connection_id?: string
          created_at?: string
          doc_type?: string
          id?: string
          line_count?: number
          provider_doc_id?: string
          raw_json?: Json | null
          total_amount?: number
          total_net?: number
          total_tax?: number
        }
        Relationships: [
          {
            foreignKeyName: "sales_events_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "pos_connections"
            referencedColumns: ["id"]
          },
        ]
      }
      sales_line_items: {
        Row: {
          connection_id: string
          created_at: string
          family: string | null
          format: string | null
          id: string
          is_wine_candidate: boolean
          mapped: boolean
          name: string
          provider_product_id: string | null
          quantity: number
          sales_event_id: string
          total_amount: number
          unit_price: number
          vat_rate: number
          winerim_product_id: string | null
        }
        Insert: {
          connection_id: string
          created_at?: string
          family?: string | null
          format?: string | null
          id?: string
          is_wine_candidate?: boolean
          mapped?: boolean
          name: string
          provider_product_id?: string | null
          quantity?: number
          sales_event_id: string
          total_amount?: number
          unit_price?: number
          vat_rate?: number
          winerim_product_id?: string | null
        }
        Update: {
          connection_id?: string
          created_at?: string
          family?: string | null
          format?: string | null
          id?: string
          is_wine_candidate?: boolean
          mapped?: boolean
          name?: string
          provider_product_id?: string | null
          quantity?: number
          sales_event_id?: string
          total_amount?: number
          unit_price?: number
          vat_rate?: number
          winerim_product_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "sales_line_items_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "pos_connections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sales_line_items_sales_event_id_fkey"
            columns: ["sales_event_id"]
            isOneToOne: false
            referencedRelation: "sales_events"
            referencedColumns: ["id"]
          },
        ]
      }
      wine_family_rules: {
        Row: {
          connection_id: string
          created_at: string
          family_name: string
          id: string
          is_wine: boolean
        }
        Insert: {
          connection_id: string
          created_at?: string
          family_name: string
          id?: string
          is_wine?: boolean
        }
        Update: {
          connection_id?: string
          created_at?: string
          family_name?: string
          id?: string
          is_wine?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "wine_family_rules_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "pos_connections"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

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
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
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
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
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
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
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
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
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
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
