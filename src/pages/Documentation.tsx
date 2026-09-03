import { motion } from "framer-motion";
import { BookOpen, Terminal, Key, Link2, Database, FileText, Globe, Server } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";

interface DocSection {
  icon: typeof Key;
  title: string;
  content: string;
}

interface ProviderDoc {
  id: string;
  name: string;
  maturity: string;
  sections: DocSection[];
  apiRef?: { method: string; path: string; methodColor: string }[];
  authHeader?: string;
}

const providers: ProviderDoc[] = [
  {
    id: "agora",
    name: "Agora POS",
    maturity: "Production",
    sections: [
      { icon: Key, title: "1. Enable Integration Module", content: "In your Agora POS admin panel, navigate to Settings → Integrations → HTTP API. Enable the integration module and note the base URL (typically http://YOUR_IP:PORT)." },
      { icon: Terminal, title: "2. Generate an API Token", content: 'In the Integrations section, click "Generate Token". Copy the Api-Token header value for authentication.' },
      { icon: Link2, title: "3. Connect in Winerim", content: 'Go to Integrations → Agora POS → Connect. Enter Base URL and Api-Token, then "Test Connection".' },
      { icon: BookOpen, title: "4. Configure Sync & Mapping", content: "Choose sync frequency (recommended: 15 min), backfill period, and map Agora products to your Winerim catalog." },
    ],
    apiRef: [
      { method: "GET", path: "/api/export/?business-day=YYYY-MM-DD&filter=Invoices", methodColor: "text-info bg-info/20" },
      { method: "GET", path: "/api/export/tickets/", methodColor: "text-info bg-info/20" },
      { method: "POST", path: "/api/doc/processed", methodColor: "text-success bg-success/20" },
    ],
    authHeader: "Api-Token: <TOKEN> · Accept: application/json",
  },
  {
    id: "revo",
    name: "Revo XEF",
    maturity: "Pilot",
    sections: [
      { icon: Key, title: "1. Get API Credentials", content: "Contact Revo support or access your Revo back-office. Navigate to Settings → API to obtain your Bearer token." },
      { icon: Terminal, title: "2. Note Base URL", content: "Your Revo API base URL is typically https://integrations.revoxef.works/api/v1 or provided by Revo." },
      { icon: Link2, title: "3. Connect in Winerim", content: "Go to Integrations → Revo XEF → Connect. Enter the Base URL and Bearer token." },
      { icon: BookOpen, title: "4. Configure Sync", content: "Revo supports paginated sales pull (120 req/min rate limit), catalog sync, and bidirectional product updates." },
    ],
    apiRef: [
      { method: "GET", path: "/api/v1/orders?date=YYYY-MM-DD&page=N", methodColor: "text-info bg-info/20" },
      { method: "GET", path: "/api/v1/catalog/products", methodColor: "text-info bg-info/20" },
      { method: "PUT", path: "/api/v1/catalog/products/{id}", methodColor: "text-warning bg-warning/20" },
    ],
    authHeader: "Authorization: Bearer <TOKEN>",
  },
  {
    id: "clover",
    name: "Clover",
    maturity: "Pilot",
    sections: [
      { icon: Key, title: "1. OAuth2 Setup", content: "Clover uses OAuth2 for authentication. Click Connect and authorize the Winerim app in your Clover merchant dashboard." },
      { icon: Globe, title: "2. Select Environment", content: "Choose between Sandbox (for testing) and Production. The system handles token refresh automatically." },
      { icon: Link2, title: "3. Authorize & Connect", content: "Complete the OAuth flow. Winerim will store encrypted tokens and auto-refresh before expiry." },
      { icon: BookOpen, title: "4. Configure Sync", content: "Clover supports orders, payments, items, and webhooks. Rate limits: 50 req/s per app, 16 req/s per token." },
    ],
    apiRef: [
      { method: "GET", path: "/v3/merchants/{mId}/orders", methodColor: "text-info bg-info/20" },
      { method: "GET", path: "/v3/merchants/{mId}/items", methodColor: "text-info bg-info/20" },
      { method: "POST", path: "/v3/merchants/{mId}/items", methodColor: "text-success bg-success/20" },
    ],
    authHeader: "Authorization: Bearer <OAUTH_TOKEN>",
  },
  {
    id: "square",
    name: "Square POS",
    maturity: "Pilot",
    sections: [
      { icon: Key, title: "1. OAuth2 Authorization", content: "Square uses OAuth2. Click Connect to authorize Winerim in your Square Developer dashboard." },
      { icon: Terminal, title: "2. Location Selection", content: "After authorization, select which Square location(s) to sync." },
      { icon: Link2, title: "3. Connect", content: "Complete the OAuth flow. Winerim handles token management and refresh automatically." },
      { icon: BookOpen, title: "4. Configure Sync", content: "Square supports Orders search, Catalog API, and Webhooks. Handle 429 backoff for rate limits." },
    ],
    authHeader: "Authorization: Bearer <OAUTH_TOKEN>",
  },
  {
    id: "icg",
    name: "ICG FrontRest",
    maturity: "Beta",
    sections: [
      { icon: Server, title: "1. SQL Server Access", content: "ICG uses direct SQL Server connections. Ensure the SQL Server instance is accessible from the network and TCP/IP is enabled." },
      { icon: Key, title: "2. Database Credentials", content: "Provide the host, port, database name, username, and password for the ICG SQL Server." },
      { icon: Database, title: "3. SQL Mapping", content: "Configure the SQL mapping to define which tables/fields correspond to sales headers, lines, products, and families." },
      { icon: BookOpen, title: "4. Write Mode (Optional)", content: "ICG supports write-back via direct SQL UPDATE. Enable with caution and use dry-run mode for verification." },
    ],
  },
  {
    id: "hiopos",
    name: "Hiopos / Hioffice",
    maturity: "Beta",
    sections: [
      { icon: FileText, title: "1. Export Files", content: "Export CSV or XML files from Hiopos/Hioffice back-office: Menu Item Sales, Articles, Departments." },
      { icon: Link2, title: "2. Upload to Winerim", content: "Use the Hiopos wizard to upload exported files. The system parses and normalizes the data automatically." },
      { icon: BookOpen, title: "3. Configure Mapping", content: "Map Hiopos articles to your Winerim wine catalog. Configure family rules for wine classification." },
    ],
  },
  {
    id: "touchbistro",
    name: "TouchBistro",
    maturity: "Pilot",
    sections: [
      { icon: FileText, title: "1. Export CSV Reports", content: "From TouchBistro's reporting section, export Menu Item Sales, Bills, Payments, and Items CSV files." },
      { icon: Link2, title: "2. Upload & Parse", content: "Upload CSV files in the TouchBistro wizard. The system auto-detects column mappings." },
      { icon: Key, title: "3. Private API (Optional)", content: "For approved partners, configure the Private API credentials for real-time sync capabilities." },
    ],
  },
  {
    id: "toast",
    name: "Toast POS",
    maturity: "Pilot",
    sections: [
      { icon: Key, title: "1. API Credentials", content: "Obtain API credentials from the Toast Developer Portal. You'll need Client ID, Client Secret, and Restaurant External ID." },
      { icon: Link2, title: "2. Connect", content: "Enter credentials in the Toast wizard. The system validates connectivity and webhook registration." },
      { icon: BookOpen, title: "3. Configure", content: "Toast supports orders polling, business date sync, Menus V2, and webhooks with circuit breaker resilience." },
    ],
    apiRef: [
      { method: "GET", path: "/orders/v2/orders?businessDate=YYYYMMDD", methodColor: "text-info bg-info/20" },
      { method: "GET", path: "/menus/v2/menus", methodColor: "text-info bg-info/20" },
    ],
    authHeader: "Authorization: Bearer <TOKEN> · Toast-Restaurant-External-ID: <ID>",
  },
];

export default function Documentation() {
  return (
    <div className="max-w-3xl mx-auto space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Documentation</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Quick-start guides for connecting each POS provider to Winerim.
        </p>
      </div>

      <Tabs defaultValue="agora" className="space-y-4">
        <TabsList className="flex-wrap h-auto gap-1">
          {providers.map((p) => (
            <TabsTrigger key={p.id} value={p.id} className="text-xs">
              {p.name}
            </TabsTrigger>
          ))}
        </TabsList>

        {providers.map((provider) => (
          <TabsContent key={provider.id} value={provider.id} className="space-y-4">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold text-foreground">{provider.name}</h2>
              <Badge variant="outline" className="text-[10px]">{provider.maturity}</Badge>
            </div>

            <div className="space-y-3">
              {provider.sections.map((section, i) => (
                <motion.div
                  key={i}
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.08 }}
                  className="rounded-xl border border-border bg-card p-5 shadow-card"
                >
                  <div className="flex items-start gap-4">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                      <section.icon className="h-4 w-4 text-primary" />
                    </div>
                    <div>
                      <h3 className="text-sm font-semibold text-foreground">{section.title}</h3>
                      <p className="mt-2 text-xs text-muted-foreground leading-relaxed">{section.content}</p>
                    </div>
                  </div>
                </motion.div>
              ))}
            </div>

            {provider.apiRef && (
              <div className="rounded-xl border border-border bg-secondary/30 p-5">
                <h3 className="text-sm font-semibold text-foreground mb-3">API Reference</h3>
                <div className="space-y-2 font-mono text-xs">
                  {provider.apiRef.map((ref, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <span className={`rounded px-1.5 py-0.5 font-semibold ${ref.methodColor}`}>{ref.method}</span>
                      <span className="text-muted-foreground">{ref.path}</span>
                    </div>
                  ))}
                </div>
                {provider.authHeader && (
                  <p className="mt-3 text-[10px] text-muted-foreground">
                    Header: {provider.authHeader}
                  </p>
                )}
              </div>
            )}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
