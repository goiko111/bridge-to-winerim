import { CheckCircle2, Clock, XCircle, HelpCircle, ChevronDown, ChevronUp } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";

type CheckStatus = "ok" | "pending" | "error";

interface CheckItem {
  id: string;
  label: string;
  status: CheckStatus;
  helpAsk: string;
  helpDetail: string;
  example: string;
}

interface BdpSetupChecklistProps {
  baseUrl: string;
  port: string;
  userKey: string;
  password: string;
  exportProfileCode: string;
  firewallConfirmed: boolean;
  weblinkConfirmed: boolean;
  testStatus: "idle" | "testing" | "success" | "error";
  testError: string | null;
  onToggleFirewall: () => void;
  onToggleWeblink: () => void;
}

const StatusIcon = ({ status }: { status: CheckStatus }) => {
  if (status === "ok") return <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />;
  if (status === "error") return <XCircle className="h-4 w-4 shrink-0 text-destructive" />;
  return <Clock className="h-4 w-4 shrink-0 text-amber-500" />;
};

const statusLabel = (s: CheckStatus) =>
  s === "ok" ? "Listo" : s === "error" ? "Error" : "Pendiente";

const statusVariant = (s: CheckStatus): "default" | "destructive" | "secondary" =>
  s === "ok" ? "default" : s === "error" ? "destructive" : "secondary";

export default function BdpSetupChecklist({
  baseUrl, port, userKey, password, exportProfileCode,
  firewallConfirmed, weblinkConfirmed,
  testStatus, testError,
  onToggleFirewall, onToggleWeblink,
}: BdpSetupChecklistProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const connTested = testStatus === "success";
  const connFailed = testStatus === "error";

  const checks: CheckItem[] = [
    {
      id: "url",
      label: "Dirección del servidor (URL o DDNS)",
      status: baseUrl.trim() ? "ok" : "pending",
      helpAsk: "¿Cuál es la dirección pública (URL o DDNS) del servidor de BDP?",
      helpDetail:
        "Es la IP, dominio o dirección DDNS desde la que se accede al servicio REST de BDP desde fuera del restaurante. Normalmente la configura el técnico de BDP o el proveedor de internet.",
      example: "http://mirestaurante.ddns.net",
    },
    {
      id: "port",
      label: "Puerto del servicio",
      status: port.trim() ? "ok" : "pending",
      helpAsk: "¿En qué puerto está escuchando el servicio REST de BDP?",
      helpDetail:
        "Suele ser 8080 o 443. Lo puedes ver en BDP NET → Configuración → Servicio Web. Si no lo sabes, pregunta al técnico de BDP.",
      example: "8080",
    },
    {
      id: "credentials",
      label: "Credenciales API (User Key y Password)",
      status: userKey.trim() && password.trim() ? "ok" : "pending",
      helpAsk: "¿Cuáles son las credenciales (User Key y Password) del servicio Weblink?",
      helpDetail:
        "Se crean en BDP NET → Configuración → Servicio Web → Usuarios. Necesitan permisos de lectura para ventas y catálogo, y de escritura si se van a enviar productos.",
      example: "User Key: WINERIM / Password: ••••••",
    },
    {
      id: "export",
      label: "Código de plantilla de exportación",
      status: exportProfileCode.trim() ? "ok" : "pending",
      helpAsk: "¿Cómo se llama la plantilla de exportación configurada en BDP?",
      helpDetail:
        'Está en BDP NET → Configuración → Exportación → Plantillas. Es el nombre que identifica qué datos de venta se exportan. Los nombres habituales son "WEBLINK" o "WINERIM_EXPORT".',
      example: "WINERIM_EXPORT",
    },
    {
      id: "firewall",
      label: "Firewall / puerto abierto desde internet",
      status: firewallConfirmed ? "ok" : "pending",
      helpAsk: "¿Está el puerto del API abierto en el firewall y accesible desde internet?",
      helpDetail:
        "El puerto del servidor BDP debe aceptar conexiones entrantes desde nuestros servidores. Pide al técnico de red que verifique que el puerto está redirigido en el router (NAT) y que ninguna regla de firewall lo bloquea.",
      example: "Puerto 8080 abierto, regla NAT configurada",
    },
    {
      id: "weblink",
      label: "Servicio REST (Weblink) activado en BDP",
      status: weblinkConfirmed ? "ok" : "pending",
      helpAsk: "¿Está el servicio Weblink REST activado y arrancado en BDP?",
      helpDetail:
        "En BDP NET → Configuración → Servicio Web, el toggle del API REST debe estar ON. El servicio debe arrancar automáticamente con el TPV. Si se para, la sincronización dejará de funcionar hasta que se reinicie.",
      example: "Weblink REST API = Habilitado / Auto-arranque = Sí",
    },
    {
      id: "connection_test",
      label: "Test de conexión superado",
      status: connTested ? "ok" : connFailed ? "error" : "pending",
      helpAsk: "Pulsa el botón 'Test Connection' de abajo para verificar la conexión.",
      helpDetail: connFailed && testError
        ? `El último test falló: ${testError}`
        : "Este check se completa automáticamente al pulsar 'Test Connection' y obtener respuesta correcta del servidor BDP.",
      example: "HTTP 200 OK",
    },
  ];

  const doneCount = checks.filter((c) => c.status === "ok").length;
  const hasErrors = checks.some((c) => c.status === "error");

  return (
    <div className="rounded-lg border border-border bg-card">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div className="flex items-center gap-2">
          <HelpCircle className="h-4 w-4 text-primary" />
          <span className="text-sm font-semibold text-foreground">Checklist de conexión</span>
        </div>
        <Badge
          variant={doneCount === checks.length ? "default" : hasErrors ? "destructive" : "secondary"}
          className="text-[10px]"
        >
          {doneCount}/{checks.length} completados
        </Badge>
      </div>

      <p className="px-4 pt-3 pb-1 text-[11px] text-muted-foreground leading-relaxed">
        Usa esta lista para saber qué datos pedir al restaurante. Pulsa cada punto para ver qué preguntar exactamente.
      </p>

      {/* Items */}
      <div className="px-4 pb-4 pt-2 space-y-1">
        {checks.map((item) => {
          const isExpanded = expandedId === item.id;
          const isManualToggle = item.id === "firewall" || item.id === "weblink";

          return (
            <div key={item.id} className="rounded-md border border-border bg-background">
              <button
                onClick={() => setExpandedId(isExpanded ? null : item.id)}
                className="flex w-full items-center gap-3 px-3 py-2.5 text-left"
              >
                <StatusIcon status={item.status} />
                <span className="flex-1 text-xs font-medium text-foreground">{item.label}</span>
                <Badge variant={statusVariant(item.status)} className="text-[9px] px-1.5 py-0">
                  {statusLabel(item.status)}
                </Badge>
                {isExpanded ? (
                  <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                )}
              </button>

              {isExpanded && (
                <div className="border-t border-border px-3 pb-3 pt-2 space-y-2">
                  <p className="text-[11px] text-primary font-medium italic">"{item.helpAsk}"</p>
                  <p className="text-[11px] text-muted-foreground leading-relaxed">{item.helpDetail}</p>
                  <p className="text-[10px] text-muted-foreground/70 font-mono">Ejemplo: {item.example}</p>

                  {isManualToggle && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        item.id === "firewall" ? onToggleFirewall() : onToggleWeblink();
                      }}
                      className="mt-1 text-[11px] font-medium text-primary hover:underline"
                    >
                      {item.status === "ok" ? "✓ Confirmado — pulsa para desmarcar" : "Pulsa aquí para confirmar este punto"}
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Summary */}
      {doneCount === checks.length && (
        <div className="mx-4 mb-4 rounded-md bg-emerald-500/10 border border-emerald-500/30 px-3 py-2 flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4 text-emerald-500" />
          <span className="text-xs font-medium text-emerald-700 dark:text-emerald-400">
            ¡Todo listo! La conexión está completamente configurada.
          </span>
        </div>
      )}
    </div>
  );
}
