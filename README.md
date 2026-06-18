# NAIS CLI

Command-line tool for scaffolding and signing NAIS-compliant agents.

NAIS (Network Agent Identity Standard) lets AI agents use domains as globally
discoverable, **cryptographically verifiable** identities over DNS and HTTPS.
This CLI generates a ready-to-deploy agent — with a **signed** card — from a
single command, and verifies live agents end-to-end using
[`@nais-standard/sdk`](https://www.npmjs.com/package/@nais-standard/sdk) — the
same library NAIS clients use, so what the CLI signs is exactly what they verify.

## Install

```bash
npm install -g @nais-standard/cli
# or, without installing:
npx @nais-standard/cli init-agent myagent.com
```

This installs the `nais` command.

## Usage

```bash
nais init-agent <domain>    # scaffold + generate a signing key + sign the card
nais sign [dir]             # refresh snapshot + re-sign the card in [dir] (default: .)
nais verify <domain>        # resolve a live domain + verify it (DNS + signature)
```

`nais sign` also takes `--tags a,b,c`, `--description <text>`, `--name <name>`,
`--mcp <url>`, and `--no-refresh` — so you can update metadata or refresh the
`mcpSnapshot` from your live MCP server without hand-editing the JSON.

### Example

```bash
nais init-agent myagent.com
```

Generates and **signs** a Node MCP agent:

```
  Created and signed myagent.com/ (with a starter Node MCP server)
  Key fingerprint: ed25519:…
  Signature self-check: verified ✓

  Next steps:

    1. Publish the DNS record (also written to dns.txt):
       _agent.myagent.com TXT "v=nais1; manifest=https://myagent.com/.well-known/agent.json; k=ed25519:…"

    2. Serve .well-known/agent.json over HTTPS at https://myagent.com/
       and run the MCP server:  cd myagent.com && node mcp.js

    3. Once it's live, confirm it resolves end-to-end (DNS + signature):
       nais verify myagent.com
```

Every `init-agent` and `sign` ends with a **signature self-check** — the card is
verified with `@nais-standard/sdk` before you ever deploy it.

## What It Generates

| File | Purpose |
|------|---------|
| `.well-known/agent.json` | **Signed** NAIS 1.0 card — identity, tags, MCP endpoint, `mcpSnapshot` |
| `mcp.js` | Zero-dependency Node MCP server (JSON-RPC 2.0) + card host, with a starter `ping` tool |
| `package.json` | `npm start` → `node mcp.js` |
| `dns.txt` | DNS TXT record (its `k=` is filled in for you) |
| `README.md` | Deployment + testing guide for the generated agent |
| `test.sh` | curl commands to exercise the card + MCP endpoint |
| `tools/signing-key.json` | The agent's Ed25519 **private key** — gitignored; keep offline |

## Signing

Every NAIS card must carry a detached Ed25519 (JWS) signature. `nais init-agent`
generates the agent's key (`tools/signing-key.json`, gitignored) and writes a
signed card; its public fingerprint becomes the `k=` value in DNS, which clients
verify against. Signing uses **Node's built-in crypto** — no PHP, OpenSSL, or
other tooling required. After editing tools, update the card's `mcpSnapshot` and
run `nais sign` to refresh and re-sign.

## Deploy

1. **Run/serve** the agent over HTTPS at `https://<domain>/` (`node mcp.js`
   behind a reverse proxy that forwards `/mcp` and `/.well-known/`).
2. **Publish DNS** — copy the TXT record from `dns.txt` into your DNS provider.
3. **Verify** — `nais verify <domain>` resolves the record, fetches the card, and
   checks the signature against the DNS `k=` key (the full client path). It exits
   non-zero if anything fails, so it drops straight into CI.

## Adding a tool

1. In `mcp.js`: add an entry to `TOOLS` and a `case` in `callTool()`.
2. Mirror the tool in the card's `mcpSnapshot.tools`.
3. `nais sign` — refreshes the card's `toolsHash` and re-signs.

See the [NAIS specification](https://nais.id/spec) for the full schema.

## How NAIS Discovery Works

```
Domain
  ↓  DNS lookup: _agent.<domain> TXT  (manifest URL + signing-key k=)
  ↓  Fetch the signed card: /.well-known/agent.json
  ↓  Verify the signature against the DNS k= key
  ↓  Call the agent: POST /mcp
```

## Requirements

- Node.js 18+ (the CLI uses built-in `crypto` for signing and global `fetch`; the
  generated agent itself runs on Node 16+)
- HTTPS-capable hosting
- DNS access to add TXT records

## Related

| Resource | Link |
|----------|------|
| NAIS Website | https://nais.id |
| Specification | https://nais.id/spec |
| SDKs | https://github.com/nais-standard/clients |
| MCP gateway | https://github.com/nais-standard/mcp |
| Examples | https://github.com/nais-standard/examples |

## License

MIT
