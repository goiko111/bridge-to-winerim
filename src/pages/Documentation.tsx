import { motion } from "framer-motion";
import { BookOpen, Terminal, Key, Link2, ArrowRight } from "lucide-react";

const sections = [
  {
    icon: Key,
    title: "1. Enable Integration Module in Agora",
    content: "In your Agora POS admin panel, navigate to Settings → Integrations → HTTP API. Enable the integration module and note the base URL displayed (typically http://YOUR_IP:PORT).",
  },
  {
    icon: Terminal,
    title: "2. Generate an API Token",
    content: 'In the same Integrations section, click "Generate Token" or "API Keys". Copy the generated Api-Token. This token is used as a header (Api-Token: <YOUR_TOKEN>) to authenticate all API requests.',
  },
  {
    icon: Link2,
    title: "3. Connect in Winerim",
    content: 'Go to Integrations → Agora POS → Connect. Enter the Base URL and Api-Token from the previous steps. Click "Test Connection" to verify. If successful, proceed to configure sync settings.',
  },
  {
    icon: BookOpen,
    title: "4. Configure Sync & Mapping",
    content: "Choose your sync frequency (recommended: 15 min) and backfill period. The system will pull sales data from Agora's /api/export/ endpoint using the business-day filter. Map Agora products to your Winerim wine catalog for accurate analytics.",
  },
];

export default function Documentation() {
  return (
    <div className="max-w-2xl mx-auto space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Documentation</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          How to connect your Agora POS system to Winerim.
        </p>
      </div>

      <div className="space-y-4">
        {sections.map((section, i) => (
          <motion.div
            key={i}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.1 }}
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

      <div className="rounded-xl border border-border bg-secondary/30 p-5">
        <h3 className="text-sm font-semibold text-foreground mb-3">Agora API Reference</h3>
        <div className="space-y-2 font-mono text-xs">
          <div className="flex items-center gap-2">
            <span className="rounded bg-info/20 px-1.5 py-0.5 text-info font-semibold">GET</span>
            <span className="text-muted-foreground">/api/export/?business-day=YYYY-MM-DD&filter=Invoices</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="rounded bg-info/20 px-1.5 py-0.5 text-info font-semibold">GET</span>
            <span className="text-muted-foreground">/api/export/tickets/</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="rounded bg-success/20 px-1.5 py-0.5 text-success font-semibold">POST</span>
            <span className="text-muted-foreground">/api/doc/processed</span>
          </div>
        </div>
        <p className="mt-3 text-[10px] text-muted-foreground">
          Header: Api-Token: &lt;TOKEN&gt; · Accept: application/json
        </p>
      </div>
    </div>
  );
}
