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
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      agora_dispatch_locks: {
        Row: {
          acquired_at: string
          connection_id: string
          job: string
          lock_token: string
          locked_until: string
        }
        Insert: {
          acquired_at?: string
          connection_id: string
          job: string
          lock_token: string
          locked_until: string
        }
        Update: {
          acquired_at?: string
          connection_id?: string
          job?: string
          lock_token?: string
          locked_until?: string
        }
        Relationships: [
          {
            foreignKeyName: "agora_dispatch_locks_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: true
            referencedRelation: "pos_connections"
            referencedColumns: ["id"]
          },
        ]
      }
      agora_master_data: {
        Row: {
          connection_id: string
          created_at: string
          families_json: Json
          fetched_at: string | null
          id: string
          preparation_orders_json: Json
          preparation_types_json: Json
          price_lists_json: Json
          products_summary_json: Json
          raw_xml_preview: string | null
          sale_centers_json: Json
          sale_points_json: Json
          updated_at: string
          vats_json: Json
          warehouses_json: Json
        }
        Insert: {
          connection_id: string
          created_at?: string
          families_json?: Json
          fetched_at?: string | null
          id?: string
          preparation_orders_json?: Json
          preparation_types_json?: Json
          price_lists_json?: Json
          products_summary_json?: Json
          raw_xml_preview?: string | null
          sale_centers_json?: Json
          sale_points_json?: Json
          updated_at?: string
          vats_json?: Json
          warehouses_json?: Json
        }
        Update: {
          connection_id?: string
          created_at?: string
          families_json?: Json
          fetched_at?: string | null
          id?: string
          preparation_orders_json?: Json
          preparation_types_json?: Json
          price_lists_json?: Json
          products_summary_json?: Json
          raw_xml_preview?: string | null
          sale_centers_json?: Json
          sale_points_json?: Json
          updated_at?: string
          vats_json?: Json
          warehouses_json?: Json
        }
        Relationships: [
          {
            foreignKeyName: "agora_master_data_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: true
            referencedRelation: "pos_connections"
            referencedColumns: ["id"]
          },
        ]
      }
      agora_sales_variant_mappings: {
        Row: {
          connection_id: string
          created_at: string
          evidence: Json
          format_type: string
          id: string
          match_method: string
          provider_product_id: string
          provider_product_name: string
          provider_sale_format_name: string
          sale_format_id: string
          status: string
          updated_at: string
          winerim_wine_id: string
        }
        Insert: {
          connection_id: string
          created_at?: string
          evidence?: Json
          format_type: string
          id?: string
          match_method: string
          provider_product_id: string
          provider_product_name: string
          provider_sale_format_name: string
          sale_format_id: string
          status?: string
          updated_at?: string
          winerim_wine_id: string
        }
        Update: {
          connection_id?: string
          created_at?: string
          evidence?: Json
          format_type?: string
          id?: string
          match_method?: string
          provider_product_id?: string
          provider_product_name?: string
          provider_sale_format_name?: string
          sale_format_id?: string
          status?: string
          updated_at?: string
          winerim_wine_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "agora_sales_variant_mappings_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "pos_connections"
            referencedColumns: ["id"]
          },
        ]
      }
      catalog_readback_snapshots: {
        Row: {
          agora_family_id: string | null
          agora_family_name: string | null
          agora_name: string | null
          agora_price: number | null
          agora_product_id: string | null
          agora_saleable: boolean | null
          agora_visible: boolean | null
          connection_id: string
          created_at: string
          differences: string[]
          expected_family_id: string | null
          expected_price: number | null
          format_key: string
          found_in_agora: boolean | null
          id: string
          read_at: string
          read_source: string
          updated_at: string
          winerim_wine_id: string
        }
        Insert: {
          agora_family_id?: string | null
          agora_family_name?: string | null
          agora_name?: string | null
          agora_price?: number | null
          agora_product_id?: string | null
          agora_saleable?: boolean | null
          agora_visible?: boolean | null
          connection_id: string
          created_at?: string
          differences?: string[]
          expected_family_id?: string | null
          expected_price?: number | null
          format_key: string
          found_in_agora?: boolean | null
          id?: string
          read_at?: string
          read_source?: string
          updated_at?: string
          winerim_wine_id: string
        }
        Update: {
          agora_family_id?: string | null
          agora_family_name?: string | null
          agora_name?: string | null
          agora_price?: number | null
          agora_product_id?: string | null
          agora_saleable?: boolean | null
          agora_visible?: boolean | null
          connection_id?: string
          created_at?: string
          differences?: string[]
          expected_family_id?: string | null
          expected_price?: number | null
          format_key?: string
          found_in_agora?: boolean | null
          id?: string
          read_at?: string
          read_source?: string
          updated_at?: string
          winerim_wine_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "catalog_readback_snapshots_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "pos_connections"
            referencedColumns: ["id"]
          },
        ]
      }
      catalog_review_decisions: {
        Row: {
          applied_at: string | null
          applied_by: string | null
          applied_mapping_id: string | null
          connection_id: string
          created_at: string
          decided_at: string | null
          decided_by: string | null
          family: string | null
          id: string
          last_sale_at: string | null
          note: string | null
          provider_product_id: string
          provider_product_name: string | null
          sale_format: string
          selected_capacity_liters: number | null
          selected_format_key: string | null
          selected_winerim_id: string | null
          selected_winerim_name: string | null
          status: string
          units_recent: number | null
          updated_at: string
        }
        Insert: {
          applied_at?: string | null
          applied_by?: string | null
          applied_mapping_id?: string | null
          connection_id: string
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          family?: string | null
          id?: string
          last_sale_at?: string | null
          note?: string | null
          provider_product_id: string
          provider_product_name?: string | null
          sale_format?: string
          selected_capacity_liters?: number | null
          selected_format_key?: string | null
          selected_winerim_id?: string | null
          selected_winerim_name?: string | null
          status?: string
          units_recent?: number | null
          updated_at?: string
        }
        Update: {
          applied_at?: string | null
          applied_by?: string | null
          applied_mapping_id?: string | null
          connection_id?: string
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          family?: string | null
          id?: string
          last_sale_at?: string | null
          note?: string | null
          provider_product_id?: string
          provider_product_name?: string | null
          sale_format?: string
          selected_capacity_liters?: number | null
          selected_format_key?: string | null
          selected_winerim_id?: string | null
          selected_winerim_name?: string | null
          status?: string
          units_recent?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "catalog_review_decisions_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "pos_connections"
            referencedColumns: ["id"]
          },
        ]
      }
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
      connection_alerts: {
        Row: {
          alert_key: string
          alert_type: string
          client_notified_at: string | null
          connection_id: string
          consecutive_failures: number
          created_at: string
          first_seen_at: string
          id: string
          internal_notified_at: string | null
          last_check_id: string | null
          last_error_class: string | null
          last_error_message: string | null
          last_notification_error: string | null
          last_seen_at: string
          message: string
          metadata: Json
          notify_client: boolean
          notify_internal: boolean
          occurrences: number
          provider: string
          recovery_notified_at: string | null
          resolved_at: string | null
          severity: string
          status: string
          title: string
          updated_at: string
        }
        Insert: {
          alert_key: string
          alert_type: string
          client_notified_at?: string | null
          connection_id: string
          consecutive_failures?: number
          created_at?: string
          first_seen_at?: string
          id?: string
          internal_notified_at?: string | null
          last_check_id?: string | null
          last_error_class?: string | null
          last_error_message?: string | null
          last_notification_error?: string | null
          last_seen_at?: string
          message: string
          metadata?: Json
          notify_client?: boolean
          notify_internal?: boolean
          occurrences?: number
          provider: string
          recovery_notified_at?: string | null
          resolved_at?: string | null
          severity: string
          status?: string
          title: string
          updated_at?: string
        }
        Update: {
          alert_key?: string
          alert_type?: string
          client_notified_at?: string | null
          connection_id?: string
          consecutive_failures?: number
          created_at?: string
          first_seen_at?: string
          id?: string
          internal_notified_at?: string | null
          last_check_id?: string | null
          last_error_class?: string | null
          last_error_message?: string | null
          last_notification_error?: string | null
          last_seen_at?: string
          message?: string
          metadata?: Json
          notify_client?: boolean
          notify_internal?: boolean
          occurrences?: number
          provider?: string
          recovery_notified_at?: string | null
          resolved_at?: string | null
          severity?: string
          status?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "connection_alerts_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "pos_connections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "connection_alerts_last_check_id_fkey"
            columns: ["last_check_id"]
            isOneToOne: false
            referencedRelation: "connection_health_checks"
            referencedColumns: ["id"]
          },
        ]
      }
      connection_health_checks: {
        Row: {
          check_type: string
          checked_at: string
          connection_id: string
          created_at: string
          details: Json
          error_class: string | null
          error_message: string | null
          http_status: number | null
          id: string
          latency_ms: number | null
          location_name: string
          provider: string
          severity: string
          status: string
        }
        Insert: {
          check_type?: string
          checked_at?: string
          connection_id: string
          created_at?: string
          details?: Json
          error_class?: string | null
          error_message?: string | null
          http_status?: number | null
          id?: string
          latency_ms?: number | null
          location_name: string
          provider: string
          severity?: string
          status: string
        }
        Update: {
          check_type?: string
          checked_at?: string
          connection_id?: string
          created_at?: string
          details?: Json
          error_class?: string | null
          error_message?: string | null
          http_status?: number | null
          id?: string
          latency_ms?: number | null
          location_name?: string
          provider?: string
          severity?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "connection_health_checks_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "pos_connections"
            referencedColumns: ["id"]
          },
        ]
      }
      connection_notification_contacts: {
        Row: {
          alert_types: string[]
          channel: string
          connection_id: string
          created_at: string
          enabled: boolean
          id: string
          label: string
          min_severity: string
          notify_client: boolean
          notify_recovery: boolean
          target: string
          updated_at: string
        }
        Insert: {
          alert_types?: string[]
          channel?: string
          connection_id: string
          created_at?: string
          enabled?: boolean
          id?: string
          label?: string
          min_severity?: string
          notify_client?: boolean
          notify_recovery?: boolean
          target: string
          updated_at?: string
        }
        Update: {
          alert_types?: string[]
          channel?: string
          connection_id?: string
          created_at?: string
          enabled?: boolean
          id?: string
          label?: string
          min_severity?: string
          notify_client?: boolean
          notify_recovery?: boolean
          target?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "connection_notification_contacts_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "pos_connections"
            referencedColumns: ["id"]
          },
        ]
      }
      outbound_tasks: {
        Row: {
          attempts: number
          blocked_reason: string | null
          connection_id: string
          created_at: string
          external_id: string | null
          id: string
          last_error: string | null
          max_attempts: number
          next_retry_at: string | null
          payload_json: Json
          status: string
          task_type: string
          updated_at: string
        }
        Insert: {
          attempts?: number
          blocked_reason?: string | null
          connection_id: string
          created_at?: string
          external_id?: string | null
          id?: string
          last_error?: string | null
          max_attempts?: number
          next_retry_at?: string | null
          payload_json?: Json
          status?: string
          task_type?: string
          updated_at?: string
        }
        Update: {
          attempts?: number
          blocked_reason?: string | null
          connection_id?: string
          created_at?: string
          external_id?: string | null
          id?: string
          last_error?: string | null
          max_attempts?: number
          next_retry_at?: string | null
          payload_json?: Json
          status?: string
          task_type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "outbound_tasks_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "pos_connections"
            referencedColumns: ["id"]
          },
        ]
      }
      pos_connections: {
        Row: {
          api_token: string
          auto_create_families: boolean
          auto_push_bottle: boolean
          auto_push_glass: boolean
          auto_push_on_create: boolean
          auto_push_on_update: boolean
          auto_push_verified_ready: boolean
          backfill_days: number
          base_url: string
          catalog_endpoint: string | null
          catalog_product_count: number | null
          catalog_sync_enabled: boolean | null
          catalog_wine_candidate_count: number | null
          circuit_breaker_paused_until: string | null
          circuit_breaker_reason: string | null
          consecutive_failures: number
          created_at: string
          default_bottle_format_name: string | null
          default_family_id: string | null
          default_glass_format_name: string | null
          default_preparation_order_id: string | null
          default_preparation_type_id: string | null
          default_vat_id: string | null
          default_vat_rate: number | null
          default_warehouse_id: string | null
          default_wine_family_name: string | null
          enabled: boolean
          estimated_glasses_per_bottle: number
          id: string
          last_business_day_synced: string | null
          last_catalog_sync_at: string | null
          last_sync_at: string | null
          location_name: string
          provider: string
          provider_config: Json | null
          require_manual_review_before_push: boolean
          restaurant_guid: string | null
          selected_sale_center_ids: string[]
          sync_frequency_minutes: number
          sync_mode: string
          updated_at: string
          winerim_api_token: string | null
          write_bottle: boolean
          write_glass: boolean
          write_mode: string
        }
        Insert: {
          api_token: string
          auto_create_families?: boolean
          auto_push_bottle?: boolean
          auto_push_glass?: boolean
          auto_push_on_create?: boolean
          auto_push_on_update?: boolean
          auto_push_verified_ready?: boolean
          backfill_days?: number
          base_url: string
          catalog_endpoint?: string | null
          catalog_product_count?: number | null
          catalog_sync_enabled?: boolean | null
          catalog_wine_candidate_count?: number | null
          circuit_breaker_paused_until?: string | null
          circuit_breaker_reason?: string | null
          consecutive_failures?: number
          created_at?: string
          default_bottle_format_name?: string | null
          default_family_id?: string | null
          default_glass_format_name?: string | null
          default_preparation_order_id?: string | null
          default_preparation_type_id?: string | null
          default_vat_id?: string | null
          default_vat_rate?: number | null
          default_warehouse_id?: string | null
          default_wine_family_name?: string | null
          enabled?: boolean
          estimated_glasses_per_bottle?: number
          id?: string
          last_business_day_synced?: string | null
          last_catalog_sync_at?: string | null
          last_sync_at?: string | null
          location_name: string
          provider?: string
          provider_config?: Json | null
          require_manual_review_before_push?: boolean
          restaurant_guid?: string | null
          selected_sale_center_ids?: string[]
          sync_frequency_minutes?: number
          sync_mode?: string
          updated_at?: string
          winerim_api_token?: string | null
          write_bottle?: boolean
          write_glass?: boolean
          write_mode?: string
        }
        Update: {
          api_token?: string
          auto_create_families?: boolean
          auto_push_bottle?: boolean
          auto_push_glass?: boolean
          auto_push_on_create?: boolean
          auto_push_on_update?: boolean
          auto_push_verified_ready?: boolean
          backfill_days?: number
          base_url?: string
          catalog_endpoint?: string | null
          catalog_product_count?: number | null
          catalog_sync_enabled?: boolean | null
          catalog_wine_candidate_count?: number | null
          circuit_breaker_paused_until?: string | null
          circuit_breaker_reason?: string | null
          consecutive_failures?: number
          created_at?: string
          default_bottle_format_name?: string | null
          default_family_id?: string | null
          default_glass_format_name?: string | null
          default_preparation_order_id?: string | null
          default_preparation_type_id?: string | null
          default_vat_id?: string | null
          default_vat_rate?: number | null
          default_warehouse_id?: string | null
          default_wine_family_name?: string | null
          enabled?: boolean
          estimated_glasses_per_bottle?: number
          id?: string
          last_business_day_synced?: string | null
          last_catalog_sync_at?: string | null
          last_sync_at?: string | null
          location_name?: string
          provider?: string
          provider_config?: Json | null
          require_manual_review_before_push?: boolean
          restaurant_guid?: string | null
          selected_sale_center_ids?: string[]
          sync_frequency_minutes?: number
          sync_mode?: string
          updated_at?: string
          winerim_api_token?: string | null
          write_bottle?: boolean
          write_glass?: boolean
          write_mode?: string
        }
        Relationships: []
      }
      product_mappings: {
        Row: {
          agora_product_id: string | null
          connection_id: string
          created_at: string
          format_type: string
          id: string
          last_sync_error: string | null
          last_synced_at: string | null
          match_method: string
          match_reasons: string[] | null
          match_score: number | null
          provider_product_id: string
          provider_product_name: string
          status: string
          updated_at: string
          winerim_wine_id: string | null
          winerim_wine_name: string | null
        }
        Insert: {
          agora_product_id?: string | null
          connection_id: string
          created_at?: string
          format_type?: string
          id?: string
          last_sync_error?: string | null
          last_synced_at?: string | null
          match_method?: string
          match_reasons?: string[] | null
          match_score?: number | null
          provider_product_id: string
          provider_product_name: string
          status?: string
          updated_at?: string
          winerim_wine_id?: string | null
          winerim_wine_name?: string | null
        }
        Update: {
          agora_product_id?: string | null
          connection_id?: string
          created_at?: string
          format_type?: string
          id?: string
          last_sync_error?: string | null
          last_synced_at?: string | null
          match_method?: string
          match_reasons?: string[] | null
          match_score?: number | null
          provider_product_id?: string
          provider_product_name?: string
          status?: string
          updated_at?: string
          winerim_wine_id?: string | null
          winerim_wine_name?: string | null
        }
        Relationships: []
      }
      provider_capabilities: {
        Row: {
          can_read_catalog: boolean
          can_read_sales: boolean
          can_write_products: string
          connection_id: string
          created_at: string
          id: string
          last_checked_at: string | null
          last_verified_at: string | null
          provider: string
          readiness_status: string
          updated_at: string
          webhook_supported: boolean
          write_endpoint: string | null
          write_endpoints_json: Json | null
          write_mode: string
        }
        Insert: {
          can_read_catalog?: boolean
          can_read_sales?: boolean
          can_write_products?: string
          connection_id: string
          created_at?: string
          id?: string
          last_checked_at?: string | null
          last_verified_at?: string | null
          provider?: string
          readiness_status?: string
          updated_at?: string
          webhook_supported?: boolean
          write_endpoint?: string | null
          write_endpoints_json?: Json | null
          write_mode?: string
        }
        Update: {
          can_read_catalog?: boolean
          can_read_sales?: boolean
          can_write_products?: string
          connection_id?: string
          created_at?: string
          id?: string
          last_checked_at?: string | null
          last_verified_at?: string | null
          provider?: string
          readiness_status?: string
          updated_at?: string
          webhook_supported?: boolean
          write_endpoint?: string | null
          write_endpoints_json?: Json | null
          write_mode?: string
        }
        Relationships: [
          {
            foreignKeyName: "provider_capabilities_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: true
            referencedRelation: "pos_connections"
            referencedColumns: ["id"]
          },
        ]
      }
      provider_credentials: {
        Row: {
          access_token_enc: string
          connection_id: string
          created_at: string
          expires_at: string | null
          id: string
          merchant_id: string
          oauth_state: string | null
          oauth_state_expires_at: string | null
          refresh_token_enc: string | null
          scopes: string[]
          status: string
          toast_access_token: string | null
          toast_client_id: string | null
          toast_client_secret: string | null
          toast_expires_at: string | null
          toast_refresh_token: string | null
          updated_at: string
        }
        Insert: {
          access_token_enc: string
          connection_id: string
          created_at?: string
          expires_at?: string | null
          id?: string
          merchant_id: string
          oauth_state?: string | null
          oauth_state_expires_at?: string | null
          refresh_token_enc?: string | null
          scopes?: string[]
          status?: string
          toast_access_token?: string | null
          toast_client_id?: string | null
          toast_client_secret?: string | null
          toast_expires_at?: string | null
          toast_refresh_token?: string | null
          updated_at?: string
        }
        Update: {
          access_token_enc?: string
          connection_id?: string
          created_at?: string
          expires_at?: string | null
          id?: string
          merchant_id?: string
          oauth_state?: string | null
          oauth_state_expires_at?: string | null
          refresh_token_enc?: string | null
          scopes?: string[]
          status?: string
          toast_access_token?: string | null
          toast_client_id?: string | null
          toast_client_secret?: string | null
          toast_expires_at?: string | null
          toast_refresh_token?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "provider_credentials_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: true
            referencedRelation: "pos_connections"
            referencedColumns: ["id"]
          },
        ]
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
          last_synced_at: string | null
          name: string
          price: number | null
          provider_product_id: string
          provider_updated_at: string | null
          raw_payload: Json | null
          sale_format: string | null
          sync_error: string | null
          sync_status: string
          updated_at: string
          vat_rate: number | null
          wine_reasons: string[] | null
          wine_score: number | null
          winerim_wine_id: string | null
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
          last_synced_at?: string | null
          name: string
          price?: number | null
          provider_product_id: string
          provider_updated_at?: string | null
          raw_payload?: Json | null
          sale_format?: string | null
          sync_error?: string | null
          sync_status?: string
          updated_at?: string
          vat_rate?: number | null
          wine_reasons?: string[] | null
          wine_score?: number | null
          winerim_wine_id?: string | null
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
          last_synced_at?: string | null
          name?: string
          price?: number | null
          provider_product_id?: string
          provider_updated_at?: string | null
          raw_payload?: Json | null
          sale_format?: string | null
          sync_error?: string | null
          sync_status?: string
          updated_at?: string
          vat_rate?: number | null
          wine_reasons?: string[] | null
          wine_score?: number | null
          winerim_wine_id?: string | null
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
      qtomas_review_decisions: {
        Row: {
          connection_id: string
          created_at: string
          decision_status: string
          family: string | null
          format_type: string
          id: string
          note: string | null
          provider_product_id: string
          provider_product_name: string
          selected_winerim_id: string | null
          selected_winerim_name: string | null
          units_30d: number
          updated_at: string
        }
        Insert: {
          connection_id: string
          created_at?: string
          decision_status?: string
          family?: string | null
          format_type?: string
          id?: string
          note?: string | null
          provider_product_id: string
          provider_product_name?: string
          selected_winerim_id?: string | null
          selected_winerim_name?: string | null
          units_30d?: number
          updated_at?: string
        }
        Update: {
          connection_id?: string
          created_at?: string
          decision_status?: string
          family?: string | null
          format_type?: string
          id?: string
          note?: string | null
          provider_product_id?: string
          provider_product_name?: string
          selected_winerim_id?: string | null
          selected_winerim_name?: string | null
          units_30d?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "qtomas_review_decisions_connection_id_fkey"
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
          provider_sold_at: string | null
          provider_sold_at_source: string | null
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
          provider_sold_at?: string | null
          provider_sold_at_source?: string | null
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
          provider_sold_at?: string | null
          provider_sold_at_source?: string | null
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
      stock_sync_log: {
        Row: {
          connection_id: string
          created_at: string
          error_message: string | null
          id: string
          idempotency_key: string | null
          product_name: string
          provider_product_id: string | null
          quantity: number
          sales_event_id: string | null
          sales_line_item_id: string | null
          status: string
          stock_id: number | null
          synced_at: string | null
          variant: string | null
          winerim_product_id: string | null
          winerim_response: Json | null
        }
        Insert: {
          connection_id: string
          created_at?: string
          error_message?: string | null
          id?: string
          idempotency_key?: string | null
          product_name: string
          provider_product_id?: string | null
          quantity?: number
          sales_event_id?: string | null
          sales_line_item_id?: string | null
          status?: string
          stock_id?: number | null
          synced_at?: string | null
          variant?: string | null
          winerim_product_id?: string | null
          winerim_response?: Json | null
        }
        Update: {
          connection_id?: string
          created_at?: string
          error_message?: string | null
          id?: string
          idempotency_key?: string | null
          product_name?: string
          provider_product_id?: string | null
          quantity?: number
          sales_event_id?: string | null
          sales_line_item_id?: string | null
          status?: string
          stock_id?: number | null
          synced_at?: string | null
          variant?: string | null
          winerim_product_id?: string | null
          winerim_response?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "stock_sync_log_sales_event_id_fkey"
            columns: ["sales_event_id"]
            isOneToOne: false
            referencedRelation: "sales_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_sync_log_sales_line_item_id_fkey"
            columns: ["sales_line_item_id"]
            isOneToOne: false
            referencedRelation: "sales_line_items"
            referencedColumns: ["id"]
          },
        ]
      }
      user_roles: {
        Row: {
          connection_id: string | null
          created_at: string
          id: string
          role: string
          user_id: string
        }
        Insert: {
          connection_id?: string | null
          created_at?: string
          id?: string
          role: string
          user_id: string
        }
        Update: {
          connection_id?: string | null
          created_at?: string
          id?: string
          role?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_roles_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "pos_connections"
            referencedColumns: ["id"]
          },
        ]
      }
      webhook_events: {
        Row: {
          connection_id: string | null
          created_at: string
          event_id: string
          event_type: string
          id: string
          payload: Json
          processed_at: string | null
          provider: string
          status: string
        }
        Insert: {
          connection_id?: string | null
          created_at?: string
          event_id: string
          event_type: string
          id?: string
          payload?: Json
          processed_at?: string | null
          provider?: string
          status?: string
        }
        Update: {
          connection_id?: string | null
          created_at?: string
          event_id?: string
          event_type?: string
          id?: string
          payload?: Json
          processed_at?: string | null
          provider?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "webhook_events_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "pos_connections"
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
      wine_type_family_mappings: {
        Row: {
          agora_family_id: string | null
          agora_family_name: string | null
          connection_id: string
          created_at: string
          id: string
          mapping_key: string
          updated_at: string
        }
        Insert: {
          agora_family_id?: string | null
          agora_family_name?: string | null
          connection_id: string
          created_at?: string
          id?: string
          mapping_key: string
          updated_at?: string
        }
        Update: {
          agora_family_id?: string | null
          agora_family_name?: string | null
          connection_id?: string
          created_at?: string
          id?: string
          mapping_key?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "wine_type_family_mappings_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "pos_connections"
            referencedColumns: ["id"]
          },
        ]
      }
      winerim_push_tracking: {
        Row: {
          agora_family_id: string | null
          agora_product_id: string | null
          connection_id: string
          created_at: string
          format: string
          id: string
          last_error: string | null
          pushed_at: string | null
          source: string
          sync_status: string
          task_id: string | null
          updated_at: string
          verified_at: string | null
          winerim_wine_id: string
        }
        Insert: {
          agora_family_id?: string | null
          agora_product_id?: string | null
          connection_id: string
          created_at?: string
          format?: string
          id?: string
          last_error?: string | null
          pushed_at?: string | null
          source?: string
          sync_status?: string
          task_id?: string | null
          updated_at?: string
          verified_at?: string | null
          winerim_wine_id: string
        }
        Update: {
          agora_family_id?: string | null
          agora_product_id?: string | null
          connection_id?: string
          created_at?: string
          format?: string
          id?: string
          last_error?: string | null
          pushed_at?: string | null
          source?: string
          sync_status?: string
          task_id?: string | null
          updated_at?: string
          verified_at?: string | null
          winerim_wine_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "winerim_push_tracking_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "pos_connections"
            referencedColumns: ["id"]
          },
        ]
      }
      winerim_wine_formats: {
        Row: {
          connection_id: string
          cost_price: number | null
          created_at: string
          format_key: string
          id: string
          is_active: boolean
          sale_price: number | null
          source_variant: string | null
          stock_id: number | null
          updated_at: string
          winerim_id: string
        }
        Insert: {
          connection_id: string
          cost_price?: number | null
          created_at?: string
          format_key: string
          id?: string
          is_active?: boolean
          sale_price?: number | null
          source_variant?: string | null
          stock_id?: number | null
          updated_at?: string
          winerim_id: string
        }
        Update: {
          connection_id?: string
          cost_price?: number | null
          created_at?: string
          format_key?: string
          id?: string
          is_active?: boolean
          sale_price?: number | null
          source_variant?: string | null
          stock_id?: number | null
          updated_at?: string
          winerim_id?: string
        }
        Relationships: []
      }
      winerim_wines: {
        Row: {
          bottle_purchase_price: number | null
          bottle_sale_price: number | null
          bottle_stock_id: number | null
          connection_id: string
          created_at: string
          ean: string | null
          format: string | null
          glass_cost_price: number | null
          glass_sale_price: number | null
          glass_stock_id: number | null
          grape_variety: string | null
          id: string
          is_active: boolean
          magnum_purchase_price: number | null
          magnum_sale_price: number | null
          magnum_stock_id: number | null
          name: string
          price: number | null
          pricing_missing_reason: string | null
          pricing_status: string
          raw_payload: Json | null
          region: string | null
          serve_by_glass: boolean
          sku: string | null
          stock_quantity: number | null
          updated_at: string
          vintage: string | null
          wine_type: string | null
          winerim_id: string
          winery: string | null
        }
        Insert: {
          bottle_purchase_price?: number | null
          bottle_sale_price?: number | null
          bottle_stock_id?: number | null
          connection_id: string
          created_at?: string
          ean?: string | null
          format?: string | null
          glass_cost_price?: number | null
          glass_sale_price?: number | null
          glass_stock_id?: number | null
          grape_variety?: string | null
          id?: string
          is_active?: boolean
          magnum_purchase_price?: number | null
          magnum_sale_price?: number | null
          magnum_stock_id?: number | null
          name: string
          price?: number | null
          pricing_missing_reason?: string | null
          pricing_status?: string
          raw_payload?: Json | null
          region?: string | null
          serve_by_glass?: boolean
          sku?: string | null
          stock_quantity?: number | null
          updated_at?: string
          vintage?: string | null
          wine_type?: string | null
          winerim_id: string
          winery?: string | null
        }
        Update: {
          bottle_purchase_price?: number | null
          bottle_sale_price?: number | null
          bottle_stock_id?: number | null
          connection_id?: string
          created_at?: string
          ean?: string | null
          format?: string | null
          glass_cost_price?: number | null
          glass_sale_price?: number | null
          glass_stock_id?: number | null
          grape_variety?: string | null
          id?: string
          is_active?: boolean
          magnum_purchase_price?: number | null
          magnum_sale_price?: number | null
          magnum_stock_id?: number | null
          name?: string
          price?: number | null
          pricing_missing_reason?: string | null
          pricing_status?: string
          raw_payload?: Json | null
          region?: string | null
          serve_by_glass?: boolean
          sku?: string | null
          stock_quantity?: number | null
          updated_at?: string
          vintage?: string | null
          wine_type?: string | null
          winerim_id?: string
          winery?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      review_winerim_variants: {
        Row: {
          capacity_liters: number | null
          connection_id: string | null
          cost_price: number | null
          ean: string | null
          format_key: string | null
          grape_variety: string | null
          is_active: boolean | null
          name: string | null
          origin: string | null
          region: string | null
          sale_price: number | null
          sku: string | null
          stock_id: number | null
          variant_source: string | null
          vintage: string | null
          wine_type: string | null
          winerim_id: string | null
          winery: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      acquire_agora_dispatch_lock: {
        Args: {
          p_connection_id: string
          p_job: string
          p_lock_token: string
          p_ttl_seconds?: number
        }
        Returns: boolean
      }
      can_access_connection: {
        Args: { _connection_id: string }
        Returns: boolean
      }
      claim_outbound_tasks: {
        Args: {
          p_connection_id: string
          p_limit?: number
          p_task_types: string[]
        }
        Returns: {
          attempts: number
          blocked_reason: string | null
          connection_id: string
          created_at: string
          external_id: string | null
          id: string
          last_error: string | null
          max_attempts: number
          next_retry_at: string | null
          payload_json: Json
          status: string
          task_type: string
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "outbound_tasks"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      has_role: { Args: { _role: string; _user_id: string }; Returns: boolean }
      invoke_connection_health_monitor: {
        Args: { fn_url: string; notify_clients?: boolean; service_key: string }
        Returns: undefined
      }
      invoke_connection_health_monitor_secure: {
        Args: {
          bearer_key: string
          fn_url: string
          monitor_secret: string
          notify_clients?: boolean
        }
        Returns: undefined
      }
      is_platform_admin: { Args: never; Returns: boolean }
      release_agora_dispatch_lock: {
        Args: { p_connection_id: string; p_job: string; p_lock_token: string }
        Returns: boolean
      }
      rescue_zombie_outbound_tasks: { Args: never; Returns: number }
      review_catalog_audit: {
        Args: {
          p_connection_id: string
          p_format?: string
          p_limit?: number
          p_offset?: number
          p_readback_max_age_minutes?: number
          p_search?: string
          p_status?: string
        }
        Returns: {
          agora_family_id: string
          agora_family_name: string
          agora_price: number
          agora_product_id: string
          agora_saleable: boolean
          agora_visible: boolean
          applied_at: string
          audit_status: string
          capacity_liters: number
          comparison: string
          detected_at: string
          differences: string[]
          format_key: string
          latency_seconds: number
          next_action: string
          push_error: string
          push_status: string
          queued_at: string
          read_at: string
          readback_fresh: boolean
          stock_id: number
          total_count: number
          wine_name: string
          wine_type: string
          winerim_id: string
          winerim_price: number
        }[]
      }
      review_catalog_audit_summary: {
        Args: { p_connection_id: string; p_readback_max_age_minutes?: number }
        Returns: {
          active_wines: number
          ambiguous: number
          expected_variants: number
          family_mismatch: number
          format_mismatch: number
          hidden: number
          last_read_at: string
          legacy_only: number
          matched_live: number
          missing_in_agora: number
          no_current_readback: number
          not_saleable: number
          pending_push: number
          price_mismatch: number
          push_failed: number
          read_variants: number
        }[]
      }
      review_format_key: { Args: { p: string }; Returns: string }
      review_format_liters: { Args: { p: string }; Returns: number }
      review_is_wine: {
        Args: { p_family: string; p_format: string; p_winerim_id: string }
        Returns: boolean
      }
      review_legacy_products: {
        Args: {
          p_connection_id: string
          p_limit?: number
          p_offset?: number
          p_search?: string
          p_state?: string
        }
        Returns: {
          agora_saleable: boolean
          agora_visible: boolean
          family: string
          format_key: string
          last_sale_at: string
          legacy_state: string
          mapping_status: string
          name: string
          next_action: string
          price: number
          provider_product_id: string
          reason: string
          sale_format: string
          source: string
          total_count: number
          tracking_status: string
          units_recent: number
        }[]
      }
      review_normalize_text: { Args: { p: string }; Returns: string }
      review_search_winerim_variants: {
        Args: {
          p_connection_id: string
          p_format?: string
          p_limit?: number
          p_offset?: number
          p_query?: string
        }
        Returns: {
          capacity_liters: number
          cost_price: number
          ean: string
          format_key: string
          grape_variety: string
          name: string
          origin: string
          region: string
          sale_price: number
          sku: string
          stock_id: number
          total_count: number
          variant_source: string
          vintage: string
          wine_type: string
          winerim_id: string
          winery: string
        }[]
      }
      review_unmapped_counters: {
        Args: { p_connection_id: string; p_days?: number }
        Returns: {
          draft: number
          needs_confirmation: number
          no_match: number
          ready: number
          sin_dato: number
          total: number
          units: number
        }[]
      }
      review_unmapped_families: {
        Args: { p_connection_id: string; p_days?: number }
        Returns: {
          family: string
          rows_count: number
        }[]
      }
      review_unmapped_products: {
        Args: {
          p_connection_id: string
          p_days?: number
          p_family?: string
          p_format?: string
          p_limit?: number
          p_offset?: number
          p_search?: string
          p_status?: string
        }
        Returns: {
          agora_price: number
          decided_at: string
          decision_status: string
          family: string
          format_key: string
          last_sale_at: string
          line_count: number
          note: string
          provider_product_id: string
          provider_product_name: string
          sale_format: string
          selected_format_key: string
          selected_winerim_id: string
          selected_winerim_name: string
          total_count: number
          units: number
        }[]
      }
      schedule_next_catalog_batch: {
        Args: {
          conn_id: string
          fn_url: string
          next_batch_size: number
          next_offset: number
          service_key: string
        }
        Returns: undefined
      }
      schedule_next_queue_batch: {
        Args: { conn_id: string; fn_url: string; service_key: string }
        Returns: undefined
      }
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
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
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
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
