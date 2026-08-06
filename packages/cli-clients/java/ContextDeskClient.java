// Minimal Java thin client — ProcessBuilder argv only (no shell).
// Future: JNI / C ABI are staged options, not this path.
// See docs/CLI_CLIENT_PROTOCOL.md.

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

public final class ContextDeskClient {
    private static final int MAX_ENVELOPE_BYTES = 1024 * 1024;
    public record CommandResult(String envelope, int exitCode, String verdictKind) {}

    private static String completedVerdict(int code) {
        return switch (code) {
            case 8 -> "not_ready";
            case 9 -> "non_conforming";
            case 10 -> "partial";
            default -> null;
        };
    }
    private final String bin;
    private final String dataDir;

    public ContextDeskClient(String bin, String dataDir) {
        this.bin = bin != null ? bin : System.getenv().getOrDefault("CONTEXTDESK_BIN", "contextdesk");
        this.dataDir = dataDir;
    }

    /** Run contextdesk with --json; return stdout envelope text. */
    public CommandResult runJson(List<String> commandArgs) throws Exception {
        List<String> argv = new ArrayList<>();
        argv.add(bin);
        if (dataDir != null && !dataDir.isEmpty()) {
            argv.add("--data-dir");
            argv.add(dataDir);
        }
        argv.add("--json");
        argv.addAll(commandArgs);

        ProcessBuilder pb = new ProcessBuilder(argv); // argv list — never a shell string
        pb.redirectError(ProcessBuilder.Redirect.INHERIT);
        Map<String, String> env = pb.environment();
        // inherit parent env; do not inject secrets on argv
        Process p = pb.start();
        byte[] bytes = readBounded(p.getInputStream());
        int code = p.waitFor();
        if (bytes == null) throw new RuntimeException("oversized JSON envelope, exit=" + code);
        String text = new String(bytes, StandardCharsets.UTF_8).trim();
        if (text.isEmpty()) {
            throw new RuntimeException("empty stdout, exit=" + code);
        }
        boolean ok = JsonEnvelope.parseOk(text);
        String verdict = completedVerdict(code);
        if (code != 0 && ok && verdict == null) {
            throw new RuntimeException("exit=" + code + " body=" + text);
        }
        if (!ok) throw new RuntimeException("command error exit=" + code + " body=" + text);
        return new CommandResult(text, code, verdict);
    }

    private static byte[] readBounded(InputStream input) throws Exception {
        ByteArrayOutputStream kept = new ByteArrayOutputStream();
        byte[] chunk = new byte[4096];
        boolean oversized = false;
        for (int n; (n = input.read(chunk)) != -1;) {
            if (kept.size() + n > MAX_ENVELOPE_BYTES) oversized = true;
            else if (!oversized) kept.write(chunk, 0, n);
        }
        return oversized ? null : kept.toByteArray();
    }

    /** Small complete JSON tokenizer: bounded input, bounded depth, top-level boolean `ok`. */
    private static final class JsonEnvelope {
        private final String text;
        private int at;
        private int depth;

        private JsonEnvelope(String text) { this.text = text; }

        static boolean parseOk(String text) {
            JsonEnvelope j = new JsonEnvelope(text);
            j.ws();
            j.expect('{');
            j.ws();
            Boolean ok = null;
            if (j.take('}')) throw new IllegalArgumentException("missing top-level ok");
            for (;;) {
                String key = j.string();
                j.ws(); j.expect(':'); j.ws();
                if (key.equals("ok")) {
                    if (ok != null) throw new IllegalArgumentException("duplicate top-level ok");
                    if (j.literal("true")) ok = true;
                    else if (j.literal("false")) ok = false;
                    else throw new IllegalArgumentException("top-level ok is not boolean");
                } else j.value();
                j.ws();
                if (j.take('}')) break;
                j.expect(','); j.ws();
            }
            j.ws();
            if (j.at != text.length() || ok == null) throw new IllegalArgumentException("invalid envelope");
            return ok;
        }

        private void value() {
            ws();
            if (at >= text.length()) throw new IllegalArgumentException("missing value");
            char ch = text.charAt(at);
            if (ch == '"') { string(); return; }
            if (ch == '{') { compound('{', '}'); return; }
            if (ch == '[') { compound('[', ']'); return; }
            if (literal("true") || literal("false") || literal("null")) return;
            number();
        }

        private void compound(char open, char close) {
            if (++depth > 64) throw new IllegalArgumentException("JSON too deep");
            expect(open); ws();
            if (take(close)) { depth--; return; }
            for (;;) {
                if (open == '{') { string(); ws(); expect(':'); ws(); }
                value(); ws();
                if (take(close)) { depth--; return; }
                expect(','); ws();
            }
        }

        private String string() {
            expect('"');
            StringBuilder out = new StringBuilder();
            while (at < text.length()) {
                char ch = text.charAt(at++);
                if (ch == '"') return out.toString();
                if (ch < 0x20) throw new IllegalArgumentException("control in string");
                if (ch != '\\') { out.append(ch); continue; }
                if (at >= text.length()) throw new IllegalArgumentException("bad escape");
                char esc = text.charAt(at++);
                switch (esc) {
                    case '"', '\\', '/' -> out.append(esc);
                    case 'b' -> out.append('\b'); case 'f' -> out.append('\f');
                    case 'n' -> out.append('\n'); case 'r' -> out.append('\r'); case 't' -> out.append('\t');
                    case 'u' -> {
                        if (at + 4 > text.length()) throw new IllegalArgumentException("bad unicode escape");
                        try { out.append((char)Integer.parseInt(text.substring(at, at + 4), 16)); }
                        catch (NumberFormatException e) { throw new IllegalArgumentException("bad unicode escape"); }
                        at += 4;
                    }
                    default -> throw new IllegalArgumentException("bad escape");
                }
            }
            throw new IllegalArgumentException("unterminated string");
        }

        private void number() {
            int start = at;
            take('-');
            if (take('0')) { }
            else { if (!digit19()) throw new IllegalArgumentException("bad number"); while (digit()) at++; }
            if (take('.')) { if (!digit()) throw new IllegalArgumentException("bad number"); while (digit()) at++; }
            if (take('e') || take('E')) { if (!take('+')) take('-'); if (!digit()) throw new IllegalArgumentException("bad number"); while (digit()) at++; }
            if (at == start) throw new IllegalArgumentException("bad number");
        }

        private boolean digit() { return at < text.length() && text.charAt(at) >= '0' && text.charAt(at) <= '9'; }
        private boolean digit19() { if (at < text.length() && text.charAt(at) >= '1' && text.charAt(at) <= '9') { at++; return true; } return false; }
        private boolean literal(String value) { if (text.startsWith(value, at)) { at += value.length(); return true; } return false; }
        private boolean take(char ch) { if (at < text.length() && text.charAt(at) == ch) { at++; return true; } return false; }
        private void expect(char ch) { if (!take(ch)) throw new IllegalArgumentException("expected " + ch); }
        private void ws() { while (at < text.length() && " \t\r\n".indexOf(text.charAt(at)) >= 0) at++; }
    }

    public CommandResult capabilities() throws Exception {
        List<String> args = new ArrayList<>();
        args.add("capabilities");
        return runJson(args);
    }

    public static void main(String[] args) throws Exception {
        String dataDir = null;
        List<String> cmd = new ArrayList<>();
        for (int i = 0; i < args.length; i++) {
            if ("--data-dir".equals(args[i]) && i + 1 < args.length) {
                dataDir = args[++i];
            } else {
                cmd.add(args[i]);
            }
        }
        if (cmd.isEmpty()) {
            cmd.add("capabilities");
        }
        ContextDeskClient c = new ContextDeskClient(null, dataDir);
        CommandResult result = c.runJson(cmd);
        System.out.println(result.envelope());
        if (result.exitCode() != 0) System.exit(result.exitCode());
    }
}
