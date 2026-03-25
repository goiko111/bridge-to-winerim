import { useState, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CheckCircle2, AlertTriangle, Loader2, ArrowLeft, ArrowRight, MapPin, ShoppingCart } from "lucide-react";
import { useNumierConnection } from "@/hooks/useNumierConnection";
import ProviderReadinessPanel from "@/components/ProviderReadinessPanel";
import { useNavigate } from "react-router-dom";

const steps = [
  { label: "Connection", description: "Configure Numier API credentials" },
  { label: "Locations", description: "Discover available locations" },
  { label: "Sales Preview", description: "Fetch and preview sales data" },
  { label: "Activate", description: "Enable automated sync" },
];

/**
 * NumierWizard — MVP wizard for the Numier POS connector.
 *
 * Capabilities status:
 * ✅ IMPLEMENTED: healthcheck, test connection
 * 🔲 STUB: read_locations, read_sales (needs real API endpoints)
 * ❌ NOT YET: read_catalog, write_catalog, verify_catalog
 */
export default function NumierWizard() {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);

  // Form state
  const [locationName, setLocationName] = useState("");
  const [apiBaseUrl, setApiBaseUrl] = useState("");
  const [apiToken, setApiToken] = useState("");
  const [authMode, setAuthMode] = useState("API_KEY");
  const [selectedDay, setSelectedDay] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  });

  const {
    connectionId,
    testStatus,
    testError,
    testConnection,
    capabilities,
    locations,
    loadingLocations,
    fetchLocations,
    salesEvents,
    loadingSales,
    fetchSalesForDay,
    saving,
    saveResult,
    saveSalesToDb,
    enableSync,
  } = useNumierConnection();

  const canNext = useMemo(() => {
    switch (step) {
      case 0: return testStatus === "success";
      case 1: return true; // locations is optional
      case 2: return true;
      case 3: return true;
      default: return false;
    }
  }, [step, testStatus]);

  return (
    <div className="space-y-6 max-w-3xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate("/integrations")}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-2xl font-bold text-foreground">Numier Integration</h1>
          <p className="text-sm text-muted-foreground">Connect your Numier POS to Winerim</p>
        </div>
        <Badge variant="outline" className="ml-auto bg-purple-500/15 text-purple-700 dark:text-purple-400 border-purple-500/30">
          Experimental
        </Badge>
      </div>

      {/* Step indicator */}
      <div className="flex gap-2">
        {steps.map((s, i) => (
          <div
            key={i}
            className={`flex-1 text-center text-xs py-2 rounded-md border transition-colors ${
              i === step
                ? "bg-primary/10 border-primary text-primary font-medium"
                : i < step
                ? "bg-muted border-border text-muted-foreground"
                : "border-border text-muted-foreground/50"
            }`}
          >
            {s.label}
          </div>
        ))}
      </div>

      {/* Step 0: Connection */}
      {step === 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Numier API Connection</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <label className="text-sm font-medium text-foreground">Location Name</label>
              <Input
                placeholder="Mi Restaurante"
                value={locationName}
                onChange={(e) => setLocationName(e.target.value)}
              />
            </div>
            <div>
              <label className="text-sm font-medium text-foreground">API Base URL</label>
              <Input
                placeholder="https://api.numier.com"
                value={apiBaseUrl}
                onChange={(e) => setApiBaseUrl(e.target.value)}
              />
            </div>
            <div>
              <label className="text-sm font-medium text-foreground">Auth Mode</label>
              <Select value={authMode} onValueChange={setAuthMode}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="API_KEY">API Key (Bearer)</SelectItem>
                  <SelectItem value="BASIC">Basic Auth (user:password)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-sm font-medium text-foreground">
                {authMode === "BASIC" ? "Credentials (user:password)" : "API Token"}
              </label>
              <Input
                type="password"
                placeholder={authMode === "BASIC" ? "user:password" : "Bearer token"}
                value={apiToken}
                onChange={(e) => setApiToken(e.target.value)}
              />
            </div>

            <Button
              onClick={() => testConnection(apiBaseUrl, apiToken, authMode)}
              disabled={!apiBaseUrl || !apiToken || testStatus === "testing"}
              className="w-full"
            >
              {testStatus === "testing" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {testStatus === "success" ? (
                <><CheckCircle2 className="mr-2 h-4 w-4" /> Connected</>
              ) : (
                "Test Connection"
              )}
            </Button>

            {testStatus === "error" && testError && (
              <div className="flex items-start gap-2 text-sm text-destructive bg-destructive/10 p-3 rounded-md">
                <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                <span>{testError}</span>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Step 1: Locations */}
      {step === 1 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <MapPin className="h-5 w-5" /> Discover Locations
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Fetch available locations/stores from Numier. This step is optional — you can skip if your API doesn't support multi-location.
            </p>
            <Button onClick={fetchLocations} disabled={loadingLocations}>
              {loadingLocations && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Discover Locations
            </Button>

            {locations.length > 0 && (
              <div className="space-y-2">
                {locations.map((loc) => (
                  <div key={loc.id} className="flex items-center justify-between p-3 rounded-md border border-border bg-secondary/30">
                    <div>
                      <span className="font-medium text-foreground">{loc.name}</span>
                      {loc.address && <span className="text-xs text-muted-foreground ml-2">{loc.address}</span>}
                    </div>
                    <Badge variant="outline">{loc.id}</Badge>
                  </div>
                ))}
              </div>
            )}

            {!loadingLocations && locations.length === 0 && (
              <p className="text-xs text-muted-foreground italic">No locations found or endpoint not available yet.</p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Step 2: Sales Preview */}
      {step === 2 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <ShoppingCart className="h-5 w-5" /> Sales Preview
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex gap-2 items-end">
              <div className="flex-1">
                <label className="text-sm font-medium text-foreground">Business Day</label>
                <Input type="date" value={selectedDay} onChange={(e) => setSelectedDay(e.target.value)} />
              </div>
              <Button onClick={() => fetchSalesForDay(selectedDay)} disabled={loadingSales || !selectedDay}>
                {loadingSales && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Fetch Sales
              </Button>
            </div>

            {salesEvents.length > 0 && (
              <div className="space-y-3">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Documents found</span>
                  <span className="font-medium text-foreground">{salesEvents.length}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Total lines</span>
                  <span className="font-medium text-foreground">
                    {salesEvents.reduce((s, e) => s + e.line_count, 0)}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Total amount</span>
                  <span className="font-medium text-foreground">
                    €{salesEvents.reduce((s, e) => s + e.total_amount, 0).toFixed(2)}
                  </span>
                </div>

                <Button
                  onClick={() => saveSalesToDb(selectedDay)}
                  disabled={saving}
                  variant="secondary"
                  className="w-full"
                >
                  {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Save to Database
                </Button>

                {saveResult && (
                  <div className="text-sm text-muted-foreground bg-muted p-3 rounded-md">
                    Saved {saveResult.savedEvents} events, {saveResult.savedLines} lines.
                  </div>
                )}
              </div>
            )}

            {!loadingSales && salesEvents.length === 0 && (
              <p className="text-xs text-muted-foreground italic">No sales fetched yet. Select a day and click Fetch.</p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Step 3: Activate */}
      {step === 3 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Activate Sync</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Enable automated sales sync for this Numier connection.
            </p>

            {connectionId && (
              <ProviderReadinessPanel connectionId={connectionId} provider="numier" />
            )}

            {/* Capabilities summary */}
            <div className="rounded-md border border-border p-4 space-y-2">
              <h4 className="text-sm font-medium text-foreground">Capabilities</h4>
              {Object.entries(capabilities).map(([key, val]) => (
                <div key={key} className="flex justify-between text-xs">
                  <span className="text-muted-foreground">{key.replace(/_/g, " ")}</span>
                  <Badge variant={val ? "default" : "outline"} className="text-xs">
                    {val ? "✅ Verified" : "⬜ Not verified"}
                  </Badge>
                </div>
              ))}
            </div>

            <Button onClick={enableSync} className="w-full">
              Enable Automated Sync
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Navigation */}
      <div className="flex justify-between">
        <Button variant="outline" onClick={() => setStep((s) => s - 1)} disabled={step === 0}>
          <ArrowLeft className="mr-2 h-4 w-4" /> Back
        </Button>
        <Button onClick={() => setStep((s) => s + 1)} disabled={step >= steps.length - 1 || !canNext}>
          Next <ArrowRight className="ml-2 h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
