export type AgoraOpenTicket = Record<string, unknown> & {
  Lines?: Array<Record<string, unknown>>;
};

function parseXmlAttributes(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of source.matchAll(/([A-Za-z0-9_:-]+)\s*=\s*"([^"]*)"/g)) {
    attrs[match[1]] = match[2];
  }
  return attrs;
}

function openingTag(fragment: string): string {
  const match = fragment.match(/^<[^>]+>/);
  return match ? match[0] : fragment;
}

function parseXmlLineElements(ticketXml: string): Array<Record<string, string>> {
  const lines: Array<Record<string, string>> = [];
  const lineRegex = /<Line\b[^>]*\/>|<Line\b[\s\S]*?<\/Line>/g;
  for (const match of ticketXml.matchAll(lineRegex)) {
    lines.push(parseXmlAttributes(openingTag(match[0])));
  }
  return lines;
}

export function parseAgoraOpenTicketsXml(xml: string): AgoraOpenTicket[] {
  const text = String(xml || "").trim();
  if (!text) return [];

  const tickets: AgoraOpenTicket[] = [];
  const ticketRegex = /<TicketModel\b[\s\S]*?<\/TicketModel>|<Ticket\b[\s\S]*?<\/Ticket>|<TicketModel\b[^>]*\/>|<Ticket\b[^>]*\/>/g;
  for (const match of text.matchAll(ticketRegex)) {
    const fragment = match[0];
    const attrs = parseXmlAttributes(openingTag(fragment));
    if (!Object.keys(attrs).length) continue;
    tickets.push({
      ...attrs,
      Lines: parseXmlLineElements(fragment),
      _rawSourceFormat: "xml",
    });
  }
  return tickets;
}

// deno-lint-ignore no-explicit-any
export function parseOpenTickets(raw: any): AgoraOpenTicket[] {
  if (!raw) return [];
  if (typeof raw === "string") return parseAgoraOpenTicketsXml(raw);
  if (Array.isArray(raw)) return raw;
  if (raw.Tickets && Array.isArray(raw.Tickets)) return raw.Tickets;
  if (raw.Data?.Tickets && Array.isArray(raw.Data.Tickets)) return raw.Data.Tickets;
  for (const key of Object.keys(raw)) {
    if (Array.isArray(raw[key]) && raw[key].length > 0) return raw[key];
  }
  return [];
}

export function countXmlOpenTickets(xml: string): number {
  return parseAgoraOpenTicketsXml(xml).length;
}
