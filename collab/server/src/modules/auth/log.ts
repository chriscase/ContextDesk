/**
 * Auth-module logger. Never accepts a password field; callers must not pass
 * credential material. Tests assert emitted lines contain no secrets.
 */
export interface AuthLogEvent {
  event: string;
  username?: string;
  detail?: string;
}

export interface AuthLog {
  event(entry: AuthLogEvent): void;
  lines(): string[];
}

export function createAuthLog(): AuthLog {
  const lines: string[] = [];
  return {
    event(entry: AuthLogEvent): void {
      if ("password" in entry) {
        throw new Error("auth log must never receive a password field");
      }
      const line = JSON.stringify({
        event: entry.event,
        username: entry.username,
        detail: entry.detail,
      });
      lines.push(line);
    },
    lines: () => [...lines],
  };
}
