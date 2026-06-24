# Sessionscope

> **See how you actually work.** Drop your AI coding sessions (Claude Code, Codex, ChatGPT, Anthropic exports) and get a chat archive plus a **flow & ship** view — when you're active, and which sessions actually landed code.

**🔒 Everything runs in your browser. Nothing is uploaded. No server. No network calls.**

---

## 🌐 Live app

**→ https://sessionscope.pages.dev** *(deploy in progress — see [Deploy](#deploy-your-own) below)*

---

## What it does

| Dashboard | What you see |
|---|---|
| **Chat Archive** | Every session as a browsable thread — your prompts, agent replies, tool calls, thinking blocks |
| **Flow & Ship** | A 24h radial clock of your turn activity, split by outcome: **shipped** (ran `git commit`), **built** (heavy edits, no commit), **explored** (read-only) |

The cut that matters: **what separates a shipping session from one that doesn't isn't thinking — it's how far you cross into execution.** The funnel is look → edit → commit.

## Supported formats

| Format | Where to find it | Capability |
|---|---|---|
| **Claude Code** | `~/.claude/projects/<project>/*.jsonl` | sessions + flow/ship |
| **Codex CLI** | `~/.codex/sessions/**/rollout-*.jsonl` | sessions + flow/ship |
| **ChatGPT export** | Settings → Data controls → Export → `conversations.json` | sessions + activity |
| **Anthropic export** | claude.ai → Settings → Export data → `conversations.json` | sessions + activity |

Chat exports (ChatGPT, Anthropic) have no tool/git data, so flow/ship degrades to a turn-activity view rather than fabricating a commit signal.

## Privacy posture

- **Zero upload.** Files are read and parsed inside your browser tab. No POST, no fetch to a third party.
- **Enforced at the edge.** Cloudflare headers (`_headers`) lock CSP to `connect-src 'self'` — the page is *incapable* of contacting a third party.
- **Disconnect-the-internet test.** After the page loads, turn off Wi‑Fi. Everything still works. That's the guarantee.
- **In-memory only.** Results live in this tab's `sessionStorage` and vanish when you close it.

## Quick start — three ways

### 1. Use the hosted app
Visit **[sessionscope.pages.dev](https://sessionscope.pages.dev)**, click **⌖ Find my sessions**, grant a folder (your home, or `~/.codex` / `~/.claude`). The scanner walks the tree and flags candidates — you never pick files by hand.

### 2. Local indexer (zero clicks)
For the fastest path on your own machine — no folder picker, no browser permission:

```bash
git clone https://github.com/everettVT/sessionscope.git
cd sessionscope
node scope.js
```

That walks `~/.claude/projects`, `~/.codex/sessions`, and `~/Downloads`, parses everything with the same `parsers.js` the web app uses, writes `scope_data.js`, and opens the dashboards with your data preloaded.

### 3. Run the static site locally
```bash
cd sessionscope
python3 -m http.server 8000
# open http://localhost:8000
```
(Localhost is a secure context, so the folder scanner works. `file://` won't.)

## Deploy your own

### Cloudflare Pages (~30 seconds, no CLI)
1. Open [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages** → **Create** → **Upload assets**
2. Name it `sessionscope`
3. Drag this folder in
4. Click **Deploy** → live at `https://sessionscope.<your-subdomain>.pages.dev`

### Cloudflare CLI
```bash
npx wrangler pages deploy . --project-name sessionscope
```

### GitHub Pages
```bash
# settings → pages → source: main / root → save
# live at https://everettvt.github.io/sessionscope/
```

## Architecture

```
index.html       privacy modal · folder scanner · format detection
parsers.js       one normalizer + four adapters (Claude / Codex / ChatGPT / Anthropic)
sessions.html    chat archive: time rail · session list · thread view
flow.html        24h radial turn clock · ship/build/explore tier cards
scope.js         local Node indexer (reads standard hidden dirs, reuses parsers.js)
_headers         Cloudflare edge headers — CSP enforces no-network at the edge
```

The web app and the Node indexer **share the same parser** — one source of truth, validated against real Claude Code (80 sessions, 4,243 turns) and Codex (53 sessions, 6,388 turns) rollouts.

## What's next

- **Braid view** — git commit history as entity world-lines (requires a `--repo` pass in `scope.js`)
- **Cognition profile** — quality-axis radar with per-day trajectory
- **Cognition clock** — circadian rhythm with shipping-tier overlay
- **Cursor adapter** — SQLite (`state.vscdb`) parsing via `sql.js` in-browser

## License

MIT — see [LICENSE](LICENSE).
