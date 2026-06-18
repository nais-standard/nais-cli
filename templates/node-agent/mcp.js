#!/usr/bin/env node
'use strict';

/**
 * {{AGENT_NAME}} — NAIS MCP agent for {{DOMAIN}}.
 *
 * A zero-dependency Node HTTP server (built-in `http`) implementing JSON-RPC 2.0
 * MCP (initialize, tools/list, tools/call). It also serves the signed NAIS card
 * at /.well-known/agent.json.
 *
 *   node mcp.js            # listens on PORT (default 8080)
 *
 * In production, put it behind a reverse proxy that terminates HTTPS for
 * {{DOMAIN}} and forwards /mcp and /.well-known/ to this process.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const AGENT = '{{AGENT_NAME}}';
const DOMAIN = '{{DOMAIN}}';
const MAX_BODY = 64 * 1024;

// Tools — keep in sync with the card's mcpSnapshot (run `nais sign` after edits).
const TOOLS = [
  {
    name: 'ping',
    description: 'Health check. Returns a pong response confirming the agent is reachable.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
];

const ok = (id, result) => JSON.stringify({ jsonrpc: '2.0', id, result });
const err = (id, code, message) => JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });

function callTool(name) {
  switch (name) {
    case 'ping':
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'pong', agent: DOMAIN, timestamp: new Date().toISOString() }) }], isError: false };
    // Add your tools here, and mirror them in TOOLS above + the card's mcpSnapshot.
    default:
      return null;
  }
}

function handleRpc(res, body) {
  res.setHeader('Content-Type', 'application/json');
  let msg;
  try { msg = JSON.parse(body); } catch { res.writeHead(200); return res.end(err(null, -32700, 'Parse error')); }
  if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    res.writeHead(200); return res.end(err(msg && msg.id != null ? msg.id : null, -32600, 'Invalid Request'));
  }
  const id = msg.id != null ? msg.id : null;
  res.writeHead(200);
  switch (msg.method) {
    case 'initialize':
      return res.end(ok(id, {
        protocolVersion: '2024-11-05',
        serverInfo: { name: AGENT, version: '1.0.0' },
        capabilities: { tools: { listChanged: false } },
        instructions: `${AGENT} is a NAIS agent on ${DOMAIN}. Call tools/list to see available tools.`,
      }));
    case 'tools/list':
      return res.end(ok(id, { tools: TOOLS }));
    case 'tools/call': {
      const name = msg.params && msg.params.name;
      const result = callTool(name);
      return result ? res.end(ok(id, result)) : res.end(err(id, -32602, `Unknown tool: ${name}`));
    }
    default:
      return res.end(err(id, -32601, `Method not found: ${msg.method}`));
  }
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const url = req.url.split('?')[0];

  if (req.method === 'GET') {
    if (url === '/' || url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'ok', agent: DOMAIN, mcp: '/mcp' }));
    }
    if (url === '/.well-known/agent.json' || url === '/.well-known/nais-agents.json') {
      const file = path.join(__dirname, url);
      if (fs.existsSync(file)) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(fs.readFileSync(file)); }
      res.writeHead(404); return res.end('Not found');
    }
    res.writeHead(404); return res.end('Not found');
  }

  if (req.method === 'POST' && url === '/mcp') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > MAX_BODY) req.destroy(); });
    req.on('end', () => handleRpc(res, body));
    return;
  }

  res.writeHead(405, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Method Not Allowed' }));
});

server.listen(PORT, () => console.error(`${AGENT} MCP server listening on :${PORT}  (POST /mcp)`));
