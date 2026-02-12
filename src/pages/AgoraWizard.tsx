import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Loader2,
  XCircle,
  Search,
  Link2,
  Settings2,
  Map,
  Power,
  Wine,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useAgoraConnection } from "@/hooks/useAgoraConnection";

const steps = [
  { id: 1, label: "Connection", icon: Link2 },
  { id: 2, label: "Sync Settings", icon: Settings2 },
  { id: 3, label: "Mapping", icon: Map },
  { id: 4, label: "Go Live", icon: Power },
];

export default function AgoraWizard() {
  const navigate = useNavigate();
  const [currentStep, setCurrentStep] = useState(1);
  const [baseUrl, setBaseUrl] = useState("");
  const [apiToken, setApiToken] = useState("");
  const [locationName, setLocationName] = useState("");
  const [syncMode, setSyncMode] = useState<"PULL_ONLY" | "BIDIRECTIONAL">("PULL_ONLY");
  const [frequency, setFrequency] = useState(15);
  const [backfill, setBackfill] = useState(30);
  const [enabled, setEnabled] = useState(false);
  const [searchMapping, setSearchMapping] = useState("");

  const {
    connectionId,
    testStatus,
    testError,
    testConnection,
    updateConnection,
    products,
    loadingProducts,
    fetchProducts,
    enableSync,
  } = useAgoraConnection();

  const handleTestConnection = () => {
    testConnection(baseUrl, apiToken);
  };

  // Fetch products when entering mapping step
  useEffect(() => {
    if (currentStep === 3 && connectionId) {
      fetchProducts();
    }
  }, [currentStep, connectionId]);

  // Save sync settings when leaving step 2
  const handleNext = async () => {
    if (currentStep === 2 && connectionId) {
      await updateConnection(connectionId, {
        sync_mode: syncMode,
        sync_frequency_minutes: frequency,
        backfill_days: backfill,
        location_name: locationName || "New Location",
      });
    }
    setCurrentStep((s) => Math.min(4, s + 1));
  };

  const filteredProducts = products.filter((p) =>
    p.name.toLowerCase().includes(searchMapping.toLowerCase())
  );

  return (
    <div className="max-w-3xl mx-auto space-y-8">
      {/* Back */}
      <button
        onClick={() => navigate("/integrations")}
        className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to Integrations
      </button>

      {/* Header */}
      <div className="flex items-center gap-4">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-primary font-bold text-lg">
          A
        </div>
        <div>
          <h1 className="text-xl font-bold text-foreground">Connect Agora POS</h1>
          <p className="text-sm text-muted-foreground">
            Set up your Agora integration in a few steps.
          </p>
        </div>
      </div>

      {/* Step indicator */}
      <div className="flex items-center gap-2">
        {steps.map((step, i) => {
          const isActive = step.id === currentStep;
          const isDone = step.id < currentStep;
          return (
            <div key={step.id} className="flex items-center gap-2 flex-1">
              <div
                className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-semibold transition-all ${
                  isDone
                    ? "bg-success text-success-foreground"
                    : isActive
                    ? "bg-primary text-primary-foreground"
                    : "bg-secondary text-muted-foreground"
                }`}
              >
                {isDone ? <CheckCircle2 className="h-4 w-4" /> : step.id}
              </div>
              <span
                className={`text-xs font-medium hidden sm:block ${
                  isActive ? "text-foreground" : "text-muted-foreground"
                }`}
              >
                {step.label}
              </span>
              {i < steps.length - 1 && (
                <div
                  className={`h-px flex-1 ${
                    isDone ? "bg-success" : "bg-border"
                  }`}
                />
              )}
            </div>
          );
        })}
      </div>

      {/* Step Content */}
      <AnimatePresence mode="wait">
        <motion.div
          key={currentStep}
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -20 }}
          transition={{ duration: 0.25 }}
          className="rounded-xl border border-border bg-card p-6 shadow-card"
        >
          {/* Step 1: Connection */}
          {currentStep === 1 && (
            <div className="space-y-5">
              <div>
                <h2 className="text-lg font-semibold text-foreground">Connection Details</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Enter your Agora POS base URL, API token, and location name.
                </p>
              </div>

              <div className="space-y-4">
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
                    Location Name
                  </label>
                  <Input
                    placeholder="e.g. La Vinoteca Central"
                    value={locationName}
                    onChange={(e) => setLocationName(e.target.value)}
                    className="bg-background text-sm"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
                    Base URL
                  </label>
                  <Input
                    placeholder="http://192.168.1.100:8080"
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    className="bg-background font-mono text-sm"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
                    Api-Token
                  </label>
                  <Input
                    type="password"
                    placeholder="Enter your Agora API token"
                    value={apiToken}
                    onChange={(e) => setApiToken(e.target.value)}
                    className="bg-background font-mono text-sm"
                  />
                </div>

                <Button
                  onClick={handleTestConnection}
                  disabled={testStatus === "testing" || !baseUrl || !apiToken}
                  variant="secondary"
                  className="w-full"
                >
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
          )}

          {/* Step 2: Sync Settings */}
          {currentStep === 2 && (
            <div className="space-y-5">
              <div>
                <h2 className="text-lg font-semibold text-foreground">Sync Settings</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Configure how and how often data is synced.
                </p>
              </div>

              <div className="space-y-4">
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-2 block">
                    Sync Mode
                  </label>
                  <div className="grid grid-cols-2 gap-3">
                    {(["PULL_ONLY", "BIDIRECTIONAL"] as const).map((mode) => (
                      <button
                        key={mode}
                        onClick={() => setSyncMode(mode)}
                        className={`rounded-lg border p-3 text-left transition-all ${
                          syncMode === mode
                            ? "border-primary bg-primary/5"
                            : "border-border hover:border-primary/30"
                        }`}
                      >
                        <span className="text-sm font-medium text-foreground">
                          {mode === "PULL_ONLY" ? "Pull Only" : "Bidirectional"}
                        </span>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {mode === "PULL_ONLY"
                            ? "Read sales data from Agora"
                            : "Read sales + push wines to Agora"}
                        </p>
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-2 block">
                    Sync Frequency
                  </label>
                  <div className="flex gap-2">
                    {[5, 10, 15, 30, 60].map((f) => (
                      <button
                        key={f}
                        onClick={() => setFrequency(f)}
                        className={`rounded-lg border px-3 py-2 text-xs font-medium transition-all ${
                          frequency === f
                            ? "border-primary bg-primary/5 text-primary"
                            : "border-border text-muted-foreground hover:border-primary/30"
                        }`}
                      >
                        {f} min
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-2 block">
                    Backfill Period
                  </label>
                  <div className="flex gap-2">
                    {[7, 30, 90].map((d) => (
                      <button
                        key={d}
                        onClick={() => setBackfill(d)}
                        className={`rounded-lg border px-3 py-2 text-xs font-medium transition-all ${
                          backfill === d
                            ? "border-primary bg-primary/5 text-primary"
                            : "border-border text-muted-foreground hover:border-primary/30"
                        }`}
                      >
                        Last {d} days
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Step 3: Mapping */}
          {currentStep === 3 && (
            <div className="space-y-5">
              <div>
                <h2 className="text-lg font-semibold text-foreground">Product Mapping</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Map Agora products to your Winerim wine catalog.
                </p>
              </div>

              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Search products…"
                  value={searchMapping}
                  onChange={(e) => setSearchMapping(e.target.value)}
                  className="pl-10 bg-background"
                />
              </div>

              <div className="flex gap-2">
                <Button size="sm" variant="secondary">
                  Auto-map by name
                </Button>
                <Button size="sm" variant="secondary">
                  Fuzzy match
                </Button>
              </div>

              {loadingProducts ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                  <span className="ml-2 text-sm text-muted-foreground">Loading products from Agora…</span>
                </div>
              ) : filteredProducts.length === 0 ? (
                <div className="text-center py-12 text-sm text-muted-foreground">
                  No products found. Make sure the connection is working.
                </div>
              ) : (
                <div className="divide-y divide-border rounded-lg border border-border overflow-hidden">
                  {filteredProducts.map((p) => (
                    <div
                      key={p.id}
                      className="flex items-center justify-between px-4 py-3 bg-card hover:bg-secondary/30 transition-colors"
                    >
                      <div className="flex items-center gap-3">
                        <div
                          className={`h-2 w-2 rounded-full ${
                            p.mapped ? "bg-success" : p.confidence > 50 ? "bg-warning" : "bg-muted-foreground"
                          }`}
                        />
                        <div>
                          <p className="text-sm font-medium text-foreground">{p.name}</p>
                          <p className="text-xs text-muted-foreground font-mono">{p.id}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        {p.mapped ? (
                          <Badge variant="default" className="text-[10px]">
                            <Wine className="mr-1 h-3 w-3" />
                            {p.winerimId}
                          </Badge>
                        ) : p.confidence > 50 ? (
                          <Badge variant="outline" className="text-[10px] text-warning border-warning/30">
                            {p.confidence}% match
                          </Badge>
                        ) : (
                          <Badge variant="secondary" className="text-[10px]">
                            Unmapped
                          </Badge>
                        )}
                        <Button size="sm" variant="outline" className="h-7 text-xs">
                          {p.mapped ? "Change" : "Map"}
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Step 4: Go Live */}
          {currentStep === 4 && (
            <div className="space-y-6 text-center py-4">
              <div className="flex justify-center">
                <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10">
                  <Power className="h-8 w-8 text-primary" />
                </div>
              </div>
              <div>
                <h2 className="text-lg font-semibold text-foreground">Ready to Go Live</h2>
                <p className="mt-1 text-sm text-muted-foreground max-w-md mx-auto">
                  Your Agora integration is configured. Enable sync to start pulling sales data
                  every {frequency} minutes.
                </p>
              </div>

              <div className="rounded-lg border border-border bg-secondary/30 p-4 text-left max-w-sm mx-auto space-y-2">
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Mode</span>
                  <span className="font-medium text-foreground">
                    {syncMode === "PULL_ONLY" ? "Pull Only" : "Bidirectional"}
                  </span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Frequency</span>
                  <span className="font-medium text-foreground">Every {frequency} min</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Backfill</span>
                  <span className="font-medium text-foreground">Last {backfill} days</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Products</span>
                  <span className="font-medium text-foreground">
                    {products.filter((p) => p.mapped).length} / {products.length} mapped
                  </span>
                </div>
              </div>

              <Button
                size="lg"
                onClick={async () => {
                  await enableSync();
                  setEnabled(true);
                  setTimeout(() => navigate("/sync-monitor"), 1000);
                }}
                className="shadow-glow"
              >
                {enabled ? (
                  <>
                    <CheckCircle2 className="mr-2 h-4 w-4" /> Sync Enabled — Redirecting…
                  </>
                ) : (
                  "Enable Sync"
                )}
              </Button>
            </div>
          )}
        </motion.div>
      </AnimatePresence>

      {/* Navigation */}
      <div className="flex justify-between">
        <Button
          variant="outline"
          onClick={() => setCurrentStep((s) => Math.max(1, s - 1))}
          disabled={currentStep === 1}
        >
          <ArrowLeft className="mr-2 h-4 w-4" /> Previous
        </Button>
        {currentStep < 4 && (
          <Button onClick={handleNext}>
            Next <ArrowRight className="ml-2 h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  );
}
