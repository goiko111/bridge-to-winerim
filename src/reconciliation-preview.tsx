import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DailyReconciliationDashboard } from "./features/daily-reconciliation/DailyReconciliationDashboard";

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
ReactDOM.createRoot(document.getElementById("root")!).render(<React.StrictMode><QueryClientProvider client={client}><DailyReconciliationDashboard /></QueryClientProvider></React.StrictMode>);
