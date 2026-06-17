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
  ClipboardCheck,
  ListChecks,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

const navItems = [
  { to: "/", icon: LayoutDashboard, label: "Dashboard" },
  { to: "/onboarding", icon: ClipboardCheck, label: "Onboarding" },
  { to: "/onboarding/requests", icon: ListChecks, label: "Requests" },
  { to: "/integrations", icon: Plug, label: "Integrations" },
  { to: "/sync-monitor", icon: Activity, label: "Sync Monitor" },
  { to: "/alerts", icon: Bell, label: "Alerts", badgeKey: "alerts" },
  { to: "/docs", icon: FileText, label: "Documentation" },
  { to: "/settings", icon: Settings, label: "Settings" },
];

export default function Layout({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [alertCount, setAlertCount] = useState(0);
  const location = useLocation();

  useEffect(() => {
    // Count active alerts: failed stock syncs + failed/blocked outbound tasks
    const fetchAlertCount = async () => {
      const [stockRes, outboundRes] = await Promise.all([
        supabase.from("stock_sync_log").select("id", { count: "exact", head: true }).eq("status", "FAILED"),
        supabase.from("outbound_tasks").select("id", { count: "exact", head: true }).in("status", ["FAILED", "BLOCKED"]),
      ]);
      setAlertCount((stockRes.count || 0) + (outboundRes.count || 0));
    };
    fetchAlertCount();
  }, [location.pathname]);

  return (
    <div className="flex min-h-screen bg-background">
      {/* Sidebar */}
      <aside
        className={`fixed left-0 top-0 z-40 flex h-screen flex-col border-r border-border bg-sidebar transition-all duration-300 ${
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
        <nav className="flex-1 space-y-1 px-2 py-4">
          {navItems.map((item) => {
            const isActive = location.pathname === item.to;
            const showBadge = item.badgeKey === "alerts" && alertCount > 0;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                className={`group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all ${
                  isActive
                    ? "bg-primary/10 text-primary"
                    : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                }`}
              >
                <div className="relative shrink-0">
                  <item.icon className={`h-4 w-4 ${isActive ? "text-primary" : ""}`} />
                  {showBadge && (
                    <span className="absolute -top-1.5 -right-1.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-destructive px-1 text-[9px] font-bold text-destructive-foreground">
                      {alertCount > 99 ? "99+" : alertCount}
                    </span>
                  )}
                </div>
                {!collapsed && <span>{item.label}</span>}
              </NavLink>
            );
          })}
        </nav>

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
      <main
        className={`flex-1 transition-all duration-300 ${
          collapsed ? "ml-16" : "ml-60"
        }`}
      >
        {/* Top bar */}
        <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b border-border bg-background/80 backdrop-blur-xl px-6">
          <div className="text-sm text-muted-foreground font-mono">
            {navItems.find((n) => n.to === location.pathname)?.label ?? "Page"}
          </div>
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-secondary text-xs font-medium text-secondary-foreground">
              W
            </div>
          </div>
        </header>

        {/* Page content */}
        <div className="p-6">
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
