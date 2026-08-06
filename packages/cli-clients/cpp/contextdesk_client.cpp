// Minimal C++ thin client — posix_spawn / exec argv vector (no system()).
// Direct C ABI / JNI are staged FUTURE options.
// See docs/CLI_CLIENT_PROTOCOL.md.

#include <cstdlib>
#include <iostream>
#include <string>
#include <vector>

#include <sys/wait.h>
#include <unistd.h>

#include "../shared/contextdesk_envelope.h"

static std::string resolve_bin() {
    if (const char *b = std::getenv("CONTEXTDESK_BIN")) {
        if (b[0]) return b;
    }
    return "contextdesk";
}

enum class CompletedVerdict { None, NotReady, NonConforming, Partial };

// Parsed ok:true kinds: not_ready, non_conforming, partial (completed verdicts).
static CompletedVerdict completed_verdict(int exit_code) {
    if (exit_code == 8) return CompletedVerdict::NotReady;
    if (exit_code == 9) return CompletedVerdict::NonConforming;
    if (exit_code == 10) return CompletedVerdict::Partial;
    return CompletedVerdict::None;
}

struct CommandResult {
    std::string envelope;
    int exit_code;
    CompletedVerdict verdict;
};

static CommandResult failure(int code) { return {"", code, CompletedVerdict::None}; }

CommandResult run_json(const std::string &data_dir, const std::vector<std::string> &cmd) {
    std::string bin = resolve_bin();
    std::vector<std::string> storage;
    storage.push_back(bin);
    if (!data_dir.empty()) {
        storage.emplace_back("--data-dir");
        storage.push_back(data_dir);
    }
    storage.emplace_back("--json");
    for (const auto &a : cmd) storage.push_back(a);

    std::vector<char *> argv;
    argv.reserve(storage.size() + 1);
    for (auto &s : storage) argv.push_back(s.data());
    argv.push_back(nullptr);

    int output_pipe[2];
    if (pipe(output_pipe) != 0) {
        std::perror("pipe");
        return failure(70);
    }
    pid_t pid = fork();
    if (pid < 0) {
        close(output_pipe[0]);
        close(output_pipe[1]);
        std::perror("fork");
        return failure(70);
    }
    if (pid == 0) {
        close(output_pipe[0]);
        if (dup2(output_pipe[1], STDOUT_FILENO) < 0) _exit(127);
        close(output_pipe[1]);
        execvp(bin.c_str(), argv.data());
        std::perror("execvp");
        _exit(127);
    }
    close(output_pipe[1]);
    std::string body;
    body.reserve(4096);
    bool oversized = false;
    for (;;) {
        char chunk[4096];
        ssize_t got = read(output_pipe[0], chunk, sizeof(chunk));
        if (got == 0) break;
        if (got < 0) { close(output_pipe[0]); return failure(70); }
        if (body.size() + static_cast<size_t>(got) > CONTEXTDESK_MAX_ENVELOPE_BYTES) oversized = true;
        else body.append(chunk, static_cast<size_t>(got));
    }
    close(output_pipe[0]);
    int status = 0;
    if (waitpid(pid, &status, 0) < 0) {
        std::perror("waitpid");
        return failure(70);
    }
    if (WIFEXITED(status)) {
        int code = WEXITSTATUS(status);
        while (!body.empty() && (body.back() == '\n' || body.back() == '\r' || body.back() == ' ' || body.back() == '\t')) body.pop_back();
        int ok = 0;
        if (oversized || !contextdesk_parse_envelope_ok(body.data(), body.size(), &ok)) {
            std::cerr << "invalid or oversized ContextDesk JSON envelope\n";
            return failure(70);
        }
        CompletedVerdict verdict = completed_verdict(code);
        if (!ok) verdict = CompletedVerdict::None;
        if ((!ok && code == 0) || (ok && code != 0 && verdict == CompletedVerdict::None)) return failure(70);
        return {std::move(body), code, verdict};
    }
    return failure(130);
}

#ifndef CONTEXTDESK_CLIENT_NO_MAIN
int main(int argc, char **argv) {
    std::string data_dir;
    std::vector<std::string> cmd;
    for (int i = 1; i < argc; i++) {
        std::string a = argv[i];
        if (a == "--data-dir" && i + 1 < argc) {
            data_dir = argv[++i];
        } else {
            cmd.emplace_back(std::move(a));
        }
    }
    if (cmd.empty()) cmd.emplace_back("capabilities");
    CommandResult result = run_json(data_dir, cmd);
    if (!result.envelope.empty()) std::cout << result.envelope << '\n';
    return result.exit_code;
}
#endif
