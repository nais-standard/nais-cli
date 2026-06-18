# {{AGENT_NAME}}

A NAIS-compliant agent running on `{{DOMAIN}}`.

Generated with [nais-cli](https://github.com/nais-standard/nais-cli). Zero
dependencies — runs on Node's built-in `http`.

## Files

```
{{DOMAIN}}/
├── .well-known/
│   └── agent.json     # Signed NAIS 1.0 card (written by nais-cli)
├── mcp.js             # MCP server + card host (JSON-RPC 2.0 over HTTP)
├── package.json       # `npm start` → node mcp.js
├── dns.txt            # DNS record (k= filled in by nais-cli)
├── test.sh            # Local test commands
└── README.md          # This file
```

## Run

```bash
node mcp.js            # or: npm start   (listens on PORT, default 8080)
./test.sh              # exercise the card + MCP endpoint locally
```

`mcp.js` serves both the signed card (`/.well-known/agent.json`) and the MCP
endpoint (`POST /mcp`). In production, put it behind a reverse proxy that
terminates HTTPS for `{{DOMAIN}}`.

## Deploy

1. Serve this app over HTTPS at `https://{{DOMAIN}}/` (reverse-proxy `/mcp` and
   `/.well-known/` to `node mcp.js`, or host the static `.well-known/` and proxy
   `/mcp`).
2. Publish the DNS record from `dns.txt`:

   | Type | Host | Value |
   |------|------|-------|
   | TXT | `_agent.{{DOMAIN}}` | `v=nais1; manifest=https://{{DOMAIN}}/.well-known/agent.json; k=ed25519:…` |

   ```bash
   dig +short TXT _agent.{{DOMAIN}}
   ```

## Add a tool

1. In `mcp.js`: add an entry to `TOOLS` (name, description, `inputSchema`) and a
   `case` in `callTool()`.
2. Mirror the same tool in the card's `mcpSnapshot.tools` (in `.well-known/agent.json`).
3. Re-sign so the card's `mcpSnapshot` matches your live tools:

   ```bash
   nais sign        # run in this directory
   ```

## Signing

This agent's card is signed with an Ed25519 key created by nais-cli and stored
in `tools/signing-key.json` — **keep it offline; never commit it** (it's
gitignored). Its public fingerprint is the `k=` value in your DNS record;
clients verify the card's signature against it.

## Validate

Once the DNS record is live, verify the agent end-to-end (DNS + signature):

```bash
nais verify {{DOMAIN}}
```

Or resolve with any NAIS client (e.g. `@nais-standard/mcp`), or in a browser at
https://nais.id/validate.

## Requirements

- Node.js 16+ (to run `mcp.js`)
- HTTPS in production (required by NAIS)
