# MF0-1984 (`mf-lab`) — Custom Fork

**MF0-1984** is a **local-first** single-page app for multi-provider LLM chat, structured workflows (Intro / Access / Rules / Help), a **Memory tree** (3D graph over SQLite), **themes** and dialogs, **analytics**, **favorites**, and **project profile** backup/restore (`.mf` bundles).

This fork extends the original with **Ollama** and **OpenRouter** support, per-dialog model memory, a **LocalFS** file-system tool layer, **login/password authentication**, **HTTPS**, **semantic memory search**, and **per-model analytics**.

| | |
|---|---|
| **UI dev server** | Vite — default port **1984** (`vite.config.js`) |
| **Local API** | Node + `better-sqlite3` — default port **35184** (`API_PORT`) |
| **Version** | **1.10.01** |
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

| Button label | Provider ID | localStorage key |
|---|---|---|
| model short name | `openrouter` (OR Slot 1) | `mf0.settings.aiModel.openrouter.dialogue` |
| model short name | `ollama-kimi` (OR Slot 2) | `mf0.settings.aiModel.ollama-kimi.dialogue` |
| model short name | `ollama-ds` (OR Slot 3) | `mf0.settings.aiModel.ollama-ds.dialogue` |

All three slots share the same `OPENROUTER_API_KEY`. Each slot's **selected model is saved per-dialog** — switching dialogs restores the model that was active in that dialog.

#### Configuring available models: `openrouter-models.txt`

Add or remove models by editing `openrouter-models.txt` in the project root. No rebuild required — the file is read on every Settings open.

```
# Format: model_id | input_per_1M_USD | output_per_1M_USD | short_name
# Lines starting with # and blank lines are ignored.

deepseek/deepseek-v4-flash  | 0.14  | 0.28  | DS Flash
deepseek/deepseek-v4-pro    | 0.435 | 0.87  | DS Pro
anthropic/claude-sonnet-4.6 | 3.00  | 15.00 | Sonnet 4.6
anthropic/claude-haiku-4.5  | 1.00  | 5.00  | Haiku 4.5
# openai/gpt-4o             | 2.50  | 10.00 | GPT-4o
```

`short_name` is displayed on the button and in AI opinion headers. If omitted, the last segment of the model ID is used.

#### Picking a model from the button

Click an OR slot button to activate it — the model picker opens automatically. If the slot is already active, click again to reopen the picker. The picker shows the short name and full model ID for each entry. The list opens upward if there is more space above the button.

---

## Per-dialog memory

The following settings are saved **per dialog** and restored when you switch back:

| What | Storage key pattern |
|---|---|
| Active provider (Gemini, Ollama, OR Slot…) | `mf0.dialog.<dialogId>.provider` |
| Chat mode (default / AI opinion) | `mf0.dialog.mode.<dialogId>` |
| OR Slot 1 model | `mf0.dialog.ormodel.<dialogId>.openrouter` |
| OR Slot 2 model | `mf0.dialog.ormodel.<dialogId>.ollama-kimi` |
| OR Slot 3 model | `mf0.dialog.ormodel.<dialogId>.ollama-ds` |

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

For OpenRouter, costs are calculated **per model** using the prices from `openrouter-models.txt` — column 2 = input $/1M tokens, column 3 = output $/1M tokens. The `responding_model_id` column in `conversation_turns` records the exact model used for each turn, so usage is attributed correctly even when you switch models mid-project.

Restarting the server reloads prices from the file (cache is in-process only).

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
| `openrouter-models.txt` | OpenRouter model list with prices and short names |
| `server/api.mjs` | Express bootstrap — loads OR prices at startup |
| `server/https-proxy.mjs` | Standalone HTTPS reverse proxy with auto self-signed cert |
| `server/routes/` | Route modules (health, LLM proxy, themes, analytics, localfs, auth, …) |
| `server/routes/auth.mjs` | Login / logout / register / user management |
| `server/routes/localfs.mjs` | LocalFS sandbox API |
| `server/middleware/auth.mjs` | `requireAuth` / `requireAdmin` Express middleware |
| `server/db/` | Schema, migrations, analytics queries |
| `server/db/auth.mjs` | User + session CRUD, password hashing (scrypt) |
| `server/db/openrouterPrices.mjs` | Shared runtime OR price map (singleton) |
| `server/services/memoryGraphEmbeddings.mjs` | Server-side embedding ingest + semantic candidate search |
| `data/` | Runtime SQLite and caches |
| `certs/` | TLS cert + key (auto-generated if absent) |
| `HANDOFF.md` | Full technical orientation |

---

## Differences from upstream

| Feature | Upstream | This fork |
|---|---|---|
| 4th provider | Perplexity | Ollama (local, gemma4) |
| OpenRouter | — | Three independent slots with per-dialog model memory |
| Model picker | Settings only | Inline dropdown on every OR slot button |
| Button height | Default | ×1.5 vertical padding |
| File system access | — | LocalFS sandbox (7 tools, works with any model) |
| AI opinion participants | All providers | Configurable checkboxes in Settings |
| Per-dialog memory | Provider only | Provider + AI opinion mode + OR model per slot |
| OpenRouter analytics | — | Per-slot **and** per-model pricing from `openrouter-models.txt` |
| Memory retrieval | Lexical + LLM rerank | + Semantic layer (pplx-embed-v1-4b, cosine, pool boosting) |
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
