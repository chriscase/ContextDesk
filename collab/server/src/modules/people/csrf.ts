/**
 * Compatibility re-export of the canonical browser-mutation CSRF helper.
 * Enforcement lives in `auth/csrf.ts` (app-wide onRequest hook). People
 * mutation routes may still consult `hasCsrfHeader` as defense in depth.
 */
export {
  CSRF_HEADER,
  CSRF_HEADER_VALUE,
  hasCsrfHeader,
} from "../auth/index.js";
