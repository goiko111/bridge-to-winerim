import { useState, useEffect, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  ArrowLeft, ArrowRight, CheckCircle2, Loader2, XCircle,
  Search, Link2, Settings2, Map, Power, Wine, Calendar,
  Download, Filter, Grape, ShieldCheck, ShieldX, HelpCircle, ChevronDown,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { useTcposConnection, SalesEvent, SalesLineItem, DetectedFamily } from "@/hooks/useTcposConnection";
import ProviderReadinessPanel from "@/components/ProviderReadinessPanel";

const steps = [
  { id: 1, label: "Connessione", icon: Link2 },
  { id: 2, label: "Sync Settings", icon: Settings2 },
  { id: 3, label: "Famiglie", icon: Grape },
  { id: 4, label: "Vendite & Mapping", icon: Map },
  { id: 5, label: "Go Live", icon: Power },
];

// ── Step 1: Connection ──
function StepConnection({
  locationName, setLocationName,
  baseUrl, setBaseUrl,
  tcposUser, setTcposUser,
  tcposPassword, setTcposPassword,
  winerimApiToken, setWinerimApiToken,
  testStatus, testError,
  onTest,
}: {
  locationName: string; setLocationName: (v: string) => void;
  baseUrl: string; setBaseUrl: (v: string) => void;
  tcposUser: string; setTcposUser: (v: string) => void;
  tcposPassword: string; setTcposPassword: (v: string) => void;
  winerimApiToken: string; setWinerimApiToken: (v: string) => void;
  testStatus: string; testError: string | null;
  onTest: () => void;
}) {
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Dettagli Connessione</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Inserisci l'URL del server Kumo/TCPOS, le credenziali di accesso e il nome della location.
        </p>
      </div>
      <div className="space-y-4">
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Nome Location</label>
          <Input placeholder="es. Ristorante Da Mario" value={locationName} onChange={(e) => setLocationName(e.target.value)} className="bg-background text-sm" />
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Base URL</label>
          <Input placeholder="http://lemans.b-positive.ch:40029" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} className="bg-background font-mono text-sm" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Utente</label>
            <Input placeholder="es. 2021" value={tcposUser} onChange={(e) => setTcposUser(e.target.value)} className="bg-background font-mono text-sm" />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Password</label>
            <Input type="password" placeholder="••••••••" value={tcposPassword} onChange={(e) => setTcposPassword(e.target.value)} className="bg-background font-mono text-sm" />
          </div>
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Winerim API Token</label>
          <Input type="password" placeholder="Token API v2 di Winerim" value={winerimApiToken} onChange={(e) => setWinerimApiToken(e.target.value)} className="bg-background font-mono text-sm" />
          <p className="mt-1 text-[11px] text-muted-foreground">Token dell'API v2 di Winerim per sincronizzare catalogo e stock.</p>
        </div>
        <Button onClick={onTest} disabled={testStatus === "testing" || !baseUrl || !tcposUser || !tcposPassword} variant="secondary" className="w-full">
          {testStatus === "testing" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {testStatus === "success" && <CheckCircle2 className="mr-2 h-4 w-4 text-success" />}
          {testStatus === "error" && <XCircle className="mr-2 h-4 w-4 text-destructive" />}
          {testStatus === "idle" && "Test Connessione"}
          {testStatus === "testing" && "Test in corso…"}
          {testStatus === "success" && "Connessione riuscita"}
          {testStatus === "error" && (testError || "Connessione fallita")}
        </Button>
      </div>
    </div>
  );
}

// ── Step 2: Sync Settings ──
function StepSyncSettings({
  syncMode, setSyncMode,
  frequency, setFrequency,
  backfill, setBackfill,
}: {
  syncMode: string; setSyncMode: (v: "PULL_ONLY" | "BIDIRECTIONAL") => void;
  frequency: number; setFrequency: (v: number) => void;
  backfill: number; setBackfill: (v: number) => void;
}) {
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Impostazioni Sync</h2>
        <p className="mt-1 text-sm text-muted-foreground">Configura modalità e frequenza di sincronizzazione.</p>
      </div>
      <div className="space-y-4">
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-2 block">Modalità Sync</label>
          <div className="grid grid-cols-2 gap-3">
            {(["PULL_ONLY", "BIDIRECTIONAL"] as const).map((mode) => (
              <button key={mode} onClick={() => setSyncMode(mode)} className={`rounded-lg border p-3 text-left transition-all ${syncMode === mode ? "border-primary bg-primary/5" : "border-border hover:border-primary/30"}`}>
                <span className="text-sm font-medium text-foreground">{mode === "PULL_ONLY" ? "Solo Pull" : "Bidirezionale"}</span>
                <p className="mt-0.5 text-xs text-muted-foreground">{mode === "PULL_ONLY" ? "Leggi vendite da TCPOS" : "Leggi vendite + sincronizza vini"}</p>
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-2 block">Frequenza Sync</label>
          <div className="flex gap-2">
            {[5, 10, 15, 30, 60].map((f) => (
              <button key={f} onClick={() => setFrequency(f)} className={`rounded-lg border px-3 py-2 text-xs font-medium transition-all ${frequency === f ? "border-primary bg-primary/5 text-primary" : "border-border text-muted-foreground hover:border-primary/30"}`}>
                {f} min
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-2 block">Periodo di Backfill</label>
          <div className="flex gap-2">
            {[7, 30, 90].map((d) => (
              <button key={d} onClick={() => setBackfill(d)} className={`rounded-lg border px-3 py-2 text-xs font-medium transition-all ${backfill === d ? "border-primary bg-primary/5 text-primary" : "border-border text-muted-foreground hover:border-primary/30"}`}>
                Ultimi {d} giorni
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Step 3: Families ──
function StepFamilies({
  detectedFamilies, loadingDays, loadingSales,
  familyOverrides, setFamilyOverrides,
  scanStats, daysWithSales, selectedDay,
  onRunHistoricalScan, salesEvents,
}: {
  detectedFamilies: DetectedFamily[];
  loadingDays: boolean; loadingSales: boolean;
  familyOverrides: Record<string, boolean>;
  setFamilyOverrides: (v: Record<string, boolean>) => void;
  scanStats: { totalScanned: number; totalInvoicesFound: number } | null;
  daysWithSales: string[];
  selectedDay: string | null;
  onRunHistoricalScan: () => void;
  salesEvents: SalesEvent[];
}) {
  const [expandedFamily, setExpandedFamily] = useState<string | null>(null);

  const familyProducts = useMemo(() => {
    const map: Record<string, { name: string; format: string; unitPrice: number; quantity: number }[]> = {};
    for (const ev of salesEvents) {
      for (const line of ev.lines) {
        const fam = line.family || "Senza famiglia";
        if (!map[fam]) map[fam] = [];
        const existing = map[fam].find((p) => p.name === line.name && p.format === line.format);
        if (existing) { existing.quantity += line.quantity; }
        else { map[fam].push({ name: line.name, format: line.format, unitPrice: line.unit_price, quantity: line.quantity }); }
      }
    }
    for (const fam of Object.keys(map)) { map[fam].sort((a, b) => a.name.localeCompare(b.name)); }
    return map;
  }, [salesEvents]);

  const sortedFamilies = useMemo(() => {
    return [...detectedFamilies].sort((a, b) => {
      const aWine = a.name in familyOverrides ? familyOverrides[a.name] : a.suggestedWine;
      const bWine = b.name in familyOverrides ? familyOverrides[b.name] : b.suggestedWine;
      if (aWine !== bWine) return aWine ? -1 : 1;
      const confOrder = { high: 0, medium: 1, low: 2 };
      if (a.confidence !== b.confidence) return confOrder[a.confidence] - confOrder[b.confidence];
      return b.itemCount - a.itemCount;
    });
  }, [detectedFamilies, familyOverrides]);

  const wineCount = sortedFamilies.filter((f) => f.name in familyOverrides ? familyOverrides[f.name] : f.suggestedWine).length;

  const confidenceIcon = (c: "high" | "medium" | "low") => {
    if (c === "high") return <ShieldCheck className="h-3.5 w-3.5 text-success" />;
    if (c === "medium") return <HelpCircle className="h-3.5 w-3.5 text-warning" />;
    return <ShieldX className="h-3.5 w-3.5 text-muted-foreground" />;
  };

  const isLoading = loadingDays || loadingSales;

  if (isLoading) {
    return (
      <div className="space-y-5">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Classificazione Famiglie Vino</h2>
          <p className="mt-1 text-sm text-muted-foreground">Scansione dati vendite per famiglie prodotto…</p>
        </div>
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          <span className="ml-2 text-sm text-muted-foreground">
            {loadingDays ? "Scansione giorni lavorativi (fino a 60 giorni)…" : "Caricamento dati vendite…"}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Classificazione Famiglie Vino</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {detectedFamilies.length > 0
            ? <>Rilevate <span className="font-medium text-foreground">{detectedFamilies.length}</span> famiglie prodotto. Conferma quali contengono vini.</>
            : "Nessuna famiglia prodotto rilevata."}
        </p>
      </div>

      {scanStats && (
        <div className="rounded-lg border border-border bg-secondary/30 p-3 space-y-1">
          <p className="text-xs font-medium text-muted-foreground">Risultati Scansione</p>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
            <span className="text-muted-foreground">Giorni scansionati</span>
            <span className="font-mono text-foreground">{scanStats.totalScanned}</span>
            <span className="text-muted-foreground">Giorni con vendite</span>
            <span className="font-mono text-foreground">{daysWithSales.length}</span>
            <span className="text-muted-foreground">Totale ricevute trovate</span>
            <span className="font-mono text-foreground">{scanStats.totalInvoicesFound}</span>
            {selectedDay && (
              <>
                <span className="text-muted-foreground">Ultimo giorno con dati</span>
                <span className="font-mono text-foreground">{selectedDay}</span>
              </>
            )}
            <span className="text-muted-foreground">Famiglie rilevate</span>
            <span className="font-mono text-foreground">{detectedFamilies.length}</span>
          </div>
        </div>
      )}

      {detectedFamilies.length === 0 && (
        <div className="text-center py-8 space-y-4 rounded-lg border border-border bg-secondary/20">
          <p className="text-sm text-muted-foreground">
            {daysWithSales.length === 0
              ? "Nessuna chiusura cassa trovata nel periodo scansionato."
              : "Nessuna famiglia prodotto trovata. Prova con una scansione più ampia."}
          </p>
          <Button variant="secondary" onClick={onRunHistoricalScan}>
            <Search className="mr-2 h-4 w-4" />
            Scansione Storica (90 giorni)
          </Button>
        </div>
      )}

      {detectedFamilies.length > 0 && (
        <>
          <div className="flex gap-4 text-xs">
            <div className="flex items-center gap-1.5">
              <div className="h-2.5 w-2.5 rounded-full bg-success" />
              <span className="text-muted-foreground"><span className="font-medium text-foreground">{wineCount}</span> famiglie vino</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="h-2.5 w-2.5 rounded-full bg-muted-foreground" />
              <span className="text-muted-foreground"><span className="font-medium text-foreground">{sortedFamilies.length - wineCount}</span> non-vino</span>
            </div>
          </div>

          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => {
              const overrides: Record<string, boolean> = {};
              detectedFamilies.forEach((f) => { overrides[f.name] = true; });
              setFamilyOverrides(overrides);
            }}>Seleziona Tutti come Vino</Button>
            <Button variant="outline" size="sm" onClick={() => {
              const overrides: Record<string, boolean> = {};
              detectedFamilies.forEach((f) => { overrides[f.name] = false; });
              setFamilyOverrides(overrides);
            }}>Deseleziona Tutti</Button>
            <Button variant="outline" size="sm" onClick={() => setFamilyOverrides({})}>Reset Suggerimenti</Button>
          </div>

          <div className="divide-y divide-border rounded-lg border border-border overflow-hidden max-h-96 overflow-y-auto">
            {sortedFamilies.map((f) => {
              const isWine = f.name in familyOverrides ? familyOverrides[f.name] : f.suggestedWine;
              const isOverridden = f.name in familyOverrides && familyOverrides[f.name] !== f.suggestedWine;
              return (
                <div key={f.name}>
                  <div
                    className={`flex items-center justify-between px-4 py-3 transition-colors cursor-pointer hover:bg-secondary/30 ${isWine ? "bg-success/5" : "bg-card"}`}
                    onClick={() => setExpandedFamily(expandedFamily === f.name ? null : f.name)}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <Switch checked={isWine} onCheckedChange={(v) => setFamilyOverrides({ ...familyOverrides, [f.name]: v })} onClick={(e) => e.stopPropagation()} />
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium text-foreground truncate">{f.name}</p>
                          {isOverridden && <Badge variant="outline" className="text-[10px] px-1.5 py-0">modificato</Badge>}
                          <ChevronDown className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${expandedFamily === f.name ? "rotate-180" : ""}`} />
                        </div>
                        <div className="flex items-center gap-2 mt-0.5">
                          {confidenceIcon(f.confidence)}
                          <span className="text-[11px] text-muted-foreground capitalize">{f.confidence === "high" ? "alta" : f.confidence === "medium" ? "media" : "bassa"} confidenza</span>
                          <span className="text-[11px] text-muted-foreground">· {f.itemCount} articoli</span>
                        </div>
                      </div>
                    </div>
                    <div className="shrink-0">
                      {isWine ? (
                        <Badge variant="default" className="text-[10px]"><Wine className="mr-1 h-3 w-3" />Vino</Badge>
                      ) : (
                        <Badge variant="secondary" className="text-[10px]">Non-vino</Badge>
                      )}
                    </div>
                  </div>
                  {expandedFamily === f.name && (
                    <div className="bg-secondary/10 border-t border-border px-6 py-2 max-h-48 overflow-y-auto">
                      {(familyProducts[f.name] || []).length === 0 ? (
                        <p className="text-xs text-muted-foreground py-1">Nessun prodotto caricato per questa famiglia.</p>
                      ) : (
                        <table className="w-full text-xs">
                          <thead><tr className="text-muted-foreground border-b border-border">
                            <th className="text-left py-1 font-medium">Prodotto</th>
                            <th className="text-left py-1 font-medium">Formato</th>
                            <th className="text-right py-1 font-medium">P.Unit</th>
                            <th className="text-right py-1 font-medium">Qty</th>
                          </tr></thead>
                          <tbody>
                            {(familyProducts[f.name] || []).map((p, i) => (
                              <tr key={i} className="border-b border-border/50 last:border-0">
                                <td className="py-1 text-foreground">{p.name}</td>
                                <td className="py-1 text-muted-foreground">{p.format || "—"}</td>
                                <td className="py-1 text-right text-foreground">{p.unitPrice.toFixed(2)}€</td>
                                <td className="py-1 text-right text-muted-foreground">{p.quantity}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// ── Step 4: Sales & Mapping ──
function StepSalesMapping({
  daysWithSales, selectedDay, setSelectedDay, loadingDays,
  salesEvents, loadingSales,
  onFetchDay, onSaveSales,
  saving, saveResult,
  familyOverrides, detectedFamilies,
  searchMapping, setSearchMapping,
  showWineOnly, setShowWineOnly,
}: {
  daysWithSales: string[]; selectedDay: string | null; setSelectedDay: (d: string) => void; loadingDays: boolean;
  salesEvents: SalesEvent[]; loadingSales: boolean;
  onFetchDay: (day: string) => void; onSaveSales: (day: string) => void;
  saving: boolean; saveResult: { savedEvents: number; savedLines: number } | null;
  familyOverrides: Record<string, boolean>; detectedFamilies: DetectedFamily[];
  searchMapping: string; setSearchMapping: (v: string) => void;
  showWineOnly: boolean; setShowWineOnly: (v: boolean) => void;
}) {
  const isFamilyWine = (familyName: string) => {
    if (familyName in familyOverrides) return familyOverrides[familyName];
    const detected = detectedFamilies.find((f) => f.name === familyName);
    return detected?.suggestedWine ?? false;
  };

  const allLines = useMemo(() => {
    const lines: (SalesLineItem & { docId: string; familyIsWine: boolean })[] = [];
    for (const ev of salesEvents) {
      for (const l of ev.lines) {
        lines.push({ ...l, docId: ev.provider_doc_id, familyIsWine: isFamilyWine(l.family) });
      }
    }
    return lines;
  }, [salesEvents, familyOverrides, detectedFamilies]);

  const filteredLines = useMemo(() => {
    let result = allLines;
    if (searchMapping) {
      const q = searchMapping.toLowerCase();
      result = result.filter((l) => l.name.toLowerCase().includes(q) || l.family.toLowerCase().includes(q));
    }
    if (showWineOnly) result = result.filter((l) => l.familyIsWine || l.is_wine_candidate);
    return result;
  }, [allLines, searchMapping, showWineOnly]);

  const totalAmount = salesEvents.reduce((s, e) => s + e.total_amount, 0);
  const wineLines = allLines.filter((l) => l.familyIsWine || l.is_wine_candidate);

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Vendite & Mapping Prodotti</h2>
        <p className="mt-1 text-sm text-muted-foreground">Rivedi i dati di vendita. Gli articoli classificati come vino sono mostrati di default.</p>
      </div>

      <div>
        <label className="text-xs font-medium text-muted-foreground mb-2 block">
          <Calendar className="inline h-3.5 w-3.5 mr-1" />
          Giorno Lavorativo (chiusura cassa)
        </label>
        {loadingDays ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
            <Loader2 className="h-4 w-4 animate-spin" /> Ricerca giorni con vendite…
          </div>
        ) : daysWithSales.length === 0 ? (
          <p className="text-sm text-muted-foreground py-2">Nessuna chiusura cassa trovata negli ultimi 30 giorni.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {daysWithSales.map((day) => (
              <button key={day} onClick={() => { setSelectedDay(day); onFetchDay(day); }}
                className={`rounded-lg border px-3 py-2 text-xs font-mono font-medium transition-all ${selectedDay === day ? "border-primary bg-primary/5 text-primary" : "border-border text-muted-foreground hover:border-primary/30"}`}>
                {day}
              </button>
            ))}
          </div>
        )}
      </div>

      {selectedDay && !loadingSales && salesEvents.length > 0 && (
        <div className="rounded-lg border border-border bg-secondary/30 p-4 space-y-2">
          <div className="flex justify-between text-xs"><span className="text-muted-foreground">Giorno</span><span className="font-mono font-medium text-foreground">{selectedDay}</span></div>
          <div className="flex justify-between text-xs"><span className="text-muted-foreground">Ricevute</span><span className="font-medium text-foreground">{salesEvents.length}</span></div>
          <div className="flex justify-between text-xs"><span className="text-muted-foreground">Righe totali</span><span className="font-medium text-foreground">{allLines.length}</span></div>
          <div className="flex justify-between text-xs"><span className="text-muted-foreground">Totale</span><span className="font-medium text-foreground">€{totalAmount.toFixed(2)}</span></div>
          <div className="flex justify-between text-xs"><span className="text-muted-foreground">Candidati vino</span><span className="font-medium text-success">{wineLines.length}</span></div>
          <Button size="sm" variant="secondary" className="w-full mt-2" onClick={() => onSaveSales(selectedDay)} disabled={saving}>
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
            {saveResult ? `Salvati ${saveResult.savedEvents} eventi, ${saveResult.savedLines} righe` : "Salva nel DB"}
          </Button>
        </div>
      )}

      {selectedDay && !loadingSales && salesEvents.length === 0 && (
        <div className="text-center py-8 text-sm text-muted-foreground rounded-lg border border-border bg-secondary/20">
          Nessun dato: non c'è stata chiusura cassa quel giorno.
        </div>
      )}

      {loadingSales && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          <span className="ml-2 text-sm text-muted-foreground">Caricamento vendite…</span>
        </div>
      )}

      {allLines.length > 0 && (
        <>
          <div className="flex gap-3 items-center">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input placeholder="Cerca prodotti…" value={searchMapping} onChange={(e) => setSearchMapping(e.target.value)} className="pl-10 bg-background" />
            </div>
            <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer whitespace-nowrap">
              <Switch checked={showWineOnly} onCheckedChange={setShowWineOnly} />
              <Filter className="h-3.5 w-3.5" />
              Solo vino
            </label>
          </div>

          <div className="divide-y divide-border rounded-lg border border-border overflow-hidden max-h-80 overflow-y-auto">
            {filteredLines.length === 0 ? (
              <div className="text-center py-8 text-sm text-muted-foreground">Nessun prodotto trovato.</div>
            ) : (
              filteredLines.map((l, i) => {
                const isWine = l.familyIsWine || l.is_wine_candidate;
                return (
                  <div key={`${l.docId}-${l.provider_product_id}-${i}`} className="flex items-center justify-between px-4 py-2.5 bg-card hover:bg-secondary/30 transition-colors">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className={`h-2 w-2 rounded-full shrink-0 ${isWine ? "bg-success" : "bg-muted-foreground"}`} />
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-foreground truncate">{l.name}</p>
                        <p className="text-[11px] text-muted-foreground">
                          {l.family && <span className="mr-2">{l.family}</span>}
                          {l.format && <span className="mr-2">· {l.format}</span>}
                          <span className="font-mono">×{l.quantity}</span>
                          <span className="ml-2 font-mono">@€{l.unit_price.toFixed(2)}</span>
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <span className="text-xs font-mono text-foreground">€{l.total_amount.toFixed(2)}</span>
                      {isWine ? (
                        <Badge variant="default" className="text-[10px]"><Wine className="mr-1 h-3 w-3" />Vino</Badge>
                      ) : (
                        <Badge variant="secondary" className="text-[10px]">Non-vino</Badge>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ── Step 5: Go Live ──
function StepGoLive({
  syncMode, frequency, backfill,
  salesEvents, selectedDay,
  onEnable, enabled,
  familyOverrides, detectedFamilies,
  connectionId,
}: {
  syncMode: string; frequency: number; backfill: number;
  salesEvents: SalesEvent[]; selectedDay: string | null;
  onEnable: () => void; enabled: boolean;
  familyOverrides: Record<string, boolean>; detectedFamilies: DetectedFamily[];
  connectionId: string | null;
}) {
  const wineFamilyCount = detectedFamilies.filter((f) => f.name in familyOverrides ? familyOverrides[f.name] : f.suggestedWine).length;
  const wineLines = salesEvents.flatMap((e) => e.lines).filter((l) => l.is_wine_candidate);

  return (
    <div className="space-y-6 text-center py-4">
      <div className="flex justify-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10">
          <Power className="h-8 w-8 text-primary" />
        </div>
      </div>
      <div>
        <h2 className="text-lg font-semibold text-foreground">Pronto per il Go Live</h2>
        <p className="mt-1 text-sm text-muted-foreground max-w-md mx-auto">
          L'integrazione TCPOS è configurata. Attiva la sync per iniziare a importare vendite ogni {frequency} minuti.
        </p>
      </div>
      {connectionId && <ConnectionHealthPanel connectionId={connectionId} />}
      <ProviderReadinessPanel connectionId={connectionId} provider="tcpos" />
      <div className="rounded-lg border border-border bg-secondary/30 p-4 text-left max-w-sm mx-auto space-y-2">
        <div className="flex justify-between text-xs"><span className="text-muted-foreground">Modalità</span><span className="font-medium text-foreground">{syncMode === "PULL_ONLY" ? "Solo Pull" : "Bidirezionale"}</span></div>
        <div className="flex justify-between text-xs"><span className="text-muted-foreground">Frequenza</span><span className="font-medium text-foreground">Ogni {frequency} min</span></div>
        <div className="flex justify-between text-xs"><span className="text-muted-foreground">Backfill</span><span className="font-medium text-foreground">Ultimi {backfill} giorni</span></div>
        {selectedDay && <div className="flex justify-between text-xs"><span className="text-muted-foreground">Ultimo giorno</span><span className="font-medium font-mono text-foreground">{selectedDay}</span></div>}
        <div className="flex justify-between text-xs"><span className="text-muted-foreground">Famiglie vino</span><span className="font-medium text-foreground">{wineFamilyCount}</span></div>
        <div className="flex justify-between text-xs"><span className="text-muted-foreground">Candidati vino</span><span className="font-medium text-foreground">{wineLines.length}</span></div>
      </div>
      <Button size="lg" onClick={onEnable} className="shadow-glow">
        {enabled ? (<><CheckCircle2 className="mr-2 h-4 w-4" /> Sync Attivata — Reindirizzamento…</>) : "Attiva Sync"}
      </Button>
    </div>
  );
}

// ── Main Wizard ──
export default function TcposWizard() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [currentStep, setCurrentStep] = useState(1);
  const [baseUrl, setBaseUrl] = useState("");
  const [tcposUser, setTcposUser] = useState("");
  const [tcposPassword, setTcposPassword] = useState("");
  const [winerimApiToken, setWinerimApiToken] = useState("");
  const [locationName, setLocationName] = useState("");
  const [syncMode, setSyncMode] = useState<"PULL_ONLY" | "BIDIRECTIONAL">("PULL_ONLY");
  const [frequency, setFrequency] = useState(15);
  const [backfill, setBackfill] = useState(30);
  const [enabled, setEnabled] = useState(false);
  const [searchMapping, setSearchMapping] = useState("");
  const [showWineOnly, setShowWineOnly] = useState(true);
  const [familyOverrides, setFamilyOverrides] = useState<Record<string, boolean>>({});

  const apiToken = `${tcposUser}:${tcposPassword}`;

  const {
    connectionId, setConnectionId,
    testStatus, testError,
    testConnection, updateConnection, loadConnection,
    daysWithSales, selectedDay, setSelectedDay, loadingDays, findDaysWithSales, scanStats,
    salesEvents, detectedFamilies, loadingSales, fetchSalesForDay,
    saving, saveResult, saveSalesToDb,
    enableSync, saveFamilyRules,
  } = useTcposConnection();

  // Load existing connection
  useEffect(() => {
    const connParam = searchParams.get("connection");
    if (connParam && !connectionId) {
      loadConnection(connParam).then((conn) => {
        if (conn) {
          setLocationName(conn.location_name);
          setBaseUrl(conn.base_url);
          const [u, p] = (conn.api_token || "").split(":");
          setTcposUser(u || "");
          setTcposPassword(p || "");
          setWinerimApiToken(conn.winerim_api_token || "");
          setSyncMode(conn.sync_mode as "PULL_ONLY" | "BIDIRECTIONAL");
          setFrequency(conn.sync_frequency_minutes);
          setBackfill(conn.backfill_days);
          setEnabled(conn.enabled);
          setCurrentStep(4);
        }
      });
    }
  }, [searchParams]);

  useEffect(() => {
    if ((currentStep === 3 || currentStep === 4) && connectionId && daysWithSales.length === 0 && !loadingDays) {
      findDaysWithSales(60);
    }
  }, [currentStep, connectionId]);

  useEffect(() => {
    if (selectedDay && (currentStep === 3 || currentStep === 4)) {
      fetchSalesForDay(selectedDay);
    }
  }, [selectedDay]);

  const handleNext = async () => {
    if (currentStep === 2 && connectionId) {
      await updateConnection(connectionId, {
        sync_mode: syncMode,
        sync_frequency_minutes: frequency,
        backfill_days: backfill,
        location_name: locationName || "New Location",
      });
    }
    if (currentStep === 3) {
      const families = detectedFamilies.map((f) => ({
        name: f.name,
        isWine: f.name in familyOverrides ? familyOverrides[f.name] : f.suggestedWine,
      }));
      if (families.length > 0) await saveFamilyRules(families);
    }
    setCurrentStep((s) => Math.min(5, s + 1));
  };

  return (
    <div className="max-w-3xl mx-auto space-y-8">
      <button onClick={() => navigate("/integrations")} className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors">
        <ArrowLeft className="h-4 w-4" /> Torna alle Integrazioni
      </button>

      <div className="flex items-center gap-4">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-primary font-bold text-lg">K</div>
        <div>
          <h1 className="text-xl font-bold text-foreground">Connetti Kumo (TCPOS)</h1>
          <p className="text-sm text-muted-foreground">Configura l'integrazione TCPOS in pochi passaggi.</p>
        </div>
      </div>

      {/* Step indicator */}
      <div className="flex items-center gap-2">
        {steps.map((step, i) => {
          const isActive = step.id === currentStep;
          const isDone = step.id < currentStep;
          return (
            <div key={step.id} className="flex items-center gap-2 flex-1">
              <div className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-semibold transition-all ${isDone ? "bg-success text-success-foreground" : isActive ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground"}`}>
                {isDone ? <CheckCircle2 className="h-4 w-4" /> : step.id}
              </div>
              <span className={`text-xs font-medium hidden sm:block ${isActive ? "text-foreground" : "text-muted-foreground"}`}>{step.label}</span>
              {i < steps.length - 1 && <div className={`h-px flex-1 ${isDone ? "bg-success" : "bg-border"}`} />}
            </div>
          );
        })}
      </div>

      {/* Step content */}
      <AnimatePresence mode="wait">
        <motion.div key={currentStep} initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} transition={{ duration: 0.25 }} className="rounded-xl border border-border bg-card p-6 shadow-card">
          {currentStep === 1 && (
            <StepConnection
              locationName={locationName} setLocationName={setLocationName}
              baseUrl={baseUrl} setBaseUrl={setBaseUrl}
              tcposUser={tcposUser} setTcposUser={setTcposUser}
              tcposPassword={tcposPassword} setTcposPassword={setTcposPassword}
              winerimApiToken={winerimApiToken} setWinerimApiToken={setWinerimApiToken}
              testStatus={testStatus} testError={testError}
              onTest={() => testConnection(baseUrl, apiToken, winerimApiToken)}
            />
          )}
          {currentStep === 2 && (
            <StepSyncSettings syncMode={syncMode} setSyncMode={setSyncMode} frequency={frequency} setFrequency={setFrequency} backfill={backfill} setBackfill={setBackfill} />
          )}
          {currentStep === 3 && (
            <StepFamilies
              detectedFamilies={detectedFamilies} loadingDays={loadingDays} loadingSales={loadingSales}
              familyOverrides={familyOverrides} setFamilyOverrides={setFamilyOverrides}
              scanStats={scanStats} daysWithSales={daysWithSales} selectedDay={selectedDay}
              onRunHistoricalScan={() => findDaysWithSales(90)} salesEvents={salesEvents}
            />
          )}
          {currentStep === 4 && (
            <StepSalesMapping
              daysWithSales={daysWithSales} selectedDay={selectedDay} setSelectedDay={setSelectedDay} loadingDays={loadingDays}
              salesEvents={salesEvents} loadingSales={loadingSales}
              onFetchDay={fetchSalesForDay} onSaveSales={saveSalesToDb}
              saving={saving} saveResult={saveResult}
              familyOverrides={familyOverrides} detectedFamilies={detectedFamilies}
              searchMapping={searchMapping} setSearchMapping={setSearchMapping}
              showWineOnly={showWineOnly} setShowWineOnly={setShowWineOnly}
            />
          )}
          {currentStep === 5 && (
            <StepGoLive
              syncMode={syncMode} frequency={frequency} backfill={backfill}
              salesEvents={salesEvents} selectedDay={selectedDay}
              onEnable={async () => { await enableSync(); setEnabled(true); setTimeout(() => navigate("/sync-monitor"), 1000); }}
              enabled={enabled}
              familyOverrides={familyOverrides} detectedFamilies={detectedFamilies}
              connectionId={connectionId}
            />
          )}
        </motion.div>
      </AnimatePresence>

      {/* Navigation */}
      <div className="flex justify-between">
        <Button variant="outline" onClick={() => setCurrentStep((s) => Math.max(1, s - 1))} disabled={currentStep === 1}>
          <ArrowLeft className="mr-2 h-4 w-4" /> Precedente
        </Button>
        {currentStep < 5 && (
          <Button onClick={handleNext}>Avanti <ArrowRight className="ml-2 h-4 w-4" /></Button>
        )}
      </div>
    </div>
  );
}
