const DEFAULT_MIDDLEWARE_API_URL = "http://localhost:8787";

export function getMiddlewareApiUrl(): string {
  const deployedOrigin = typeof window !== "undefined"
    && !["localhost", "127.0.0.1"].includes(window.location.hostname)
    ? window.location.origin
    : DEFAULT_MIDDLEWARE_API_URL;
  return String(import.meta.env.VITE_MIDDLEWARE_API_URL || deployedOrigin).replace(/\/+$/, "");
}

export async function middlewareApiGet<TResponse>(path: string): Promise<TResponse> {
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  const res = await fetch(`${getMiddlewareApiUrl()}${cleanPath}`, {
    method: "GET",
    credentials: "include",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = typeof data?.error === "string" ? data.error : `HTTP ${res.status}`;
    throw Object.assign(new Error(message), { status: res.status, data });
  }
  return data as TResponse;
}

export async function middlewareApiPost<TResponse>(path: string, body: unknown): Promise<TResponse> {
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  const res = await fetch(`${getMiddlewareApiUrl()}${cleanPath}`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = typeof data?.error === "string" ? data.error : `HTTP ${res.status}`;
    throw Object.assign(new Error(message), { status: res.status, data });
  }
  return data as TResponse;
}
