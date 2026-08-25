/**
 * Minimal RFC 4515 matcher for the filters this adapter generates.
 * Not a general LDAP filter engine.
 */
function unescapeAssertion(value: string): string {
  return value.replace(/\\([0-9A-Fa-f]{2})/g, (_match, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

function attributeOf(entry: Record<string, unknown>, name: string): string[] {
  const needle = name.toLowerCase();
  if (needle === "dn" || needle === "entrydn") {
    const dn = typeof entry.dn === "string" ? entry.dn : "";
    return dn ? [dn] : [];
  }
  for (const [key, value] of Object.entries(entry)) {
    if (key.toLowerCase() !== needle) continue;
    const values = Array.isArray(value) ? value : [value];
    return values
      .map((item) => (typeof item === "string" ? item : Buffer.isBuffer(item) ? item.toString("utf8") : ""))
      .filter((item) => item.length > 0);
  }
  return [];
}

interface ParsedFilter {
  kind: "and" | "or" | "present" | "equals" | "prefix";
  children?: ParsedFilter[];
  attribute?: string;
  value?: string;
}

function parseFilter(raw: string, start = 0): { filter: ParsedFilter; next: number } {
  if (raw[start] !== "(") throw new Error("unsupported LDAP filter");
  let cursor = start + 1;
  if (raw[cursor] === "&" || raw[cursor] === "|") {
    const kind = raw[cursor] === "&" ? "and" : "or";
    cursor += 1;
    const children: ParsedFilter[] = [];
    while (raw[cursor] === "(") {
      const child = parseFilter(raw, cursor);
      children.push(child.filter);
      cursor = child.next;
    }
    if (raw[cursor] !== ")" || children.length < 1) throw new Error("unsupported LDAP filter");
    return { filter: { kind, children }, next: cursor + 1 };
  }
  const close = raw.indexOf(")", cursor);
  if (close < 0) throw new Error("unsupported LDAP filter");
  const body = raw.slice(cursor, close);
  const equals = body.indexOf("=");
  if (equals < 1) throw new Error("unsupported LDAP filter");
  const attribute = body.slice(0, equals);
  const value = body.slice(equals + 1);
  if (value === "*") {
    return { filter: { kind: "present", attribute }, next: close + 1 };
  }
  if (value.endsWith("*") && !value.slice(0, -1).includes("*")) {
    return {
      filter: { kind: "prefix", attribute, value: unescapeAssertion(value.slice(0, -1)) },
      next: close + 1,
    };
  }
  return {
    filter: { kind: "equals", attribute, value: unescapeAssertion(value) },
    next: close + 1,
  };
}

function matchParsed(entry: Record<string, unknown>, filter: ParsedFilter): boolean {
  if (filter.kind === "and") {
    return (filter.children ?? []).every((child) => matchParsed(entry, child));
  }
  if (filter.kind === "or") {
    return (filter.children ?? []).some((child) => matchParsed(entry, child));
  }
  const values = attributeOf(entry, filter.attribute ?? "");
  if (filter.kind === "present") return values.length > 0;
  if (filter.kind === "prefix") {
    const prefix = (filter.value ?? "").toLowerCase();
    return values.some((value) => value.toLowerCase().startsWith(prefix));
  }
  const expected = (filter.value ?? "").toLowerCase();
  return values.some((value) => value.toLowerCase() === expected);
}

export function matchLdapFilter(entry: Record<string, unknown>, filter: string): boolean {
  const parsed = parseFilter(filter, 0);
  if (parsed.next !== filter.length) throw new Error("unsupported LDAP filter");
  return matchParsed(entry, parsed.filter);
}

export function underBase(dn: string, base: string): boolean {
  const haystack = dn.toLowerCase();
  const needle = base.toLowerCase();
  return haystack === needle || haystack.endsWith(`,${needle}`);
}
