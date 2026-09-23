import { useCallback, useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { AlertTriangle, CheckCircle2, ClipboardList, Info, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "@/hooks/use-toast";

type Category = "CATALOGO" | "COMANDAS" | "VENTAS" | "STOCK" | "PRECIOS" | "OTROS";
type Impact = "INFO" | "IMPORTANTE" | "BLOQUEANTE";
type Status = "OPEN" | "ACCEPTED" | "RESOLVED";

interface Specific {
  id: string;
  connection_id: string;
  category: Category;
  title: string;
  detail: string;
  impact: Impact;
  status: Status;
  reported_by: string | null;
  reported_at: string | null;
  created_at: string;
  updated_at: string;
}

interface Connection {
  id: string;
  location_name: string;
  provider: string;
}

const CATEGORY_LABEL: Record<Category, string> = {
  CATALOGO: "Catálogo",
  COMANDAS: "Comandas / cocina",
  VENTAS: "Ventas",
  STOCK: "Stock",
  PRECIOS: "Precios",
  OTROS: "Otros",
};

const IMPACT_LABEL: Record<Impact, string> = {
  INFO: "Informativo",
  IMPORTANTE: "Importante",
  BLOQUEANTE: "Bloqueante",
};

const STATUS_LABEL: Record<Status, string> = {
  OPEN: "Abierto",
  ACCEPTED: "Aceptado / así trabajamos",
  RESOLVED: "Resuelto",
};

const impactStyle: Record<Impact, { icon: typeof Info; className: string }> = {
  INFO: { icon: Info, className: "bg-info/10 text-info border-info/30" },
  IMPORTANTE: { icon: AlertTriangle, className: "bg-warning/10 text-warning border-warning/30" },
  BLOQUEANTE: { icon: AlertTriangle, className: "bg-destructive/10 text-destructive border-destructive/30" },
};

const statusStyle: Record<Status, string> = {
  OPEN: "bg-warning/10 text-warning border-warning/30",
  ACCEPTED: "bg-info/10 text-info border-info/30",
  RESOLVED: "bg-success/10 text-success border-success/30",
};

const emptyDraft = {
  category: "OTROS" as Category,
  title: "",
  detail: "",
  impact: "INFO" as Impact,
  status: "OPEN" as Status,
  reported_by: "",
};

export default function IntegrationSpecifics() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [connectionId, setConnectionId] = useState<string>("");
  const [items, setItems] = useState<Specific[]>([]);
  const [loading, setLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [draft, setDraft] = useState(emptyDraft);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase
        .from("pos_connections")
        .select("id, location_name, provider")
        .order("location_name");
      if (error) {
        toast({ title: "No se pudieron cargar los restaurantes", description: error.message, variant: "destructive" });
        return;
      }
      const rows = (data || []) as Connection[];
      setConnections(rows);
      setConnectionId((current) => current || rows[0]?.id || "");
    })();
  }, []);

  const loadItems = useCallback(async (connId: string) => {
    if (!connId) return;
    setLoading(true);
    const { data, error } = await supabase
      .from("integration_specifics")
      .select("*")
      .eq("connection_id", connId)
      .order("created_at", { ascending: false });
    setLoading(false);
    if (error) {
      toast({ title: "No se pudieron cargar las particularidades", description: error.message, variant: "destructive" });
      return;
    }
    setItems((data || []) as Specific[]);
  }, []);

  useEffect(() => {
    loadItems(connectionId);
  }, [connectionId, loadItems]);

  const currentConnection = useMemo(
    () => connections.find((c) => c.id === connectionId),
    [connections, connectionId],
  );

  const openCount = items.filter((i) => i.status === "OPEN").length;

  async function saveDraft() {
    if (!connectionId || !draft.title.trim()) {
      toast({ title: "Falta el título", description: "Escribe en una línea de qué va la particularidad.", variant: "destructive" });
      return;
    }
    setSaving(true);
    const { error } = await supabase.from("integration_specifics").insert({
      connection_id: connectionId,
      category: draft.category,
      title: draft.title.trim(),
      detail: draft.detail.trim(),
      impact: draft.impact,
      status: draft.status,
      reported_by: draft.reported_by.trim() || null,
      reported_at: new Date().toISOString(),
    });
    setSaving(false);
    if (error) {
      toast({ title: "No se pudo guardar", description: error.message, variant: "destructive" });
      return;
    }
    setDraft(emptyDraft);
    setShowForm(false);
    toast({ title: "Particularidad guardada" });
    loadItems(connectionId);
  }

  async function updateStatus(item: Specific, status: Status) {
    const { error } = await supabase.from("integration_specifics").update({ status }).eq("id", item.id);
    if (error) {
      toast({ title: "No se pudo actualizar", description: error.message, variant: "destructive" });
      return;
    }
    loadItems(connectionId);
  }

  async function remove(item: Specific) {
    const { error } = await supabase.from("integration_specifics").delete().eq("id", item.id);
    if (error) {
      toast({ title: "No se pudo borrar", description: error.message, variant: "destructive" });
      return;
    }
    loadItems(connectionId);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <ClipboardList className="h-5 w-5 text-primary" />
            Particularidades por integración
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Cómo trabaja cada restaurante y qué condiciones propias hay que respetar al publicar sus vinos.
          </p>
        </div>
        <div className="flex items-end gap-2">
          <div className="w-72">
            <Label className="text-xs text-muted-foreground">Restaurante</Label>
            <Select value={connectionId} onValueChange={setConnectionId}>
              <SelectTrigger>
                <SelectValue placeholder="Elige restaurante" />
              </SelectTrigger>
              <SelectContent>
                {connections.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.location_name} · {c.provider}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button variant="outline" size="icon" onClick={() => loadItems(connectionId)} disabled={loading}>
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
          <Button onClick={() => setShowForm((v) => !v)}>
            <Plus className="mr-1 h-4 w-4" />
            Añadir
          </Button>
        </div>
      </div>

      {currentConnection && (
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <Badge variant="outline">{items.length} anotadas</Badge>
          {openCount > 0 && <Badge className="bg-warning/10 text-warning border-warning/30">{openCount} abiertas</Badge>}
        </div>
      )}

      {showForm && (
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          className="space-y-4 rounded-lg border border-border bg-card/60 p-4 backdrop-blur"
        >
          <div className="grid gap-4 md:grid-cols-3">
            <div>
              <Label className="text-xs text-muted-foreground">Categoría</Label>
              <Select value={draft.category} onValueChange={(v) => setDraft({ ...draft, category: v as Category })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(CATEGORY_LABEL).map(([k, v]) => (
                    <SelectItem key={k} value={k}>{v}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">Impacto</Label>
              <Select value={draft.impact} onValueChange={(v) => setDraft({ ...draft, impact: v as Impact })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(IMPACT_LABEL).map(([k, v]) => (
                    <SelectItem key={k} value={k}>{v}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">Estado</Label>
              <Select value={draft.status} onValueChange={(v) => setDraft({ ...draft, status: v as Status })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(STATUS_LABEL).map(([k, v]) => (
                    <SelectItem key={k} value={k}>{v}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">Título</Label>
            <Input
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              placeholder="Copa y botella en un solo botón con ratios de venta"
            />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">Detalle</Label>
            <Textarea
              rows={5}
              value={draft.detail}
              onChange={(e) => setDraft({ ...draft, detail: e.target.value })}
              placeholder="Qué pide el restaurante, por qué, y qué hacemos nosotros."
            />
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <Label className="text-xs text-muted-foreground">Lo comenta</Label>
              <Input
                value={draft.reported_by}
                onChange={(e) => setDraft({ ...draft, reported_by: e.target.value })}
                placeholder="Nombre y cargo"
              />
            </div>
          </div>
          <div className="flex gap-2">
            <Button onClick={saveDraft} disabled={saving}>Guardar</Button>
            <Button variant="ghost" onClick={() => { setShowForm(false); setDraft(emptyDraft); }}>Cancelar</Button>
          </div>
        </motion.div>
      )}

      <div className="space-y-3">
        {!loading && items.length === 0 && (
          <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            Todavía no hay particularidades anotadas para este restaurante.
          </div>
        )}
        {items.map((item) => {
          const Icon = impactStyle[item.impact].icon;
          return (
            <motion.div
              key={item.id}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              className="rounded-lg border border-border bg-card/60 p-4 backdrop-blur"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex items-start gap-3">
                  <Icon className={`mt-0.5 h-4 w-4 ${item.impact === "INFO" ? "text-info" : item.impact === "IMPORTANTE" ? "text-warning" : "text-destructive"}`} />
                  <div>
                    <div className="font-medium">{item.title}</div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <Badge variant="outline">{CATEGORY_LABEL[item.category]}</Badge>
                      <Badge variant="outline" className={impactStyle[item.impact].className}>{IMPACT_LABEL[item.impact]}</Badge>
                      <Badge variant="outline" className={statusStyle[item.status]}>{STATUS_LABEL[item.status]}</Badge>
                      {item.reported_by && <span>Lo comenta: {item.reported_by}</span>}
                      <span>{new Date(item.created_at).toLocaleDateString()}</span>
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  {item.status !== "ACCEPTED" && (
                    <Button variant="ghost" size="sm" onClick={() => updateStatus(item, "ACCEPTED")}>Aceptar</Button>
                  )}
                  {item.status !== "RESOLVED" && (
                    <Button variant="ghost" size="sm" onClick={() => updateStatus(item, "RESOLVED")}>
                      <CheckCircle2 className="mr-1 h-4 w-4" />Resuelto
                    </Button>
                  )}
                  {item.status !== "OPEN" && (
                    <Button variant="ghost" size="sm" onClick={() => updateStatus(item, "OPEN")}>Reabrir</Button>
                  )}
                  <Button variant="ghost" size="icon" onClick={() => remove(item)}>
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              </div>
              {item.detail && (
                <p className="mt-3 whitespace-pre-wrap text-sm text-muted-foreground">{item.detail}</p>
              )}
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}
