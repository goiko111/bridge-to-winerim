const AGORA_TCP_EGRESS_PORTS = new Set(["8898", "8984", "9984"]);
const AGORA_TCP_EGRESS_PROXY_URL = "https://agora-tcp-egress.internal/forward";
export const AGORA_TCP_EGRESS_TARGET_HEADER = "x-winerim-agora-target-url";

export function shouldUseAgoraTcpEgress(target: URL): boolean {
  return target.protocol === "http:" && AGORA_TCP_EGRESS_PORTS.has(target.port);
}

export function agoraTcpEgressRequiredForHosts(allowedHosts: string): boolean {
  return allowedHosts
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean)
    .some((host) => {
      const match = host.match(/:(\d+)$/);
      return match ? AGORA_TCP_EGRESS_PORTS.has(match[1]) : false;
    });
}

export async function createAgoraTcpEgressProxyRequest(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Request> {
  const source = input instanceof Request ? input : new Request(input, init);
  const target = new URL(source.url);
  if (!shouldUseAgoraTcpEgress(target)) {
    throw new Error("AGORA_TCP_EGRESS_TARGET_INVALID");
  }
  const headers = new Headers();
  for (const name of ["accept", "api-token", "content-type"]) {
    const value = source.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  headers.set(AGORA_TCP_EGRESS_TARGET_HEADER, target.toString());
  return new Request(AGORA_TCP_EGRESS_PROXY_URL, {
    method: source.method,
    headers,
    body: ["GET", "HEAD"].includes(source.method)
      ? undefined
      : await source.arrayBuffer(),
  });
}
