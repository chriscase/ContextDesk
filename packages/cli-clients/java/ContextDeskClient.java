// Minimal Java thin client — ProcessBuilder argv only (no shell).
// Future: JNI / C ABI are staged options, not this path.
// See docs/CLI_CLIENT_PROTOCOL.md.

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

public final class ContextDeskClient {
    private final String bin;
    private final String dataDir;

    public ContextDeskClient(String bin, String dataDir) {
        this.bin = bin != null ? bin : System.getenv().getOrDefault("CONTEXTDESK_BIN", "contextdesk");
        this.dataDir = dataDir;
    }

    /** Run contextdesk with --json; return stdout envelope text. */
    public String runJson(List<String> commandArgs) throws Exception {
        List<String> argv = new ArrayList<>();
        argv.add(bin);
        if (dataDir != null && !dataDir.isEmpty()) {
            argv.add("--data-dir");
            argv.add(dataDir);
        }
        argv.add("--json");
        argv.addAll(commandArgs);

        ProcessBuilder pb = new ProcessBuilder(argv); // argv list — never a shell string
        pb.redirectErrorStream(false);
        Map<String, String> env = pb.environment();
        // inherit parent env; do not inject secrets on argv
        Process p = pb.start();
        StringBuilder out = new StringBuilder();
        try (BufferedReader r = new BufferedReader(
                new InputStreamReader(p.getInputStream(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = r.readLine()) != null) {
                if (out.length() > 0) out.append('\n');
                out.append(line);
            }
        }
        int code = p.waitFor();
        String text = out.toString().trim();
        if (text.isEmpty()) {
            throw new RuntimeException("empty stdout, exit=" + code);
        }
        // Caller parses JSON; we only guarantee spawn + capture.
        if (code != 0 && !text.contains("\"ok\": false") && !text.contains("\"ok\":false")) {
            throw new RuntimeException("exit=" + code + " body=" + text);
        }
        return text;
    }

    public String capabilities() throws Exception {
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
        System.out.println(c.runJson(cmd));
    }
}
