import { useState, useEffect, useMemo, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  ArrowLeft, ArrowRight, CheckCircle2, Loader2, XCircle, Search, Link2, Settings2, Map,
  Power, Wine, Calendar, Download, Filter, Grape, ShieldCheck, ShieldX, HelpCircle,
  ChevronDown, Package, RefreshCw, Database, Zap, RotateCcw, Tag,
  Upload, AlertTriangle, Play, FileJson, FileText, Send, Shield, Eye,
  Server, Wrench, GlassWater,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "@/hooks/use-toast";
import {
  useAgoraConnection, SalesEvent, SalesLineItem, DetectedFamily,
  CatalogDiscoveryResult, ProviderProduct, ClassificationConfig,
} from "@/hooks/useAgoraConnection";
import { useOutboundSync, OutboundTask } from "@/hooks/useOutboundSync";
import { useAgoraMasterData, AgoraMasterItem } from "@/hooks/useAgoraMasterData";
import AgoraFamilyManager from "@/components/AgoraFamilyManager";

const steps = [
  { id: 1, label: "Connection", icon: Link2 },
  { id: 2, label: "Sync Settings", icon: Settings2 },
  { id: 3, label: "Capabilities", icon: Shield },
  { id: 4, label: "Catalog", icon: Package },
  { id: 5, label: "Master Data", icon: Server },
  { id: 6, label: "Families", icon: Grape },
  { id: 7, label: "Sales & Mapping", icon: Map },
  { id: 8, label: "Wine Matching", icon: Wine },
  { id: 9, label: "Winerim Catalog", icon: Grape },
  { id: 10, label: "Write Settings", icon: Wrench },
  { id: 11, label: "Outbound Sync", icon: Upload },
  { id: 12, label: "Go Live", icon: Power },
];

// Helper to fetch all rows from a table without limit
async function fetchAllWinerimWines(connectionId: string, select: string): Promise<any[]> {
  const PAGE_SIZE = 1000;
  const allRows: any[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase.from("winerim_wines").select(select).eq("connection_id", connectionId).order("name").range(from, from + PAGE_SIZE - 1);
    if (error || !data || data.length === 0) break;
    allRows.push(...data);
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return allRows;
}

async function fetchAllMappings(connectionId: string): Promise<any[]> {
  const PAGE_SIZE = 1000;
  const allRows: any[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase.from("product_mappings").select("*").eq("connection_id", connectionId).order("match_score", { ascending: false }).range(from, from + PAGE_SIZE - 1);
    if (error || !data || data.length === 0) break;
    allRows.push(...data);
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return allRows;
}

// ── Classification badge component ──
function ClassificationBadge({ product }: { product: ProviderProduct | { classification_override?: string; is_wine_candidate: boolean; last_score?: number; last_reasons?: string[]; wine_score?: number; wine_reasons?: string[] } }) {
  const override = (product as any).classification_override || "AUTO";
  const isWine = product.is_wine_candidate;
  const score = (product as any).last_score ?? (product as any).wine_score ?? 0;
  const reasons = (product as any).last_reasons ?? (product as any).wine_reasons ?? [];

  const getLabel = () => {
    if (override === "WINE") return "WINE";
    if (override === "NOT_WINE") return "NOT_WINE";
    if (isWine) return "WINE";
    if (score > 0 && score < 40) return "NEEDS_REVIEW";
    return "NOT_WINE";
  };

  const label = getLabel();
  const variant = label === "WINE" ? "default" : label === "NEEDS_REVIEW" ? "outline" : "secondary";

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant={variant} className="text-[10px] cursor-help gap-1">
            {override !== "AUTO" && <Tag className="h-2.5 w-2.5" />}
            {label === "WINE" && <Wine className="h-3 w-3" />}
            {label === "NEEDS_REVIEW" && <HelpCircle className="h-3 w-3" />}
            {label}
          </Badge>
        </TooltipTrigger>
        <TooltipContent side="left" className="max-w-xs">
          <div className="space-y-1 text-xs">
            <p className="font-medium">Score: {score} · Override: {override}</p>
            {reasons.length > 0 && (
              <ul className="list-disc pl-3 space-y-0.5">
                {reasons.map((r: string, i: number) => <li key={i} className="text-muted-foreground">{r}</li>)}
              </ul>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

// ── Step 1: Connection ──
function StepConnection({
  locationName, setLocationName, baseUrl, setBaseUrl, apiToken, setApiToken,
  winerimApiToken, setWinerimApiToken, testStatus, testError, onTest,
}: {
  locationName: string; setLocationName: (v: string) => void;
  baseUrl: string; setBaseUrl: (v: string) => void;
  apiToken: string; setApiToken: (v: string) => void;
  winerimApiToken: string; setWinerimApiToken: (v: string) => void;
  testStatus: string; testError: string | null; onTest: () => void;
}) {
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Connection Details</h2>
        <p className="mt-1 text-sm text-muted-foreground">Enter your Agora POS base URL, API token, and location name.</p>
      </div>
      <div className="space-y-4">
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Location Name</label>
          <Input placeholder="e.g. La Vinoteca Central" value={locationName} onChange={(e) => setLocationName(e.target.value)} className="bg-background text-sm" />
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Base URL</label>
          <Input placeholder="http://192.168.1.100:8080" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} className="bg-background font-mono text-sm" />
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Api-Token</label>
          <Input type="password" placeholder="Enter your Agora API token" value={apiToken} onChange={(e) => setApiToken(e.target.value)} className="bg-background font-mono text-sm" />
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Winerim API Token</label>
          <Input type="password" placeholder="Enter your Winerim API token" value={winerimApiToken} onChange={(e) => setWinerimApiToken(e.target.value)} className="bg-background font-mono text-sm" />
          <p className="mt-1 text-[11px] text-muted-foreground">Token de la API v2 de Winerim para sincronizar catálogo y stock.</p>
        </div>
        <Button onClick={onTest} disabled={testStatus === "testing" || !baseUrl || !apiToken} variant="secondary" className="w-full">
          {testStatus === "testing" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {testStatus === "success" && <CheckCircle2 className="mr-2 h-4 w-4 text-success" />}
          {testStatus === "error" && <XCircle className="mr-2 h-4 w-4 text-destructive" />}
          {testStatus === "idle" && "Test Connection"}
          {testStatus === "testing" && "Testing…"}
          {testStatus === "success" && "Connection Successful"}
          {testStatus === "error" && (testError || "Connection Failed")}
        </Button>
      </div>
    </div>
  );
}

// ── Step 2: Sync Settings ──
function StepSyncSettings({
  syncMode, setSyncMode, frequency, setFrequency, backfill, setBackfill,
  catalogSyncEnabled, onToggleCatalogSync,
}: {
  syncMode: string; setSyncMode: (v: "PULL_ONLY" | "BIDIRECTIONAL") => void;
  frequency: number; setFrequency: (v: number) => void;
  backfill: number; setBackfill: (v: number) => void;
  catalogSyncEnabled: boolean; onToggleCatalogSync: (v: boolean) => void;
}) {
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Sync Settings</h2>
        <p className="mt-1 text-sm text-muted-foreground">Configure how and how often data is synced.</p>
      </div>
      <div className="space-y-4">
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-2 block">Sync Mode</label>
          <div className="grid grid-cols-2 gap-3">
            {(["PULL_ONLY", "BIDIRECTIONAL"] as const).map((mode) => (
              <button key={mode} onClick={() => setSyncMode(mode)} className={`rounded-lg border p-3 text-left transition-all ${syncMode === mode ? "border-primary bg-primary/5" : "border-border hover:border-primary/30"}`}>
                <span className="text-sm font-medium text-foreground">{mode === "PULL_ONLY" ? "Pull Only" : "Bidirectional"}</span>
                <p className="mt-0.5 text-xs text-muted-foreground">{mode === "PULL_ONLY" ? "Read sales data from Agora" : "Read sales + push wines to Agora"}</p>
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-2 block">Sync Frequency</label>
          <div className="flex gap-2">
            {[5, 10, 15, 30, 60].map((f) => (
              <button key={f} onClick={() => setFrequency(f)} className={`rounded-lg border px-3 py-2 text-xs font-medium transition-all ${frequency === f ? "border-primary bg-primary/5 text-primary" : "border-border text-muted-foreground hover:border-primary/30"}`}>
                {f} min
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-2 block">Backfill Period</label>
          <div className="flex gap-2">
            {[7, 30, 90].map((d) => (
              <button key={d} onClick={() => setBackfill(d)} className={`rounded-lg border px-3 py-2 text-xs font-medium transition-all ${backfill === d ? "border-primary bg-primary/5 text-primary" : "border-border text-muted-foreground hover:border-primary/30"}`}>
                Last {d} days
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center justify-between rounded-lg border border-border p-3">
          <div>
            <p className="text-sm font-medium text-foreground">Sync catalog/products</p>
            <p className="text-xs text-muted-foreground">Fetch the full product catalog from Agora daily</p>
          </div>
          <Switch checked={catalogSyncEnabled} onCheckedChange={onToggleCatalogSync} />
        </div>
      </div>
    </div>
  );
}

// ── Step 3: Catalog ──
function StepCatalog({
  catalogStatus, catalogDiscovering, catalogDiscoveryResults, catalogDiscoverySample,
  catalogSyncing, catalogSyncResult, catalogTestResult, catalogTestingEndpoint,
  catalogProducts, buildingDerived, derivedResult,
  onDiscover, onSync, onTestEndpoint, onFetchProducts, onBuildDerived,
}: {
  catalogStatus: { catalogEndpoint: string | null; lastCatalogSyncAt: string | null; catalogProductCount: number; catalogWineCandidateCount: number };
  catalogDiscovering: boolean; catalogDiscoveryResults: CatalogDiscoveryResult[];
  catalogDiscoverySample: unknown; catalogSyncing: boolean;
  catalogSyncResult: { totalProducts: number; wineCandidates: number } | null;
  catalogTestResult: { count: number; sample: unknown[] } | null;
  catalogTestingEndpoint: boolean; catalogProducts: ProviderProduct[];
  buildingDerived: boolean; derivedResult: { totalProducts: number; wineCandidates: number; daysScanned: number } | null;
  onDiscover: () => void; onSync: () => void; onTestEndpoint: (filter?: string) => void;
  onFetchProducts: () => void; onBuildDerived: () => void;
}) {
  const [searchCatalog, setSearchCatalog] = useState("");
  const [showWineOnly, setShowWineOnly] = useState(false);
  const [testFilter, setTestFilter] = useState("");

  const filteredProducts = useMemo(() => {
    let result = catalogProducts;
    if (searchCatalog) {
      const q = searchCatalog.toLowerCase();
      result = result.filter((p) => p.name.toLowerCase().includes(q) || (p.family || "").toLowerCase().includes(q));
    }
    if (showWineOnly) result = result.filter((p) => p.is_wine_candidate);
    return result;
  }, [catalogProducts, searchCatalog, showWineOnly]);

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Catalog / Product Sync</h2>
        <p className="mt-1 text-sm text-muted-foreground">Discover and sync the product catalog from Agora.</p>
      </div>
      <div className="rounded-lg border border-border bg-secondary/30 p-4 space-y-2">
        <p className="text-xs font-medium text-muted-foreground flex items-center gap-1.5"><Database className="h-3.5 w-3.5" /> Catalog Status</p>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
          <span className="text-muted-foreground">Endpoint</span>
          <span className="font-mono text-foreground">{catalogStatus.catalogEndpoint || "Not discovered"}</span>
          <span className="text-muted-foreground">Last sync</span>
          <span className="font-mono text-foreground">{catalogStatus.lastCatalogSyncAt ? new Date(catalogStatus.lastCatalogSyncAt).toLocaleString() : "Never"}</span>
          <span className="text-muted-foreground">Products</span>
          <span className="font-mono text-foreground">{catalogStatus.catalogProductCount}</span>
          <span className="text-muted-foreground">Wine candidates</span>
          <span className={`font-mono ${catalogStatus.catalogWineCandidateCount > 0 ? "text-success" : "text-muted-foreground"}`}>{catalogStatus.catalogWineCandidateCount}</span>
        </div>
        {catalogStatus.catalogWineCandidateCount === 0 && catalogStatus.catalogProductCount > 0 && (
          <p className="text-[11px] text-muted-foreground col-span-2 mt-1 flex items-center gap-1">
            <HelpCircle className="h-3 w-3 shrink-0" /> No wines currently in POS catalog. Wine candidates will appear after pushing products from Winerim.
          </p>
        )}
      </div>
      <div className="flex gap-2 flex-wrap">
        <Button variant="secondary" size="sm" onClick={onDiscover} disabled={catalogDiscovering}>
          {catalogDiscovering ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Search className="mr-2 h-4 w-4" />} Discover Endpoint
        </Button>
        <Button variant="secondary" size="sm" onClick={onSync} disabled={catalogSyncing || !catalogStatus.catalogEndpoint}>
          {catalogSyncing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />} Sync Now
        </Button>
        {catalogStatus.catalogEndpoint && catalogProducts.length === 0 && (
          <Button variant="outline" size="sm" onClick={onFetchProducts}><Download className="mr-2 h-4 w-4" /> Load Products</Button>
        )}
      </div>
      {catalogSyncResult && (
        <div className="rounded-lg border border-success/30 bg-success/5 p-3 text-xs space-y-1">
          <p className="font-medium text-foreground flex items-center gap-1.5"><CheckCircle2 className="h-3.5 w-3.5 text-success" /> Catalog synced</p>
          <p className="text-muted-foreground">{catalogSyncResult.totalProducts} products, {catalogSyncResult.wineCandidates} wine candidates.</p>
        </div>
      )}
      {catalogDiscoveryResults.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">Discovery Results</p>
          <div className="divide-y divide-border rounded-lg border border-border overflow-hidden">
            {catalogDiscoveryResults.map((r, idx) => (
              <div key={`${r.label}-${idx}`} className="px-4 py-2.5 bg-card space-y-1">
                <div className="flex items-center justify-between">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground font-mono">{r.label}</p>
                    <p className="text-[11px] text-muted-foreground">Status: {r.status} · {r.contentType} · {r.count} items</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {r.count > 0 ? <Badge variant="default" className="text-[10px]">{r.count} items</Badge> : <Badge variant="secondary" className="text-[10px]">{r.status >= 400 ? `Error ${r.status}` : "Empty"}</Badge>}
                    {r.filter === catalogStatus.catalogEndpoint && <Badge variant="default" className="text-[10px] bg-success"><Zap className="mr-1 h-3 w-3" />Selected</Badge>}
                  </div>
                </div>
                {r.errorBody && (
                  <pre className="rounded bg-destructive/5 border border-destructive/20 p-2 text-[10px] font-mono text-destructive overflow-x-auto max-h-24 overflow-y-auto whitespace-pre-wrap">{r.errorBody}</pre>
                )}
              </div>
            ))}
          </div>
          {!catalogStatus.catalogEndpoint && catalogDiscoveryResults.every((r) => r.count === 0) && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 space-y-2">
              <p className="text-xs font-medium text-foreground flex items-center gap-1.5"><HelpCircle className="h-3.5 w-3.5 text-amber-500" /> Catalog export not available</p>
              <p className="text-[11px] text-muted-foreground">Ask your installer to enable catalog export permissions/modules.</p>
              <Button variant="secondary" size="sm" onClick={onBuildDerived} disabled={buildingDerived}>
                {buildingDerived ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Database className="mr-2 h-4 w-4" />} Build Derived Catalog (last 30 days)
              </Button>
            </div>
          )}
        </div>
      )}
      {derivedResult && (
        <div className="rounded-lg border border-success/30 bg-success/5 p-3 text-xs space-y-2">
          <p className="font-medium text-foreground flex items-center gap-1.5"><CheckCircle2 className="h-3.5 w-3.5 text-success" /> Derived catalog built</p>
          <p className="text-muted-foreground">Scanned {derivedResult.daysScanned} days → {derivedResult.totalProducts} products, {derivedResult.wineCandidates} wine candidates.</p>
          {derivedResult.wineCandidates === 0 && (
            <div className="rounded-md bg-blue-500/10 border border-blue-500/20 p-2 text-[11px] text-blue-700 flex items-start gap-1.5">
              <HelpCircle className="h-3 w-3 shrink-0 mt-0.5" />
              <span>This customer currently has no wines in Agora POS, so derived wine candidates may be low or zero until Winerim products are pushed.</span>
            </div>
          )}
        </div>
      )}
      {catalogDiscoverySample && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">Sample Record</p>
          <pre className="rounded-lg border border-border bg-secondary/30 p-3 text-xs font-mono overflow-x-auto max-h-48 overflow-y-auto text-foreground">{JSON.stringify(catalogDiscoverySample, null, 2)}</pre>
        </div>
      )}
      <div className="space-y-2 rounded-lg border border-border p-4">
        <p className="text-xs font-medium text-muted-foreground">Debug: Test Catalog Endpoint</p>
        <div className="flex gap-2">
          <Input placeholder="Filter name (e.g. Articles)" value={testFilter} onChange={(e) => setTestFilter(e.target.value)} className="bg-background text-sm font-mono flex-1" />
          <Button variant="outline" size="sm" onClick={() => onTestEndpoint(testFilter || undefined)} disabled={catalogTestingEndpoint}>
            {catalogTestingEndpoint ? <Loader2 className="h-4 w-4 animate-spin" /> : "Test"}
          </Button>
        </div>
        {catalogTestResult && (
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">{catalogTestResult.count} items found</p>
            <pre className="rounded-lg bg-secondary/30 p-2 text-xs font-mono overflow-x-auto max-h-36 overflow-y-auto text-foreground">{JSON.stringify(catalogTestResult.sample, null, 2)}</pre>
          </div>
        )}
      </div>
      {catalogProducts.length > 0 && (
        <div className="space-y-3">
          <div className="flex gap-3 items-center">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input placeholder="Search products…" value={searchCatalog} onChange={(e) => setSearchCatalog(e.target.value)} className="pl-10 bg-background" />
            </div>
            <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer whitespace-nowrap">
              <Switch checked={showWineOnly} onCheckedChange={setShowWineOnly} />
              <Wine className="h-3.5 w-3.5" /> Wine only
            </label>
          </div>
          <div className="divide-y divide-border rounded-lg border border-border overflow-hidden max-h-72 overflow-y-auto">
            {filteredProducts.length === 0 ? (
              <div className="text-center py-6 text-sm text-muted-foreground">No matching products.</div>
            ) : filteredProducts.map((p) => (
              <div key={p.id} className="flex items-center justify-between px-4 py-2.5 bg-card hover:bg-secondary/30 transition-colors">
                <div className="flex items-center gap-3 min-w-0">
                  <div className={`h-2 w-2 rounded-full shrink-0 ${p.is_wine_candidate ? "bg-success" : "bg-muted-foreground"}`} />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">{p.name}</p>
                    <p className="text-[11px] text-muted-foreground">
                      {p.family && <span className="mr-2">{p.family}</span>}
                      {p.sale_format && <span className="mr-2">· {p.sale_format}</span>}
                      {p.price > 0 && <span className="font-mono">€{p.price.toFixed(2)}</span>}
                    </p>
                  </div>
                </div>
                <ClassificationBadge product={p} />
              </div>
            ))}
          </div>
          <p className="text-[11px] text-muted-foreground text-right">Showing {filteredProducts.length} of {catalogProducts.length}</p>
        </div>
      )}
    </div>
  );
}

// ── Step 4: Families ──
function StepFamilies({
  detectedFamilies, loadingDays, loadingSales, familyOverrides, setFamilyOverrides,
  scanStats, daysWithSales, selectedDay, onRunHistoricalScan, salesEvents,
  catalogProducts, onAddKeyword,
}: {
  detectedFamilies: DetectedFamily[]; loadingDays: boolean; loadingSales: boolean;
  familyOverrides: Record<string, boolean>; setFamilyOverrides: (v: Record<string, boolean>) => void;
  scanStats: { totalScanned: number; totalInvoicesFound: number } | null;
  daysWithSales: string[]; selectedDay: string | null;
  onRunHistoricalScan: () => void; salesEvents: SalesEvent[];
  catalogProducts: ProviderProduct[];
  onAddKeyword: (keyword: string, type: "wine" | "non_wine") => void;
}) {
  const [expandedFamily, setExpandedFamily] = useState<string | null>(null);

  // Merge families from catalog + sales
  const allFamilies = useMemo(() => {
    const familyMap: Record<string, { itemCount: number; wineCount: number; notWineCount: number }> = {};
    for (const p of catalogProducts) {
      const fam = p.family || "Sin familia";
      if (!familyMap[fam]) familyMap[fam] = { itemCount: 0, wineCount: 0, notWineCount: 0 };
      familyMap[fam].itemCount++;
      if (p.is_wine_candidate) familyMap[fam].wineCount++; else familyMap[fam].notWineCount++;
    }
    for (const df of detectedFamilies) {
      if (!familyMap[df.name]) {
        familyMap[df.name] = { itemCount: df.itemCount, wineCount: 0, notWineCount: 0 };
      }
    }
    return familyMap;
  }, [catalogProducts, detectedFamilies]);

  const familyProducts = useMemo(() => {
    const map: Record<string, { name: string; format: string; unitPrice: number; quantity: number; isWine: boolean }[]> = {};
    // From catalog
    for (const p of catalogProducts) {
      const fam = p.family || "Sin familia";
      if (!map[fam]) map[fam] = [];
      map[fam].push({ name: p.name, format: p.sale_format || "", unitPrice: p.price, quantity: 0, isWine: p.is_wine_candidate });
    }
    // Fallback from sales
    if (catalogProducts.length === 0) {
      for (const ev of salesEvents) {
        for (const line of ev.lines) {
          const fam = line.family || "Sin familia";
          if (!map[fam]) map[fam] = [];
          const existing = map[fam].find((p) => p.name === line.name && p.format === line.format);
          if (existing) existing.quantity += line.quantity;
          else map[fam].push({ name: line.name, format: line.format, unitPrice: line.unit_price, quantity: line.quantity, isWine: line.is_wine_candidate });
        }
      }
    }
    for (const fam of Object.keys(map)) map[fam].sort((a, b) => a.name.localeCompare(b.name));
    return map;
  }, [salesEvents, catalogProducts]);

  const sortedFamilies = useMemo(() => {
    const entries = Object.entries(allFamilies).map(([name, info]) => {
      const detected = detectedFamilies.find((f) => f.name === name);
      const suggestedWine = detected?.suggestedWine ?? (info.wineCount > info.notWineCount);
      const confidence = detected?.confidence ?? "low";
      return { name, suggestedWine, confidence, itemCount: info.itemCount, wineCount: info.wineCount, notWineCount: info.notWineCount };
    });
    return entries.sort((a, b) => {
      const aWine = a.name in familyOverrides ? familyOverrides[a.name] : a.suggestedWine;
      const bWine = b.name in familyOverrides ? familyOverrides[b.name] : b.suggestedWine;
      if (aWine !== bWine) return aWine ? -1 : 1;
      return b.itemCount - a.itemCount;
    });
  }, [allFamilies, detectedFamilies, familyOverrides]);

  const wineCount = sortedFamilies.filter((f) => f.name in familyOverrides ? familyOverrides[f.name] : f.suggestedWine).length;
  const isLoading = loadingDays || loadingSales;

  const confidenceIcon = (c: string) => {
    if (c === "high") return <ShieldCheck className="h-3.5 w-3.5 text-success" />;
    if (c === "medium") return <HelpCircle className="h-3.5 w-3.5 text-warning" />;
    return <ShieldX className="h-3.5 w-3.5 text-muted-foreground" />;
  };

  if (isLoading) {
    return (
      <div className="space-y-5">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Wine Family Classification</h2>
          <p className="mt-1 text-sm text-muted-foreground">Scanning sales data…</p>
        </div>
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          <span className="ml-2 text-sm text-muted-foreground">{loadingDays ? "Scanning business days…" : "Loading sales…"}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Wine Family Classification</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {sortedFamilies.length > 0
            ? <>Detected <span className="font-medium text-foreground">{sortedFamilies.length}</span> families. One-click to classify as Wine/Not wine.</>
            : "No families detected yet."}
        </p>
      </div>

      {scanStats && (
        <div className="rounded-lg border border-border bg-secondary/30 p-3 space-y-1">
          <p className="text-xs font-medium text-muted-foreground">Scan Results</p>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
            <span className="text-muted-foreground">Days scanned</span><span className="font-mono text-foreground">{scanStats.totalScanned}</span>
            <span className="text-muted-foreground">Days with sales</span><span className="font-mono text-foreground">{daysWithSales.length}</span>
            <span className="text-muted-foreground">Total invoices</span><span className="font-mono text-foreground">{scanStats.totalInvoicesFound}</span>
            {selectedDay && <><span className="text-muted-foreground">Last day with data</span><span className="font-mono text-foreground">{selectedDay}</span></>}
            <span className="text-muted-foreground">Families</span><span className="font-mono text-foreground">{sortedFamilies.length}</span>
          </div>
        </div>
      )}

      {sortedFamilies.length === 0 && (
        <div className="text-center py-8 space-y-4 rounded-lg border border-border bg-secondary/20">
          <p className="text-sm text-muted-foreground">No families found. Try scanning more history or sync catalog first.</p>
          <Button variant="secondary" onClick={onRunHistoricalScan}><Search className="mr-2 h-4 w-4" /> Run Historical Scan (90 days)</Button>
        </div>
      )}

      {sortedFamilies.length > 0 && (
        <>
          <div className="flex gap-4 text-xs">
            <div className="flex items-center gap-1.5"><div className="h-2.5 w-2.5 rounded-full bg-success" /><span className="text-muted-foreground"><span className="font-medium text-foreground">{wineCount}</span> wine</span></div>
            <div className="flex items-center gap-1.5"><div className="h-2.5 w-2.5 rounded-full bg-muted-foreground" /><span className="text-muted-foreground"><span className="font-medium text-foreground">{sortedFamilies.length - wineCount}</span> non-wine</span></div>
          </div>
          <div className="flex gap-2 flex-wrap">
            <Button variant="outline" size="sm" onClick={() => {
              const o: Record<string, boolean> = {};
              sortedFamilies.forEach((f) => { o[f.name] = true; });
              setFamilyOverrides(o);
            }}>Select All as Wine</Button>
            <Button variant="outline" size="sm" onClick={() => {
              const o: Record<string, boolean> = {};
              sortedFamilies.forEach((f) => { o[f.name] = false; });
              setFamilyOverrides(o);
            }}>Deselect All</Button>
            <Button variant="outline" size="sm" onClick={() => setFamilyOverrides({})}>Reset</Button>
          </div>
          <div className="divide-y divide-border rounded-lg border border-border overflow-hidden max-h-96 overflow-y-auto">
            {sortedFamilies.map((f) => {
              const isWine = f.name in familyOverrides ? familyOverrides[f.name] : f.suggestedWine;
              const isOverridden = f.name in familyOverrides && familyOverrides[f.name] !== f.suggestedWine;
              return (
                <div key={f.name}>
                  <div className={`flex items-center justify-between px-4 py-3 transition-colors cursor-pointer hover:bg-secondary/30 ${isWine ? "bg-success/5" : "bg-card"}`}
                    onClick={() => setExpandedFamily(expandedFamily === f.name ? null : f.name)}>
                    <div className="flex items-center gap-3 min-w-0">
                      <Switch checked={isWine} onCheckedChange={(v) => {
                        setFamilyOverrides({ ...familyOverrides, [f.name]: v });
                        onAddKeyword(f.name, v ? "wine" : "non_wine");
                      }} onClick={(e) => e.stopPropagation()} />
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium text-foreground truncate">{f.name}</p>
                          {isOverridden && <Badge variant="outline" className="text-[10px] px-1.5 py-0">edited</Badge>}
                          <ChevronDown className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${expandedFamily === f.name ? "rotate-180" : ""}`} />
                        </div>
                        <div className="flex items-center gap-2 mt-0.5">
                          {confidenceIcon(f.confidence)}
                          <span className="text-[11px] text-muted-foreground capitalize">{f.confidence}</span>
                          <span className="text-[11px] text-muted-foreground">· {f.itemCount} items</span>
                          {f.wineCount > 0 && <span className="text-[11px] text-success">({f.wineCount} wine)</span>}
                        </div>
                      </div>
                    </div>
                    <div className="shrink-0">
                      {isWine ? <Badge variant="default" className="text-[10px]"><Wine className="mr-1 h-3 w-3" />Wine</Badge>
                        : <Badge variant="secondary" className="text-[10px]">Non-wine</Badge>}
                    </div>
                  </div>
                  {expandedFamily === f.name && (
                    <div className="bg-secondary/10 border-t border-border px-6 py-2 max-h-48 overflow-y-auto">
                      {(familyProducts[f.name] || []).length === 0 ? (
                        <p className="text-xs text-muted-foreground py-1">No products loaded for this family.</p>
                      ) : (
                        <table className="w-full text-xs">
                          <thead><tr className="text-muted-foreground border-b border-border">
                            <th className="text-left py-1 font-medium">Product</th>
                            <th className="text-left py-1 font-medium">Format</th>
                            <th className="text-right py-1 font-medium">Price</th>
                            <th className="text-right py-1 font-medium">Class</th>
                          </tr></thead>
                          <tbody>
                            {(familyProducts[f.name] || []).map((p, i) => (
                              <tr key={i} className="border-b border-border/50 last:border-0">
                                <td className="py-1 text-foreground">{p.name}</td>
                                <td className="py-1 text-muted-foreground">{p.format || "—"}</td>
                                <td className="py-1 text-right text-foreground">{p.unitPrice.toFixed(2)}€</td>
                                <td className="py-1 text-right">{p.isWine ? <Wine className="h-3 w-3 text-success inline" /> : <span className="text-muted-foreground">—</span>}</td>
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

// ── Step 5: Sales & Mapping ──
function StepSalesMapping({
  daysWithSales, selectedDay, setSelectedDay, loadingDays,
  salesEvents, loadingSales, onFetchDay, onSaveSales,
  saving, saveResult, familyOverrides, detectedFamilies,
  catalogProducts, onOverride, onBulkOverride, recomputing, onRecompute, recomputeResult,
}: {
  daysWithSales: string[]; selectedDay: string | null; setSelectedDay: (d: string) => void;
  loadingDays: boolean; salesEvents: SalesEvent[]; loadingSales: boolean;
  onFetchDay: (day: string) => void; onSaveSales: (day: string) => void;
  saving: boolean; saveResult: { savedEvents: number; savedLines: number } | null;
  familyOverrides: Record<string, boolean>; detectedFamilies: DetectedFamily[];
  catalogProducts: ProviderProduct[];
  onOverride: (id: string, override: "WINE" | "NOT_WINE" | "AUTO") => void;
  onBulkOverride: (ids: string[], override: "WINE" | "NOT_WINE") => void;
  recomputing: boolean; onRecompute: () => void;
  recomputeResult: { wine: number; notWine: number; needsReview: number } | null;
}) {
  const [searchMapping, setSearchMapping] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const useCatalog = catalogProducts.length > 0;

  const isFamilyWine = (familyName: string) => {
    if (familyName in familyOverrides) return familyOverrides[familyName];
    const detected = detectedFamilies.find((f) => f.name === familyName);
    return detected?.suggestedWine ?? false;
  };

  // Split products by classification
  const { wineProducts, notWineProducts, reviewProducts } = useMemo(() => {
    const products = useCatalog
      ? catalogProducts.map((p) => ({
          id: p.id, provider_product_id: p.provider_product_id, name: p.name,
          format: p.sale_format || "", family: p.family || "", quantity: 0,
          unit_price: p.price, total_amount: 0, vat_rate: p.vat_rate,
          is_wine_candidate: p.is_wine_candidate, wine_score: p.wine_score,
          wine_reasons: p.wine_reasons, classification_override: p.classification_override,
          last_score: p.last_score, last_reasons: p.last_reasons,
          familyIsWine: isFamilyWine(p.family || ""),
        }))
      : salesEvents.flatMap((ev) =>
          ev.lines.map((l, i) => ({
            id: `${ev.provider_doc_id}-${i}`, provider_product_id: l.provider_product_id, name: l.name,
            format: l.format, family: l.family, quantity: l.quantity,
            unit_price: l.unit_price, total_amount: l.total_amount, vat_rate: l.vat_rate,
            is_wine_candidate: l.is_wine_candidate, wine_score: l.wine_score || 0,
            wine_reasons: l.wine_reasons || [], classification_override: "AUTO",
            last_score: l.wine_score || 0, last_reasons: l.wine_reasons || [],
            familyIsWine: isFamilyWine(l.family),
          }))
        );

    const search = searchMapping.toLowerCase();
    const filtered = search
      ? products.filter((p) => p.name.toLowerCase().includes(search) || p.family.toLowerCase().includes(search))
      : products;

    return {
      wineProducts: filtered.filter((p) => p.classification_override === "WINE" || (p.classification_override === "AUTO" && p.is_wine_candidate)),
      notWineProducts: filtered.filter((p) => p.classification_override === "NOT_WINE" || (p.classification_override === "AUTO" && !p.is_wine_candidate && p.last_score <= 0)),
      reviewProducts: filtered.filter((p) => p.classification_override === "AUTO" && !p.is_wine_candidate && p.last_score > 0),
    };
  }, [catalogProducts, salesEvents, familyOverrides, detectedFamilies, searchMapping, useCatalog]);

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const renderProductRow = (p: typeof wineProducts[0]) => (
    <div key={p.id} className="flex items-center justify-between px-4 py-2 bg-card hover:bg-secondary/30 transition-colors group">
      <div className="flex items-center gap-3 min-w-0">
        {useCatalog && (
          <input type="checkbox" checked={selectedIds.has(p.id)} onChange={() => toggleSelect(p.id)}
            className="h-3.5 w-3.5 rounded border-border accent-primary" />
        )}
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground truncate">{p.name}</p>
          <p className="text-[11px] text-muted-foreground">
            {p.family && <span className="mr-2">{p.family}</span>}
            {p.format && <span className="mr-2">· {p.format}</span>}
            {p.unit_price > 0 && <span className="font-mono">€{p.unit_price.toFixed(2)}</span>}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {useCatalog && (
          <div className="hidden group-hover:flex gap-1">
            <button onClick={() => onOverride(p.id, "WINE")} className="text-[10px] px-1.5 py-0.5 rounded border border-success/30 text-success hover:bg-success/10">Wine</button>
            <button onClick={() => onOverride(p.id, "NOT_WINE")} className="text-[10px] px-1.5 py-0.5 rounded border border-destructive/30 text-destructive hover:bg-destructive/10">Not wine</button>
            {p.classification_override !== "AUTO" && (
              <button onClick={() => onOverride(p.id, "AUTO")} className="text-[10px] px-1.5 py-0.5 rounded border border-border text-muted-foreground hover:bg-secondary">Auto</button>
            )}
          </div>
        )}
        <ClassificationBadge product={p} />
      </div>
    </div>
  );

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Sales & Product Mapping</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {useCatalog ? "Products from catalog with classification. NEEDS_REVIEW tab shown by default." : "Review sales data."}
        </p>
        {useCatalog && <Badge variant="outline" className="mt-1 text-[10px]"><Package className="mr-1 h-3 w-3" /> Catalog ({catalogProducts.length})</Badge>}
      </div>

      {/* Day selector for invoice-based */}
      {!useCatalog && (
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-2 block"><Calendar className="inline h-3.5 w-3.5 mr-1" /> Business Day</label>
          {loadingDays ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-2"><Loader2 className="h-4 w-4 animate-spin" /> Scanning…</div>
          ) : daysWithSales.length === 0 ? (
            <p className="text-sm text-muted-foreground py-2">No cash closures found.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {daysWithSales.map((day) => (
                <button key={day} onClick={() => { setSelectedDay(day); onFetchDay(day); }}
                  className={`rounded-lg border px-3 py-2 text-xs font-mono transition-all ${selectedDay === day ? "border-primary bg-primary/5 text-primary" : "border-border text-muted-foreground hover:border-primary/30"}`}>
                  {day}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Recompute + bulk actions */}
      {useCatalog && (
        <div className="flex gap-2 flex-wrap items-center">
          <Button variant="secondary" size="sm" onClick={onRecompute} disabled={recomputing}>
            {recomputing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RotateCcw className="mr-2 h-4 w-4" />}
            Recompute Classification
          </Button>
          {selectedIds.size > 0 && (
            <>
              <Button variant="outline" size="sm" onClick={() => { onBulkOverride(Array.from(selectedIds), "WINE"); setSelectedIds(new Set()); }}>
                <Wine className="mr-1 h-3.5 w-3.5" /> Mark {selectedIds.size} as Wine
              </Button>
              <Button variant="outline" size="sm" onClick={() => { onBulkOverride(Array.from(selectedIds), "NOT_WINE"); setSelectedIds(new Set()); }}>
                Mark {selectedIds.size} as Not Wine
              </Button>
            </>
          )}
        </div>
      )}

      {recomputeResult && (
        <div className="rounded-lg border border-success/30 bg-success/5 p-3 text-xs">
          <p className="font-medium text-foreground flex items-center gap-1.5"><CheckCircle2 className="h-3.5 w-3.5 text-success" /> Classification recomputed</p>
          <p className="text-muted-foreground">{recomputeResult.wine} wine · {recomputeResult.notWine} not wine · {recomputeResult.needsReview} needs review</p>
        </div>
      )}

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input placeholder="Search products…" value={searchMapping} onChange={(e) => setSearchMapping(e.target.value)} className="pl-10 bg-background" />
      </div>

      {/* Tabs */}
      <Tabs defaultValue="review">
        <TabsList className="w-full">
          <TabsTrigger value="review" className="flex-1">
            <HelpCircle className="mr-1.5 h-3.5 w-3.5" /> Needs Review ({reviewProducts.length})
          </TabsTrigger>
          <TabsTrigger value="wine" className="flex-1">
            <Wine className="mr-1.5 h-3.5 w-3.5" /> Wine ({wineProducts.length})
          </TabsTrigger>
          <TabsTrigger value="notwine" className="flex-1">
            Not Wine ({notWineProducts.length})
          </TabsTrigger>
        </TabsList>
        <TabsContent value="review">
          <div className="divide-y divide-border rounded-lg border border-border overflow-hidden max-h-80 overflow-y-auto">
            {reviewProducts.length === 0 ? <div className="text-center py-8 text-sm text-muted-foreground">No products need review.</div>
              : reviewProducts.map(renderProductRow)}
          </div>
        </TabsContent>
        <TabsContent value="wine">
          <div className="divide-y divide-border rounded-lg border border-border overflow-hidden max-h-80 overflow-y-auto">
            {wineProducts.length === 0 ? <div className="text-center py-8 text-sm text-muted-foreground">No wine products.</div>
              : wineProducts.map(renderProductRow)}
          </div>
        </TabsContent>
        <TabsContent value="notwine">
          <div className="divide-y divide-border rounded-lg border border-border overflow-hidden max-h-80 overflow-y-auto">
            {notWineProducts.length === 0 ? <div className="text-center py-8 text-sm text-muted-foreground">No non-wine products.</div>
              : notWineProducts.map(renderProductRow)}
          </div>
        </TabsContent>
      </Tabs>

      {/* Save for invoice mode */}
      {!useCatalog && selectedDay && !loadingSales && salesEvents.length > 0 && (
        <Button size="sm" variant="secondary" className="w-full" onClick={() => onSaveSales(selectedDay)} disabled={saving}>
          {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
          {saveResult ? `Saved ${saveResult.savedEvents} events, ${saveResult.savedLines} lines` : "Save to DB"}
        </Button>
      )}
    </div>
  );
}

// ── Step 6: Wine Matching ──
interface ProductMapping {
  id: string;
  provider_product_id: string;
  provider_product_name: string;
  winerim_wine_id: string | null;
  winerim_wine_name: string | null;
  match_method: string;
  match_score: number;
  match_reasons: string[];
  status: string;
}

interface WinerimWine {
  winerim_id: string;
  name: string;
  winery: string | null;
  vintage: string | null;
  region: string | null;
}

function StepWineMatching({
  connectionId,
}: {
  connectionId: string | null;
}) {
  const [loading, setLoading] = useState(false);
  const [fetchingCatalog, setFetchingCatalog] = useState(false);
  const [matching, setMatching] = useState(false);
  const [aiMatching, setAiMatching] = useState(false);
  const [mappings, setMappings] = useState<ProductMapping[]>([]);
  const [winerimWines, setWinerimWines] = useState<WinerimWine[]>([]);
  const [matchResult, setMatchResult] = useState<{ matched: number; skuMatched: number; fuzzyMatched: number; noMatch: number } | null>(null);
  const [aiResult, setAiResult] = useState<{ processed: number; updated: number } | null>(null);
  const [searchWinerim, setSearchWinerim] = useState("");
  const [searchMappings, setSearchMappings] = useState("");
  const [editingMapping, setEditingMapping] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    if (!connectionId) return;
    setLoading(true);
    const [mappingsData, winesData] = await Promise.all([
      fetchAllMappings(connectionId),
      fetchAllWinerimWines(connectionId, "winerim_id, name, winery, vintage, region"),
    ]);
    setMappings(mappingsData as ProductMapping[]);
    setWinerimWines(winesData as WinerimWine[]);
    setLoading(false);
  }, [connectionId]);

  useEffect(() => { loadData(); }, [loadData]);

  const fetchWinerimCatalog = async () => {
    if (!connectionId) return;
    setFetchingCatalog(true);
    try {
      const { data, error } = await supabase.functions.invoke("winerim-proxy", {
        body: { action: "fetch-catalog", connectionId, mode: "start", detailOffset: 0, detailBatchSize: 100 },
      });
      if (error) throw error;
      if (data?.success) {
        toast({ title: "Catálogo Winerim cargado", description: `${data.totalWines} vinos importados` });
        await loadData();
      } else {
        toast({ title: "Error", description: data?.error || "No se pudo cargar el catálogo", variant: "destructive" });
      }
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    } finally { setFetchingCatalog(false); }
  };

  const runMatching = async () => {
    if (!connectionId) return;
    setMatching(true); setMatchResult(null);
    try {
      const { data, error } = await supabase.functions.invoke("winerim-proxy", {
        body: { action: "match-products", connectionId },
      });
      if (error) throw error;
      setMatchResult(data);
      await loadData();
    } catch (e: any) {
      toast({ title: "Error matching", description: e.message, variant: "destructive" });
    } finally { setMatching(false); }
  };

  const runAiMatching = async () => {
    if (!connectionId) return;
    setAiMatching(true); setAiResult(null);
    try {
      const { data, error } = await supabase.functions.invoke("winerim-proxy", {
        body: { action: "ai-match", connectionId },
      });
      if (error) throw error;
      setAiResult(data);
      await loadData();
    } catch (e: any) {
      toast({ title: "Error AI matching", description: e.message, variant: "destructive" });
    } finally { setAiMatching(false); }
  };

  const confirmMapping = async (mappingId: string, winerimWineId?: string, winerimWineName?: string) => {
    await supabase.functions.invoke("winerim-proxy", {
      body: { action: "confirm-mapping", connectionId, mappingId, winerimWineId, winerimWineName },
    });
    await loadData();
    setEditingMapping(null);
  };

  const rejectMapping = async (mappingId: string) => {
    await supabase.functions.invoke("winerim-proxy", {
      body: { action: "reject-mapping", connectionId, mappingId },
    });
    await loadData();
  };

  const ignoreMapping = async (mappingId: string) => {
    await supabase.functions.invoke("winerim-proxy", {
      body: { action: "ignore-mapping", connectionId, mappingId },
    });
    await loadData();
  };

  const matchesSearch = (m: ProductMapping) => {
    if (!searchMappings.trim()) return true;
    const q = searchMappings.toLowerCase();
    return m.provider_product_name.toLowerCase().includes(q) || (m.winerim_wine_name || "").toLowerCase().includes(q);
  };

  const pendingMappings = mappings.filter(m => m.status === "PENDING" && matchesSearch(m));
  const confirmedMappings = mappings.filter(m => m.status === "CONFIRMED" && matchesSearch(m));
  const rejectedMappings = mappings.filter(m => (m.status === "REJECTED" || m.status === "IGNORED") && matchesSearch(m));

  const filteredWines = searchWinerim
    ? winerimWines.filter(w => w.name.toLowerCase().includes(searchWinerim.toLowerCase()) || (w.winery || "").toLowerCase().includes(searchWinerim.toLowerCase()))
    : winerimWines;

  const methodBadge = (method: string) => {
    const v = method === "SKU" ? "default" : method === "AI" ? "secondary" : "outline";
    return <Badge variant={v} className="text-[10px]">{method}</Badge>;
  };

  const scoreBadge = (score: number) => {
    const color = score >= 80 ? "text-success" : score >= 50 ? "text-warning" : "text-destructive";
    return <span className={`font-mono text-[10px] font-medium ${color}`}>{score}%</span>;
  };

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Wine Matching (POS → Winerim)</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Match POS wine products with your Winerim catalog to enable stock sync.
        </p>
      </div>

      {/* Status bar */}
      <div className="rounded-lg border border-border bg-secondary/30 p-4 space-y-2">
        <div className="grid grid-cols-3 gap-4 text-xs">
          <div><span className="text-muted-foreground block">Winerim Wines</span><span className="font-medium text-foreground text-sm">{winerimWines.length}</span></div>
          <div><span className="text-muted-foreground block">Matched</span><span className="font-medium text-success text-sm">{confirmedMappings.length}</span></div>
          <div><span className="text-muted-foreground block">Pending Review</span><span className="font-medium text-warning text-sm">{pendingMappings.length}</span></div>
        </div>
      </div>

      {/* Action buttons */}
      <div className="flex gap-2 flex-wrap">
        <Button variant="secondary" size="sm" onClick={fetchWinerimCatalog} disabled={fetchingCatalog}>
          {fetchingCatalog ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
          {winerimWines.length > 0 ? "Refresh Winerim Catalog" : "Fetch Winerim Catalog"}
        </Button>
        {winerimWines.length > 0 && (
          <>
            <Button variant="secondary" size="sm" onClick={runMatching} disabled={matching}>
              {matching ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Zap className="mr-2 h-4 w-4" />}
              SKU + Fuzzy Match
            </Button>
            {pendingMappings.length > 0 && (
              <Button variant="outline" size="sm" onClick={runAiMatching} disabled={aiMatching}>
                {aiMatching ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <span className="mr-2">🤖</span>}
                AI Match ({pendingMappings.length} pending)
              </Button>
            )}
          </>
        )}
      </div>

      {matchResult && (
        <div className="rounded-lg border border-success/30 bg-success/5 p-3 text-xs space-y-1">
          <p className="font-medium text-foreground flex items-center gap-1.5"><CheckCircle2 className="h-3.5 w-3.5 text-success" /> Matching completed</p>
          <p className="text-muted-foreground">
            {matchResult.matched} matched ({matchResult.skuMatched} SKU, {matchResult.fuzzyMatched} fuzzy), {matchResult.noMatch} no match
          </p>
        </div>
      )}
      {aiResult && (
        <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 text-xs space-y-1">
          <p className="font-medium text-foreground flex items-center gap-1.5">🤖 AI Matching completed</p>
          <p className="text-muted-foreground">{aiResult.processed} processed, {aiResult.updated} updated</p>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : mappings.length === 0 && winerimWines.length === 0 ? (
        <div className="text-center py-8 rounded-lg border border-border bg-secondary/20 space-y-2">
          <Wine className="mx-auto h-8 w-8 text-muted-foreground/40 mb-2" />
          <p className="text-sm text-muted-foreground">Fetch your Winerim catalog first, then run matching.</p>
        </div>
      ) : mappings.length === 0 && winerimWines.length > 0 ? (
        <div className="rounded-lg border border-blue-500/20 bg-blue-500/5 p-4 space-y-2">
          <div className="flex items-start gap-2">
            <HelpCircle className="h-4 w-4 text-blue-500 mt-0.5 shrink-0" />
            <div>
              <p className="text-sm font-medium text-foreground">No POS wine products to match</p>
              <p className="text-xs text-muted-foreground mt-1">
                This customer has no wine products in Agora yet. Use the <strong>Winerim Catalog</strong> step (next step) to browse and push wines directly into Agora.
              </p>
            </div>
          </div>
        </div>
      ) : (
        <>
        {/* Search mappings */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input placeholder="Search mappings…" value={searchMappings} onChange={(e) => setSearchMappings(e.target.value)} className="pl-10 bg-background" />
        </div>
        <Tabs defaultValue="pending" className="space-y-3">
          <TabsList className="w-full">
            <TabsTrigger value="pending" className="flex-1">
              <HelpCircle className="mr-1.5 h-3.5 w-3.5" /> Pending ({pendingMappings.length})
            </TabsTrigger>
            <TabsTrigger value="confirmed" className="flex-1">
              <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" /> Confirmed ({confirmedMappings.length})
            </TabsTrigger>
            <TabsTrigger value="rejected" className="flex-1">
              Rejected ({rejectedMappings.length})
            </TabsTrigger>
          </TabsList>

          {[
            { key: "pending", items: pendingMappings },
            { key: "confirmed", items: confirmedMappings },
            { key: "rejected", items: rejectedMappings },
          ].map(({ key, items }) => (
            <TabsContent key={key} value={key}>
              <div className="divide-y divide-border rounded-lg border border-border overflow-hidden max-h-80 overflow-y-auto">
                {items.length === 0 ? (
                  <div className="text-center py-8 text-sm text-muted-foreground">
                    {key === "pending" ? "No pending matches. Run matching first." : `No ${key} matches.`}
                  </div>
                ) : items.map((m) => (
                  <div key={m.id} className="px-4 py-3 bg-card hover:bg-secondary/30 transition-colors">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-foreground truncate">{m.provider_product_name}</p>
                        <div className="flex items-center gap-2 mt-1">
                          <ArrowRight className="h-3 w-3 text-muted-foreground shrink-0" />
                          <p className="text-sm text-primary truncate">{m.winerim_wine_name || "No match"}</p>
                        </div>
                        <div className="flex items-center gap-2 mt-1">
                          {methodBadge(m.match_method)}
                          {scoreBadge(m.match_score)}
                          {m.match_reasons.length > 0 && (
                            <TooltipProvider>
                              <Tooltip>
                                <TooltipTrigger><HelpCircle className="h-3 w-3 text-muted-foreground" /></TooltipTrigger>
                                <TooltipContent side="right" className="max-w-xs text-xs">
                                  {m.match_reasons.map((r, i) => <div key={i}>{r}</div>)}
                                </TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          )}
                        </div>
                      </div>
                      {key === "pending" && (
                        <div className="flex gap-1 shrink-0">
                          <Button variant="ghost" size="sm" className="h-7 px-2 text-success hover:text-success" onClick={() => confirmMapping(m.id)}>
                            <CheckCircle2 className="h-3.5 w-3.5" />
                          </Button>
                          <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => setEditingMapping(editingMapping === m.id ? null : m.id)}>
                            <Search className="h-3.5 w-3.5" />
                          </Button>
                          <Button variant="ghost" size="sm" className="h-7 px-2 text-destructive hover:text-destructive" onClick={() => rejectMapping(m.id)}>
                            <XCircle className="h-3.5 w-3.5" />
                          </Button>
                          <Button variant="ghost" size="sm" className="h-7 px-2 text-muted-foreground" onClick={() => ignoreMapping(m.id)}>
                            <Filter className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      )}
                    </div>
                    {/* Manual search panel */}
                    {editingMapping === m.id && (
                      <div className="mt-3 border-t border-border pt-3 space-y-2">
                        <div className="relative">
                          <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                          <Input placeholder="Search Winerim wines…" value={searchWinerim} onChange={(e) => setSearchWinerim(e.target.value)} className="pl-9 bg-background text-sm h-8" />
                        </div>
                        <div className="max-h-40 overflow-y-auto divide-y divide-border rounded border border-border">
                          {filteredWines.slice(0, 20).map((w) => (
                            <button key={w.winerim_id} onClick={() => confirmMapping(m.id, w.winerim_id, w.name)}
                              className="w-full text-left px-3 py-2 text-xs hover:bg-secondary/30 transition-colors flex items-center justify-between">
                              <div>
                                <span className="font-medium text-foreground">{w.name}</span>
                                {w.winery && <span className="text-muted-foreground ml-2">({w.winery})</span>}
                                {w.vintage && <span className="text-muted-foreground ml-1">{w.vintage}</span>}
                              </div>
                              <CheckCircle2 className="h-3.5 w-3.5 text-primary shrink-0" />
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </TabsContent>
          ))}
        </Tabs>
        </>
      )}
    </div>
  );
}

// ── Step 9: Winerim Catalog (Winerim → Agora) ──
interface WinerimCatalogWine {
  winerim_id: string;
  name: string;
  wine_type: string | null;
  bottle_sale_price: number | null;
  bottle_purchase_price: number | null;
  glass_sale_price: number | null;
  glass_cost_price: number | null;
  magnum_sale_price: number | null;
  magnum_purchase_price: number | null;
  serve_by_glass: boolean;
  is_active: boolean;
  winery: string | null;
  region: string | null;
  vintage: string | null;
  updated_at: string;
  pricing_status: string;
  pricing_missing_reason: string | null;
}

const PRICING_REASON_ORDER = [
  "503_from_winerim",
  "detail_fetch_failed",
  "no_prices_array",
  "prices_array_empty",
  "format_not_recognized",
  "sale_price_missing",
  "parser_error",
  "unknown",
] as const;

type PricingMissingReason = (typeof PRICING_REASON_ORDER)[number];

const RETRYABLE_REASONS = new Set<PricingMissingReason>(["503_from_winerim"]);

const normalizePricingReason = (reason: string | null | undefined): PricingMissingReason => {
  if (!reason) return "unknown";
  return (PRICING_REASON_ORDER as readonly string[]).includes(reason) ? (reason as PricingMissingReason) : "unknown";
};

const isRetryableReason = (reason: PricingMissingReason) => RETRYABLE_REASONS.has(reason);

function StepWinerimCatalog({
  connectionId,
  onQueueProducts,
  queuingProducts,
  families,
  priceListCount,
}: {
  connectionId: string | null;
  onQueueProducts: (ids: string[], formatTypes?: string[], familyOverrideId?: string) => void;
  queuingProducts: boolean;
  families: { Id: string; Name: string }[];
  priceListCount: number;
}) {
  const [wines, setWines] = useState<WinerimCatalogWine[]>([]);
  const [loading, setLoading] = useState(false);
  const [fetchingCatalog, setFetchingCatalog] = useState(false);
  const [refreshDiagnostics, setRefreshDiagnostics] = useState<{
    total: number;
    processed: number;
    listFetched: number;
    detailAttempted: number;
    detailSucceeded: number;
    bottleUpdated: number;
    glassUpdated: number;
  } | null>(null);
  const [lastEnrichedAt, setLastEnrichedAt] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filterActive, setFilterActive] = useState(true);
  const [filterGlass, setFilterGlass] = useState(false);
  const [filterNonReadyOnly, setFilterNonReadyOnly] = useState(false);
  const [filterMissingReason, setFilterMissingReason] = useState<"all" | PricingMissingReason>("all");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [familyOverrideId, setFamilyOverrideId] = useState("");
  const [previewXml, setPreviewXml] = useState<string | null>(null);
  const [generatingXml, setGeneratingXml] = useState(false);
  const [enrichingMissing, setEnrichingMissing] = useState(false);
  const [diagnosingUnknown, setDiagnosingUnknown] = useState(false);
  const [diagnoseResult, setDiagnoseResult] = useState<{
    totalNonReady: number;
    reclassified: number;
    results: Record<string, number>;
    debugSamples: any[];
  } | null>(null);
  const [enrichResult, setEnrichResult] = useState<{
    processed: number;
    movedToReady: number;
    readyBefore: number;
    readyAfter: number;
    missingBefore: number;
    missingAfter: number;
    byStatusAfter: Record<string, number>;
    byReasonAfter: Record<PricingMissingReason, number>;
  } | null>(null);

  const loadWines = useCallback(async () => {
    if (!connectionId) return;
    setLoading(true);
    const data = await fetchAllWinerimWines(
      connectionId,
      "winerim_id, name, wine_type, bottle_sale_price, bottle_purchase_price, glass_sale_price, glass_cost_price, magnum_sale_price, magnum_purchase_price, serve_by_glass, is_active, winery, region, vintage, updated_at, pricing_status, pricing_missing_reason"
    );
    const rows = data as WinerimCatalogWine[];
    setWines(rows);

    const latestEnriched = rows
      .filter((w) =>
        (w.bottle_sale_price != null && Number(w.bottle_sale_price) > 0) ||
        (w.glass_sale_price != null && Number(w.glass_sale_price) > 0) ||
        (w.magnum_sale_price != null && Number(w.magnum_sale_price) > 0)
      )
      .map((w) => w.updated_at)
      .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0] || null;

    setLastEnrichedAt(latestEnriched);
    setLoading(false);
  }, [connectionId]);

  useEffect(() => { loadWines(); }, [loadWines]);

  const fetchCatalog = async () => {
    if (!connectionId) return;
    setFetchingCatalog(true);
    setRefreshDiagnostics(null);

    try {
      const runBatch = async (mode: "start" | "enrich", offset: number) => {
        const { data, error } = await supabase.functions.invoke("winerim-proxy", {
          body: { action: "fetch-catalog", connectionId, mode, detailOffset: offset, detailBatchSize: 100 },
        });
        if (error) throw error;
        if (!data?.success) throw new Error(data?.error || "Catalog refresh failed");
        return data;
      };

      let total = 0;
      let processed = 0;
      let listFetched = 0;
      let detailAttempted = 0;
      let detailSucceeded = 0;
      let bottleUpdated = 0;
      let glassUpdated = 0;

      let mode: "start" | "enrich" = "start";
      let nextOffset = 0;
      let complete = false;
      let completionTs: string | null = null;

      while (!complete) {
        const batch = await runBatch(mode, nextOffset);

        total = Number(batch.totalWines || total);
        processed = Number(batch.processedDetails || processed);
        listFetched = Math.max(listFetched, Number(batch.listWinesFetched || 0));
        detailAttempted += Number(batch.detailRequestsAttempted || 0);
        detailSucceeded += Number(batch.detailRequestsSucceeded || 0);
        bottleUpdated += Number(batch.winesUpdatedWithBottlePrice || 0);
        glassUpdated += Number(batch.winesUpdatedWithGlassPrice || 0);

        setRefreshDiagnostics({
          total,
          processed,
          listFetched,
          detailAttempted,
          detailSucceeded,
          bottleUpdated,
          glassUpdated,
        });

        complete = Boolean(batch.complete);
        if (complete) {
          completionTs = batch.enrichmentCompletedAt || new Date().toISOString();
        } else {
          const candidateOffset = Number(batch.nextDetailOffset ?? processed);
          if (!Number.isFinite(candidateOffset) || candidateOffset <= nextOffset) {
            throw new Error("Pricing enrichment stalled before completion.");
          }
          nextOffset = candidateOffset;
          mode = "enrich";
        }
      }

      await loadWines();
      if (completionTs) setLastEnrichedAt(completionTs);

      if (detailAttempted > 0 && detailSucceeded === 0) {
        toast({
          title: "Catalog synced, but detail enrichment failed",
          description: "No wine detail requests succeeded. Check connection/token and retry refresh.",
          variant: "destructive",
        });
      } else {
        toast({
          title: "Winerim catalog refresh completed",
          description: `List: ${listFetched} wines · Details: ${detailSucceeded}/${detailAttempted} · Bottle priced: ${bottleUpdated} · Glass priced: ${glassUpdated}`,
        });
      }
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    } finally {
      setFetchingCatalog(false);
    }
  };

  const filteredWines = useMemo(() => {
    let result = wines;
    if (filterActive) result = result.filter(w => w.is_active);
    if (filterGlass) result = result.filter(w => w.serve_by_glass);
    if (filterNonReadyOnly || filterMissingReason !== "all") {
      result = result.filter(w => (w.pricing_status || "MISSING") !== "READY");
    }
    if (filterMissingReason !== "all") {
      result = result.filter(w => normalizePricingReason(w.pricing_missing_reason) === filterMissingReason);
    }
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(w =>
        w.name.toLowerCase().includes(q) ||
        (w.winery || "").toLowerCase().includes(q) ||
        (w.wine_type || "").toLowerCase().includes(q) ||
        (w.region || "").toLowerCase().includes(q)
      );
    }
    return result;
  }, [wines, search, filterActive, filterGlass, filterNonReadyOnly, filterMissingReason]);

  const toggleWine = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const selectAll = () => setSelectedIds(new Set(filteredWines.map(w => w.winerim_id)));
  const clearSelection = () => setSelectedIds(new Set());

  const pricingStats = useMemo(() => {
    const byStatus: Record<string, number> = {};
    const byReason = Object.fromEntries(PRICING_REASON_ORDER.map((reason) => [reason, 0])) as Record<PricingMissingReason, number>;
    let nonReadyTotal = 0;
    let retryable = 0;
    let nonRetryable = 0;

    for (const w of wines) {
      const st = w.pricing_status || "MISSING";
      byStatus[st] = (byStatus[st] || 0) + 1;
      if (st !== "READY") {
        nonReadyTotal += 1;
        const reason = normalizePricingReason(w.pricing_missing_reason);
        byReason[reason] = (byReason[reason] || 0) + 1;
        if (isRetryableReason(reason)) retryable += 1;
        else nonRetryable += 1;
      }
    }

    return { byStatus, byReason, nonReadyTotal, retryable, nonRetryable };
  }, [wines]);

  const enrichMissingPrices = async () => {
    if (!connectionId) return;
    setEnrichingMissing(true);
    setEnrichResult(null);

    // Capture "before" snapshot from current wines state
    const readyBefore = wines.filter(w => w.pricing_status === "READY").length;
    const missingBefore = wines.length - readyBefore;

    let totalProcessed = 0;
    try {
      for (let i = 0; i < 5; i++) {
        const { data, error } = await supabase.functions.invoke("winerim-proxy", {
          body: { action: "fetch-wine-details", connectionId },
        });
        if (error) throw error;
        if (!data?.success) break;
        totalProcessed += data.enriched || 0;
        if ((data.requested || 0) === 0) break;
      }

      // Re-fetch wines from DB to get fresh counts
      const freshWines = await fetchAllWinerimWines(
        connectionId,
        "winerim_id, name, wine_type, bottle_sale_price, bottle_purchase_price, glass_sale_price, glass_cost_price, magnum_sale_price, magnum_purchase_price, serve_by_glass, is_active, winery, region, vintage, updated_at, pricing_status, pricing_missing_reason"
      ) as WinerimCatalogWine[];
      setWines(freshWines);

      // Compute "after" stats from fresh data
      const byStatusAfter: Record<string, number> = {};
      const byReasonAfter = Object.fromEntries(PRICING_REASON_ORDER.map((reason) => [reason, 0])) as Record<PricingMissingReason, number>;
      for (const w of freshWines) {
        const st = w.pricing_status || "MISSING";
        byStatusAfter[st] = (byStatusAfter[st] || 0) + 1;
        if (st !== "READY") {
          const reason = normalizePricingReason(w.pricing_missing_reason);
          byReasonAfter[reason] = (byReasonAfter[reason] || 0) + 1;
        }
      }
      const readyAfter = byStatusAfter.READY || 0;
      const missingAfter = freshWines.length - readyAfter;
      const movedToReady = readyAfter - readyBefore;

      setEnrichResult({
        processed: totalProcessed,
        movedToReady,
        readyBefore,
        readyAfter,
        missingBefore,
        missingAfter,
        byStatusAfter,
        byReasonAfter,
      });

      toast({
        title: "Pricing enrichment complete",
        description: `${totalProcessed} processed · ${movedToReady} newly priced · ${missingAfter} still pending`,
      });
    } catch (e: any) {
      toast({ title: "Enrichment error", description: e.message, variant: "destructive" });
    } finally { setEnrichingMissing(false); }
  };

  const diagnoseUnknownWines = async () => {
    if (!connectionId) return;
    setDiagnosingUnknown(true);
    setDiagnoseResult(null);
    try {
      const { data, error } = await supabase.functions.invoke("winerim-proxy", {
        body: { action: "diagnose-unknown", connectionId },
      });
      if (error) throw error;
      setDiagnoseResult(data);
      await loadWines();
      toast({
        title: "Diagnosis complete",
        description: `${data.reclassified} wines reclassified with explicit reasons`,
      });
    } catch (e: any) {
      toast({ title: "Diagnosis error", description: e.message, variant: "destructive" });
    } finally { setDiagnosingUnknown(false); }
  };

  const handlePreviewXml = async () => {
    if (!connectionId || selectedIds.size === 0) return;
    setGeneratingXml(true);
    setPreviewXml(null);
    try {
      // Always send both formats — backend validates per-wine eligibility
      const formatTypes = ["BOTTLE", "GLASS"];

      const { data, error } = await supabase.functions.invoke("agora-proxy", {
        body: { action: "preview-xml", connectionId, winerimWineIds: Array.from(selectedIds), formatTypes },
      });
      if (error) throw error;

      const validationResults = data?.validationResults || [];
      
      // Build format diagnostics
      const formatsGenerated = validationResults.filter((v: any) => v.validation?.valid).map((v: any) => v.formatType);
      const formatsSkipped = validationResults.filter((v: any) => !v.validation?.valid);
      const uniqueGenerated = [...new Set(formatsGenerated)] as string[];
      const skippedReasons = formatsSkipped.map((v: any) => {
        const wine = wines.find(w => w.winerim_id === v.winerimId);
        const name = wine?.name || v.winerimId;
        const missing = v.validation?.missingFields || [];
        if (v.formatType === "GLASS") {
          if (missing.includes("missing_glass_sale_price")) return `COPA ${name}: No glass price available`;
          if (missing.includes("serve_by_glass_not_enabled")) return `COPA ${name}: serve_by_glass not enabled`;
          if (missing.includes("wine_inactive")) return `COPA ${name}: Wine is inactive`;
        }
        if (v.formatType === "BOTTLE") {
          if (missing.includes("missing_bottle_sale_price")) return `BOT. ${name}: No bottle price available`;
          if (missing.includes("wine_inactive")) return `BOT. ${name}: Wine is inactive`;
        }
        return `${v.formatType} ${name}: ${missing.join(", ")}`;
      });

      const allInvalid = validationResults.length > 0 && validationResults.every((v: any) => !v.validation?.valid);

      if (allInvalid && (!data?.xml || !data.xml.includes("<Product"))) {
        const warningMsg = skippedReasons.length > 0
          ? `No exportable products found.\n\nIssues:\n${skippedReasons.map((w: string) => `• ${w}`).join("\n")}\n\nTip: Click "Refresh Catalog" to re-fetch wine details.`
          : "No exportable products found. Click \"Refresh Catalog\" to re-fetch.";
        setPreviewXml(warningMsg);
      } else {
        // Build diagnostic header
        const diagLines: string[] = [];
        diagLines.push(`Formats generated: ${uniqueGenerated.join(", ") || "none"}`);
        if (skippedReasons.length > 0) {
          diagLines.push(`Formats skipped (${formatsSkipped.length}):`);
          skippedReasons.forEach((r: string) => diagLines.push(`  - ${r}`));
        }
        const diagComment = `<!-- DIAGNOSTICS:\n${diagLines.map(l => `  ${l}`).join("\n")}\n-->`;
        setPreviewXml(`${diagComment}\n${data?.xml || "No XML generated"}`);
      }
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    } finally { setGeneratingXml(false); }
  };

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Winerim Catalog (Winerim → Agora)</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Browse your Winerim wine catalog, select wines, and push them to Agora POS.
        </p>
      </div>

      {/* Stats */}
      <div className="rounded-lg border border-border bg-secondary/30 p-4 space-y-2">
        <div className="grid grid-cols-3 sm:grid-cols-6 gap-4 text-xs">
          <div><span className="text-muted-foreground block">Total Wines</span><span className="font-medium text-foreground text-sm">{wines.length}</span></div>
          <div><span className="text-muted-foreground block">Active</span><span className="font-medium text-success text-sm">{wines.filter(w => w.is_active).length}</span></div>
          <div><span className="text-muted-foreground block">With Bottle Price</span><span className="font-medium text-foreground text-sm">{wines.filter(w => w.bottle_sale_price != null && Number(w.bottle_sale_price) > 0).length}</span></div>
          <div><span className="text-muted-foreground block">With Glass Price</span><span className="font-medium text-foreground text-sm">{wines.filter(w => w.serve_by_glass && w.glass_sale_price != null && Number(w.glass_sale_price) > 0).length}</span></div>
          <div><span className="text-muted-foreground block">With Magnum Price</span><span className="font-medium text-foreground text-sm">{wines.filter(w => w.magnum_sale_price != null && Number(w.magnum_sale_price) > 0).length}</span></div>
          <div><span className="text-muted-foreground block">Serve by Glass</span><span className="font-medium text-foreground text-sm">{wines.filter(w => w.serve_by_glass).length}</span></div>
        </div>
        {lastEnrichedAt && (
          <p className="text-[11px] text-muted-foreground">
            Pricing enrichment completed: {new Date(lastEnrichedAt).toLocaleString()}
          </p>
        )}
        {wines.length > 0 && wines.filter(w => (w.bottle_sale_price != null && Number(w.bottle_sale_price) > 0) || (w.glass_sale_price != null && Number(w.glass_sale_price) > 0) || (w.magnum_sale_price != null && Number(w.magnum_sale_price) > 0)).length === 0 && (
          <div className="flex items-start gap-2 mt-2 p-2 rounded bg-destructive/10 border border-destructive/20">
            <AlertTriangle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
            <p className="text-xs text-destructive">
              No wines have pricing data yet. Click <strong>"Refresh Catalog"</strong> to fetch wine details including prices from Winerim.
            </p>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex gap-2 flex-wrap">
        <Button variant="secondary" size="sm" onClick={fetchCatalog} disabled={fetchingCatalog}>
          {fetchingCatalog ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
          {fetchingCatalog
            ? `Refreshing… ${refreshDiagnostics?.processed || 0}/${refreshDiagnostics?.total || 0}`
            : wines.length > 0 ? "Refresh Catalog" : "Fetch Winerim Catalog"}
        </Button>
        {wines.length > 0 && pricingStats.nonReadyTotal > 0 && (
          <Button variant="outline" size="sm" onClick={enrichMissingPrices} disabled={enrichingMissing || fetchingCatalog}>
            {enrichingMissing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Zap className="mr-2 h-4 w-4" />}
            {enrichingMissing ? "Enriching…" : `Re-enrich ${pricingStats.nonReadyTotal} non-ready wines`}
          </Button>
        )}
        {wines.length > 0 && (pricingStats.byReason.unknown || 0) > 0 && (
          <Button variant="outline" size="sm" onClick={diagnoseUnknownWines} disabled={diagnosingUnknown || fetchingCatalog}>
            {diagnosingUnknown ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Search className="mr-2 h-4 w-4" />}
            {diagnosingUnknown ? "Diagnosing…" : `Diagnose ${pricingStats.byReason.unknown} unknown reasons`}
          </Button>
        )}
      </div>

      {/* Missing price diagnostics */}
      {wines.length > 0 && pricingStats.nonReadyTotal > 0 && !fetchingCatalog && !enrichingMissing && (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-card border border-border">
          <AlertTriangle className="h-4 w-4 text-yellow-400 shrink-0 mt-0.5" />
          <div className="text-xs text-foreground space-y-1.5">
            <p className="font-semibold text-sm"><span className="text-yellow-400">{pricingStats.nonReadyTotal}</span> wines currently non-ready</p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-1 text-foreground/80">
              <span>⚠️ Missing: <strong className="text-foreground">{pricingStats.byStatus.MISSING || 0}</strong></span>
              <span>⏳ Retrying: <strong className="text-foreground">{pricingStats.byStatus.RETRYING || 0}</strong></span>
              <span>❌ Failed: <strong className="text-foreground">{pricingStats.byStatus.FAILED || 0}</strong></span>
              <span>Total: <strong className="text-foreground">{pricingStats.nonReadyTotal}</strong></span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-1 text-foreground/80 mt-1">
              <span>🔄 Retryable: <strong className="text-blue-400">{pricingStats.retryable}</strong></span>
              <span>🚫 Non-retryable: <strong className="text-red-400">{pricingStats.nonRetryable}</strong></span>
            </div>
            <div className="mt-2 pt-2 border-t border-border/50">
              <p className="text-foreground/70 font-medium mb-1">Stuck set by reason:</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-4 gap-y-1 text-foreground/80">
                {PRICING_REASON_ORDER.map((reason) => {
                  const count = pricingStats.byReason[reason] || 0;
                  return (
                    <span key={reason} className={count > 0 ? "text-foreground" : "text-foreground/40"}>
                      {reason}: <strong>{count}</strong>{" "}
                      <span className={`text-[10px] ${isRetryableReason(reason) ? "text-blue-400" : "text-red-400/70"}`}>
                        {isRetryableReason(reason) ? "retryable" : "non-retryable"}
                      </span>
                    </span>
                  );
                })}
              </div>
            </div>
            {(pricingStats.byReason.unknown || 0) > 0 && (
              <div className="mt-2 p-2 rounded bg-red-500/10 border border-red-500/30">
                <p className="text-red-300 text-[11px]">
                  ⚠ <strong className="text-red-200">{pricingStats.byReason.unknown}</strong> wines have "unknown" reason — the system failed to classify the missing-price cause. Click <strong className="text-red-200">"Diagnose unknown reasons"</strong> to reclassify them. This count should be close to zero.
                </p>
              </div>
            )}
            {diagnoseResult && (
              <div className="mt-2 p-2.5 rounded bg-secondary border border-border space-y-1.5">
                <p className="font-semibold text-foreground text-xs">Diagnosis result:</p>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1 text-foreground/80">
                  <span>Reclassified: <strong className="text-foreground">{diagnoseResult.reclassified}</strong></span>
                  {Object.entries(diagnoseResult.results).map(([reason, count]) => (
                    <span key={reason}>{reason}: <strong className="text-foreground">{count}</strong></span>
                  ))}
                </div>
                {diagnoseResult.debugSamples.length > 0 && (
                  <details className="mt-1">
                    <summary className="text-foreground/60 cursor-pointer text-[11px] hover:text-foreground/80">Debug samples ({diagnoseResult.debugSamples.length})</summary>
                    <pre className="mt-1 text-[10px] font-mono text-foreground/70 bg-background/50 p-2 rounded whitespace-pre-wrap max-h-40 overflow-y-auto">
                      {JSON.stringify(diagnoseResult.debugSamples, null, 2)}
                    </pre>
                  </details>
                )}
              </div>
            )}
            {enrichResult && (
              <div className="mt-2 p-2.5 rounded bg-secondary border border-border space-y-1.5">
                <p className="font-semibold text-foreground text-xs">Last enrichment run:</p>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-1 text-foreground/80">
                  <span>Processed: <strong className="text-foreground">{enrichResult.processed}</strong></span>
                  <span>Moved to READY: <strong className={enrichResult.movedToReady > 0 ? "text-green-400" : "text-foreground"}>{enrichResult.movedToReady}</strong></span>
                  <span>Ready: {enrichResult.readyBefore} → <strong className="text-foreground">{enrichResult.readyAfter}</strong></span>
                  <span>Non-ready: {enrichResult.missingBefore} → <strong className="text-foreground">{enrichResult.missingAfter}</strong></span>
                </div>
                {enrichResult.missingAfter > 0 && (
                  <div className="mt-1.5 pt-1.5 border-t border-border/50">
                    <p className="text-foreground/70 font-medium mb-1">Still pending by reason:</p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-4 gap-y-1 text-foreground/80">
                      {PRICING_REASON_ORDER.map((reason) => (
                        <span key={reason}>{reason}: <strong className="text-foreground">{enrichResult.byReasonAfter[reason] || 0}</strong></span>
                      ))}
                    </div>
                  </div>
                )}
                {enrichResult.missingAfter > 0 && enrichResult.missingAfter === enrichResult.missingBefore && (
                  <p className="text-red-400 mt-1.5 font-semibold">⚠ No net progress — same wines remain stuck. Check reasons above.</p>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {(fetchingCatalog || refreshDiagnostics) && (
        <div className="rounded-lg border border-border bg-secondary/30 p-3 text-xs space-y-1">
          <p className="text-muted-foreground">Diagnostics</p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <p className="text-foreground">List fetched: <span className="font-mono">{refreshDiagnostics?.listFetched ?? 0}</span></p>
            <p className="text-foreground">Details attempted: <span className="font-mono">{refreshDiagnostics?.detailAttempted ?? 0}</span></p>
            <p className="text-foreground">Details succeeded: <span className="font-mono">{refreshDiagnostics?.detailSucceeded ?? 0}</span></p>
            <p className="text-foreground">Progress: <span className="font-mono">{refreshDiagnostics?.processed ?? 0}/{refreshDiagnostics?.total ?? 0}</span></p>
            <p className="text-foreground">Bottle priced: <span className="font-mono">{refreshDiagnostics?.bottleUpdated ?? 0}</span></p>
            <p className="text-foreground">Glass priced: <span className="font-mono">{refreshDiagnostics?.glassUpdated ?? 0}</span></p>
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : wines.length === 0 ? (
        <div className="text-center py-8 rounded-lg border border-border bg-secondary/20">
          <Wine className="mx-auto h-8 w-8 text-muted-foreground/40 mb-2" />
          <p className="text-sm text-muted-foreground">No Winerim wines synced yet. Click "Fetch Winerim Catalog" above.</p>
        </div>
      ) : (
        <>
          {/* Search and filters */}
          <div className="flex gap-3 items-center flex-wrap">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input placeholder="Search wines…" value={search} onChange={(e) => setSearch(e.target.value)} className="pl-10 bg-background" />
            </div>
            <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer whitespace-nowrap">
              <Switch checked={filterActive} onCheckedChange={setFilterActive} /> Active only
            </label>
            <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer whitespace-nowrap">
              <Switch checked={filterGlass} onCheckedChange={setFilterGlass} /> Glass only
            </label>
            <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer whitespace-nowrap">
              <Switch checked={filterNonReadyOnly} onCheckedChange={setFilterNonReadyOnly} /> Non-ready only
            </label>
            <select
              value={filterMissingReason}
              onChange={(e) => setFilterMissingReason(e.target.value as "all" | PricingMissingReason)}
              className="h-9 rounded-md border border-input bg-background px-3 text-xs text-foreground"
            >
              <option value="all">All reasons</option>
              {PRICING_REASON_ORDER.map((reason) => (
                <option key={reason} value={reason}>{reason}</option>
              ))}
            </select>
          </div>

          {/* Selection actions */}
          <div className="flex gap-2 items-center flex-wrap">
            <Button variant="ghost" size="sm" onClick={selectAll} className="h-7 text-[11px]">Select All ({filteredWines.length})</Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSelectedIds(new Set(filteredWines.filter((w) => w.pricing_status === "READY").map((w) => w.winerim_id)))}
              className="h-7 text-[11px]"
            >
              Select READY ({filteredWines.filter((w) => w.pricing_status === "READY").length})
            </Button>
            {selectedIds.size > 0 && (() => {
              const pushableIds = Array.from(selectedIds).filter(id => {
                const w = wines.find(x => x.winerim_id === id);
                return w && w.pricing_status === "READY";
              });
              const blockedCount = selectedIds.size - pushableIds.length;
              return (
                <>
                  <Button variant="ghost" size="sm" onClick={clearSelection} className="h-7 text-[11px]">Clear ({selectedIds.size})</Button>
                  <Button variant="secondary" size="sm"
                    onClick={() => { onQueueProducts(pushableIds, ["BOTTLE", "GLASS"], familyOverrideId || undefined); clearSelection(); }}
                    disabled={queuingProducts || pushableIds.length === 0} className="h-7 text-[11px]">
                    {queuingProducts ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Send className="mr-1 h-3 w-3" />}
                    Push {pushableIds.length} to Agora
                    {blockedCount > 0 && <span className="text-destructive ml-1">({blockedCount} blocked)</span>}
                  </Button>
                  <Button variant="outline" size="sm" onClick={handlePreviewXml} disabled={generatingXml} className="h-7 text-[11px]">
                    {generatingXml ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Eye className="mr-1 h-3 w-3" />}
                    Preview XML
                  </Button>
                </>
              );
            })()}
            <span className="text-[11px] text-muted-foreground ml-auto">
              Only READY wines are pushable · Showing {filteredWines.length} of {wines.length}
            </span>
          </div>

          {/* Family override at push time */}
          {families.length > 0 && selectedIds.size > 0 && (
            <div className="flex items-center gap-3 rounded-lg border border-border bg-secondary/30 p-3">
              <span className="text-xs font-medium text-muted-foreground whitespace-nowrap">Family override:</span>
              <select
                value={familyOverrideId}
                onChange={(e) => setFamilyOverrideId(e.target.value)}
                className="flex-1 rounded-md border border-input bg-background px-2 py-1.5 text-xs"
              >
                <option value="">Use default mapping</option>
                {families.map(f => (
                  <option key={f.Id} value={f.Id}>{f.Id}: {f.Name}</option>
                ))}
              </select>
              {familyOverrideId && (
                <span className="text-[10px] text-primary font-medium">All selected wines will be sent to this family</span>
              )}
            </div>
          )}

          {/* Wine list */}
          <div className="divide-y divide-border rounded-lg border border-border overflow-hidden max-h-96 overflow-y-auto">
            {filteredWines.length === 0 ? (
              <div className="text-center py-8 text-sm text-muted-foreground">No wines match your filters.</div>
            ) : filteredWines.map((w) => (
              <label key={w.winerim_id} className="flex items-center gap-3 px-4 py-2.5 bg-card hover:bg-secondary/30 cursor-pointer transition-colors">
                <input type="checkbox" checked={selectedIds.has(w.winerim_id)} onChange={() => toggleWine(w.winerim_id)}
                  className="h-3.5 w-3.5 rounded border-border accent-primary shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-foreground truncate">{w.name}</p>
                    {!w.is_active && <Badge variant="secondary" className="text-[10px]">Inactive</Badge>}
                    {w.pricing_status === "READY" ? (
                      <Badge variant="default" className="text-[10px]">✓ READY</Badge>
                    ) : (
                      <>
                        <Badge variant="outline" className="text-[10px]">{w.pricing_status || "MISSING"}</Badge>
                        <Badge variant="outline" className="text-[10px]" title={`Reason: ${normalizePricingReason(w.pricing_missing_reason)}`}>
                          {normalizePricingReason(w.pricing_missing_reason)}
                        </Badge>
                        <Badge variant="secondary" className="text-[10px]">
                          {isRetryableReason(normalizePricingReason(w.pricing_missing_reason)) ? "Retryable" : "Non-retryable"}
                        </Badge>
                      </>
                    )}
                  </div>
                  <div className="flex items-center gap-3 text-[11px] text-muted-foreground mt-0.5 flex-wrap">
                    {w.wine_type && <span className="capitalize">{w.wine_type}</span>}
                    {w.winery && <span>{w.winery}</span>}
                    {w.vintage && <span>{w.vintage}</span>}
                    {w.region && <span>{w.region}</span>}
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0 text-[11px]">
                  {w.bottle_sale_price != null && (
                    <span className="font-mono text-foreground inline-flex items-center gap-1"><svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 2v4.5a2 2 0 0 1-.5 1.3L7 11a5 5 0 0 0-1 3v6a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-6a5 5 0 0 0-1-3l-2.5-3.2A2 2 0 0 1 14 6.5V2"/><path d="M10 2h4"/></svg> €{Number(w.bottle_sale_price).toFixed(2)}</span>
                  )}
                  {w.glass_sale_price != null && (
                    <span className="font-mono text-foreground inline-flex items-center gap-1"><Wine className="h-3.5 w-3.5" /> €{Number(w.glass_sale_price).toFixed(2)}</span>
                  )}
                  {w.magnum_sale_price != null && (
                    <span className="font-mono text-foreground inline-flex items-center gap-1"><svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 2v4.5a2 2 0 0 1-.5 1.3L7 11a5 5 0 0 0-1 3v6a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-6a5 5 0 0 0-1-3l-2.5-3.2A2 2 0 0 1 14 6.5V2"/><path d="M10 2h4"/></svg> €{Number(w.magnum_sale_price).toFixed(2)}<span className="text-muted-foreground ml-0.5">mag</span></span>
                  )}
                  {w.serve_by_glass && <Badge variant="outline" className="text-[10px]">Glass</Badge>}
                </div>
              </label>
            ))}
          </div>

          {/* XML Preview */}
          {previewXml && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium text-muted-foreground">XML Preview</p>
                <Button variant="ghost" size="sm" className="h-6 text-[10px]" onClick={() => setPreviewXml(null)}>Close</Button>
              </div>
              <pre className="rounded-lg border border-border bg-secondary/30 p-3 text-xs font-mono overflow-x-auto max-h-64 overflow-y-auto text-foreground whitespace-pre-wrap">
                {previewXml}
              </pre>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Step 3: Capabilities Detection ──
function StepCapabilities({
  connectionId, capabilities, detecting, detectionResults, onDetect, onLoadCapabilities,
  exporting, onExport, writeMode, xmlWriteCapability,
}: {
  connectionId: string | null;
  capabilities: import("@/hooks/useOutboundSync").ProviderCapability | null;
  detecting: boolean;
  detectionResults: unknown[];
  onDetect: () => void;
  onLoadCapabilities: () => void;
  exporting: boolean;
  onExport: (format: "json" | "csv") => void;
  writeMode: string;
  xmlWriteCapability: "UNKNOWN" | "YES" | "NO";
}) {
  useEffect(() => { onLoadCapabilities(); }, [connectionId]);

  // XML Import status: 3 states based on write_mode + successful import
  const xmlStatus: "NOT_SUPPORTED" | "SUPPORTED_NOT_VERIFIED" | "VALIDATED" =
    writeMode !== "XML_IMPORT"
      ? "NOT_SUPPORTED"
      : xmlWriteCapability === "YES"
        ? "VALIDATED"
        : "SUPPORTED_NOT_VERIFIED";

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Capabilities Detection</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Check if this Agora installation supports writing products (creating/updating wines).
        </p>
      </div>

      <div className="rounded-lg border border-border bg-secondary/30 p-4 space-y-3">
        <p className="text-xs font-medium text-muted-foreground flex items-center gap-1.5"><Shield className="h-3.5 w-3.5" /> Write Capabilities</p>
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-lg border border-border bg-background p-3 space-y-1">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wide">REST Write</p>
            <Badge variant="secondary" className="text-[10px]"><XCircle className="mr-1 h-3 w-3" /> Not Supported</Badge>
            <p className="text-[10px] text-muted-foreground mt-1">Standard REST endpoints not available on this installation.</p>
          </div>
          <div className="rounded-lg border border-border bg-background p-3 space-y-1">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wide">XML Import Write</p>
            {xmlStatus === "VALIDATED" ? (
              <Badge variant="default" className="text-[10px] bg-emerald-600"><CheckCircle2 className="mr-1 h-3 w-3" /> Validated</Badge>
            ) : xmlStatus === "SUPPORTED_NOT_VERIFIED" ? (
              <Badge variant="outline" className="text-[10px] border-amber-500/50 text-amber-600"><HelpCircle className="mr-1 h-3 w-3" /> Supported / Not Verified</Badge>
            ) : (
              <Badge variant="secondary" className="text-[10px]"><XCircle className="mr-1 h-3 w-3" /> Not Supported</Badge>
            )}
            <p className="text-[10px] text-muted-foreground mt-1">
              {xmlStatus === "VALIDATED"
                ? "XML import has been validated successfully for this connection."
                : xmlStatus === "SUPPORTED_NOT_VERIFIED"
                  ? "XML import is available. Run a manual XML import to validate before enabling auto-push."
                  : "Write mode is not set to XML Import. Configure in Write Settings (Step 9)."}
            </p>
          </div>
        </div>
        {capabilities?.last_checked_at && (
          <p className="text-[11px] text-muted-foreground">Last checked: {new Date(capabilities.last_checked_at).toLocaleString()}</p>
        )}
      </div>

      <Button variant="secondary" size="sm" onClick={onDetect} disabled={detecting}>
        {detecting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Search className="mr-2 h-4 w-4" />}
        Detect REST Write Support
      </Button>

      {(detectionResults as any[]).length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">Detection Results</p>
          <div className="divide-y divide-border rounded-lg border border-border overflow-hidden">
            {(detectionResults as any[]).map((r: any, i: number) => (
              <div key={i} className="px-4 py-2.5 bg-card">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-mono text-foreground">{r.label}</span>
                  <div className="flex items-center gap-2">
                    <Badge variant={r.supports ? "default" : "secondary"} className="text-[10px]">
                      {r.status} {r.supports ? "✓ Supported" : "✗ Not found"}
                    </Badge>
                  </div>
                </div>
                {r.body && <pre className="mt-1 text-[10px] font-mono text-muted-foreground truncate max-w-full">{r.body.substring(0, 200)}</pre>}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="rounded-lg border border-border bg-secondary/30 p-4 space-y-3">
        <div className="flex items-start gap-2">
          <HelpCircle className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-medium text-foreground">REST write not available</p>
            <p className="text-xs text-muted-foreground mt-1">
              This Agora installation does not expose REST write endpoints. Use <strong>XML Import</strong> (Steps 5 & 9) to push products, or export as JSON/CSV for manual import.
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => onExport("json")} disabled={exporting}>
            <FileJson className="mr-2 h-4 w-4" /> Export JSON
          </Button>
          <Button variant="outline" size="sm" onClick={() => onExport("csv")} disabled={exporting}>
            <FileText className="mr-2 h-4 w-4" /> Export CSV
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Step 8: Outbound Sync Panel ──
function StepOutboundSync({
  connectionId, capabilities, outboundTasks, loadingTasks,
  processingQueue, queuingProducts, exporting,
  onLoadTasks, onProcessQueue, onRetry, onExport,
  winerimWines, onQueueProducts,
}: {
  connectionId: string | null;
  capabilities: import("@/hooks/useOutboundSync").ProviderCapability | null;
  outboundTasks: OutboundTask[];
  loadingTasks: boolean;
  processingQueue: boolean;
  queuingProducts: boolean;
  exporting: boolean;
  onLoadTasks: () => void;
  onProcessQueue: () => void;
  onRetry: (taskId: string) => void;
  onExport: (format: "json" | "csv") => void;
  winerimWines: { winerim_id: string; name: string }[];
  onQueueProducts: (ids: string[], formatTypes?: string[]) => void;
}) {
  const [selectedWineIds, setSelectedWineIds] = useState<Set<string>>(new Set());
  const [searchOutbound, setSearchOutbound] = useState("");
  const wineNameMap = useMemo(() => {
    const m: Record<string, string> = {};
    for (const w of winerimWines) m[w.winerim_id] = w.name;
    return m;
  }, [winerimWines]);

  useEffect(() => { onLoadTasks(); }, [connectionId]);

  const canWrite = capabilities?.can_write_products === "YES" || capabilities?.can_write_products === "UNKNOWN";

  const getTaskName = (t: OutboundTask) => {
    const wid = (t.payload_json as any)?._winerim_wine_id;
    return wineNameMap[wid] || (t.payload_json as any)?.Name || (wid ? `Wine ${wid}` : t.task_type);
  };

  const filteredTasks = useMemo(() => {
    if (!searchOutbound.trim()) return outboundTasks;
    const q = searchOutbound.toLowerCase();
    return outboundTasks.filter(t => getTaskName(t).toLowerCase().includes(q) || t.status.toLowerCase().includes(q));
  }, [outboundTasks, searchOutbound, wineNameMap]);

  const filteredWinerimWines = useMemo(() => {
    if (!searchOutbound.trim()) return winerimWines;
    const q = searchOutbound.toLowerCase();
    return winerimWines.filter(w => w.name.toLowerCase().includes(q));
  }, [winerimWines, searchOutbound]);

  const queuedTasks = filteredTasks.filter(t => t.status === "QUEUED");
  const runningTasks = filteredTasks.filter(t => t.status === "RUNNING");
  const successTasks = filteredTasks.filter(t => t.status === "SUCCESS");
  const failedTasks = filteredTasks.filter(t => t.status === "FAILED");
  const blockedTasks = filteredTasks.filter(t => t.status === "BLOCKED");
  const canProcessQueue = canWrite || outboundTasks.some(t => t.status === "QUEUED");

  const toggleWine = (id: string) => {
    setSelectedWineIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Outbound Sync (Winerim → Agora)</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {canWrite
            ? "Push matched wines from Winerim to your Agora product catalog."
            : canProcessQueue
              ? "Write not validated yet, but you can process queued tasks to validate XML import."
              : "Write not supported. Use export to create products in Agora manually."}
        </p>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input placeholder="Search wines or tasks…" value={searchOutbound} onChange={(e) => setSearchOutbound(e.target.value)} className="pl-10 bg-background" />
      </div>

      {/* Stats */}
      <div className="grid grid-cols-5 gap-2">
        {[
          { label: "Queued", count: queuedTasks.length, color: "text-primary" },
          { label: "Running", count: runningTasks.length, color: "text-primary" },
          { label: "Success", count: successTasks.length, color: "text-success" },
          { label: "Failed", count: failedTasks.length, color: "text-destructive" },
          { label: "Blocked", count: blockedTasks.length, color: "text-amber-500" },
        ].map(s => (
          <div key={s.label} className="rounded-lg border border-border bg-card p-3 text-center">
            <p className={`text-lg font-bold ${s.color}`}>{s.count}</p>
            <p className="text-[10px] text-muted-foreground uppercase">{s.label}</p>
          </div>
        ))}
      </div>

      {/* Actions */}
      <div className="flex gap-2 flex-wrap">
        {canProcessQueue && (
          <>
            <Button variant="secondary" size="sm" onClick={onProcessQueue}
              disabled={processingQueue || queuedTasks.length === 0}>
              {processingQueue ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
              Process Queue ({queuedTasks.length})
            </Button>
          </>
        )}
        <Button variant="outline" size="sm" onClick={() => onExport("json")} disabled={exporting}>
          <FileJson className="mr-2 h-4 w-4" /> Export JSON
        </Button>
        <Button variant="outline" size="sm" onClick={() => onExport("csv")} disabled={exporting}>
          <FileText className="mr-2 h-4 w-4" /> Export CSV
        </Button>
        <Button variant="ghost" size="sm" onClick={onLoadTasks} disabled={loadingTasks}>
          <RefreshCw className={`mr-2 h-4 w-4 ${loadingTasks ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>

      {/* Queue wines */}
      {canWrite && winerimWines.length > 0 && (
        <div className="rounded-lg border border-border p-4 space-y-3">
          <p className="text-xs font-medium text-muted-foreground">Push Wines to Agora</p>
          <div className="max-h-48 overflow-y-auto divide-y divide-border rounded-lg border border-border">
            {filteredWinerimWines.map(w => (
              <label key={w.winerim_id} className="flex items-center gap-3 px-3 py-2 hover:bg-secondary/30 cursor-pointer text-sm">
                <input type="checkbox" checked={selectedWineIds.has(w.winerim_id)}
                  onChange={() => toggleWine(w.winerim_id)}
                  className="h-3.5 w-3.5 rounded border-border accent-primary" />
                <span className="text-foreground">{w.name}</span>
              </label>
            ))}
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" disabled={selectedWineIds.size === 0 || queuingProducts}
              onClick={() => { onQueueProducts(Array.from(selectedWineIds), ["BOTTLE", "GLASS"]); setSelectedWineIds(new Set()); }}>
              {queuingProducts ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
              Push {selectedWineIds.size} to Agora
            </Button>
            <Button variant="ghost" size="sm" onClick={() => {
              setSelectedWineIds(new Set(winerimWines.map(w => w.winerim_id)));
            }}>Select All</Button>
          </div>
        </div>
      )}

      {/* Task list */}
      <Tabs defaultValue="all" className="space-y-3">
        <TabsList className="w-full">
          <TabsTrigger value="all" className="flex-1">All ({filteredTasks.length})</TabsTrigger>
          <TabsTrigger value="failed" className="flex-1">
            Failed ({failedTasks.length})
            {failedTasks.length > 0 && <Badge variant="destructive" className="ml-1 text-[10px]">{failedTasks.length}</Badge>}
          </TabsTrigger>
          <TabsTrigger value="blocked" className="flex-1">
            Blocked ({blockedTasks.length})
          </TabsTrigger>
        </TabsList>

        {[
          { key: "all", items: filteredTasks },
          { key: "failed", items: failedTasks },
          { key: "blocked", items: blockedTasks },
        ].map(({ key, items }) => (
          <TabsContent key={key} value={key}>
            <div className="divide-y divide-border rounded-lg border border-border overflow-hidden max-h-72 overflow-y-auto">
              {items.length === 0 ? (
                <div className="text-center py-8 text-sm text-muted-foreground">No tasks.</div>
              ) : items.map(t => (
                <div key={t.id} className="px-4 py-3 bg-card hover:bg-secondary/30 transition-colors">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-foreground truncate">
                        {getTaskName(t)}
                      </p>
                      <div className="flex items-center gap-2 mt-1 text-[11px] text-muted-foreground flex-wrap">
                        <Badge variant={
                          t.status === "SUCCESS" ? "default" :
                          t.status === "FAILED" ? "destructive" :
                          t.status === "BLOCKED" ? "outline" :
                          "secondary"
                        } className="text-[10px]">{t.status}</Badge>
                        {(t.payload_json as any)?._trigger_source && (
                          <Badge variant="outline" className="text-[10px]">
                            {(t.payload_json as any)._trigger_source === "AUTO_CREATE" ? "⚡ Auto Create" :
                             (t.payload_json as any)._trigger_source === "AUTO_UPDATE" ? "⚡ Auto Update" : 
                             (t.payload_json as any)._trigger_source}
                          </Badge>
                        )}
                        {(t.payload_json as any)?._winerim_wine_id && (
                          <span className="font-mono">Winerim: {(t.payload_json as any)._winerim_wine_id}</span>
                        )}
                        {t.external_id && <span className="font-mono">Agora: {t.external_id}</span>}
                        <span>Attempts: {t.attempts}/{t.max_attempts}</span>
                      </div>
                      {t.last_error && (
                        <p className="mt-1 text-[11px] text-destructive truncate">{t.last_error}</p>
                      )}
                      {t.blocked_reason && (
                        <p className="mt-1 text-[11px] text-amber-600">{t.blocked_reason}</p>
                      )}
                    </div>
                    {(t.status === "FAILED" || t.status === "BLOCKED") && (
                      <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => onRetry(t.id)}>
                        <RotateCcw className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}

// ── Agora Products Panel (browsable) ──
function AgoraProductsPanel({ products, families }: {
  products: { Id: string; Name: string; FamilyId?: string; VatId?: string }[];
  families: { Id: string; Name: string }[];
}) {
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [selectedFamily, setSelectedFamily] = useState<string>("ALL");
  const [viewMode, setViewMode] = useState<"list" | "families">("list");

  const familyMap = useMemo(() => {
    const map: Record<string, string> = {};
    families.forEach(f => { map[f.Id] = f.Name; });
    return map;
  }, [families]);

  const familyGroups = useMemo(() => {
    const groups: Record<string, typeof products> = {};
    // Seed all master-data families so they always appear
    families.forEach(f => { groups[f.Id] = []; });
    products.forEach(p => {
      const fid = p.FamilyId || "none";
      if (!groups[fid]) groups[fid] = [];
      groups[fid].push(p);
    });
    return Object.entries(groups)
      .map(([id, items]) => ({ id, name: familyMap[id] || (id === "none" ? "Sin familia" : `Family ${id}`), items }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [products, families, familyMap]);

  const filtered = useMemo(() => {
    let list = products;
    if (selectedFamily !== "ALL") {
      list = list.filter(p => (p.FamilyId || "none") === selectedFamily);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(p => p.Name.toLowerCase().includes(q) || p.Id.includes(q));
    }
    return list;
  }, [products, selectedFamily, search]);

  const shown = expanded ? filtered : filtered.slice(0, 50);

  return (
    <div className="rounded-lg border border-border bg-secondary/30 p-3 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <p className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
          <Package className="h-3.5 w-3.5" /> Agora Products ({products.length})
        </p>
        <div className="flex gap-2 items-center">
          <div className="flex rounded-md border border-border overflow-hidden">
            <button onClick={() => setViewMode("list")}
              className={`px-2.5 py-1 text-[10px] font-medium transition-colors ${viewMode === "list" ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:bg-muted"}`}>
              List
            </button>
            <button onClick={() => setViewMode("families")}
              className={`px-2.5 py-1 text-[10px] font-medium transition-colors ${viewMode === "families" ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:bg-muted"}`}>
              By Family
            </button>
          </div>
          <Input
            placeholder="Search by name or ID..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-7 w-48 text-xs"
          />
        </div>
      </div>

      {viewMode === "families" ? (
        <div className="space-y-1">
          {familyGroups.map(g => {
            const isOpen = selectedFamily === g.id;
            const groupFiltered = search.trim()
              ? g.items.filter(p => p.Name.toLowerCase().includes(search.toLowerCase()) || p.Id.includes(search))
              : g.items;
            if (search.trim() && groupFiltered.length === 0) return null;
            return (
              <div key={g.id} className="rounded-md border border-border overflow-hidden">
                <button
                  onClick={() => setSelectedFamily(isOpen ? "ALL" : g.id)}
                  className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium hover:bg-muted/50 transition-colors"
                >
                  <span className="flex items-center gap-2 text-foreground">
                    <ChevronDown className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${isOpen ? "rotate-0" : "-rotate-90"}`} />
                    {g.name}
                  </span>
                  <span className="text-[10px] text-muted-foreground">{groupFiltered.length} products</span>
                </button>
                {isOpen && (
                  <div className="max-h-60 overflow-y-auto border-t border-border divide-y divide-border">
                    {groupFiltered.length === 0 ? (
                      <p className="text-[11px] text-muted-foreground italic py-3 text-center">No products match.</p>
                    ) : groupFiltered.map((p) => (
                      <div key={p.Id} className="grid grid-cols-[80px_1fr] gap-2 px-3 py-1.5 text-xs hover:bg-muted/30">
                        <span className="font-mono text-muted-foreground">{p.Id}</span>
                        <span className="text-foreground truncate">{p.Name}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <>
          {filtered.length === 0 ? (
            <p className="text-[11px] text-muted-foreground italic py-2 text-center">No products match your search.</p>
          ) : (
            <>
              <div className="max-h-72 overflow-y-auto rounded-md border border-border divide-y divide-border">
                <div className="grid grid-cols-[80px_1fr_100px_60px] gap-2 px-3 py-1.5 bg-muted/50 text-[10px] font-medium text-muted-foreground sticky top-0">
                  <span>ID</span><span>Name</span><span>Family</span><span>VAT</span>
                </div>
                {shown.map((p) => (
                  <div key={p.Id} className="grid grid-cols-[80px_1fr_100px_60px] gap-2 px-3 py-1.5 text-xs hover:bg-muted/30">
                    <span className="font-mono text-muted-foreground">{p.Id}</span>
                    <span className="text-foreground truncate">{p.Name}</span>
                    <span className="text-muted-foreground truncate">{familyMap[p.FamilyId || ""] || "—"}</span>
                    <span className="text-muted-foreground">{p.VatId || "—"}</span>
                  </div>
                ))}
              </div>
              {!expanded && filtered.length > 50 && (
                <Button variant="ghost" size="sm" className="h-7 text-[11px] w-full" onClick={() => setExpanded(true)}>
                  Show all {filtered.length} products
                </Button>
              )}
              {expanded && filtered.length > 50 && (
                <Button variant="ghost" size="sm" className="h-7 text-[11px] w-full" onClick={() => setExpanded(false)}>
                  Collapse
                </Button>
              )}
            </>
          )}
        </>
      )}

      <p className="text-[10px] text-muted-foreground">
        Products loaded from last Master Data sync. New wines created via XML import will appear here after re-syncing.
      </p>
    </div>
  );
}

// ── Step 5: Master Data ──
function StepMasterData({
  masterData, syncing, syncError, syncTruncationWarnings, onSync, onLoad, writeCapability, writeSettings, connectionId, saveWriteSettings,
}: {
  masterData: import("@/hooks/useAgoraMasterData").AgoraMasterData;
  syncing: boolean; syncError: string | null;
  syncTruncationWarnings: string[];
  onSync: () => void; onLoad: () => void;
  writeCapability: "UNKNOWN" | "YES" | "NO";
  writeSettings: import("@/hooks/useAgoraMasterData").WriteSettings;
  connectionId: string | null;
  saveWriteSettings: (settings: Partial<import("@/hooks/useAgoraMasterData").WriteSettings>) => Promise<void>;
}) {
  useEffect(() => { onLoad(); }, []);

  // ── Wine data diagnostics ──
  const [wineStats, setWineStats] = useState<{
    total: number; hasBottlePrice: number; hasGlassPrice: number;
    serveByGlass: number; hasWineType: number; missingPricing: number; missingWineType: number; inactive: number;
  } | null>(null);
  const [loadingStats, setLoadingStats] = useState(false);
  const [enriching, setEnriching] = useState(false);
  const [enrichResult, setEnrichResult] = useState<{ enriched: number; detailsMissing: number } | null>(null);

  const loadWineStats = useCallback(async () => {
    if (!connectionId) return;
    setLoadingStats(true);
    const data = await fetchAllWinerimWines(connectionId,
      "bottle_sale_price, glass_sale_price, magnum_sale_price, serve_by_glass, wine_type, is_active"
    );
    if (data.length > 0) {
      setWineStats({
        total: data.length,
        hasBottlePrice: data.filter((w: any) => w.bottle_sale_price != null).length,
        hasGlassPrice: data.filter((w: any) => w.glass_sale_price != null).length,
        serveByGlass: data.filter((w: any) => w.serve_by_glass).length,
        hasWineType: data.filter((w: any) => w.wine_type != null).length,
        missingPricing: data.filter((w: any) => w.bottle_sale_price == null && w.glass_sale_price == null && w.magnum_sale_price == null).length,
        missingWineType: data.filter((w: any) => w.wine_type == null).length,
        inactive: data.filter((w: any) => w.is_active === false).length,
      });
    } else {
      setWineStats({ total: 0, hasBottlePrice: 0, hasGlassPrice: 0, serveByGlass: 0, hasWineType: 0, missingPricing: 0, missingWineType: 0, inactive: 0 });
    }
    setLoadingStats(false);
  }, [connectionId]);

  useEffect(() => { loadWineStats(); }, [loadWineStats]);

  const enrichWines = useCallback(async () => {
    if (!connectionId) return;
    setEnriching(true);
    setEnrichResult(null);
    try {
      const { data, error } = await supabase.functions.invoke("winerim-proxy", {
        body: { action: "fetch-wine-details", connectionId },
      });
      if (error) throw error;
      setEnrichResult({ enriched: data?.enriched || 0, detailsMissing: data?.detailsMissing || 0 });
      await loadWineStats();
    } catch (e: any) {
      console.error("Enrich failed:", e);
    } finally {
      setEnriching(false);
    }
  }, [connectionId, loadWineStats]);

  const [searchMaster, setSearchMaster] = useState("");

  // ── Sale Center / PriceList diagnostic ──
  // Find all candidate central sale centers
  const centralCandidates = masterData.saleCenters.filter(
    (sc: any) => (sc.Name || "").toLowerCase().includes("central") || sc.IsDefault === "true"
  );
  const [selectedSaleCenterId, setSelectedSaleCenterId] = useState<string | null>(null);

  // Determine active central: user selection > single candidate > first sale center
  const activeCentralCenter = (() => {
    if (selectedSaleCenterId) {
      return masterData.saleCenters.find((sc: any) => sc.Id === selectedSaleCenterId) || null;
    }
    if (centralCandidates.length === 1) return centralCandidates[0];
    if (centralCandidates.length > 1) return null; // force selection
    return null;
  })();

  const centralPriceListId = activeCentralCenter?.CurrentPriceListId || null;
  const centralPriceList = centralPriceListId
    ? masterData.priceLists.find((pl: any) => pl.Id === centralPriceListId)
    : null;

  // ── Verify & Backfill ──
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<any>(null);
  const [backfilling, setBackfilling] = useState(false);

  const verifyProducts = useCallback(async () => {
    if (!connectionId) return;
    setVerifying(true);
    setVerifyResult(null);
    try {
      const { data, error } = await supabase.functions.invoke("agora-proxy", {
        body: { 
          action: "verify-products", 
          connectionId,
          ...(selectedSaleCenterId ? { saleCenterId: selectedSaleCenterId } : {}),
        },
      });
      if (error) throw error;
      setVerifyResult(data);
    } catch (e: any) {
      console.error("Verify failed:", e);
    } finally {
      setVerifying(false);
    }
  }, [connectionId, selectedSaleCenterId]);

  const backfillPrices = useCallback(async () => {
    if (!connectionId) return;
    setBackfilling(true);
    try {
      const { data, error } = await supabase.functions.invoke("agora-proxy", {
        body: { action: "backfill-prices", connectionId, formatTypes: ["BOTTLE", "GLASS"] },
      });
      if (error) throw error;
      toast({ title: "Backfill queued", description: `${data?.queued || 0} products queued for re-push` });
    } catch (e: any) {
      console.error("Backfill failed:", e);
    } finally {
      setBackfilling(false);
    }
  }, [connectionId]);

  const sections = [
    { label: "Families", data: masterData.families, icon: Grape },
    { label: "VATs", data: masterData.vats, icon: Tag },
    { label: "Price Lists", data: masterData.priceLists, icon: FileText },
    { label: "Preparation Types", data: masterData.preparationTypes, icon: Settings2 },
    { label: "Preparation Orders", data: masterData.preparationOrders, icon: Settings2 },
    { label: "Warehouses", data: masterData.warehouses, icon: Database },
    { label: "Sale Points", data: masterData.salePoints, icon: Server },
    { label: "Sale Centers", data: masterData.saleCenters, icon: Server },
  ];

  const filterItems = (data: any[]) => {
    if (!searchMaster.trim()) return data;
    const q = searchMaster.toLowerCase();
    return data.filter((item: any) => (item.Name || "").toLowerCase().includes(q) || (item.Id || "").toLowerCase().includes(q));
  };

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Agora Master Data</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Fetch master data (families, VATs, price lists, etc.) from Agora via <code className="text-xs font-mono bg-secondary px-1 rounded">/api/export-master/</code>
        </p>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input placeholder="Search master data…" value={searchMaster} onChange={(e) => setSearchMaster(e.target.value)} className="pl-10 bg-background" />
      </div>

      {/* Status badges */}
      <div className="flex gap-2 flex-wrap">
        {masterData.fetchedAt ? (
          <Badge variant="default" className="text-[10px]"><CheckCircle2 className="mr-1 h-3 w-3" /> Master data synced</Badge>
        ) : (
          <Badge variant="outline" className="text-[10px]"><AlertTriangle className="mr-1 h-3 w-3" /> Not synced</Badge>
        )}
        {writeCapability === "YES" ? (
          <Badge variant="default" className="text-[10px] bg-emerald-600"><CheckCircle2 className="mr-1 h-3 w-3" /> XML import validated</Badge>
        ) : writeCapability === "UNKNOWN" ? (
          <Badge variant="outline" className="text-[10px]"><HelpCircle className="mr-1 h-3 w-3" /> XML import not verified</Badge>
        ) : (
          <Badge variant="secondary" className="text-[10px]"><XCircle className="mr-1 h-3 w-3" /> XML import not supported</Badge>
        )}
        {writeSettings.auto_push_verified_ready ? (
          <Badge variant="default" className="text-[10px]"><Zap className="mr-1 h-3 w-3" /> Auto-push ready</Badge>
        ) : (
          <Badge variant="outline" className="text-[10px]">Auto-push not verified</Badge>
        )}
      </div>

      {/* ── Auto-push verification gate ── */}
      <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 space-y-2">
        <p className="text-xs font-medium text-foreground flex items-center gap-1.5">
          <Shield className="h-3.5 w-3.5 text-primary" /> Auto-push Verification Gate
        </p>
        {writeSettings.auto_push_verified_ready ? (
          <div className="space-y-2">
            <p className="text-[11px] text-muted-foreground">
              ✅ This connection is verified for auto-push. Products can be automatically pushed to Agora when created or updated.
            </p>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" size="sm" className="h-7 text-[11px] text-destructive border-destructive/30 hover:bg-destructive/5">
                  <ShieldX className="mr-1 h-3 w-3" /> Revoke auto-push verification
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Revoke auto-push verification?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will disable automatic product push to Agora. You will need to manually import products and re-verify before auto-push can be used again.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    onClick={() => saveWriteSettings({ auto_push_verified_ready: false })}
                  >
                    Revoke verification
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-[11px] text-muted-foreground">
              ⚠️ Auto-push is disabled. Run a manual XML import, verify products were created correctly in Agora, then mark as verified below.
            </p>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="default"
                  size="sm"
                  className="h-7 text-[11px]"
                  disabled={writeCapability !== "YES"}
                >
                  <ShieldCheck className="mr-1 h-3 w-3" /> Mark connection as verified for auto-push
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Enable auto-push verification?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Use this only after verifying that products were created correctly in Agora (correct names, prices, families, VAT rates, and that they are sellable).
                    <br /><br />
                    Once verified, the system will be allowed to automatically push new products to Agora based on your auto-push settings.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={() => saveWriteSettings({ auto_push_verified_ready: true })}>
                    Confirm — I verified in Agora
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
            {writeCapability !== "YES" && (
              <p className="text-[10px] text-muted-foreground italic">Run a successful manual XML import first to unlock this option.</p>
            )}
          </div>
        )}
      </div>

      <Button variant="secondary" size="sm" onClick={onSync} disabled={syncing}>
        {syncing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
        Sync Agora Master Data
      </Button>
      {syncError && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
          <p className="font-medium flex items-center gap-1.5"><XCircle className="h-3.5 w-3.5" /> {syncError}</p>
        </div>
      )}
      {masterData.fetchedAt && (
        <p className="text-[11px] text-muted-foreground">Last synced: {new Date(masterData.fetchedAt).toLocaleString()}</p>
      )}
      {writeCapability === "UNKNOWN" && masterData.fetchedAt && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-600">
          <p className="flex items-center gap-1.5"><AlertTriangle className="h-3 w-3" /> Master data synced but write not yet verified. Go to Write Settings and run a manual XML import to confirm write capability.</p>
        </div>
      )}

      {/* ── Truncation Warning ── */}
      {syncTruncationWarnings.length > 0 && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs space-y-1">
          <p className="font-medium text-foreground flex items-center gap-1.5"><AlertTriangle className="h-3.5 w-3.5 text-amber-500" /> Possible data truncation</p>
          {syncTruncationWarnings.map((w, i) => (
            <p key={i} className="text-muted-foreground">{w}</p>
          ))}
        </div>
      )}

      {/* ── Sale Center / PriceList Diagnostic ── */}
      {masterData.fetchedAt && (
        <div className="rounded-lg border border-primary/20 bg-primary/5 p-4 space-y-3">
          <div className="flex items-center gap-2">
            <Server className="h-4 w-4 text-primary" />
            <p className="text-xs font-medium text-foreground">Sale Center Diagnostic</p>
          </div>

          {/* Multiple candidates warning */}
          {centralCandidates.length > 1 && !selectedSaleCenterId && (
            <div className="rounded-md bg-amber-500/10 border border-amber-500/20 p-3 space-y-2">
              <p className="text-[11px] text-amber-600 font-medium flex items-center gap-1.5">
                <AlertTriangle className="h-3 w-3 shrink-0" /> Multiple central sale centers detected ({centralCandidates.length}). Select which one to use for diagnostics:
              </p>
              <div className="flex gap-2 flex-wrap">
                {centralCandidates.map((sc: any) => (
                  <Button key={sc.Id} variant="outline" size="sm" className="h-7 text-[11px]" onClick={() => setSelectedSaleCenterId(sc.Id)}>
                    {sc.Name} (PL: {sc.CurrentPriceListId || "none"})
                  </Button>
                ))}
              </div>
            </div>
          )}

          {/* No candidates — manual selection */}
          {centralCandidates.length === 0 && masterData.saleCenters.length > 0 && !selectedSaleCenterId && (
            <div className="rounded-md bg-amber-500/10 border border-amber-500/20 p-3 space-y-2">
              <p className="text-[11px] text-amber-600 font-medium flex items-center gap-1.5">
                <AlertTriangle className="h-3 w-3 shrink-0" /> No "Central" or default sale center detected. Select one manually:
              </p>
              <div className="flex gap-2 flex-wrap">
                {masterData.saleCenters.map((sc: any) => (
                  <Button key={sc.Id} variant="outline" size="sm" className="h-7 text-[11px]" onClick={() => setSelectedSaleCenterId(sc.Id)}>
                    {sc.Name} (PL: {sc.CurrentPriceListId || "none"})
                  </Button>
                ))}
              </div>
            </div>
          )}

          {/* Fetched counts summary */}
          <div className="grid grid-cols-3 gap-2 text-[10px]">
            <div className="rounded border border-border bg-background p-2 text-center">
              <p className="text-muted-foreground">SaleCenters</p>
              <p className={`text-sm font-bold ${masterData.saleCenters.length > 0 ? "text-foreground" : "text-destructive"}`}>{masterData.saleCenters.length}</p>
            </div>
            <div className="rounded border border-border bg-background p-2 text-center">
              <p className="text-muted-foreground">SalePoints</p>
              <p className="text-sm font-bold text-foreground">{masterData.salePoints.length}</p>
            </div>
            <div className="rounded border border-border bg-background p-2 text-center">
              <p className="text-muted-foreground">PriceLists</p>
              <p className="text-sm font-bold text-foreground">{masterData.priceLists.length}</p>
            </div>
          </div>

          {activeCentralCenter ? (
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-lg border border-border bg-background p-3">
                  <p className="text-[10px] text-muted-foreground">Active Sale Center</p>
                  <p className="text-sm font-bold text-foreground">{activeCentralCenter.Name}</p>
                  <p className="text-[10px] text-muted-foreground font-mono">ID: {activeCentralCenter.Id}</p>
                  {selectedSaleCenterId && (
                    <Button variant="link" size="sm" className="h-5 px-0 text-[10px]" onClick={() => setSelectedSaleCenterId(null)}>Reset selection</Button>
                  )}
                </div>
                <div className={`rounded-lg border p-3 ${centralPriceListId ? "border-emerald-500/30 bg-emerald-500/5" : "border-destructive/30 bg-destructive/5"}`}>
                  <p className="text-[10px] text-muted-foreground">Current PriceList</p>
                  <p className={`text-sm font-bold ${centralPriceListId ? "text-emerald-600" : "text-destructive"}`}>
                    {centralPriceList ? `${centralPriceList.Name}` : centralPriceListId || "Not found"}
                  </p>
                  {centralPriceListId && <p className="text-[10px] text-muted-foreground font-mono">ID: {centralPriceListId}</p>}
                </div>
              </div>
              {!centralPriceListId && (
                <div className="rounded-md bg-destructive/10 border border-destructive/20 p-2 text-[11px] text-destructive flex items-center gap-1.5">
                  <AlertTriangle className="h-3 w-3 shrink-0" />
                  Selected sale center has no CurrentPriceListId. Products without prices for this list will fail at sale.
                </div>
              )}
              <div className="flex gap-2">
                <Button variant="outline" size="sm" className="h-7 text-[11px]" onClick={verifyProducts} disabled={verifying}>
                  {verifying ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Eye className="mr-1 h-3 w-3" />}
                  Verify Product Prices
                </Button>
                <Button variant="outline" size="sm" className="h-7 text-[11px]" onClick={backfillPrices} disabled={backfilling}>
                  {backfilling ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <RefreshCw className="mr-1 h-3 w-3" />}
                  Backfill Missing Prices
                </Button>
              </div>
              {verifyResult && (
                <div className="rounded-lg border border-border bg-background p-3 space-y-2">
                  <div className="flex items-center gap-2">
                    {verifyResult.missingCentralPrice === 0 ? (
                      <Badge variant="default" className="text-[10px] bg-emerald-600"><CheckCircle2 className="mr-1 h-3 w-3" /> All products have correct prices</Badge>
                    ) : (
                      <Badge variant="destructive" className="text-[10px]"><XCircle className="mr-1 h-3 w-3" /> {verifyResult.missingCentralPrice} price issues</Badge>
                    )}
                    {verifyResult.summary && (
                      <span className="text-[10px] text-muted-foreground">
                        {verifyResult.summary.checked} checked · {verifyResult.summary.ok} ok · {verifyResult.summary.failed} failed
                      </span>
                    )}
                  </div>
                  {verifyResult.missing_prices && verifyResult.missing_prices.length > 0 && (
                    <div className="max-h-40 overflow-auto space-y-1">
                      {verifyResult.missing_prices.map((mp: any, i: number) => (
                        <div key={i} className="text-[10px] text-destructive font-mono flex items-center gap-2">
                          <Badge variant="destructive" className="text-[8px] px-1 py-0">{mp.issue}</Badge>
                          {mp.format} {mp.name} (Agora ID: {mp.agora_product_id})
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : masterData.saleCenters.length === 0 ? (
            <div className="space-y-2">
              <div className="rounded-md bg-amber-500/10 border border-amber-500/20 p-3">
                <p className="text-[11px] text-amber-600 font-medium flex items-center gap-1.5">
                  <AlertTriangle className="h-3 w-3 shrink-0" /> SaleCenters: 0 fetched. Click "Sync Agora Master Data" above to fetch. If this persists, the Agora installation may not expose SaleCenters via export-master.
                </p>
              </div>
              <div className="grid grid-cols-3 gap-2 text-[10px]">
                <div className="rounded border border-border bg-background p-2 text-center">
                  <p className="text-muted-foreground">SaleCenters</p>
                  <p className="text-sm font-bold text-destructive">0</p>
                </div>
                <div className="rounded border border-border bg-background p-2 text-center">
                  <p className="text-muted-foreground">SalePoints</p>
                  <p className="text-sm font-bold text-foreground">{masterData.salePoints.length}</p>
                </div>
                <div className="rounded border border-border bg-background p-2 text-center">
                  <p className="text-muted-foreground">PriceLists</p>
                  <p className="text-sm font-bold text-foreground">{masterData.priceLists.length}</p>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      )}

      {/* ── Wine Data Diagnostics ── */}
      <div className="rounded-lg border border-primary/20 bg-primary/5 p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Wine className="h-4 w-4 text-primary" />
            <p className="text-xs font-medium text-foreground">Winerim Data Diagnostics</p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" className="h-7 text-[11px]" onClick={loadWineStats} disabled={loadingStats}>
              {loadingStats ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <RefreshCw className="mr-1 h-3 w-3" />}
              Refresh
            </Button>
            <Button variant="secondary" size="sm" className="h-7 text-[11px]" onClick={enrichWines} disabled={enriching}>
              {enriching ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Download className="mr-1 h-3 w-3" />}
              Enrich Missing Pricing
            </Button>
          </div>
        </div>
        {enrichResult && (
          <div className="rounded-md bg-muted/50 p-2 text-[11px] text-muted-foreground">
            Enriched {enrichResult.enriched} wines · {enrichResult.detailsMissing} details not found
          </div>
        )}
        {wineStats && wineStats.total === 0 ? (
          <div className="rounded-lg border border-border bg-secondary/20 p-4 text-center space-y-1">
            <Wine className="mx-auto h-6 w-6 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">No Winerim wine data synced yet</p>
            <p className="text-[11px] text-muted-foreground">Go to "Wine Matching" step and fetch your Winerim catalog first.</p>
          </div>
        ) : wineStats ? (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="rounded-lg border border-border bg-background p-3 text-center">
              <p className="text-lg font-bold text-foreground">{wineStats.total}</p>
              <p className="text-[10px] text-muted-foreground">Total wines</p>
            </div>
            <div className="rounded-lg border border-border bg-background p-3 text-center">
              <p className="text-lg font-bold text-emerald-600">{wineStats.hasBottlePrice}</p>
              <p className="text-[10px] text-muted-foreground">With bottle price</p>
            </div>
            <div className="rounded-lg border border-border bg-background p-3 text-center">
              <p className="text-lg font-bold text-blue-600">{wineStats.hasGlassPrice}</p>
              <p className="text-[10px] text-muted-foreground">With glass price</p>
            </div>
            <div className="rounded-lg border border-border bg-background p-3 text-center">
              <p className="text-lg font-bold text-violet-600">{wineStats.serveByGlass}</p>
              <p className="text-[10px] text-muted-foreground">Serve by glass</p>
            </div>
            <div className="rounded-lg border border-border bg-background p-3 text-center">
              <p className="text-lg font-bold text-foreground">{wineStats.hasWineType}</p>
              <p className="text-[10px] text-muted-foreground">With wine type</p>
            </div>
            <div className={`rounded-lg border p-3 text-center ${wineStats.missingPricing > 0 ? "border-amber-500/30 bg-amber-500/5" : "border-border bg-background"}`}>
              <p className={`text-lg font-bold ${wineStats.missingPricing > 0 ? "text-amber-600" : "text-emerald-600"}`}>{wineStats.missingPricing}</p>
              <p className="text-[10px] text-muted-foreground">Missing all pricing</p>
            </div>
            <div className={`rounded-lg border p-3 text-center ${wineStats.missingWineType > 0 ? "border-amber-500/30 bg-amber-500/5" : "border-border bg-background"}`}>
              <p className={`text-lg font-bold ${wineStats.missingWineType > 0 ? "text-amber-600" : "text-emerald-600"}`}>{wineStats.missingWineType}</p>
              <p className="text-[10px] text-muted-foreground">Missing wine type</p>
            </div>
            <div className={`rounded-lg border p-3 text-center ${wineStats.inactive > 0 ? "border-red-500/30 bg-red-500/5" : "border-border bg-background"}`}>
              <p className={`text-lg font-bold ${wineStats.inactive > 0 ? "text-red-600" : "text-emerald-600"}`}>{wineStats.inactive}</p>
              <p className="text-[10px] text-muted-foreground">Inactive</p>
            </div>
            <div className="rounded-lg border border-border bg-background p-3 text-center">
              <p className="text-lg font-bold text-emerald-600">{Math.round((wineStats.hasBottlePrice / Math.max(wineStats.total - wineStats.inactive, 1)) * 100)}%</p>
              <p className="text-[10px] text-muted-foreground">Active coverage</p>
            </div>
          </div>
        ) : (
          <p className="text-[11px] text-muted-foreground italic">Loading stats...</p>
        )}
        {wineStats && wineStats.missingPricing > 0 && (
          <div className="rounded-md bg-amber-500/10 border border-amber-500/20 p-2 text-[11px] text-amber-600 flex items-center gap-1.5">
            <AlertTriangle className="h-3 w-3 shrink-0" />
            {wineStats.missingPricing} wines missing pricing. Click "Enrich Missing Pricing" to fetch detail data from Winerim.
          </div>
        )}
      </div>

      {/* ── Agora Family Manager ── */}
      <AgoraFamilyManager
        connectionId={connectionId}
        families={masterData.families}
        onSyncMasterData={onSync}
        syncing={syncing}
      />

      {sections.map(({ label, data, icon: Icon }) => {
        const filtered = filterItems(data);
        if (searchMaster.trim() && filtered.length === 0) return null;
        return (
        <div key={label} className="rounded-lg border border-border bg-secondary/30 p-3 space-y-2">
          <p className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
            <Icon className="h-3.5 w-3.5" /> {label} ({filtered.length}{searchMaster.trim() ? `/${data.length}` : ""})
          </p>
          {filtered.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {filtered.map((item: any, i: number) => (
                <Badge key={i} variant="outline" className="text-[10px] font-mono">
                  {item.Id}: {item.Name}{item.VatRate ? ` (${(Number(item.VatRate) * 100).toFixed(0)}%)` : ""}
                </Badge>
              ))}
            </div>
          ) : (
            <p className="text-[11px] text-muted-foreground italic">No data yet. Click sync above.</p>
          )}
        </div>
        );
      })}
      {masterData.productsSummary.length > 0 && (
        <AgoraProductsPanel products={masterData.productsSummary} families={masterData.families} />
      )}
    </div>
  );
}
// ── Step 9: Write Settings ──
function StepWriteSettings({
  writeSettings, masterData, onSave,
}: {
  writeSettings: import("@/hooks/useAgoraMasterData").WriteSettings;
  masterData: import("@/hooks/useAgoraMasterData").AgoraMasterData;
  onSave: (s: Partial<import("@/hooks/useAgoraMasterData").WriteSettings>) => void;
}) {
  const families = masterData.families;
  const vats = masterData.vats;
  const prepTypes = masterData.preparationTypes;
  const prepOrders = masterData.preparationOrders;
  const warehouses = masterData.warehouses;

  const SelectDropdown = ({ label, value, options, onChange }: {
    label: string; value: string | null;
    options: { id: string; label: string }[];
    onChange: (v: string) => void;
  }) => (
    <div>
      <label className="text-xs font-medium text-muted-foreground mb-1.5 block">{label}</label>
      <select
        value={value || ""}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
      >
        <option value="">Auto / Default</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>{o.id}: {o.label}</option>
        ))}
      </select>
    </div>
  );

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Write Settings</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Configure defaults for creating wine products in Agora via XML import.
        </p>
      </div>

      {families.length === 0 && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs">
          <p className="font-medium flex items-center gap-1.5"><AlertTriangle className="h-3.5 w-3.5 text-amber-500" /> No master data loaded. Go back to "Master Data" step and sync first.</p>
        </div>
      )}

      <div className="grid gap-4">
        <SelectDropdown label="Default Wine Family" value={writeSettings.default_family_id}
          options={families.map((f: any) => ({ id: f.Id, label: f.Name }))}
          onChange={(v) => onSave({ default_family_id: v || null })} />
        <SelectDropdown label="Default VAT" value={writeSettings.default_vat_id}
          options={vats.map((v: any) => ({ id: v.Id, label: `${v.Name} (${(Number(v.VatRate) * 100).toFixed(0)}%)` }))}
          onChange={(v) => onSave({ default_vat_id: v || null })} />
        <SelectDropdown label="Preparation Type" value={writeSettings.default_preparation_type_id}
          options={prepTypes.map((p: any) => ({ id: p.Id, label: p.Name }))}
          onChange={(v) => onSave({ default_preparation_type_id: v || null })} />
        <SelectDropdown label="Preparation Order" value={writeSettings.default_preparation_order_id}
          options={prepOrders.map((p: any) => ({ id: p.Id, label: p.Name }))}
          onChange={(v) => onSave({ default_preparation_order_id: v || null })} />
        <SelectDropdown label="Default Warehouse" value={writeSettings.default_warehouse_id}
          options={warehouses.map((w: any) => ({ id: w.Id, label: w.Name }))}
          onChange={(v) => onSave({ default_warehouse_id: v || null })} />
      </div>

      <div className="space-y-3 rounded-lg border border-border p-4">
        <p className="text-xs font-medium text-muted-foreground">Format Options</p>
        <div className="flex items-center justify-between">
          <div><p className="text-sm text-foreground">Write Bottle (BOT.)</p><p className="text-[11px] text-muted-foreground">Create bottle products in Agora</p></div>
          <Switch checked={writeSettings.write_bottle} onCheckedChange={(v) => onSave({ write_bottle: v })} />
        </div>
        <div className="flex items-center justify-between">
          <div><p className="text-sm text-foreground">Write Glass (COPA)</p><p className="text-[11px] text-muted-foreground">Create glass/copa products in Agora. Requires serve_by_glass + glass_sale_price on the wine.</p></div>
          <Switch checked={writeSettings.write_glass} onCheckedChange={(v) => onSave({ write_glass: v })} />
        </div>
        <div className="flex items-center justify-between">
          <div><p className="text-sm text-foreground">Auto-create Missing Families</p><p className="text-[11px] text-muted-foreground">Create wine families in Agora if they don't exist</p></div>
          <Switch checked={writeSettings.auto_create_families} onCheckedChange={(v) => onSave({ auto_create_families: v })} />
        </div>
        {writeSettings.write_glass && (
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Estimated Glasses per Bottle (fallback for glass cost)</label>
            <div className="flex gap-2 items-center">
              {[4, 5, 6, 7, 8].map((n) => (
                <button key={n} onClick={() => onSave({ estimated_glasses_per_bottle: n })}
                  className={`rounded-lg border px-3 py-2 text-xs font-medium transition-all ${writeSettings.estimated_glasses_per_bottle === n ? "border-primary bg-primary/5 text-primary" : "border-border text-muted-foreground hover:border-primary/30"}`}>
                  {n}
                </button>
              ))}
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">Used to estimate glass cost when glass_cost_price is missing: bottle_purchase_price ÷ {writeSettings.estimated_glasses_per_bottle}</p>
          </div>
        )}
      </div>

      <div className="space-y-3 rounded-lg border border-primary/20 bg-primary/5 p-4">
        <div className="flex items-center gap-2">
          <Zap className="h-4 w-4 text-primary" />
          <p className="text-xs font-medium text-foreground">Auto Push</p>
        </div>
        <p className="text-[11px] text-muted-foreground">
          When enabled, syncing the Winerim catalog will automatically create outbound tasks to push new/updated wines to Agora.
        </p>
        <div className="flex items-center justify-between">
          <div><p className="text-sm text-foreground">Auto-push on Create</p><p className="text-[11px] text-muted-foreground">Queue push when a new wine is synced from Winerim</p></div>
          <Switch checked={writeSettings.auto_push_on_create} onCheckedChange={(v) => onSave({ auto_push_on_create: v })} />
        </div>
        <div className="flex items-center justify-between">
          <div><p className="text-sm text-foreground">Auto-push on Update</p><p className="text-[11px] text-muted-foreground">Queue push when an existing wine is updated (only if already synced)</p></div>
          <Switch checked={writeSettings.auto_push_on_update} onCheckedChange={(v) => onSave({ auto_push_on_update: v })} />
        </div>
        <div className="flex items-center justify-between">
          <div><p className="text-sm text-foreground">Auto-push Bottle</p><p className="text-[11px] text-muted-foreground">Auto-push BOT. format</p></div>
          <Switch checked={writeSettings.auto_push_bottle} onCheckedChange={(v) => onSave({ auto_push_bottle: v })} />
        </div>
        <div className="flex items-center justify-between">
          <div><p className="text-sm text-foreground">Auto-push Glass</p><p className="text-[11px] text-muted-foreground">Auto-push COPA format</p></div>
          <Switch checked={writeSettings.auto_push_glass} onCheckedChange={(v) => onSave({ auto_push_glass: v })} />
        </div>
        <div className="flex items-center justify-between">
          <div><p className="text-sm text-foreground">Require Manual Review</p><p className="text-[11px] text-muted-foreground">Only auto-push wines with valid name and resolvable data</p></div>
          <Switch checked={writeSettings.require_manual_review_before_push} onCheckedChange={(v) => onSave({ require_manual_review_before_push: v })} />
        </div>
        {!writeSettings.auto_push_on_create && !writeSettings.auto_push_on_update && (
          <div className="rounded-md bg-muted/50 p-2 text-[11px] text-muted-foreground flex items-center gap-1.5">
            <AlertTriangle className="h-3 w-3" /> Auto-push is disabled. Wines will only be pushed manually from the Outbound Sync step.
          </div>
        )}
        {(writeSettings.auto_push_on_create || writeSettings.auto_push_on_update) && writeSettings.write_mode !== "XML_IMPORT" && (
          <div className="rounded-md bg-amber-500/10 border border-amber-500/20 p-2 text-[11px] text-amber-600 flex items-center gap-1.5">
            <AlertTriangle className="h-3 w-3" /> Auto-push requires write_mode = XML_IMPORT. Sync Master Data first to enable.
          </div>
        )}
      </div>
    </div>
  );
}

// ── Step 11: Go Live ──
function StepGoLive({
  syncMode, frequency, backfill, salesEvents, selectedDay,
  onEnable, enabled, familyOverrides, detectedFamilies, catalogStatus,
}: {
  syncMode: string; frequency: number; backfill: number;
  salesEvents: SalesEvent[]; selectedDay: string | null;
  onEnable: () => void; enabled: boolean;
  familyOverrides: Record<string, boolean>; detectedFamilies: DetectedFamily[];
  catalogStatus: { catalogEndpoint: string | null; catalogProductCount: number; catalogWineCandidateCount: number; catalogSyncEnabled: boolean };
}) {
  const wineFamilyCount = detectedFamilies.filter((f) => f.name in familyOverrides ? familyOverrides[f.name] : f.suggestedWine).length;
  const wineLines = salesEvents.flatMap((e) => e.lines).filter((l) => l.is_wine_candidate);

  return (
    <div className="space-y-6 text-center py-4">
      <div className="flex justify-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10"><Power className="h-8 w-8 text-primary" /></div>
      </div>
      <div>
        <h2 className="text-lg font-semibold text-foreground">Ready to Go Live</h2>
        <p className="mt-1 text-sm text-muted-foreground max-w-md mx-auto">Enable sync to start pulling sales data every {frequency} minutes.</p>
      </div>
      <div className="rounded-lg border border-border bg-secondary/30 p-4 text-left max-w-sm mx-auto space-y-2">
        <div className="flex justify-between text-xs"><span className="text-muted-foreground">Mode</span><span className="font-medium text-foreground">{syncMode === "PULL_ONLY" ? "Pull Only" : "Bidirectional"}</span></div>
        <div className="flex justify-between text-xs"><span className="text-muted-foreground">Frequency</span><span className="font-medium text-foreground">Every {frequency} min</span></div>
        <div className="flex justify-between text-xs"><span className="text-muted-foreground">Backfill</span><span className="font-medium text-foreground">Last {backfill} days</span></div>
        {selectedDay && <div className="flex justify-between text-xs"><span className="text-muted-foreground">Last business day</span><span className="font-medium font-mono text-foreground">{selectedDay}</span></div>}
        <div className="flex justify-between text-xs"><span className="text-muted-foreground">Wine families</span><span className="font-medium text-foreground">{wineFamilyCount}</span></div>
        <div className="flex justify-between text-xs"><span className="text-muted-foreground">Wine candidates (sales)</span><span className="font-medium text-foreground">{wineLines.length}</span></div>
        {catalogStatus.catalogEndpoint && (
          <>
            <div className="border-t border-border pt-2 mt-2" />
            <div className="flex justify-between text-xs"><span className="text-muted-foreground">Catalog endpoint</span><span className="font-mono font-medium text-foreground">{catalogStatus.catalogEndpoint}</span></div>
            <div className="flex justify-between text-xs"><span className="text-muted-foreground">Catalog products</span><span className="font-medium text-foreground">{catalogStatus.catalogProductCount}</span></div>
            <div className="flex justify-between text-xs"><span className="text-muted-foreground">Wine candidates</span><span className="font-medium text-success">{catalogStatus.catalogWineCandidateCount}</span></div>
            <div className="flex justify-between text-xs"><span className="text-muted-foreground">Catalog sync</span><span className="font-medium text-foreground">{catalogStatus.catalogSyncEnabled ? "Enabled" : "Disabled"}</span></div>
          </>
        )}
      </div>
      <Button size="lg" onClick={onEnable} className="shadow-glow">
        {enabled ? (<><CheckCircle2 className="mr-2 h-4 w-4" /> Sync Enabled — Redirecting…</>) : "Enable Sync"}
      </Button>
    </div>
  );
}

// ── Main Wizard ──
export default function AgoraWizard() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [currentStep, setCurrentStep] = useState(1);
  const [baseUrl, setBaseUrl] = useState("");
  const [apiToken, setApiToken] = useState("");
  const [winerimApiToken, setWinerimApiToken] = useState("");
  const [locationName, setLocationName] = useState("");
  const [syncMode, setSyncMode] = useState<"PULL_ONLY" | "BIDIRECTIONAL">("PULL_ONLY");
  const [frequency, setFrequency] = useState(15);
  const [backfill, setBackfill] = useState(30);
  const [enabled, setEnabled] = useState(false);
  const [familyOverrides, setFamilyOverrides] = useState<Record<string, boolean>>({});

  const {
    connectionId, setConnectionId,
    testStatus, testError, testConnection, updateConnection, loadConnection,
    daysWithSales, selectedDay, setSelectedDay, loadingDays, findDaysWithSales, scanStats,
    salesEvents, detectedFamilies, loadingSales, fetchSalesForDay,
    saving, saveResult, saveSalesToDb, enableSync, saveFamilyRules,
    catalogStatus, catalogDiscovering, catalogDiscoveryResults, catalogDiscoverySample,
    catalogSyncing, catalogSyncResult, catalogTestResult, catalogTestingEndpoint,
    catalogProducts, discoverCatalog, syncCatalog, testCatalogEndpoint,
    fetchCatalogProducts, toggleCatalogSync,
    buildingDerived, derivedResult, buildDerivedCatalog,
    classificationConfig, loadClassificationConfig, saveClassificationConfig,
    recomputing, recomputeResult, recomputeClassification,
    overrideProductClassification, bulkOverrideProducts,
  } = useAgoraConnection();

  const outbound = useOutboundSync(connectionId);
  const agoraMaster = useAgoraMasterData(connectionId);

  // Winerim wines for outbound push
  const [winerimWinesForPush, setWinerimWinesForPush] = useState<{ winerim_id: string; name: string }[]>([]);

  useEffect(() => {
    const connParam = searchParams.get("connection");
    if (connParam && !connectionId) {
      loadConnection(connParam).then((conn) => {
        if (conn) {
          setLocationName(conn.location_name);
          setBaseUrl(conn.base_url);
          setApiToken(conn.api_token);
          setWinerimApiToken(conn.winerim_api_token || "");
          setSyncMode(conn.sync_mode as "PULL_ONLY" | "BIDIRECTIONAL");
          setFrequency(conn.sync_frequency_minutes);
          setBackfill(conn.backfill_days);
          setEnabled(conn.enabled);
          setCurrentStep(7);
        }
      });
    }
  }, [searchParams]);

  useEffect(() => {
    if ((currentStep === 6 || currentStep === 7) && connectionId && daysWithSales.length === 0 && !loadingDays) {
      findDaysWithSales(60);
    }
  }, [currentStep, connectionId]);

  useEffect(() => {
    if (selectedDay && (currentStep === 6 || currentStep === 7)) fetchSalesForDay(selectedDay);
  }, [selectedDay]);

  useEffect(() => {
    if (currentStep === 4 && connectionId && !catalogStatus.catalogEndpoint && !catalogDiscovering) discoverCatalog();
  }, [currentStep, connectionId]);

  useEffect(() => {
    if ((currentStep === 6 || currentStep === 7) && connectionId) {
      loadClassificationConfig();
      if (catalogProducts.length === 0) fetchCatalogProducts();
    }
  }, [currentStep, connectionId]);

  useEffect(() => {
    if (connectionId && currentStep === 6 && !classificationConfig.id) {
      saveClassificationConfig({
        non_wine_keywords_blacklist: ["menu", "menú", "degustación", "terrina", "ravioli", "steak", "solomillo", "atún", "gambas", "postre", "tarta", "pan", "snack", "ensalada", "pescado", "carne"],
        wine_keywords_whitelist: ["vino", "tinto", "blanco", "rosado", "cava", "champagne", "brut", "reserva", "crianza", "botella", "bot.", "75cl", "magnum", "copa"],
        format_whitelist: ["BOT", "Bottle", "75cl", "Copa", "Glass"],
      });
    }
  }, [connectionId, currentStep]);

  // Load master data + write settings when entering steps 3, 5 or 10
  useEffect(() => {
    if ((currentStep === 3 || currentStep === 5 || currentStep === 10) && connectionId) {
      agoraMaster.loadMasterData();
      agoraMaster.loadWriteSettings();
    }
  }, [currentStep, connectionId]);

  // Load winerim wines when entering step 11
  useEffect(() => {
    if (currentStep === 11 && connectionId) {
      fetchAllWinerimWines(connectionId, "winerim_id, name")
        .then((data) => { setWinerimWinesForPush(data as any); });
    }
  }, [currentStep, connectionId]);

  const handleAddKeyword = (keyword: string, type: "wine" | "non_wine") => {
    if (type === "wine") {
      const current = classificationConfig.wine_families_whitelist || [];
      if (!current.includes(keyword)) {
        saveClassificationConfig({ wine_families_whitelist: [...current, keyword] });
      }
    } else {
      const current = classificationConfig.non_wine_families_blacklist || [];
      if (!current.includes(keyword)) {
        saveClassificationConfig({ non_wine_families_blacklist: [...current, keyword] });
      }
    }
  };

  const handleNext = async () => {
    if (currentStep === 2 && connectionId) {
      await updateConnection(connectionId, {
        sync_mode: syncMode, sync_frequency_minutes: frequency,
        backfill_days: backfill, location_name: locationName || "New Location",
      });
    }
    if (currentStep === 6) {
      const families = detectedFamilies.map((f) => ({
        name: f.name, isWine: f.name in familyOverrides ? familyOverrides[f.name] : f.suggestedWine,
      }));
      if (families.length > 0) await saveFamilyRules(families);
    }
    setCurrentStep((s) => Math.min(12, s + 1));
  };

  return (
    <div className="max-w-3xl mx-auto space-y-8">
      <button onClick={() => navigate("/integrations")} className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors">
        <ArrowLeft className="h-4 w-4" /> Back to Integrations
      </button>
      <div className="flex items-center gap-4">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-primary font-bold text-lg">A</div>
        <div>
          <h1 className="text-xl font-bold text-foreground">Connect Agora POS</h1>
          <p className="text-sm text-muted-foreground">Set up your Agora integration in a few steps.</p>
        </div>
      </div>
      <div className="flex items-center gap-1">
        {steps.map((step, i) => {
          const isActive = step.id === currentStep;
          const isDone = step.id < currentStep;
          return (
            <div key={step.id} className="flex items-center gap-1 flex-1">
              <button
                type="button"
                onClick={() => setCurrentStep(step.id)}
                className={`flex h-6 w-6 items-center justify-center rounded-full text-[9px] font-semibold transition-all cursor-pointer hover:ring-2 hover:ring-primary/40 ${isDone ? "bg-success text-success-foreground" : isActive ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground"}`}
              >
                {isDone ? <CheckCircle2 className="h-3 w-3" /> : step.id}
              </button>
              <button
                type="button"
                onClick={() => setCurrentStep(step.id)}
                className={`text-[10px] font-medium hidden xl:block cursor-pointer hover:text-foreground transition-colors ${isActive ? "text-foreground" : "text-muted-foreground"}`}
              >
                {step.label}
              </button>
              {i < steps.length - 1 && <div className={`h-px flex-1 ${isDone ? "bg-success" : "bg-border"}`} />}
            </div>
          );
        })}
      </div>
      <AnimatePresence mode="wait">
        <motion.div key={currentStep} initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} transition={{ duration: 0.25 }} className="rounded-xl border border-border bg-card p-6 shadow-card">
          {currentStep === 1 && (
            <StepConnection locationName={locationName} setLocationName={setLocationName}
              baseUrl={baseUrl} setBaseUrl={setBaseUrl} apiToken={apiToken} setApiToken={setApiToken}
              winerimApiToken={winerimApiToken} setWinerimApiToken={setWinerimApiToken}
              testStatus={testStatus} testError={testError} onTest={() => testConnection(baseUrl, apiToken, winerimApiToken)} />
          )}
          {currentStep === 2 && (
            <StepSyncSettings syncMode={syncMode} setSyncMode={setSyncMode}
              frequency={frequency} setFrequency={setFrequency} backfill={backfill} setBackfill={setBackfill}
              catalogSyncEnabled={catalogStatus.catalogSyncEnabled} onToggleCatalogSync={toggleCatalogSync} />
          )}
          {currentStep === 3 && (
            <StepCapabilities connectionId={connectionId}
              capabilities={outbound.capabilities} detecting={outbound.detecting}
              detectionResults={outbound.detectionResults}
              onDetect={outbound.detectCapabilities} onLoadCapabilities={outbound.loadCapabilities}
              exporting={outbound.exporting} onExport={outbound.exportProducts}
              writeMode={agoraMaster.writeSettings.write_mode}
              xmlWriteCapability={agoraMaster.writeCapability} />
          )}
          {currentStep === 4 && (
            <StepCatalog catalogStatus={catalogStatus}
              catalogDiscovering={catalogDiscovering} catalogDiscoveryResults={catalogDiscoveryResults}
              catalogDiscoverySample={catalogDiscoverySample} catalogSyncing={catalogSyncing}
              catalogSyncResult={catalogSyncResult} catalogTestResult={catalogTestResult}
              catalogTestingEndpoint={catalogTestingEndpoint} catalogProducts={catalogProducts}
              buildingDerived={buildingDerived} derivedResult={derivedResult}
              onDiscover={discoverCatalog} onSync={syncCatalog} onTestEndpoint={testCatalogEndpoint}
              onFetchProducts={fetchCatalogProducts} onBuildDerived={buildDerivedCatalog} />
          )}
          {currentStep === 5 && (
            <StepMasterData masterData={agoraMaster.masterData}
              syncing={agoraMaster.syncing} syncError={agoraMaster.syncError}
              syncTruncationWarnings={agoraMaster.syncTruncationWarnings}
              onSync={agoraMaster.syncMasterData} onLoad={agoraMaster.loadMasterData}
              writeCapability={agoraMaster.writeCapability} writeSettings={agoraMaster.writeSettings}
              connectionId={connectionId} saveWriteSettings={agoraMaster.saveWriteSettings} />
          )}
          {currentStep === 6 && (
            <StepFamilies detectedFamilies={detectedFamilies} loadingDays={loadingDays} loadingSales={loadingSales}
              familyOverrides={familyOverrides} setFamilyOverrides={setFamilyOverrides}
              scanStats={scanStats} daysWithSales={daysWithSales} selectedDay={selectedDay}
              onRunHistoricalScan={() => findDaysWithSales(90)} salesEvents={salesEvents}
              catalogProducts={catalogProducts} onAddKeyword={handleAddKeyword} />
          )}
          {currentStep === 7 && (
            <StepSalesMapping daysWithSales={daysWithSales} selectedDay={selectedDay} setSelectedDay={setSelectedDay}
              loadingDays={loadingDays} salesEvents={salesEvents} loadingSales={loadingSales}
              onFetchDay={fetchSalesForDay} onSaveSales={saveSalesToDb} saving={saving} saveResult={saveResult}
              familyOverrides={familyOverrides} detectedFamilies={detectedFamilies}
              catalogProducts={catalogProducts}
              onOverride={overrideProductClassification} onBulkOverride={bulkOverrideProducts}
              recomputing={recomputing} onRecompute={recomputeClassification} recomputeResult={recomputeResult} />
          )}
          {currentStep === 8 && (
            <StepWineMatching connectionId={connectionId} />
          )}
          {currentStep === 9 && (
            <StepWinerimCatalog connectionId={connectionId}
              onQueueProducts={(ids, fmts, familyOverride) => outbound.queueProducts(ids, fmts, familyOverride)}
              queuingProducts={outbound.queuingProducts}
              families={agoraMaster.masterData.families} />
          )}
          {currentStep === 10 && (
            <StepWriteSettings writeSettings={agoraMaster.writeSettings}
              masterData={agoraMaster.masterData}
              onSave={agoraMaster.saveWriteSettings} />
          )}
          {currentStep === 11 && (
            <StepOutboundSync connectionId={connectionId}
              capabilities={outbound.capabilities}
              outboundTasks={outbound.outboundTasks} loadingTasks={outbound.loadingTasks}
              processingQueue={outbound.processingQueue} queuingProducts={outbound.queuingProducts}
              exporting={outbound.exporting}
              onLoadTasks={outbound.loadOutboundTasks} onProcessQueue={outbound.processQueue}
              onRetry={outbound.retryTask} onExport={outbound.exportProducts}
              winerimWines={winerimWinesForPush}
              onQueueProducts={(ids, fmts) => outbound.queueProducts(ids, fmts)} />
          )}
          {currentStep === 12 && (
            <StepGoLive syncMode={syncMode} frequency={frequency} backfill={backfill}
              salesEvents={salesEvents} selectedDay={selectedDay}
              onEnable={async () => { await enableSync(); setEnabled(true); setTimeout(() => navigate("/integrations"), 2000); }}
              enabled={enabled} familyOverrides={familyOverrides} detectedFamilies={detectedFamilies} catalogStatus={catalogStatus} />
          )}
        </motion.div>
      </AnimatePresence>
      <div className="flex justify-between">
        <Button variant="ghost" onClick={() => setCurrentStep((s) => Math.max(1, s - 1))} disabled={currentStep === 1}>
          <ArrowLeft className="mr-2 h-4 w-4" /> Previous
        </Button>
        {currentStep < 12 && (
          <Button onClick={handleNext} disabled={currentStep === 1 && testStatus !== "success"}>
            Next <ArrowRight className="ml-2 h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  );
}
