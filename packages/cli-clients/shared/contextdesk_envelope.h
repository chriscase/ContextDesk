#ifndef CONTEXTDESK_ENVELOPE_H
#define CONTEXTDESK_ENVELOPE_H

/* Dependency-free, bounded JSON envelope reader shared by the C and C++
 * subprocess examples. It validates the complete JSON value and reads only
 * the top-level literal `ok` key. Escaped spellings of protocol keys are
 * deliberately not aliases, so misleading nested/string content cannot win. */

#include <ctype.h>
#include <stddef.h>
#include <string.h>

#define CONTEXTDESK_MAX_ENVELOPE_BYTES (1024u * 1024u)
#define CONTEXTDESK_MAX_JSON_DEPTH 64u

typedef struct {
    const char *p;
    const char *end;
    unsigned depth;
} contextdesk_json_cursor;

static void contextdesk_ws(contextdesk_json_cursor *c) {
    while (c->p < c->end && (*c->p == ' ' || *c->p == '\t' || *c->p == '\r' || *c->p == '\n')) c->p++;
}

static int contextdesk_hex(char ch) {
    return (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F');
}

static int contextdesk_string(contextdesk_json_cursor *c, int *is_ok_key) {
    if (c->p == c->end || *c->p++ != '"') return 0;
    const char *start = c->p;
    int escaped = 0;
    while (c->p < c->end) {
        unsigned char ch = (unsigned char)*c->p++;
        if (ch == '"') {
            size_t n = (size_t)((c->p - 1) - start);
            if (is_ok_key) *is_ok_key = !escaped && n == 2 && start[0] == 'o' && start[1] == 'k';
            return 1;
        }
        if (ch < 0x20) return 0;
        if (ch == '\\') {
            escaped = 1;
            if (c->p == c->end) return 0;
            char esc = *c->p++;
            if (strchr("\"\\/bfnrt", esc)) continue;
            if (esc != 'u' || c->end - c->p < 4) return 0;
            for (int i = 0; i < 4; i++) if (!contextdesk_hex(*c->p++)) return 0;
        }
    }
    return 0;
}

static int contextdesk_value(contextdesk_json_cursor *c);

static int contextdesk_compound(contextdesk_json_cursor *c, char open, char close) {
    if (c->depth++ >= CONTEXTDESK_MAX_JSON_DEPTH || c->p == c->end || *c->p++ != open) return 0;
    contextdesk_ws(c);
    if (c->p < c->end && *c->p == close) { c->p++; c->depth--; return 1; }
    for (;;) {
        if (open == '{') {
            if (!contextdesk_string(c, NULL)) return 0;
            contextdesk_ws(c);
            if (c->p == c->end || *c->p++ != ':') return 0;
            contextdesk_ws(c);
        }
        if (!contextdesk_value(c)) return 0;
        contextdesk_ws(c);
        if (c->p < c->end && *c->p == close) { c->p++; c->depth--; return 1; }
        if (c->p == c->end || *c->p++ != ',') return 0;
        contextdesk_ws(c);
    }
}

static int contextdesk_number(contextdesk_json_cursor *c) {
    const char *p = c->p;
    if (p < c->end && *p == '-') p++;
    if (p == c->end) return 0;
    if (*p == '0') p++;
    else {
        if (*p < '1' || *p > '9') return 0;
        while (p < c->end && isdigit((unsigned char)*p)) p++;
    }
    if (p < c->end && *p == '.') {
        p++;
        if (p == c->end || !isdigit((unsigned char)*p)) return 0;
        while (p < c->end && isdigit((unsigned char)*p)) p++;
    }
    if (p < c->end && (*p == 'e' || *p == 'E')) {
        p++;
        if (p < c->end && (*p == '+' || *p == '-')) p++;
        if (p == c->end || !isdigit((unsigned char)*p)) return 0;
        while (p < c->end && isdigit((unsigned char)*p)) p++;
    }
    c->p = p;
    return 1;
}

static int contextdesk_literal(contextdesk_json_cursor *c, const char *literal) {
    size_t n = strlen(literal);
    if ((size_t)(c->end - c->p) < n || memcmp(c->p, literal, n) != 0) return 0;
    c->p += n;
    return 1;
}

static int contextdesk_value(contextdesk_json_cursor *c) {
    contextdesk_ws(c);
    if (c->p == c->end) return 0;
    if (*c->p == '"') return contextdesk_string(c, NULL);
    if (*c->p == '{') return contextdesk_compound(c, '{', '}');
    if (*c->p == '[') return contextdesk_compound(c, '[', ']');
    if (*c->p == 't') return contextdesk_literal(c, "true");
    if (*c->p == 'f') return contextdesk_literal(c, "false");
    if (*c->p == 'n') return contextdesk_literal(c, "null");
    return contextdesk_number(c);
}

static int contextdesk_parse_envelope_ok(const char *json, size_t len, int *ok) {
    contextdesk_json_cursor c = {json, json + len, 0};
    int found = 0;
    contextdesk_ws(&c);
    if (c.p == c.end || *c.p++ != '{') return 0;
    contextdesk_ws(&c);
    if (c.p < c.end && *c.p == '}') return 0;
    for (;;) {
        int is_ok = 0;
        if (!contextdesk_string(&c, &is_ok)) return 0;
        contextdesk_ws(&c);
        if (c.p == c.end || *c.p++ != ':') return 0;
        contextdesk_ws(&c);
        if (is_ok) {
            if (found || c.p == c.end) return 0;
            if (contextdesk_literal(&c, "true")) *ok = 1;
            else if (contextdesk_literal(&c, "false")) *ok = 0;
            else return 0;
            found = 1;
        } else if (!contextdesk_value(&c)) return 0;
        contextdesk_ws(&c);
        if (c.p < c.end && *c.p == '}') { c.p++; break; }
        if (c.p == c.end || *c.p++ != ',') return 0;
        contextdesk_ws(&c);
    }
    contextdesk_ws(&c);
    return found && c.p == c.end;
}

#endif
