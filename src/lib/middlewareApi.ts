const DEFAULT_MIDDLEWARE_API_URL = "http://localhost:8787";

export function getMiddlewareApiUrl(): string {
  return String(import.meta.env.VITE_MIDDLEWARE_API_URL || DEFAULT_MIDDLEWARE_API_URL).replace(/\/+$/, "");
}

export async function middlewareApiPost<TResponse>(path: string, body: unknown): Promise<TResponse> {
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  const res = await fetch(`${getMiddlewareApiUrl()}${cleanPath}`, {
    method: "POST",
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
