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
import CloverWizard from "./pages/CloverWizard";
import SquareWizard from "./pages/SquareWizard";
import SimphonyWizard from "./pages/SimphonyWizard";
import CassaWizard from "./pages/CassaWizard";
import RevoWizard from "./pages/RevoWizard";
import BdpWizard from "./pages/BdpWizard";
import IcgWizard from "./pages/IcgWizard";
import HioposWizard from "./pages/HioposWizard";
import TouchBistroWizard from "./pages/TouchBistroWizard";
import ToastWizard from "./pages/ToastWizard";
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
            <Route path="/integrations/clover" element={<CloverWizard />} />
            <Route path="/integrations/square" element={<SquareWizard />} />
            <Route path="/integrations/simphony" element={<SimphonyWizard />} />
            <Route path="/integrations/cassa" element={<CassaWizard />} />
            <Route path="/integrations/revo" element={<RevoWizard />} />
            <Route path="/integrations/bdp" element={<BdpWizard />} />
            <Route path="/integrations/icg" element={<IcgWizard />} />
            <Route path="/integrations/hiopos" element={<HioposWizard />} />
            <Route path="/integrations/touchbistro" element={<TouchBistroWizard />} />
            <Route path="/integrations/toast" element={<ToastWizard />} />
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
