// Minimal Go thin client — os/exec with argv slice (no shell).
// See docs/CLI_CLIENT_PROTOCOL.md.
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

func resolveBin() string {
	if b := os.Getenv("CONTEXTDESK_BIN"); b != "" {
		return b
	}
	return "contextdesk"
}

type CommandResult struct {
	Envelope    map[string]any
	ExitCode    int
	VerdictKind string
}

func completedVerdict(code int) string {
	switch code {
	case 8:
		return "not_ready"
	case 9:
		return "non_conforming"
	case 10:
		return "partial"
	default:
		return ""
	}
}

// RunJSON retains report-bearing completed verdicts (8/9/10) as typed results.
func RunJSON(dataDir string, args ...string) (CommandResult, error) {
	bin := resolveBin()
	argv := make([]string, 0, 4+len(args))
	if dataDir != "" {
		argv = append(argv, "--data-dir", dataDir)
	}
	argv = append(argv, "--json")
	argv = append(argv, args...)

	cmd := exec.Command(bin, argv...) // argv form — never shell
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	code := 0
	if cmd.ProcessState != nil {
		code = cmd.ProcessState.ExitCode()
	}
	text := strings.TrimSpace(stdout.String())
	if text == "" {
		if err != nil {
			return CommandResult{ExitCode: code}, fmt.Errorf("empty stdout: %w (stderr=%s)", err, stderr.String())
		}
		return CommandResult{ExitCode: code}, fmt.Errorf("empty stdout (stderr=%s)", stderr.String())
	}
	// last non-empty line
	lines := strings.Split(text, "\n")
	line := lines[len(lines)-1]
	var envelope map[string]any
	if jerr := json.Unmarshal([]byte(line), &envelope); jerr != nil {
		return CommandResult{ExitCode: code}, fmt.Errorf("json: %w", jerr)
	}
	if ok, _ := envelope["ok"].(bool); !ok {
		return CommandResult{ExitCode: code}, fmt.Errorf("command not ok exit=%d: %v", code, envelope["error"])
	}
	verdict := completedVerdict(code)
	if code != 0 && verdict == "" {
		return CommandResult{ExitCode: code}, fmt.Errorf("ok envelope but exit=%d", code)
	}
	return CommandResult{Envelope: envelope, ExitCode: code, VerdictKind: verdict}, nil
}

func main() {
	dataDir := ""
	args := []string{}
	for i := 1; i < len(os.Args); i++ {
		if os.Args[i] == "--data-dir" && i+1 < len(os.Args) {
			i++
			dataDir = os.Args[i]
			continue
		}
		args = append(args, os.Args[i])
	}
	if len(args) == 0 {
		args = []string{"capabilities"}
	}
	result, err := RunJSON(dataDir, args...)
	if err != nil {
		fmt.Fprintf(os.Stderr, "%v\n", err)
		if result.ExitCode == 0 {
			result.ExitCode = 70
		}
		os.Exit(result.ExitCode)
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	_ = enc.Encode(result.Envelope)
	if result.ExitCode != 0 {
		os.Exit(result.ExitCode)
	}
}
