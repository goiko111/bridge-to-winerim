import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { CheckCircle2, AlertTriangle, Clock, ArrowRight, Plug, Globe } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

type MaturityLevel = "production" | "pilot" | "beta" | "experimental";

interface Connector {
  id: string;
  name: string;
  description: string;
  logo: string;
  status: "connected" | "needs_attention" | "disconnected" | "coming_soon";
  country: string;
  locations?: number;
  lastSync?: string;
  maturity?: MaturityLevel;
}

const maturityMeta: Record<MaturityLevel, { label: string; className: string }> = {
  production: { label: "Production-ready", className: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30" },
  pilot: { label: "Pilot-ready", className: "bg-sky-500/15 text-sky-700 dark:text-sky-400 border-sky-500/30" },
  beta: { label: "Beta", className: "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30" },
  experimental: { label: "Experimental", className: "bg-purple-500/15 text-purple-700 dark:text-purple-400 border-purple-500/30" },
};

const connectors: Connector[] = [
  // España
  {
    id: "agora",
    name: "Agora POS",
    description: "Full-featured TPV integration with sales pull, product mapping, and bidirectional sync.",
    logo: "A",
    status: "connected",
    country: "España",
    locations: 2,
    maturity: "production",
  },
  {
    id: "revo",
    name: "Revo XEF",
    description: "REST API with Bearer auth, pagination and 120 req/min. Sales, catalog and bidirectional sync.",
    logo: "R",
    status: "disconnected",
    country: "España",
    maturity: "pilot",
  },
  {
    id: "icg",
    name: "ICG FrontRest",
    description: "On-prem POS via SQL Server direct access. Sales, catalog and stock sync.",
    logo: "I",
    status: "disconnected",
    country: "España",
    maturity: "beta",
  },
  {
    id: "glop",
    name: "Glop",
    description: "TPV with API docs at apidoc.glop.es. Requires developer account.",
    logo: "G",
    status: "coming_soon",
    country: "España",
  },
  {
    id: "hiopos",
    name: "Hiopos / Hioffice",
    description: "Export/Import file-based integration. Upload CSV/XML sales & articles, generate import files for HIOPOS.",
    logo: "H",
    status: "disconnected",
    country: "España",
    maturity: "beta",
  },
  {
    id: "turbopos",
    name: "Turbopos",
    description: "No public API. On-prem export or partner integration required.",
    logo: "T",
    status: "coming_soon",
    country: "España",
  },
  {
    id: "bdp",
    name: "BDP NET",
    description: "Weblink Rest API integration. Configurable base URL, port, user credentials and export profile.",
    logo: "B",
    status: "disconnected",
    country: "España",
  },
  // Italia
  {
    id: "tilby",
    name: "Zucchetti Tilby",
    description: "Developer Program with Bearer token auth, /v2/sales endpoints, and sandbox environment.",
    logo: "T",
    status: "coming_soon",
    country: "Italia",
  },
  {
    id: "cassa",
    name: "Cassa in Cloud",
    description: "TeamSystem enterprise POS. API key auth, token-based access, HMAC-signed webhooks.",
    logo: "C",
    status: "disconnected",
    country: "Italia",
  },
  {
    id: "scloby",
    name: "Scloby",
    description: "OAuth2 + OpenAPI. Documentation referenced via documentation.json.",
    logo: "S",
    status: "coming_soon",
    country: "Italia",
  },
  {
    id: "rch",
    name: "RCH",
    description: "No public API. Contact via commercial channels or marketplace.",
    logo: "R",
    status: "coming_soon",
    country: "Italia",
  },
  {
    id: "tcpos",
    name: "Kumo (TCPOS)",
    description: "Zucchetti TCPOS via Kumo REST API (V8). Basic auth, Swagger-documented endpoints for sales, catalog and orders.",
    logo: "K",
    status: "disconnected",
    country: "Italia",
  },
  // México
  {
    id: "softrestaurant",
    name: "SoftRestaurant",
    description: "REST/JSON API with AuthorizedApp header. Catalog endpoints available, sales TBD.",
    logo: "S",
    status: "coming_soon",
    country: "México",
  },
  {
    id: "poster",
    name: "Poster POS",
    description: "Developer portal available. Contact partnerships via contact@joinposter.com.",
    logo: "P",
    status: "coming_soon",
    country: "México",
  },
  {
    id: "fudo",
    name: "Fudo",
    description: "Limited APIs (order injection + catalog query). Sales scope must be requested explicitly.",
    logo: "F",
    status: "coming_soon",
    country: "México",
  },
  // USA
  {
    id: "toast",
    name: "Toast POS",
    description: "Standard API access: orders polling, business date sync, Menus V2, webhooks, and circuit breaker resilience.",
    logo: "T",
    status: "disconnected",
    country: "USA",
    maturity: "pilot",
  },
  {
    id: "clover",
    name: "Clover",
    description: "OAuth2 + apps. Orders, payments, items, webhooks. Rate limits: 50 req/s app, 16 req/s token.",
    logo: "C",
    status: "disconnected",
    country: "USA",
  },
  {
    id: "square",
    name: "Square POS",
    description: "OAuth2 + Orders search + Catalog + Webhooks. Handle 429/backoff for rate limits.",
    logo: "S",
    status: "disconnected",
    country: "USA",
  },
  {
    id: "lightspeed",
    name: "Lightspeed Restaurant",
    description: "K-Series OpenAPI. Items, financial data, and webhooks supported.",
    logo: "L",
    status: "coming_soon",
    country: "USA",
  },
  {
    id: "revel",
    name: "Revel Systems",
    description: "REST + Bearer auth with webhooks (menu changed). Requires platform credentials.",
    logo: "R",
    status: "coming_soon",
    country: "USA",
  },
  {
    id: "aloha",
    name: "NCR Aloha",
    description: "Aloha Cloud In-Store API with TLS/gRPC + BSL tokens. Requires rep enablement.",
    logo: "N",
    status: "coming_soon",
    country: "USA",
    maturity: "experimental",
  },
  {
    id: "touchbistro",
    name: "TouchBistro",
    description: "CSV report imports (Menu Item Sales, Bills, Payments, Items) + optional Private API for approved partners.",
    logo: "T",
    status: "disconnected",
    country: "USA",
    maturity: "pilot",
  },
  {
    id: "simphony",
    name: "Oracle MICROS Simphony",
    description: "REST APIs with OAuth2/TLS. CCAPI for config/catalog, STS Gen2 for cloud transactions.",
    logo: "O",
    status: "disconnected",
    country: "USA",
  },
];

const statusBadge: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  connected: { label: "Connected", variant: "default" },
  needs_attention: { label: "Needs Attention", variant: "destructive" },
  disconnected: { label: "Disconnected", variant: "secondary" },
  coming_soon: { label: "Coming Soon", variant: "outline" },
};

const statusIcon: Record<string, typeof CheckCircle2> = {
  connected: CheckCircle2,
  needs_attention: AlertTriangle,
  disconnected: Plug,
  coming_soon: Clock,
};

const statusColor: Record<string, string> = {
  connected: "text-success",
  needs_attention: "text-warning",
  disconnected: "text-muted-foreground",
  coming_soon: "text-muted-foreground",
};

const countryFlags: Record<string, string> = {
  "España": "🇪🇸",
  "Italia": "🇮🇹",
  "México": "🇲🇽",
  "USA": "🇺🇸",
};

const countries = ["España", "Italia", "México", "USA"];

export default function Integrations() {
  const navigate = useNavigate();

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Integrations</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Connect your TPV systems to sync sales, products, and analytics with Winerim.
        </p>
      </div>

      {countries.map((country) => {
        const countryConnectors = connectors.filter((c) => c.country === country);
        if (countryConnectors.length === 0) return null;

        return (
          <div key={country} className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="text-lg">{countryFlags[country]}</span>
              <h2 className="text-sm font-semibold text-foreground uppercase tracking-wide">{country}</h2>
              <span className="text-xs text-muted-foreground">({countryConnectors.length})</span>
            </div>

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {countryConnectors.map((c, i) => {
                const badge = statusBadge[c.status];
                const Icon = statusIcon[c.status];
                const color = statusColor[c.status];
                const isAvailable = c.status !== "coming_soon";

                return (
                  <motion.div
                    key={c.id}
                    initial={{ opacity: 0, y: 16 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: i * 0.05 }}
                    className={`group relative rounded-xl border bg-card shadow-card transition-all ${
                      isAvailable
                        ? "border-border hover:border-primary/40 hover:shadow-glow cursor-pointer"
                        : "border-border/50 opacity-60"
                    }`}
                    onClick={() => {
                      if (c.id === "agora") navigate("/integrations/agora");
                      if (c.id === "revo") navigate("/integrations/revo");
                      if (c.id === "tcpos") navigate("/integrations/tcpos");
                      if (c.id === "clover") navigate("/integrations/clover");
                      if (c.id === "square") navigate("/integrations/square");
                      if (c.id === "simphony") navigate("/integrations/simphony");
                      if (c.id === "cassa") navigate("/integrations/cassa");
                      if (c.id === "bdp") navigate("/integrations/bdp");
                      if (c.id === "icg") navigate("/integrations/icg");
                      if (c.id === "hiopos") navigate("/integrations/hiopos");
                      if (c.id === "touchbistro") navigate("/integrations/touchbistro");
                      if (c.id === "toast") navigate("/integrations/toast");
                    }}
                  >
                    <div className="p-5">
                      <div className="flex items-start justify-between">
                        <div className="flex items-center gap-3">
                          <div
                            className={`flex h-9 w-9 items-center justify-center rounded-lg font-bold text-xs ${
                              isAvailable
                                ? "bg-primary/10 text-primary"
                                : "bg-secondary text-muted-foreground"
                            }`}
                          >
                            {c.logo}
                          </div>
                          <div>
                            <h3 className="text-sm font-semibold text-foreground">{c.name}</h3>
                            <div className="mt-0.5 flex items-center gap-1.5 flex-wrap">
                              <Icon className={`h-3 w-3 ${color}`} />
                              <Badge variant={badge.variant} className="text-[10px] px-1.5 py-0">
                                {badge.label}
                              </Badge>
                              {c.maturity && (
                                <span className={`inline-flex items-center rounded-full border px-1.5 py-0 text-[10px] font-medium leading-4 ${maturityMeta[c.maturity].className}`}>
                                  {maturityMeta[c.maturity].label}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>

                        {isAvailable && (
                          <ArrowRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                        )}
                      </div>

                      <p className="mt-3 text-xs text-muted-foreground leading-relaxed line-clamp-2">
                        {c.description}
                      </p>

                      {c.locations && (
                        <div className="mt-3 flex items-center gap-4 text-xs text-muted-foreground">
                          <span>{c.locations} location{c.locations > 1 ? "s" : ""}</span>
                          {c.lastSync && (
                            <span className="flex items-center gap-1">
                              <Clock className="h-3 w-3" />
                              Last sync {c.lastSync}
                            </span>
                          )}
                        </div>
                      )}

                      {isAvailable && c.status === "disconnected" && (
                        <Button
                          size="sm"
                          className="mt-3"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (c.id === "agora") navigate("/integrations/agora");
                            if (c.id === "revo") navigate("/integrations/revo");
                            if (c.id === "tcpos") navigate("/integrations/tcpos");
                            if (c.id === "clover") navigate("/integrations/clover");
                            if (c.id === "square") navigate("/integrations/square");
                            if (c.id === "simphony") navigate("/integrations/simphony");
                            if (c.id === "cassa") navigate("/integrations/cassa");
                             if (c.id === "bdp") navigate("/integrations/bdp");
                             if (c.id === "icg") navigate("/integrations/icg");
                             if (c.id === "hiopos") navigate("/integrations/hiopos");
                             if (c.id === "touchbistro") navigate("/integrations/touchbistro");
                             if (c.id === "toast") navigate("/integrations/toast");
                           }}
                         >
                          Connect
                        </Button>
                      )}
                    </div>
                  </motion.div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
