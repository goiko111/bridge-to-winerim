import { useState, useEffect } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  LayoutDashboard,
  Plug,
  Activity,
  Bell,
  FileText,
  Settings,
  ChevronLeft,
  Wine,
  ClipboardList,
  ShieldCheck,
  Menu,
  X,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

const navItems = [
  { to: "/", icon: LayoutDashboard, label: "Resumen" },
  { to: "/operations", icon: ShieldCheck, label: "Operación y auditoría" },
  { to: "/revision", icon: ClipboardList, label: "Revisión de catálogo" },
  { to: "/integrations", icon: Plug, label: "Integraciones" },
  { to: "/sync-monitor", icon: Activity, label: "Actividad" },
  { to: "/alerts", icon: Bell, label: "Incidencias", badgeKey: "alerts" },
  { to: "/docs", icon: FileText, label: "Documentación" },
  { to: "/settings", icon: Settings, label: "Configuración" },
];

export default function Layout({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [alertCount, setAlertCount] = useState(0);
  const location = useLocation();

  useEffect(() => {
    // Count active persistent incidents first; keep legacy signals as a fallback
    // while the monitoring migration is being rolled out.
    const fetchAlertCount = async () => {
      const [persistentRes, stockRes, outboundRes] = await Promise.allSettled([
        supabase.from("connection_alerts" as never).select("id", { count: "exact", head: true }).in("status", ["OPEN", "ACKED"]),
        supabase.from("stock_sync_log").select("id", { count: "exact", head: true }).eq("status", "FAILED"),
        supabase.from("outbound_tasks").select("id", { count: "exact", head: true }).in("status", ["FAILED", "BLOCKED"]),
      ]);
      const persistentCount =
        persistentRes.status === "fulfilled" && !persistentRes.value.error
          ? persistentRes.value.count || 0
          : 0;
      const legacyCount =
        (stockRes.status === "fulfilled" ? stockRes.value.count || 0 : 0) +
        (outboundRes.status === "fulfilled" ? outboundRes.value.count || 0 : 0);
      setAlertCount(persistentCount || legacyCount);
    };
    fetchAlertCount();
  }, [location.pathname]);

  useEffect(() => setMobileOpen(false), [location.pathname]);

  const navigation = (mobile = false) => (
    <nav className="flex-1 space-y-1 px-2 py-4">
      {navItems.map((item) => {
        const isActive = location.pathname === item.to;
        const showBadge = item.badgeKey === "alerts" && alertCount > 0;
        return (
          <NavLink
            key={item.to}
            to={item.to}
            className={`group flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium transition-colors ${
              isActive
                ? "bg-primary/10 text-primary"
                : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            }`}
          >
            <div className="relative shrink-0">
              <item.icon className={`h-4 w-4 ${isActive ? "text-primary" : ""}`} />
              {showBadge && (
                <span className="absolute -right-1.5 -top-1.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-destructive px-1 text-[9px] font-bold text-destructive-foreground">
                  {alertCount > 99 ? "99+" : alertCount}
                </span>
              )}
            </div>
            {(!collapsed || mobile) && <span>{item.label}</span>}
          </NavLink>
        );
      })}
    </nav>
  );

  return (
    <div className="flex min-h-screen bg-background">
      {/* Sidebar */}
      <aside
        className={`fixed left-0 top-0 z-40 hidden h-screen flex-col border-r border-border bg-sidebar transition-all duration-300 md:flex ${
          collapsed ? "w-16" : "w-60"
        }`}
      >
        {/* Logo */}
        <div className="flex h-16 items-center gap-3 border-b border-border px-4">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary">
            <Wine className="h-4 w-4 text-primary-foreground" />
          </div>
          {!collapsed && (
            <motion.span
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="text-sm font-semibold text-foreground"
            >
              Winerim TPV
            </motion.span>
          )}
        </div>

        {/* Nav */}
        {navigation()}

        {/* Collapse toggle */}
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="flex h-12 items-center justify-center border-t border-border text-muted-foreground hover:text-foreground transition-colors"
        >
          <ChevronLeft
            className={`h-4 w-4 transition-transform ${collapsed ? "rotate-180" : ""}`}
          />
        </button>
      </aside>

      {/* Main content */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <button aria-label="Cerrar menú" className="absolute inset-0 bg-black/60" onClick={() => setMobileOpen(false)} />
          <aside className="relative flex h-full w-[min(86vw,280px)] flex-col border-r border-border bg-sidebar shadow-2xl">
            <div className="flex h-16 items-center justify-between border-b border-border px-4">
              <div className="flex items-center gap-3">
                <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary"><Wine className="h-4 w-4 text-primary-foreground" /></div>
                <span className="text-sm font-semibold">Winerim TPV</span>
              </div>
              <button aria-label="Cerrar menú" className="p-2 text-muted-foreground" onClick={() => setMobileOpen(false)}><X className="h-5 w-5" /></button>
            </div>
            {navigation(true)}
          </aside>
        </div>
      )}

      <main
        className={`min-w-0 flex-1 transition-all duration-300 ${
          collapsed ? "md:ml-16" : "md:ml-60"
        }`}
      >
        {/* Top bar */}
        <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b border-border bg-background/95 px-4 backdrop-blur-xl sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <button aria-label="Abrir menú" className="rounded-md p-2 text-muted-foreground hover:bg-muted md:hidden" onClick={() => setMobileOpen(true)}><Menu className="h-5 w-5" /></button>
            <div className="truncate text-sm text-muted-foreground">
            {navItems.find((n) => n.to === location.pathname)?.label ?? "Page"}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-secondary text-xs font-medium text-secondary-foreground">
              W
            </div>
          </div>
        </header>

        {/* Page content */}
        <div className="p-4 sm:p-6">
          <AnimatePresence mode="wait">
            <motion.div
              key={location.pathname}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2 }}
            >
              {children}
            </motion.div>
          </AnimatePresence>
        </div>
      </main>
    </div>
  );
}
