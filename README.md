# MF0-1984 (`mf-lab`) — Custom Fork

**MF0-1984** is a **local-first** single-page app for multi-provider LLM chat, structured workflows (Intro / Access / Rules / Help), a **Memory tree** (3D graph over SQLite), **themes** and dialogs, **analytics**, **favorites**, and **project profile** backup/restore (`.mf` bundles).

This fork extends the original with **Ollama** and **OpenRouter** support, per-dialog model memory, a **LocalFS** file-system tool layer with **file upload**, **login/password authentication**, **HTTPS**, **semantic memory search**, and **per-model analytics**.

| | |
|---|---|
| **UI dev server** | Vite — default port **1984** (`vite.config.js`) |
| **Local API** | Node + `better-sqlite3` — default port **35184** (`API_PORT`) |
| **Version** | **1.10.04** |
| **Upstream** | [PavelMuntyan/MF0-1984](https://github.com/PavelMuntyan/MF0-1984) |

For architecture, data model, and operations see **[HANDOFF.md](./HANDOFF.md)**.

---

## Prerequisites

- **Git**, **Node.js** (LTS / 18+) and **npm** on your PATH
- **Ollama** installed and running locally (`ollama serve`) with your chosen models pulled
- After setup, edit **`.env`** and add provider API keys (see [Environment variables](#environment-variables)). Keys are read server-side and never sent to the browser.

---

## Quick start

```bash
git clone <your-fork-url> && cd MF0-1984
cp .env.example .env     # then edit .env
npm install
npm run dev
```

Open the URL Vite prints — typically **`http://127.0.0.1:1984`**.

On first open you will be prompted to **create the initial admin account** (username + password). All subsequent users are created by an admin in Settings.

**API health:** `GET http://127.0.0.1:35184/api/health` → `{ "ok": true, "mfLabApi": true }`

---

## npm scripts

| Script | Purpose |
|--------|---------|
| `npm run dev` | API + Vite together (recommended) |
| `npm run api` | API only |
| `npm run dev:vite` | Vite only |
| `npm run build` | Production build → `dist/` |
| `npm run preview` | Preview production build |
| `npm run pm2:start` / `pm2:stop` / `pm2:restart` / `pm2:logs` | PM2 process manager |

---

## Environment variables

`.env` (copy from `.env.example`, never commit the real file):

```dotenv
# ── LLM providers ─────────────────────────────────────────────
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
GEMINI_API_KEY=
OPENROUTER_API_KEY=          # required for OR Slot 1 / 2 / 3 and semantic embeddings

# Optional: shown in OpenRouter request headers
OPENROUTER_REFERER=https://your-domain.com
OPENROUTER_APP_TITLE=MF0-1984

# ── LocalFS sandbox ───────────────────────────────────────────
LOCALFS_ENABLED=true
LOCALFS_ROOT=/path/to/ai-workspace   # any folder the server process can read/write

# ── API server ────────────────────────────────────────────────
API_PORT=35184               # default
# API_MAX_BODY_BYTES=20971520

# ── HTTPS proxy ───────────────────────────────────────────────
HTTPS_PORT=4443              # default
HTTPS_CERT=certs/server.crt  # path to TLS cert (auto-generated if missing)
HTTPS_KEY=certs/server.key   # path to TLS key  (auto-generated if missing)
```

---

## Authentication

The app requires login on every session. Access is controlled by username + password.

### First run

On the very first request after a fresh install, the login screen shows a **Register** form instead. Fill in a username and password — this creates the initial **admin** account and logs in immediately.

### User management

Admin users can create, list, and delete accounts via **Settings → Users**. There is no self-registration after the initial setup; only admins can add users.

### Roles

| Role | Can do |
|---|---|
| `admin` | Full access, manage users, change any password |
| `user` | Full access to chat/memory/analytics, change own password only |

### Session

Sessions are stored server-side in SQLite (`sessions` table). A session cookie (`mf_session`, `HttpOnly`, `SameSite=Lax`) is set on login and cleared on logout. Session lifetime: **7 days**. The cookie gains the `Secure` flag automatically when the request arrives over HTTPS.

### API endpoints

| Method | Path | Auth required |
|---|---|---|
| `GET` | `/api/auth/setup-required` | No |
| `POST` | `/api/auth/register` | No (first run) / Admin |
| `POST` | `/api/auth/login` | No |
| `POST` | `/api/auth/logout` | Yes |
| `GET` | `/api/auth/me` | Yes |
| `GET` | `/api/auth/users` | Admin |
| `DELETE` | `/api/auth/users/:id` | Admin |
| `POST` | `/api/auth/users/:id/password` | Admin or self |

---

## HTTPS

A standalone HTTPS reverse proxy is included at `server/https-proxy.mjs`. It terminates TLS and forwards plain HTTP to the local API.

```bash
node --env-file=.env server/https-proxy.mjs
npm run build        
npx pm2 start ecosystem.config.cjs --host 127.0.0.1 --port 1984
npx pm2 save          
npx pm2 startup       
```

**Self-signed certificate (development):** if `HTTPS_CERT` / `HTTPS_KEY` files do not exist, a self-signed certificate is generated automatically using Node's built-in `crypto` — no `openssl` binary required. Files are written to `certs/server.crt` and `certs/server.key`.

**Production:** point `HTTPS_CERT` and `HTTPS_KEY` at real certificate files (e.g. from Let's Encrypt / certbot). Restart the proxy after cert renewal.

---

## Semantic memory search (Layer 1.5)

Memory tree routing uses a **hybrid retrieval pipeline**:

1. **Lexical** — keyword + entity matching across all nodes.
2. **Layer 1.5 — semantic** — cosine similarity over pre-computed embeddings via `perplexity/pplx-embed-v1-4b` (OpenRouter).
3. **Title-scan** — LLM-assisted title-level candidate selection.
4. **Rerank** — LLM reranks the merged candidate pool.

Embeddings are computed **automatically** on every memory ingest (fire-and-forget, non-blocking). Missing embeddings can be backfilled at any time:

```
POST /api/memory-graph/reindex
```

Semantic scores influence pool ordering even on small graphs where all nodes are already returned by lexical search — the embedding model's ranking is applied as a secondary sort key.

**Requires:** `OPENROUTER_API_KEY` set in `.env`.

### Router diagnostics (activity log)

After each turn the activity log shows a line like:

```
[memRouter] nodes=112 · lexical=112 · semantic+20 · pool=72 → selected=20
[memRouter] semantic winners: Interests / Разработка AI-агентов, Interests / Interests
```

| Field | Meaning |
|---|---|
| `nodes` | Total nodes in the memory graph |
| `lexical` | Nodes in candidate pool after lexical + title scan |
| `semantic+N` | Nodes that received a semantic similarity boost in pool ordering |
| `pool` | Candidates sent to the rerank LLM |
| `selected` | Final nodes included in the context supplement |
| `semantic winners` | Selected nodes whose pool position was boosted by semantic scoring |

---

## Providers

### Ollama (local)

The **Gemma4** button connects to a locally running Ollama instance (`http://127.0.0.1:11434`). No API key required.

```bash
ollama pull gemma4:31b-cloud   # or any model you prefer
```

The active model is selected in **Settings → AI → Gemma4**.

### OpenRouter — three independent slots

Three provider slots route through the OpenRouter API, each with its own independently selected model:

| Button label | Provider ID | Storage |
|---|---|---|
| model short name | `or-1` (OR Slot 1) | server DB + localStorage fallback |
| model short name | `or-2` (OR Slot 2) | server DB + localStorage fallback |
| model short name | `or-3` (OR Slot 3) | server DB + localStorage fallback |

All three slots share the same `OPENROUTER_API_KEY`. Each slot's **selected model is saved per-dialog** — switching dialogs restores the model that was active in that dialog.

#### Configuring available models: `openrouter-models.json`

Add or remove models by editing **`openrouter-models.json`** in the project root. No rebuild required — the file is read by the server on every API call and cached for 5 minutes.

```json
[
  {
    "id": "deepseek/deepseek-v4-flash",
    "shortName": "DS4 Flash",
    "desc": "0.12/0.25",
    "inputPer1M": 0.126,
    "outputPer1M": 0.252,
    "modes": {
      "dialogue": { "model": "deepseek/deepseek-v4-flash" },
      "search":   { "model": "deepseek/deepseek-v4-flash",
                    "tools": [{ "type": "openrouter:web_search",
                                "parameters": { "max_results": 5, "max_total_results": 20 } }] },
      "research": { "model": "deepseek/deepseek-v4-flash",
                    "tools": [
                      { "type": "openrouter:web_search", "parameters": { "max_results": 10, "max_total_results": 50 } },
                      { "type": "openrouter:web_fetch",  "parameters": { "max_uses": 5, "max_content_tokens": 50000 } }
                    ]}
    }
  }
]
```

| Field | Meaning |
|---|---|
| `id` | Full OpenRouter model ID |
| `shortName` | Label shown on the slot button (first line) |
| `desc` | Price hint shown on the slot button (second line). If omitted, auto-formatted from `inputPer1M`/`outputPer1M` |
| `inputPer1M` / `outputPer1M` | Prices in USD used for analytics cost calculation |
| `modes.dialogue` | Called for normal chat — just `{ "model": "..." }` |
| `modes.search` | Called when Web Search mode is active — adds `openrouter:web_search` server tool |
| `modes.research` | Called for Deep Research — adds both `web_search` and `web_fetch` tools |

If a mode is absent, the nearest fallback is used: `search` → `dialogue`; `research` → `search` → `dialogue`.

#### Picking a model from the button

Click an OR slot button to activate it — the model picker opens automatically. If the slot is already active, click again to reopen the picker. The picker shows the short name and full model ID for each entry. The list opens upward if there is more space above the button.

---

## Per-dialog memory

The following settings are saved **per dialog** and restored when you switch back:

| What | Where stored |
|---|---|
| Active provider (Gemini, Ollama, OR Slot…) | `localStorage` — `mf0.dialog.<dialogId>.provider` |
| Chat mode (default / AI opinion) | `localStorage` — `mf0.dialog.mode.<dialogId>` |
| OR Slot 1 model | **SQLite** `dialogs.or_models_json` → `{"or-1": "..."}` |
| OR Slot 2 model | **SQLite** `dialogs.or_models_json` → `{"or-2": "..."}` |
| OR Slot 3 model | **SQLite** `dialogs.or_models_json` → `{"or-3": "..."}` |

OR slot models are written to the server immediately on selection (`PATCH /api/dialogs/:id/or-models`) and restored from the server when the dialog is opened — so they survive clearing `localStorage`, switching browsers, or accessing the app from another device.

---


## Context budget (per-provider)

Context window limits and history depth are configured in **`src/modelContextConfig.js`** — one entry per provider. No rebuild needed if you edit the file during `npm run dev` (Vite hot-reloads it).

```js
// src/modelContextConfig.js
export const MODEL_CONTEXT_CONFIG = {
  "or-1":         { maxInputTokens: 200_000, recentMessageCount: 24 },
  "or-2":         { maxInputTokens: 200_000, recentMessageCount: 24 },
  "or-3":         { maxInputTokens: 180_000, recentMessageCount: 24 },  // 256 k model
  "gemini-flash": { maxInputTokens: 200_000, recentMessageCount: 24 },
  "openai":       { maxInputTokens: 100_000, recentMessageCount: 20 },
  "anthropic":    { maxInputTokens: 150_000, recentMessageCount: 24 },
  "ollama":       { maxInputTokens:  24_000, recentMessageCount: 12 },
  "default":      { maxInputTokens:  64_000, recentMessageCount: 16 },
};
```

| Field | Meaning |
|---|---|
| `maxInputTokens` | Hard token budget for the full request (messages + system prompt). Set to ~70–80 % of the model's real context window to leave room for the answer and system blocks. |
| `recentMessageCount` | How many of the most recent turns are included verbatim. Older turns go through the RAG/retrieval pipeline. Range: 6–60. |

---

## Reply timestamps

Every assistant bubble shows the reply time at the end of the `Replied:` line (UTC+3):

```
Replied: OR Slot 1 · DS Flash  17.05 14:23
```

The timestamp is recorded **when the response is received** and stored in `el.dataset.repliedAt` (sourced from `conversation_turns.assistant_message_at` in the DB). It does not change when you reload or switch dialogs.

Turns created via the external API (`POST /api/dialogs/:id/turns`) receive a server-side timestamp automatically if the caller does not supply `assistant_message_at`.

---

## Web Search and Deep Research (OR slots)

OR slot models support two additional modes selectable in the chat toolbar:

| Mode | What happens |
|---|---|
| **Web Search** | Adds `openrouter:web_search` server tool to the request. The model decides when to search; OpenRouter executes it and returns cited results. |
| **Deep Research** | Adds both `openrouter:web_search` and `openrouter:web_fetch`. The model can search multiple times and read full page content for deeper synthesis. |

The exact tool parameters per model are defined in `openrouter-models.json` under `modes.search` and `modes.research`. Models without a `search`/`research` entry fall back to `dialogue` mode (no tools).

These modes apply **only to OR slots** — Gemini, Claude, and OpenAI use their own native grounding mechanisms configured separately.

---

## LocalFS — file system tools

When `LOCALFS_ENABLED=true`, any model (no function-calling API required) can read and write files inside `LOCALFS_ROOT` using plain text tool calls embedded in its reply:

```
<tool>list_files(".")</tool>
<tool>list_files("subdir", "recursive")</tool>
<tool>list_files(".", "recursive", ".md")</tool>
<tool>read_file("notes.md")</tool>
<tool>read_lines("big-file.txt", 10, 50)</tool>
<tool>grep_file("src/main.js", "openRouterEntries", 2)</tool>
<tool>write_file("output.md", "# Result\n...")</tool>
<tool>patch_file("config.json", "\"debug\": false", "\"debug\": true")</tool>
<tool>delete_file("old.txt")</tool>
```

**Enabling:** click the **LocalFS** button in the composer badge bar. The button is disabled if `LOCALFS_ENABLED` is not set. The mode is saved per-dialog.

**Security:** all paths are resolved inside `LOCALFS_ROOT`. Path traversal (`../`) is blocked server-side. LocalFS and AI opinion mode are mutually exclusive.

### Available tools

| Tool | Description |
|---|---|
| `list_files(path, "recursive"?, ext?)` | List files/dirs; optional recursive flag and extension filter |
| `read_file(path)` | Read a text file (max 4 MB) |
| `read_lines(path, from, to)` | Read a line range (max 2 000 lines, with line numbers) |
| `grep_file(path, pattern, context?)` | Search by substring or regex with N lines of context |
| `write_file(path, content)` | Write or overwrite a file (max 4 MB) |
| `patch_file(path, old_str, new_str)` | Replace a unique string — errors if 0 or 2+ matches |
| `delete_file(path)` | Delete a file (directories not supported) |

---

## LocalFS file upload

A dedicated upload button (diskette icon) sits immediately to the right of the LocalFS button and shares the same height. Clicking it opens a two-item menu:

| Option | Behaviour |
|---|---|
| **Файлы** | Standard multi-file picker — select one or more individual files |
| **Папка** | Folder picker (`webkitdirectory`) — selects an entire directory tree; the relative path of every file (including sub-folders) is preserved under `LOCALFS_ROOT` |

Files are uploaded one at a time via `POST /api/localfs/upload` with the relative path in the `X-Upload-Path` header. Parent directories are created automatically. Progress and result are written to the Activity log:

```
LocalFS upload: starting — 42 file(s)
LocalFS upload: done — 42 saved
```

**Note:** the browser shows a system confirmation dialog before transferring a folder — this is a built-in browser safety prompt for `webkitdirectory` uploads and cannot be suppressed by application code.

**Requires:** `LOCALFS_ENABLED=true` in `.env`. The button is disabled when LocalFS is not configured.

---

## AI opinion

AI opinion runs a round-robin discussion across all enabled providers. Manage participants in **Settings → AI opinion — participants** — uncheck any model you don't currently have access to. At least two must remain enabled.

When a model in AI opinion is one of the OR slots, the speaker label shown at the top of each response is the **short name** of the model currently selected for that slot in this dialog (e.g. `DS Flash`, `Sonnet 4.6`).

LocalFS tool mode is automatically disabled when AI opinion is activated (and vice versa).

---

## Analytics

Token tracking and cost estimation work for all providers.

### Per-slot analytics

Aggregated by provider slot — shows total tokens and estimated cost per OR Slot / Gemini / Ollama.

### Per-model analytics

For OpenRouter, costs are calculated **per model** using `inputPer1M` / `outputPer1M` from `openrouter-models.json`. The `responding_model_id` column in `conversation_turns` records the exact model used for each turn, so usage is attributed correctly even when you switch models mid-project.

The server caches the model list for **5 minutes** — edits to `openrouter-models.json` are picked up automatically without restart.

---

## Repository layout

| Path | Role |
|------|------|
| `index.html` | App shell + provider badge buttons |
| `src/` | Browser ES modules — chat, settings, memory tree, persistence, tools |
| `src/memoryTreeRouter.js` | Hybrid memory retrieval pipeline (lexical + semantic + LLM rerank) |
| `src/memoryGraphSemanticSearch.js` | Browser-side embedding + cosine similarity for semantic layer |
| `src/localFsTools.js` | Client-side tool call parser and executor |
| `src/userChatModels.js` | Model selection storage (global + per-dialog) |
| `src/modelContextConfig.js` | Per-provider context budget (`maxInputTokens`, `recentMessageCount`) |
| `openrouter-models.json` | OpenRouter model list with prices, short names, and per-mode tool config |
| `server/api.mjs` | Express bootstrap — loads OR prices at startup |
| `server/https-proxy.mjs` | Standalone HTTPS reverse proxy with auto self-signed cert |
| `server/routes/` | Route modules (health, LLM proxy, themes, analytics, localfs, auth, …) |
| `server/routes/auth.mjs` | Login / logout / register / user management |
| `server/routes/localfs.mjs` | LocalFS sandbox API + binary file upload (`POST /api/localfs/upload`) |
| `server/middleware/auth.mjs` | `requireAuth` / `requireAdmin` Express middleware |
| `server/db/` | Schema, migrations, analytics queries |
| `server/db/auth.mjs` | User + session CRUD, password hashing (scrypt) |
| `server/db/openrouterPrices.mjs` | Shared runtime OR price map (singleton) |
| `server/services/memoryGraphEmbeddings.mjs` | Server-side embedding ingest + semantic candidate search |
| `data/` | Runtime SQLite and caches |
| `certs/` | TLS cert + key (auto-generated if absent) |
| `HANDOFF.md` | Full technical orientation |

---

## Provider button visibility

In **Settings → Provider buttons** each provider button can be individually shown or hidden in the chat toolbar. Hiding a button does not disconnect the provider — it just removes it from the bar to reduce clutter.

AI opinion and LocalFS buttons are excluded from this toggle (they manage their own visibility).

Visibility preference is stored in `localStorage` under `mf0.badge.visibility`.

---

## Differences from upstream

| Feature | Upstream | This fork |
|---|---|---|
| 4th provider | Perplexity | Ollama (local, gemma4) |
| OpenRouter | — | Three independent slots with per-dialog model memory |
| Model picker | Settings only | Inline dropdown on every OR slot button |
| Button height | Default | ×1.5 vertical padding; OR slot buttons show model name + price on two lines |
| Provider button visibility | All shown | Per-button show/hide toggle in Settings |
| File system access | — | LocalFS sandbox (7 tools, works with any model) |
| LocalFS file upload | — | Upload button with file / folder picker; preserves subfolder structure |
| AI opinion participants | All providers | Configurable checkboxes in Settings |
| Per-dialog memory | Provider only | Provider + AI opinion mode + OR model per slot (persisted in DB) |
| OpenRouter analytics | — | Per-slot **and** per-model pricing from `openrouter-models.json` |
| Memory retrieval | Lexical + LLM rerank | + Semantic layer (pplx-embed-v1-4b, cosine, pool boosting) |
| Web Search / Research | — | OR slots support `openrouter:web_search` + `openrouter:web_fetch` server tools, configured per-model in `openrouter-models.json` |
| Authentication | — | Login/password, session cookies, admin/user roles |
| HTTPS | — | Standalone TLS proxy, auto self-signed cert for dev |

---

## Keeping in sync with upstream

This fork tracks `PavelMuntyan/MF0-1984` as `upstream`:

```bash
git remote add upstream https://github.com/PavelMuntyan/MF0-1984.git
git fetch upstream
git merge upstream/main   # resolve conflicts, then rebuild
npm run build
```

Files most likely to conflict on upstream updates: `index.html`, `src/main.js`, `src/chatApi.js`, `src/llmGateway.js`.

---

## Security note

Do not commit **`.env`** or live **SQLite** files with private data. The `certs/` directory contains private key material — add it to `.gitignore` if using a real certificate. Use project profile export/import (`.mf` bundles) and your own backup policy for sensitive environments.
