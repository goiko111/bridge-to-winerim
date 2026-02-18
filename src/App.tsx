import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import Layout from "@/components/Layout";
import Index from "./pages/Index";
import Integrations from "./pages/Integrations";
import AgoraWizard from "./pages/AgoraWizard";
import TcposWizard from "./pages/TcposWizard";
import SyncMonitor from "./pages/SyncMonitor";
import Alerts from "./pages/Alerts";
import Documentation from "./pages/Documentation";
import SettingsPage from "./pages/Settings";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <Layout>
          <Routes>
            <Route path="/" element={<Index />} />
            <Route path="/integrations" element={<Integrations />} />
            <Route path="/integrations/agora" element={<AgoraWizard />} />
            <Route path="/integrations/tcpos" element={<TcposWizard />} />
            <Route path="/sync-monitor" element={<SyncMonitor />} />
            <Route path="/alerts" element={<Alerts />} />
            <Route path="/docs" element={<Documentation />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </Layout>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
