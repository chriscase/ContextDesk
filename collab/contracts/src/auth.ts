import { CAPABILITIES, type Capability } from "./capability.js";
import { checkObject, f, type ObjectShape } from "./parse.js";

export const APP_ROLES = ["viewer", "contributor", "case-lead", "admin"] as const;
export type AppRole = (typeof APP_ROLES)[number];

export const SESSION_SCHEMA_ID = "cd-collab.session.v1" as const;

export interface IdentityV1 {
  id: string;
  username: string;
  displayName: string;
}

export interface SessionResponseV1 {
  schemaId: typeof SESSION_SCHEMA_ID;
  identity: IdentityV1;
  roles: AppRole[];
  /** Usable capabilities for this session, resolved fresh (never cached). */
  capabilities: Capability[];
}

const identityShape: ObjectShape = {
  id: f.req(f.str),
  username: f.req(f.str),
  displayName: f.req(f.str),
};

const sessionShape: ObjectShape = {
  schemaId: f.req(f.en(SESSION_SCHEMA_ID)),
  identity: f.req(f.obj(identityShape)),
  roles: f.req(f.arr(f.en(...APP_ROLES))),
  capabilities: f.req(
    f.arr(
      f.en(...CAPABILITIES),
    ),
  ),
};

export function parseSessionResponse(raw: unknown): SessionResponseV1 {
  checkObject("$", sessionShape, raw);
  return raw as SessionResponseV1;
}

export const AUTH_ERROR_SCHEMA_ID = "cd-collab.auth_error.v1" as const;

export type AuthErrorCode =
  | "invalid_credentials"
  | "access_denied"
  | "rate_limited"
  | "unauthenticated"
  | "forbidden"
  | "unavailable";

export interface AuthErrorV1 {
  schemaId: typeof AUTH_ERROR_SCHEMA_ID;
  error: AuthErrorCode;
}

const authErrorShape: ObjectShape = {
  schemaId: f.req(f.en(AUTH_ERROR_SCHEMA_ID)),
  error: f.req(
    f.en(
      "invalid_credentials",
      "access_denied",
      "rate_limited",
      "unauthenticated",
      "forbidden",
      "unavailable",
    ),
  ),
};

export function parseAuthError(raw: unknown): AuthErrorV1 {
  checkObject("$", authErrorShape, raw);
  return raw as AuthErrorV1;
}
