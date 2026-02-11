import { motion } from "framer-motion";
import { Building2, MapPin, User, Shield } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

export default function SettingsPage() {
  return (
    <div className="max-w-2xl mx-auto space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Manage your organization, locations, and account.
        </p>
      </div>

      {/* Organization */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        className="rounded-xl border border-border bg-card p-6 shadow-card space-y-4"
      >
        <div className="flex items-center gap-3">
          <Building2 className="h-5 w-5 text-primary" />
          <h2 className="text-sm font-semibold text-foreground">Organization</h2>
        </div>
        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Name</label>
            <Input defaultValue="Grupo Vinoteca S.L." className="bg-background" />
          </div>
        </div>
      </motion.div>

      {/* Locations */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.08 }}
        className="rounded-xl border border-border bg-card p-6 shadow-card space-y-4"
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <MapPin className="h-5 w-5 text-primary" />
            <h2 className="text-sm font-semibold text-foreground">Locations</h2>
          </div>
          <Button size="sm" variant="outline">Add Location</Button>
        </div>
        <div className="divide-y divide-border rounded-lg border border-border overflow-hidden">
          {["La Vinoteca Central", "Bodega del Puerto", "El Rincón del Vino"].map((loc) => (
            <div key={loc} className="flex items-center justify-between px-4 py-3">
              <span className="text-sm text-foreground">{loc}</span>
              <Badge variant="secondary" className="text-[10px]">Europe/Madrid</Badge>
            </div>
          ))}
        </div>
      </motion.div>

      {/* Account */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.16 }}
        className="rounded-xl border border-border bg-card p-6 shadow-card space-y-4"
      >
        <div className="flex items-center gap-3">
          <User className="h-5 w-5 text-primary" />
          <h2 className="text-sm font-semibold text-foreground">Account</h2>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Email</label>
            <Input defaultValue="admin@vinoteca.com" className="bg-background" disabled />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Role</label>
            <div className="flex items-center gap-2 h-10 px-3 rounded-md border border-border bg-background">
              <Shield className="h-3 w-3 text-primary" />
              <span className="text-sm text-foreground">Owner</span>
            </div>
          </div>
        </div>
      </motion.div>

      <div className="flex justify-end">
        <Button>Save Changes</Button>
      </div>
    </div>
  );
}
