import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { Plug, CheckCircle2, AlertTriangle, Clock, ArrowRight, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface Connector {
  id: string;
  name: string;
  description: string;
  logo: string;
  status: "connected" | "needs_attention" | "disconnected" | "coming_soon";
  locations?: number;
  lastSync?: string;
}

const connectors: Connector[] = [
  {
    id: "agora",
    name: "Agora POS",
    description: "Full-featured TPV integration with sales pull, product mapping, and bidirectional sync.",
    logo: "A",
    status: "connected",
    locations: 2,
    lastSync: "3 min ago",
  },
  {
    id: "revel",
    name: "Revel Systems",
    description: "Cloud-based POS for restaurants and retail.",
    logo: "R",
    status: "coming_soon",
  },
  {
    id: "square",
    name: "Square POS",
    description: "All-in-one commerce platform for point of sale and payments.",
    logo: "S",
    status: "coming_soon",
  },
  {
    id: "lightspeed",
    name: "Lightspeed",
    description: "Restaurant management and POS system.",
    logo: "L",
    status: "coming_soon",
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

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-2">
        {connectors.map((c, i) => {
          const badge = statusBadge[c.status];
          const Icon = statusIcon[c.status];
          const color = statusColor[c.status];
          const isAvailable = c.status !== "coming_soon";

          return (
            <motion.div
              key={c.id}
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.08 }}
              className={`group relative rounded-xl border bg-card shadow-card transition-all ${
                isAvailable
                  ? "border-border hover:border-primary/40 hover:shadow-glow cursor-pointer"
                  : "border-border/50 opacity-60"
              }`}
              onClick={() => {
                if (c.id === "agora") navigate("/integrations/agora");
              }}
            >
              <div className="p-6">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div
                      className={`flex h-10 w-10 items-center justify-center rounded-lg font-bold text-sm ${
                        isAvailable
                          ? "bg-primary/10 text-primary"
                          : "bg-secondary text-muted-foreground"
                      }`}
                    >
                      {c.logo}
                    </div>
                    <div>
                      <h3 className="text-sm font-semibold text-foreground">{c.name}</h3>
                      <div className="mt-0.5 flex items-center gap-1.5">
                        <Icon className={`h-3 w-3 ${color}`} />
                        <Badge variant={badge.variant} className="text-[10px] px-1.5 py-0">
                          {badge.label}
                        </Badge>
                      </div>
                    </div>
                  </div>

                  {isAvailable && (
                    <ArrowRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                  )}
                </div>

                <p className="mt-4 text-xs text-muted-foreground leading-relaxed">
                  {c.description}
                </p>

                {c.locations && (
                  <div className="mt-4 flex items-center gap-4 text-xs text-muted-foreground">
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
                    className="mt-4"
                    onClick={(e) => {
                      e.stopPropagation();
                      navigate("/integrations/agora");
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
}
