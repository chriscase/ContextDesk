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

// RunJSON spawns contextdesk --json <args...> and returns the envelope map.
func RunJSON(dataDir string, args ...string) (map[string]any, int, error) {
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
			return nil, code, fmt.Errorf("empty stdout: %w (stderr=%s)", err, stderr.String())
		}
		return nil, code, fmt.Errorf("empty stdout (stderr=%s)", stderr.String())
	}
	// last non-empty line
	lines := strings.Split(text, "\n")
	line := lines[len(lines)-1]
	var envelope map[string]any
	if jerr := json.Unmarshal([]byte(line), &envelope); jerr != nil {
		return nil, code, fmt.Errorf("json: %w", jerr)
	}
	if ok, _ := envelope["ok"].(bool); !ok {
		return envelope, code, fmt.Errorf("command not ok: %v", envelope["error"])
	}
	return envelope, code, nil
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
	env, code, err := RunJSON(dataDir, args...)
	if err != nil {
		fmt.Fprintf(os.Stderr, "%v\n", err)
		if code == 0 {
			code = 70
		}
		os.Exit(code)
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	_ = enc.Encode(env)
}
