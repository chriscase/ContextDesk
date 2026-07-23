#!/usr/bin/env python3
"""Hermetic Jira-shaped MCP fixture for #291 permission and secret wiring tests."""

import json
import os
import sys


TOOLS = [
    ("getJiraIssue", "Read a Jira issue"),
    ("searchJiraIssuesUsingJql", "Search Jira issues"),
    ("createJiraIssue", "Create a Jira issue"),
    ("editJiraIssue", "Edit a Jira issue"),
]


def write(message):
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def main():
    for line in sys.stdin:
        try:
            message = json.loads(line)
        except (json.JSONDecodeError, TypeError):
            continue
        request_id = message.get("id")
        method = message.get("method", "")
        if method == "initialize":
            write(
                {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "result": {
                        "protocolVersion": "2024-11-05",
                        "capabilities": {"tools": {}},
                        "serverInfo": {"name": "jira-fixture", "version": "0.0.1"},
                    },
                }
            )
        elif method == "notifications/initialized":
            continue
        elif method == "tools/list":
            write(
                {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "result": {
                        "tools": [
                            {
                                "name": name,
                                "description": description,
                                "inputSchema": {
                                    "type": "object",
                                    "additionalProperties": True,
                                },
                            }
                            for name, description in TOOLS
                        ]
                    },
                }
            )
        elif method == "tools/call":
            params = message.get("params") or {}
            tool_name = params.get("name", "")
            arguments = params.get("arguments") or {}
            auth = os.environ.get("CONTEXTDESK_ATLASSIAN_AUTH_HEADER", "")
            if not (auth.startswith("Bearer ") or auth.startswith("Basic ")):
                write(
                    {
                        "jsonrpc": "2.0",
                        "id": request_id,
                        "result": {
                            "content": [{"type": "text", "text": "auth missing"}],
                            "isError": True,
                        },
                    }
                )
                continue
            safe_result = {
                "tool": tool_name,
                "auth_present": True,
                "arguments": arguments,
            }
            write(
                {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "result": {
                        "content": [
                            {
                                "type": "text",
                                "text": json.dumps(safe_result, sort_keys=True),
                            }
                        ],
                        "isError": False,
                    },
                }
            )
        elif request_id is not None:
            write(
                {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "error": {"code": -32601, "message": "unknown method"},
                }
            )


if __name__ == "__main__":
    main()
