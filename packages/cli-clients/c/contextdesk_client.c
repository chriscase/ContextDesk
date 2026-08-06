/* Minimal C thin client — execvp argv array only (no system()).
 * Direct C ABI into cd-core is a staged FUTURE option, not this path.
 * See docs/CLI_CLIENT_PROTOCOL.md.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/wait.h>
#include "../shared/contextdesk_envelope.h"

static const char *resolve_bin(void) {
    const char *b = getenv("CONTEXTDESK_BIN");
    return (b && b[0]) ? b : "contextdesk";
}

typedef enum {
    CONTEXTDESK_NO_VERDICT = 0,
    CONTEXTDESK_NOT_READY,
    CONTEXTDESK_NON_CONFORMING,
    CONTEXTDESK_PARTIAL
} contextdesk_verdict;

/* Use only after parsing an ok:true envelope. Stable kinds are not_ready,
 * non_conforming, and partial: report-bearing verdicts, never internal. */
contextdesk_verdict contextdesk_completed_verdict(int exit_code) {
    if (exit_code == 8) return CONTEXTDESK_NOT_READY;
    if (exit_code == 9) return CONTEXTDESK_NON_CONFORMING;
    if (exit_code == 10) return CONTEXTDESK_PARTIAL;
    return CONTEXTDESK_NO_VERDICT;
}

/* argv: ["capabilities"] etc. Parses and prints one bounded envelope. */
int contextdesk_run_json(const char *data_dir, char *const cmd_args[], int cmd_argc) {
    const char *bin = resolve_bin();
    /* max 64 argv slots */
    char *argv[64];
    int n = 0;
    argv[n++] = (char *)bin;
    if (data_dir && data_dir[0]) {
        argv[n++] = "--data-dir";
        argv[n++] = (char *)data_dir;
    }
    argv[n++] = "--json";
    for (int i = 0; i < cmd_argc && n < 62; i++) {
        argv[n++] = cmd_args[i];
    }
    argv[n] = NULL;

    int output_pipe[2];
    if (pipe(output_pipe) != 0) {
        perror("pipe");
        return 70;
    }
    pid_t pid = fork();
    if (pid < 0) {
        close(output_pipe[0]);
        close(output_pipe[1]);
        perror("fork");
        return 70;
    }
    if (pid == 0) {
        close(output_pipe[0]);
        if (dup2(output_pipe[1], STDOUT_FILENO) < 0) _exit(127);
        close(output_pipe[1]);
        execvp(bin, argv);
        perror("execvp");
        _exit(127);
    }
    close(output_pipe[1]);
    char *body = (char *)malloc(CONTEXTDESK_MAX_ENVELOPE_BYTES + 1u);
    if (!body) {
        close(output_pipe[0]);
        return 70;
    }
    size_t used = 0;
    int oversized = 0;
    for (;;) {
        char chunk[4096];
        ssize_t got = read(output_pipe[0], chunk, sizeof(chunk));
        if (got == 0) break;
        if (got < 0) { free(body); close(output_pipe[0]); return 70; }
        if (used + (size_t)got > CONTEXTDESK_MAX_ENVELOPE_BYTES) oversized = 1;
        else { memcpy(body + used, chunk, (size_t)got); used += (size_t)got; }
    }
    close(output_pipe[0]);
    int status = 0;
    if (waitpid(pid, &status, 0) < 0) {
        perror("waitpid");
        free(body);
        return 70;
    }
    if (WIFEXITED(status)) {
        int code = WEXITSTATUS(status);
        int ok = 0;
        while (used && (body[used - 1] == '\n' || body[used - 1] == '\r' || body[used - 1] == ' ' || body[used - 1] == '\t')) used--;
        if (oversized || !contextdesk_parse_envelope_ok(body, used, &ok)) {
            fputs("invalid or oversized ContextDesk JSON envelope\n", stderr);
            free(body);
            return 70;
        }
        fwrite(body, 1, used, stdout);
        fputc('\n', stdout);
        free(body);
        contextdesk_verdict verdict = contextdesk_completed_verdict(code);
        if (!ok) return code ? code : 70;
        if (code != 0 && verdict == CONTEXTDESK_NO_VERDICT) return 70;
        return code;
    }
    free(body);
    return 130; /* signalled ~ cancelled */
}

int main(int argc, char **argv) {
    const char *data_dir = NULL;
    char *cmd[32];
    int cmd_n = 0;
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--data-dir") == 0 && i + 1 < argc) {
            data_dir = argv[++i];
        } else if (cmd_n < 31) {
            cmd[cmd_n++] = argv[i];
        }
    }
    if (cmd_n == 0) {
        cmd[cmd_n++] = "capabilities";
    }
    cmd[cmd_n] = NULL;
    return contextdesk_run_json(data_dir, cmd, cmd_n);
}
