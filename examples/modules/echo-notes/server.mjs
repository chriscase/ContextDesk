#!/usr/bin/env node
/**
 * Minimal MCP-over-stdio reference server for ContextDesk modules (#138).
 * No npm dependencies — Node 18+ only.
 *
 * Protocol (subset): initialize, tools/list, tools/call.
 * Tools: note_read (Read), note_append (SoftWrite intent — host still classifies).
 *
 * Host policy still applies: this process cannot self-grant HardWrite or secrets.
 */
import { createInterface } from "node:readline";

/** @type {string[]} */
const notes = [];

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function result(id, content) {
  send({
    jsonrpc: "2.0",
    id,
    result: {
      content: [{ type: "text", text: content }],
      isError: false,
    },
  });
}

function errorResult(id, message) {
  send({
    jsonrpc: "2.0",
    id,
    result: {
      content: [{ type: "text", text: message }],
      isError: true,
    },
  });
}

const TOOLS = [
  {
    name: "note_read",
    description: "Read the in-memory note buffer",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "note_append",
    description: "Append one line to the in-memory note buffer",
    inputSchema: {
      type: "object",
      properties: {
        line: { type: "string", description: "Line to append" },
      },
      required: ["line"],
      additionalProperties: false,
    },
  },
];

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", (line) => {
  const raw = line.trim();
  if (!raw) return;
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  const { id, method, params } = msg;
  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "echo-notes", version: "0.1.0" },
      },
    });
    return;
  }
  if (method === "notifications/initialized") {
    return;
  }
  if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    return;
  }
  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments ?? {};
    if (name === "note_read") {
      result(id, notes.length ? notes.join("\n") : "(empty)");
      return;
    }
    if (name === "note_append") {
      const lineText = String(args.line ?? "").trim();
      if (!lineText) {
        errorResult(id, "line is required");
        return;
      }
      notes.push(lineText);
      result(id, `appended (${notes.length} lines)`);
      return;
    }
    errorResult(id, `unknown tool: ${name}`);
    return;
  }
  if (id !== undefined) {
    send({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    });
  }
});
