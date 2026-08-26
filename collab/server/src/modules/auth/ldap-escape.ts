/**
 * LDAP string escaping. Filter (RFC 4515) and DN (RFC 4514) are not interchangeable.
 */

function hexEscape(ch: string): string {
  return `\\${ch.charCodeAt(0).toString(16).padStart(2, "0")}`;
}

/** RFC 4515 assertion-value escaping for search filters. */
export function escapeFilter(value: string): string {
  return value.replace(/[\\*()\0]/g, (ch) => hexEscape(ch));
}

/**
 * RFC 4514 distinguished-name attribute-value escaping.
 * Must not be used as a substitute for {@link escapeFilter}.
 *
 * Escapes `, + " \ < > ; =`, NUL, a leading `#` or space, and a trailing space.
 */
export function escapeDn(value: string): string {
  if (value.length === 0) return value;
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i] ?? "";
    const code = ch.charCodeAt(0);
    const first = i === 0;
    const last = i === value.length - 1;
    if (
      ch === "," ||
      ch === "+" ||
      ch === '"' ||
      ch === "\\" ||
      ch === "<" ||
      ch === ">" ||
      ch === ";" ||
      ch === "=" ||
      code === 0 ||
      (first && (ch === " " || ch === "#")) ||
      (last && ch === " ")
    ) {
      out += hexEscape(ch);
    } else {
      out += ch;
    }
  }
  return out;
}

export function interpolate(template: string, vars: Record<string, string>): string {
  let out = template;
  for (const [key, value] of Object.entries(vars)) {
    out = out.replaceAll(`{${key}}`, value);
  }
  if (vars.username !== undefined) {
    out = out.replaceAll("{0}", vars.username);
  }
  return out;
}
