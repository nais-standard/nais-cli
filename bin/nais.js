#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const nais = require('@nais-standard/sdk');

// ─── Constants ───────────────────────────────────────────────────────────────

const VERSION = '1.0.0';
const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');
// Files only relevant when scaffolding a NEW server (greenfield). For
// bring-your-own-MCP, we skip these and write a leaner identity-only project.
const SERVER_ONLY = new Set(['mcp.js', 'package.json', 'test.sh', 'README.md']);

const PING_TOOL = {
  name: 'ping',
  description: 'Health check. Returns a pong response confirming the agent is reachable.',
  inputSchema: { type: 'object', properties: {}, required: [] },
};

// ─── NAIS card signing (Node built-in crypto — no PHP/openssl needed) ──────────

// Canonicalization comes from the SDK, so the bytes the CLI *signs* are byte-for-byte
// the bytes any NAIS client will *verify* — no second implementation to drift.
const canonicalize = nais.canonicalize;

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const nowStamp = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

function loadOrCreateKey(keyPath) {
  if (fs.existsSync(keyPath)) {
    const d = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
    return { kid: d.kid, privateKey: crypto.createPrivateKey(d.private_pem) };
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const x = publicKey.export({ format: 'jwk' }).x;
  const kid = 'ed25519:' + x;
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  fs.writeFileSync(keyPath, JSON.stringify({
    _warning: "PRIVATE signing key — this is your agent's identity. Keep offline; never commit (gitignored).",
    alg: 'EdDSA', kid, public_x: x,
    private_pem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  }, null, 2) + '\n');
  return { kid, privateKey };
}

function signCard(card, privateKey, kid) {
  if (card.mcpSnapshot && Array.isArray(card.mcpSnapshot.tools)) {
    card.mcpSnapshot.toolsHash =
      'sha256:' + crypto.createHash('sha256').update(canonicalize(card.mcpSnapshot.tools)).digest('hex');
  }
  const body = { ...card };
  delete body.signature;
  const header = JSON.stringify({ alg: 'EdDSA', kid });
  const signingInput = b64url(Buffer.from(header)) + '.' + b64url(Buffer.from(canonicalize(body)));
  const sig = crypto.sign(null, Buffer.from(signingInput), privateKey);
  card.signature = { alg: 'EdDSA', kid, jws: b64url(Buffer.from(header)) + '..' + b64url(sig) };
  return card;
}

/** Fetch tools/list from a live MCP endpoint (best effort). Returns trimmed
 *  tool defs, or null if unreachable / no tools. */
async function fetchTools(url) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const json = await res.json();
    const tools = json && json.result && json.result.tools;
    if (Array.isArray(tools) && tools.length) {
      return tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
    }
  } catch (_) { /* unreachable */ }
  return null;
}

function buildCard({ domain, name, description, tags, mcpUrl, tools }) {
  const now = nowStamp();
  const card = {
    nais: '1.0',
    cardVersion: 1,
    updated: now,
    name,
    domain,
    description,
    tags: tags || [],
    contact: `https://${domain}`,
    mcp: mcpUrl,
    auth: [{ scheme: 'none' }],
  };
  if (tools && tools.length) card.mcpSnapshot = { capturedAt: now, toolsHash: '', tools };
  return card;
}

function writeCard(dir, card) {
  const p = path.join(dir, '.well-known', 'agent.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(card, null, 2) + '\n');
}

function fillDns(dir, kid) {
  const p = path.join(dir, 'dns.txt');
  if (!fs.existsSync(p)) return;
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/k=(\{\{KID\}\}|ed25519:[A-Za-z0-9_-]+)/g, 'k=' + kid));
}

// ─── Prompts (interactive; resolves defaults on EOF for piped input) ───────────

function makeAsk(rl) {
  let closed = false;
  rl.on('close', () => { closed = true; });
  return (question, def) => new Promise((resolve) => {
    if (closed) return resolve(def || '');
    const label = def ? `  ${question} [${def}]: ` : `  ${question}: `;
    const onClose = () => resolve(def || '');
    rl.once('close', onClose);
    rl.question(label, (a) => { rl.removeListener('close', onClose); resolve((a || '').trim() || def || ''); });
  });
}

// ─── Misc helpers ──────────────────────────────────────────────────────────────

function isValidDomain(d) {
  return /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/.test(d);
}
const sanitizeFolderName = (d) => d.replace(/[^a-zA-Z0-9.-]/g, '-');
const deriveAgentName = (d) => d.split('.')[0].replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

/** Parse `[positional...] --flag value --flag2 value2`. Flags pre-fill prompts. */
function parseFlags(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      o[key] = (argv[i + 1] != null && !argv[i + 1].startsWith('--')) ? argv[++i] : 'true';
    } else o._.push(a);
  }
  return o;
}

function copyTemplateDir(srcDir, destDir, replacements, skip) {
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (skip && skip.has(entry.name)) continue;
    const srcPath = path.join(srcDir, entry.name);
    // npm strips `.gitignore`, so the template ships it as `gitignore`.
    const destName = entry.name === 'gitignore' ? '.gitignore' : entry.name;
    const destPath = path.join(destDir, destName);
    if (entry.isDirectory()) {
      fs.mkdirSync(destPath, { recursive: true });
      copyTemplateDir(srcPath, destPath, replacements, skip);
    } else {
      let content = fs.readFileSync(srcPath, 'utf8');
      for (const [k, v] of Object.entries(replacements)) content = content.split(k).join(v);
      fs.writeFileSync(destPath, content, 'utf8');
    }
  }
}

function byoReadme(domain, name, mcpUrl) {
  return `# ${name}

NAIS identity for \`${domain}\` — wraps your existing MCP server at \`${mcpUrl}\`
with a signed, discoverable identity. Generated with nais-cli.

## Files

\`\`\`
${domain}/
├── .well-known/
│   └── agent.json   # Signed NAIS 1.0 card (points at your MCP endpoint)
├── dns.txt          # DNS record (k= filled in for you)
└── tools/
    └── signing-key.json   # PRIVATE key — gitignored; keep offline
\`\`\`

## Deploy

1. Serve \`.well-known/agent.json\` over HTTPS at \`https://${domain}/.well-known/agent.json\`
   (your MCP server stays where it is — this is just the identity layer).
2. Publish the DNS record from \`dns.txt\`.
3. Verify end-to-end (DNS + signature): \`nais verify ${domain}\`

## Keep the card in sync

When your MCP server's tools change, re-sign so the card's \`mcpSnapshot\` matches
your live \`tools/list\`:

\`\`\`bash
nais sign        # re-fetches tools/list from ${mcpUrl} and re-signs
\`\`\`
`;
}

// ─── Commands ────────────────────────────────────────────────────────────────

async function initAgent(argv) {
  const flags = parseFlags(argv);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = makeAsk(rl);

  console.log('\n  Create a NAIS agent\n');
  const domain = (flags._[0] || await ask('Agent domain (e.g. myagent.com)')).trim();
  const name = flags.name || await ask('Display name', deriveAgentName(domain || 'agent'));
  const description = flags.description || await ask('Short description', `A NAIS-compliant agent on ${domain}.`);
  const tagsRaw = flags.tags != null ? flags.tags : await ask('Tags (comma-separated, optional)', '');
  const tags = tagsRaw.split(',').map(s => s.trim()).filter(Boolean);

  // --mcp <url> = bring-your-own server (skips the prompt); otherwise ask.
  let mcpUrl, greenfield;
  if (flags.mcp) {
    mcpUrl = flags.mcp; greenfield = false;
  } else {
    const hasServer = /^y/i.test(await ask('Do you already have an MCP server? (y/N)', 'N'));
    mcpUrl = hasServer ? (await ask('Your MCP endpoint URL', `https://${domain}/mcp`)) : `https://${domain}/mcp`;
    greenfield = !hasServer;
  }
  rl.close();

  if (!isValidDomain(domain)) {
    console.error(`\n  Error: "${domain}" is not a valid domain.\n`);
    process.exit(1);
  }
  const folderName = sanitizeFolderName(domain);
  const outputDir = path.resolve(process.cwd(), folderName);
  if (fs.existsSync(outputDir)) {
    console.error(`\n  Error: directory "${folderName}" already exists.\n`);
    process.exit(1);
  }

  fs.mkdirSync(outputDir, { recursive: true });
  copyTemplateDir(
    path.join(TEMPLATES_DIR, 'node-agent'),
    outputDir,
    { '{{DOMAIN}}': domain, '{{AGENT_NAME}}': name, '{{DATE}}': new Date().toISOString().split('T')[0] },
    greenfield ? null : SERVER_ONLY,
  );

  // Build the tool snapshot.
  let tools;
  if (greenfield) {
    tools = [PING_TOOL];
    try { fs.chmodSync(path.join(outputDir, 'test.sh'), 0o755); } catch (_) { /* Windows */ }
  } else {
    fs.writeFileSync(path.join(outputDir, 'README.md'), byoReadme(domain, name, mcpUrl));
    process.stdout.write(`\n  Fetching tools/list from ${mcpUrl} ... `);
    tools = await fetchTools(mcpUrl);
    console.log(tools ? `found ${tools.length} tool(s)` : 'unreachable — snapshot skipped (run "nais sign" once it\'s live)');
  }

  const { kid, privateKey } = loadOrCreateKey(path.join(outputDir, 'tools', 'signing-key.json'));
  const signed = signCard(buildCard({ domain, name, description, tags, mcpUrl, tools }), privateKey, kid);
  writeCard(outputDir, signed);
  fillDns(outputDir, kid);

  // Self-check: verify the card we just signed with the same SDK clients use.
  const check = nais.verifyCard(signed, kid);

  const dns = `_agent.${domain} TXT "v=nais1; manifest=https://${domain}/.well-known/agent.json; k=${kid}"`;
  console.log(`
  Created and signed ${folderName}/ ${greenfield ? '(with a starter Node MCP server)' : `(identity for your MCP at ${mcpUrl})`}
  Key fingerprint: ${kid}
  Signature self-check: ${check.verified ? 'verified ✓' : 'FAILED ✗ — ' + (check.reason || 'unknown')}

  Next steps:

    1. Publish the DNS record (also in dns.txt):
       ${dns}

    2. Serve .well-known/agent.json over HTTPS at https://${domain}/${greenfield ? `
       and run the MCP server:  cd ${folderName} && node mcp.js` : ''}

    3. Once it's live, confirm it resolves end-to-end (DNS + signature):
       nais verify ${domain}

  Keep tools/signing-key.json offline (it's your agent's identity; gitignored).
  Re-sign after tool changes:  cd ${folderName} && nais sign

  Documentation: https://nais.id/quickstart
`);
  if (!check.verified) process.exit(1);
}

async function signAgent(argv) {
  const flags = parseFlags(argv);
  const d = path.resolve(process.cwd(), flags._[0] || '.');
  const cardPath = path.join(d, '.well-known', 'agent.json');
  if (!fs.existsSync(cardPath)) {
    console.error(`\n  Error: no .well-known/agent.json in ${d}\n  Run "nais init-agent <domain>" first.\n`);
    process.exit(1);
  }
  let card;
  try { card = JSON.parse(fs.readFileSync(cardPath, 'utf8')); } catch (e) {
    console.error(`\n  Error: agent.json is not valid JSON: ${e.message}\n`);
    process.exit(1);
  }
  if (!card.nais || !card.domain) {
    console.error('\n  Error: agent.json is not a NAIS card. Run "nais init-agent" first.\n');
    process.exit(1);
  }

  // Apply metadata edits from flags (no need to hand-edit the JSON).
  if (flags.name != null) card.name = flags.name;
  if (flags.description != null) card.description = flags.description;
  if (flags.tags != null) card.tags = flags.tags.split(',').map(s => s.trim()).filter(Boolean);
  if (flags.mcp != null) card.mcp = flags.mcp;

  // Refresh the snapshot from the live MCP endpoint, unless --no-refresh.
  if (card.mcp && !flags['no-refresh']) {
    process.stdout.write(`  Refreshing tools/list from ${card.mcp} ... `);
    const tools = await fetchTools(card.mcp);
    if (tools) { card.mcpSnapshot = { capturedAt: nowStamp(), toolsHash: '', tools }; console.log(`found ${tools.length} tool(s)`); }
    else console.log('unreachable — keeping existing snapshot');
  }

  // Each signed change is a new card revision.
  card.cardVersion = (Number.isInteger(card.cardVersion) ? card.cardVersion : 0) + 1;
  card.updated = nowStamp();

  const { kid, privateKey } = loadOrCreateKey(path.join(d, 'tools', 'signing-key.json'));
  const signed = signCard(card, privateKey, kid);
  writeCard(d, signed);
  fillDns(d, kid);

  const check = nais.verifyCard(signed, kid);
  console.log(`  Re-signed ${cardPath}  (cardVersion ${card.cardVersion})`);
  console.log(`  Key fingerprint: ${kid}`);
  console.log(`  Signature self-check: ${check.verified ? 'verified ✓' : 'FAILED ✗ — ' + (check.reason || 'unknown')}\n`);
  if (!check.verified) process.exit(1);
}

// Resolve a domain end-to-end (DNS → fetch card → verify signature) via the SDK —
// the exact path a real NAIS client follows. Requires the agent deployed + DNS live.
async function verifyAgent(argv) {
  const flags = parseFlags(argv);
  const domain = flags._[0];
  if (!domain) {
    console.error('\n  Usage: nais verify <domain>\n');
    process.exit(1);
  }
  process.stdout.write(`\n  Resolving ${domain} via NAIS (DNS + signature) ... `);
  let r;
  try {
    r = await nais.validate(domain);
  } catch (e) {
    console.log('failed');
    console.error(`    ${e.message}\n`);
    process.exit(1);
  }
  console.log(r.valid ? 'OK ✓' : 'issues found ✗');
  console.log(`    signature:  ${r.signatureVerified ? 'verified ✓' : 'NOT verified ✗' + (r.signatureReason ? ' — ' + r.signatureReason : '')}`);
  console.log(`    key (DNS):  ${r.key || '-'}`);
  console.log(`    manifest:   ${r.manifestUrl}`);
  console.log(`    mcp:        ${r.mcpEndpoint || '-'}`);
  console.log(`    tags:       ${r.tags.length ? r.tags.join(', ') : '-'}`);
  if (r.linkedAgents && r.linkedAgents.length) {
    const links = r.linkedAgents
      .map(l => `${l.domain} (${l.relation}${l.verified ? ', verified' : ''})`)
      .join(', ');
    console.log(`    linked:     ${links}  (advisory — verify each independently)`);
  }
  if (r.payTo.length) console.log(`    payTo:      ${r.payTo.join(', ')}  (trusted — signature verified)`);
  if (r.warnings && r.warnings.length) console.log(`    warnings:   ${r.warnings.join('; ')}`);
  if (r.errors && r.errors.length) console.log(`    errors:     ${r.errors.join('; ')}`);
  console.log('');
  process.exit(r.valid ? 0 : 1);
}

// ─── CLI Entry Point ─────────────────────────────────────────────────────────

function printUsage() {
  console.log(`
  nais-cli v${VERSION}
  Scaffold and sign NAIS-compliant agents.

  Usage:

    nais init-agent [domain]    Interactively create + sign a NAIS agent
    nais sign [dir] [flags]     Refresh snapshot + re-sign the card in [dir]
                                  --tags a,b,c   --description <text>
                                  --name <name>  --mcp <url>  --no-refresh
    nais verify <domain>        Resolve a live domain and verify it end-to-end
                                  (DNS record + card signature, via @nais-standard/sdk)
    nais --help | --version

  "init-agent" asks whether you already have an MCP server. If so, it builds a
  signed identity pointing at it (fetching its tools/list for the card snapshot);
  otherwise it scaffolds a starter Node MCP server.

  Any prompt can be pre-filled (and skipped) with a flag:
    --mcp <url>   --name <name>   --description <text>   --tags <a,b,c>
`);
}

const args = process.argv.slice(2);

if (args.includes('--version') || args.includes('-v')) {
  console.log(`nais-cli v${VERSION}`);
  process.exit(0);
}
if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
  printUsage();
  process.exit(0);
}

const run = (p) => p.catch((e) => { console.error(`  Error: ${e.message}`); process.exit(1); });

switch (args[0]) {
  case 'init-agent':
    run(initAgent(args.slice(1)));
    break;
  case 'sign':
    run(signAgent(args.slice(1)));
    break;
  case 'verify':
    run(verifyAgent(args.slice(1)));
    break;
  default:
    console.error(`  Unknown command: ${args[0]}\n`);
    printUsage();
    process.exit(1);
}
