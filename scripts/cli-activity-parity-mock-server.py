#!/usr/bin/env python3
"""Local OpenAI-compatible mock for scripts/cli-activity-parity-demo.sh."""
import json
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

state = {"fail_once": True}


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        n = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(n)
        try:
            req = json.loads(body.decode() or "{}")
        except Exception:
            req = {}
        messages = req.get("messages") or []
        user_blob = " ".join(
            (m.get("content") or "") if isinstance(m.get("content"), str) else ""
            for m in messages
            if m.get("role") == "user"
        )
        has_tool_role = any(m.get("role") == "tool" for m in messages)
        evidence_blob = " ".join(
            (m.get("content") or "") if isinstance(m.get("content"), str) else ""
            for m in messages
        )
        want_stream = bool(req.get("stream"))

        raw_txt = body.decode(errors="replace")
        # Slow path for exact-head cancel acceptance (SIGINT while provider waits).
        if "slow path" in raw_txt.lower() or "cancel demo" in raw_txt.lower():
            time.sleep(30)
        # Hard failure: every request with this marker fails (no client retry can succeed).
        if "FORCE_FAIL_ALWAYS" in raw_txt:
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(
                b'{"error":{"message":"hard mock failure for failure-path demo"}}'
            )
            return
        # Soft once-failure (client may auto-retry with a second request).
        if "FORCE_FAIL" in raw_txt and state["fail_once"]:
            state["fail_once"] = False
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(
                b'{"error":{"message":"transient mock failure for retry demo"}}'
            )
            return

        offered = [
            tool.get("function", {}).get("name")
            for tool in (req.get("tools") or [])
        ]
        linked_evidence = "source_kind: log_templates" in evidence_blob
        if (not linked_evidence) and "search_logs" in offered and "linked failures" in user_blob:
            args = json.dumps({"query": "payment failed E42", "semantic": False, "k": 5})
            if want_stream:
                delta = {"choices": [{"index": 0, "delta": {"tool_calls": [{
                    "index": 0, "id": "linked_search_1", "type": "function",
                    "function": {"name": "search_logs", "arguments": args}
                }]}}]}
                stop = {"choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}]}
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                self.wfile.write(("data: " + json.dumps(delta) + "\n\n").encode())
                self.wfile.write(("data: " + json.dumps(stop) + "\n\n").encode())
                self.wfile.write(b"data: [DONE]\n\n")
                return
            payload = {
                "id": "chatcmpl-linked-tool",
                "object": "chat.completion",
                "choices": [{
                    "index": 0,
                    "message": {"role": "assistant", "content": None, "tool_calls": [{
                        "id": "linked_search_1", "type": "function",
                        "function": {"name": "search_logs", "arguments": args}
                    }]},
                    "finish_reason": "tool_calls"
                }]
            }
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(payload).encode())
            return

        if (not has_tool_role) and req.get("tools") and "FORCE_TOOL" in user_blob:
            args = json.dumps({"query": "payment failed E42"})
            if want_stream:
                d1 = {
                    "choices": [
                        {
                            "index": 0,
                            "delta": {
                                "tool_calls": [
                                    {
                                        "index": 0,
                                        "id": "call_1",
                                        "type": "function",
                                        "function": {
                                            "name": "search_kb",
                                            "arguments": args,
                                        },
                                    }
                                ]
                            },
                        }
                    ]
                }
                d2 = {
                    "choices": [
                        {"index": 0, "delta": {}, "finish_reason": "tool_calls"}
                    ]
                }
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                self.wfile.write(("data: " + json.dumps(d1) + "\n\n").encode())
                self.wfile.write(("data: " + json.dumps(d2) + "\n\n").encode())
                self.wfile.write(b"data: [DONE]\n\n")
                return
            payload = {
                "id": "chatcmpl-tool",
                "object": "chat.completion",
                "choices": [
                    {
                        "index": 0,
                        "message": {
                            "role": "assistant",
                            "content": None,
                            "tool_calls": [
                                {
                                    "id": "call_1",
                                    "type": "function",
                                    "function": {
                                        "name": "search_kb",
                                        "arguments": args,
                                    },
                                }
                            ],
                        },
                        "finish_reason": "tool_calls",
                    }
                ],
            }
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(payload).encode())
            return

        if linked_evidence:
            match = re.search(r"seq=(\d+) source=([^\s]+)", evidence_blob)
            if not match:
                raise RuntimeError("linked evidence lacked exact seq/source identity")
            text = f"The payment failure is recorded at seq={match.group(1)} source={match.group(2)}."
        else:
            text = "cited answer: payment failed code=E42 [demo]"
        if want_stream:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            self.wfile.write(
                (
                    "data: "
                    + json.dumps(
                        {"choices": [{"delta": {"content": text}, "index": 0}]}
                    )
                    + "\n\n"
                ).encode()
            )
            self.wfile.write(
                b'data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}]}\n\n'
            )
            self.wfile.write(b"data: [DONE]\n\n")
            return
        payload = {
            "id": "chatcmpl-ok",
            "object": "chat.completion",
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": text},
                    "finish_reason": "stop",
                }
            ],
        }
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(payload).encode())


httpd = HTTPServer(("127.0.0.1", 0), H)
port = httpd.server_address[1]
open("PORT", "w").write(str(port))
threading.Thread(target=httpd.serve_forever, daemon=True).start()
while True:
    time.sleep(3600)
