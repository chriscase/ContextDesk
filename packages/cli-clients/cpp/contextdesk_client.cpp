// Minimal C++ thin client — posix_spawn / exec argv vector (no system()).
// Direct C ABI / JNI are staged FUTURE options.
// See docs/CLI_CLIENT_PROTOCOL.md.

#include <cstdlib>
#include <iostream>
#include <string>
#include <vector>

#include <sys/wait.h>
#include <unistd.h>

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

int run_json(const std::string &data_dir, const std::vector<std::string> &cmd) {
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

    pid_t pid = fork();
    if (pid < 0) {
        std::perror("fork");
        return 70;
    }
    if (pid == 0) {
        execvp(bin.c_str(), argv.data());
        std::perror("execvp");
        _exit(127);
    }
    int status = 0;
    if (waitpid(pid, &status, 0) < 0) {
        std::perror("waitpid");
        return 70;
    }
    if (WIFEXITED(status)) {
        int code = WEXITSTATUS(status);
        (void)completed_verdict(code); // typed mapping for the JSON parser layer
        return code;
    }
    return 130;
}

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
    return run_json(data_dir, cmd);
}
