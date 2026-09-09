import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import type { Session } from "@supabase/supabase-js";

const ACCESS_EMAIL = "acceso@winerim.app";

export default function AuthGate({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const { error } = await supabase.auth.signInWithPassword({
      email: ACCESS_EMAIL,
      password,
    });
    if (error) setError("Contraseña incorrecta");
    setLoading(false);
  };

  if (!ready) return null;

  if (!session) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-background p-6">
        <Card className="w-full max-w-sm p-8 space-y-6">
          <div className="space-y-2 text-center">
            <h1 className="text-2xl font-semibold tracking-tight">Winerim Connect Hub</h1>
            <p className="text-sm text-muted-foreground">Introduce la contraseña de acceso</p>
          </div>
          <form onSubmit={submit} className="space-y-4">
            <Input
              type="password"
              autoFocus
              placeholder="Contraseña"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-label="Contraseña de acceso"
            />
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" className="w-full" disabled={loading || !password}>
              {loading ? "Entrando…" : "Entrar"}
            </Button>
          </form>
        </Card>
      </main>
    );
  }

  return <>{children}</>;
}
