export type ChecklistProvider = "agora" | "revo";

export type ChecklistPriority = "required" | "recommended" | "optional";

export type ChecklistPhase =
  | "access"
  | "catalog"
  | "sales"
  | "stock"
  | "goLive"
  | "monitoring";

export interface IntegrationChecklistItem {
  id: string;
  phase: ChecklistPhase;
  priority: ChecklistPriority;
  title: string;
  rationale: string;
  evidence: string;
}

export interface IntegrationChecklist {
  provider: ChecklistProvider;
  title: string;
  summary: string;
  items: IntegrationChecklistItem[];
}

export const phaseLabels: Record<ChecklistPhase, string> = {
  access: "Acceso",
  catalog: "Catalogo",
  sales: "Ventas",
  stock: "Stock",
  goLive: "Go live",
  monitoring: "Monitorizacion",
};

export const priorityLabels: Record<ChecklistPriority, string> = {
  required: "Obligatorio",
  recommended: "Recomendado",
  optional: "Opcional",
};

const agoraChecklist: IntegrationChecklist = {
  provider: "agora",
  title: "Checklist Agora",
  summary: "Validacion operativa para dejar una conexion Agora preparada sin depender de Lovable Cloud.",
  items: [
    {
      id: "agora-url-token",
      phase: "access",
      priority: "required",
      title: "URL externa y token API validos",
      rationale: "Sin acceso estable no se pueden leer ventas, publicar vinos ni monitorizar caidas.",
      evidence: "Test OK contra export-master Families/Products desde el middleware.",
    },
    {
      id: "winerim-token",
      phase: "access",
      priority: "required",
      title: "Token Winerim valido",
      rationale: "El middleware necesita leer catalogo y escribir movimientos de venta/stock en Winerim.",
      evidence: "GET Winerim API v2 wines responde 200 con el token del cliente.",
    },
    {
      id: "master-data",
      phase: "catalog",
      priority: "required",
      title: "Master data Agora sincronizada",
      rationale: "Antes de escribir hay que conocer familias, productos, IVAs, price lists y preparaciones.",
      evidence: "Snapshot con familias, productos, IVA, price lists, preparation type/order, almacenes y centros de venta.",
    },
    {
      id: "winerim-catalog-ready",
      phase: "catalog",
      priority: "required",
      title: "Catalogo Winerim preparado",
      rationale: "Solo deben subir vinos activos con precio y formato valido; sin precio no deben aparecer en Agora.",
      evidence: "Conteo de vinos READY por botella, copa y magnum; lista de excluidos por sin precio/inactivo.",
    },
    {
      id: "family-strategy",
      phase: "catalog",
      priority: "required",
      title: "Estrategia de familias definida",
      rationale: "Si se mezclan legacy y Winerim sin regla clara, las ventas pueden no mapear y el TPV se desordena.",
      evidence: "Decision documentada: familias Winerim nuevas, reutilizacion de legacy, routing por regiones o matching por codigo.",
    },
    {
      id: "legacy-policy",
      phase: "catalog",
      priority: "required",
      title: "Legacy controlado de forma reversible",
      rationale: "Los botones antiguos pueden seguir apareciendo en buscador o pantallas locales y generar ventas no mapeadas.",
      evidence: "Legacy oculto/no vendible o listado de productos legacy mapeados manualmente.",
    },
    {
      id: "dry-run-create",
      phase: "catalog",
      priority: "required",
      title: "Dry-run de subida sin escrituras",
      rationale: "El preview detecta duplicados, formatos no exportables y colisiones antes de tocar Agora.",
      evidence: "Preview con productos que se crearían/actualizarían y 0 errores bloqueantes.",
    },
    {
      id: "post-write-verify",
      phase: "catalog",
      priority: "required",
      title: "Verificacion post-write",
      rationale: "Un import puede devolver timeout aunque Agora haya aplicado el XML; hay que verificar contra master data.",
      evidence: "Productos Winerim presentes, en familia correcta, con precio, IVA, preparacion y visibilidad esperadas.",
    },
    {
      id: "sales-endpoint",
      phase: "sales",
      priority: "required",
      title: "Ventas cerradas disponibles",
      rationale: "El flujo seguro de Agora se basa en Invoices de dias cerrados salvo conexiones intradia validadas.",
      evidence: "Fetch de Invoices de los ultimos dias con facturas y lineas parseadas.",
    },
    {
      id: "mapped-sale",
      phase: "sales",
      priority: "required",
      title: "Venta Winerim resuelta",
      rationale: "Si la venta entra desde un boton legacy no mapeado, Winerim no puede saber que vino/variante descontar.",
      evidence: "Al menos una linea de venta mapeada a winerim_product_id y variante BOTTLE/GLASS/MAGNUM.",
    },
    {
      id: "stock-deduction",
      phase: "stock",
      priority: "required",
      title: "Deduccion de stock confirmada",
      rationale: "La integracion no esta completa hasta que Winerim registra venta e historial con stockId correcto.",
      evidence: "stock_sync_log SUCCESS con variant, stock_id, idempotency_key y respuesta Winerim.",
    },
    {
      id: "idempotency",
      phase: "stock",
      priority: "required",
      title: "Idempotencia comprobada",
      rationale: "Releer el mismo cierre no puede descontar dos veces el mismo vino.",
      evidence: "Reejecucion del mismo dia sin nuevo PUT de stock para lineas ya sincronizadas.",
    },
    {
      id: "auto-create",
      phase: "goLive",
      priority: "required",
      title: "Alta automatica de nuevos vinos activada",
      rationale: "La promesa operativa es que un vino nuevo activo y con precio en Winerim aparezca en Agora.",
      evidence: "auto_push_on_create activo y prueba con vino nuevo o dry-run de elegibilidad.",
    },
    {
      id: "auto-update",
      phase: "goLive",
      priority: "recommended",
      title: "Actualizacion automatica diferencial",
      rationale: "Los cambios de precio deben propagarse sin reimportar masivamente productos no cambiados.",
      evidence: "auto_push_on_update solo activo si hay detector diferencial validado para esa conexion.",
    },
    {
      id: "intraday",
      phase: "goLive",
      priority: "optional",
      title: "Sincronizacion intradia",
      rationale: "Algunos Agora permiten leer ventas del dia; otros solo son fiables post-cierre.",
      evidence: "Feature flag intraday activo solo si Invoices del dia actual son estables y delta-safe.",
    },
    {
      id: "alerts",
      phase: "monitoring",
      priority: "required",
      title: "Alertas operativas activas",
      rationale: "Si el TPV se apaga, cambia IP o el token falla, el sistema debe avisar antes de que el cliente lo detecte.",
      evidence: "Monitor de salud con email interno y contactos de cliente/SAT cuando aplique.",
    },
  ],
};

const revoChecklist: IntegrationChecklist = {
  provider: "revo",
  title: "Checklist REVO",
  summary: "Validacion base para clientes REVO antes de activar catalogo, ventas y automatizacion.",
  items: [
    {
      id: "revo-credentials",
      phase: "access",
      priority: "required",
      title: "Tenant, access token y client-token validos",
      rationale: "REVO necesita los tres datos para autenticar llamadas API de partner/cliente.",
      evidence: "GET /v2/paymentMethods responde OK con tenant, Bearer token y client-token.",
    },
    {
      id: "winerim-token",
      phase: "access",
      priority: "required",
      title: "Token Winerim valido",
      rationale: "Necesario para leer catalogo y registrar ventas/stock en Winerim.",
      evidence: "GET Winerim API v2 wines responde 200.",
    },
    {
      id: "revo-locations",
      phase: "catalog",
      priority: "required",
      title: "Local/cuenta REVO definido",
      rationale: "En cuentas con REVO Master hay que saber que hoteles/outlets entran en alcance.",
      evidence: "Tenant y lista de locales/outlets confirmados por el cliente o IT.",
    },
    {
      id: "sales-window",
      phase: "sales",
      priority: "required",
      title: "Dia de negocio y cierre definidos",
      rationale: "El momento de lectura de ventas debe alinearse con cierre de caja/turno.",
      evidence: "Horario de cierre operativo documentado.",
    },
    {
      id: "mapping",
      phase: "sales",
      priority: "required",
      title: "Mapping de productos resuelto",
      rationale: "REVO debe devolver lineas identificables para enlazar venta con vino y variante Winerim.",
      evidence: "Venta de prueba mapeada y stock_sync_log SUCCESS.",
    },
    {
      id: "alerts",
      phase: "monitoring",
      priority: "required",
      title: "Alertas operativas activas",
      rationale: "IT y Winerim deben enterarse si tokens, permisos o endpoints fallan.",
      evidence: "Monitor de salud configurado.",
    },
  ],
};

const checklists: Record<ChecklistProvider, IntegrationChecklist> = {
  agora: agoraChecklist,
  revo: revoChecklist,
};

export function getIntegrationChecklist(provider: ChecklistProvider = "agora"): IntegrationChecklist {
  return checklists[provider] || checklists.agora;
}

export function getRequiredItems(checklist: IntegrationChecklist): IntegrationChecklistItem[] {
  return checklist.items.filter((item) => item.priority === "required");
}

export function getGoLiveBlockingItems(checklist: IntegrationChecklist): IntegrationChecklistItem[] {
  return checklist.items.filter((item) => item.priority === "required" && item.phase !== "monitoring");
}
