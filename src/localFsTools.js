/**
 * LocalFS tool execution layer for MF0-1984.
 *
 * Works with ANY LLM model — no function calling API required.
 * The model uses a simple XML-like syntax in its reply:
 *
 *   <tool>list_files("docs")</tool>
 *   <tool>read_file("notes.md")</tool>
 *   <tool>write_file("output.md", "# Result\n...")</tool>
 *   <tool>delete_file("old.txt")</tool>
 *
 * After model reply, call processToolCalls(text) to execute any tool calls
 * found in the text. Returns the text with tool blocks replaced by results,
 * or null if no tool calls found.
 *
 * Multi-turn: if tool calls were found and executed, the results are fed back
 * to the model as a follow-up so it can produce a final answer.
 */

// ── Config cache ──────────────────────────────────────────────────────────────
let _config = null;

/**
 * Fetch LocalFS config from server (once, then cached).
 * @returns {Promise<{enabled: boolean, root: string|null}>}
 */
export async function getLocalFsConfig() {
  if (_config) return _config;
  try {
    const res = await fetch("/api/localfs/config");
    const data = await res.json();
    _config = { enabled: Boolean(data.enabled), root: data.root ?? null };
  } catch {
    _config = { enabled: false, root: null };
  }
  return _config;
}

// ── System prompt injection ───────────────────────────────────────────────────
/**
 * Returns a block to append to the system prompt when LocalFS is enabled.
 * Designed to work with any model — uses plain text with XML-like syntax.
 * @param {string|null} root
 * @returns {string}
 */
export function buildLocalFsSystemBlock(root) {
  return `
=== LOCAL FILE SYSTEM ACCESS ===
You have access to the user's local file system folder: ${root ?? "sandbox"}
Use these tool calls in your reply when the user asks to read, write, list, search, or edit files.
Always use the exact XML-like syntax below — one call per line, no extra text inside the tags.

Available tools:

  LIST & NAVIGATE
  <tool>list_files(".")</tool>                                      — list files in root directory
  <tool>list_files("src")</tool>                                    — list files in a subdirectory
  <tool>list_files(".", recursive, "js,ts,mjs")</tool>              — recursive tree, filter by extension
  <tool>find_files("*.md")</tool>                                   — find files matching glob in root
  <tool>find_files("**/*.js", "src")</tool>                         — find recursively under src/

  READ
  <tool>read_file("filename.txt")</tool>                            — read entire file (up to 4 MB)
  <tool>read_lines("src/main.js", 100, 200)</tool>                  — read lines 100-200 (1-indexed)

  SEARCH
  <tool>grep_file("src/main.js", "turnPayload")</tool>              — find lines containing text
  <tool>grep_file("src/main.js", "turnPayload", 3)</tool>           — with 3 lines of context
  <tool>grep_file("src/main.js", "async function \\w+", 0, regex)</tool> — regex search

  WRITE & EDIT
  <tool>write_file("path", "content")</tool>                        — create or overwrite a file
  <tool>patch_file("path", "old fragment", "new fragment")</tool>   — replace unique fragment

  FILE OPERATIONS
  <tool>move_file("old/path.js", "new/path.js")</tool>              — move or rename file/directory
  <tool>copy_file("src/file.js", "dst/file.js")</tool>              — copy file or directory
  <tool>delete_file("filename.txt")</tool>                          — delete a file
  <tool>make_dir("path/to/dir")</tool>                              — create directory (recursive)
  <tool>remove_dir("path/to/dir")</tool>                            — remove empty directory
  <tool>remove_dir("path/to/dir", recursive)</tool>                 — remove directory with contents

  SHELL
  <tool>bash("node --check src/main.js")</tool>                     — run command in sandbox root
  <tool>bash("npm test", "src")</tool>                              — run command in subdirectory
  <tool>bash("python3 -c \"print('hello')\"")                     — inline script

Rules:
- Paths are relative to the sandbox root — never use absolute paths or ../
- For large files (> 300 lines) prefer read_lines or grep_file over read_file
- patch_file requires old_fragment to appear EXACTLY ONCE in the file — make it unique
- After listing or reading files, summarize what you found for the user
- Never invent file contents — only report what tools return
- If a tool returns an error, tell the user what went wrong
- To understand a large file: first grep for relevant symbols, then read_lines around the hits
- After writing or patching code: use bash("node --check <file>") to verify syntax
- bash is sandboxed: no sudo, no curl/wget, no network tools; timeout 30s

MULTI-LINE PATCH SYNTAX (preferred for patch_file with code blocks):
Instead of patch_file() with escaped strings, use the <patch> tag for multi-line replacements:

  <patch path="src/main.js">
  <old>
  exact original lines here
  (must appear exactly once in the file)
  </old>
  <new>
  replacement lines here
  </new>
  </patch>

Rules for <patch>:
- path is relative to sandbox root
- Content inside <old> and <new> is taken literally — no escaping needed
- Leading/trailing blank lines inside <old>/<new> are stripped
- old content must appear EXACTLY ONCE in the file
`.trim();
}

// ── Tool call parser ──────────────────────────────────────────────────────────
const TOOL_RE = /<tool>([\s\S]*?)<\/tool>/g;

// ── Patch tag parser ──────────────────────────────────────────────────────────
// Matches: <patch path="..."><old>...</old><new>...</new></patch>
// Whitespace around <old>/<new> content is stripped.
const PATCH_RE = /<patch\s+path="([^"]+)"\s*>([\s\S]*?)<\/patch>/g;

/**
 * Parse all <patch path="..."><old>...</old><new>...</new></patch> blocks.
 * @param {string} text
 * @returns {Array<{raw: string, path: string, oldStr: string, newStr: string}>}
 */
function parsePatchTags(text) {
  const patches = [];
  let m;
  PATCH_RE.lastIndex = 0;
  while ((m = PATCH_RE.exec(text)) !== null) {
    const path  = m[1].trim();
    const inner = m[2];
    const oldMatch = inner.match(/<old>([\s\S]*?)<\/old>/);
    const newMatch = inner.match(/<new>([\s\S]*?)<\/new>/);
    if (!oldMatch || !newMatch) continue;
    // Strip exactly one leading and one trailing newline (the ones after/before the tag)
    const oldStr = oldMatch[1].replace(/^\n/, "").replace(/\n$/, "");
    const newStr = newMatch[1].replace(/^\n/, "").replace(/\n$/, "");
    patches.push({ raw: m[0], path, oldStr, newStr });
  }
  return patches;
}

/**
 * Execute a single patch tag operation.
 * @param {{path: string, oldStr: string, newStr: string}} patch
 * @returns {Promise<string>}
 */
async function executePatchTag(patch) {
  try {
    const res  = await fetch("/api/localfs/patch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: patch.path, old_str: patch.oldStr, new_str: patch.newStr }),
    });
    const data = await res.json();
    if (!data.ok) return `Patch error: ${data.error}`;
    return `File "${data.path}" patched successfully (${data.sizeBytes} bytes).`;
  } catch (e) {
    return `Patch error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * Parse all <tool>...</tool> blocks from model output.
 * @param {string} text
 * @returns {Array<{raw: string, name: string, args: string[]}>}
 */
export function parseToolCalls(text) {
  const calls = [];
  let m;
  TOOL_RE.lastIndex = 0;
  while ((m = TOOL_RE.exec(text)) !== null) {
    const inner = m[1].trim();
    // Parse: function_name("arg1", "arg2")
    const fnMatch = inner.match(/^(\w+)\(([\s\S]*)\)$/);
    if (!fnMatch) continue;
    const name = fnMatch[1];
    const argsRaw = fnMatch[2];
    const args = parseArgs(argsRaw);
    calls.push({ raw: m[0], name, args });
  }
  return calls;
}

/**
 * Simple argument parser — handles quoted strings with escaped quotes.
 * @param {string} argsRaw
 * @returns {string[]}
 */
function parseArgs(argsRaw) {
  const args = [];
  let i = 0;
  while (i < argsRaw.length) {
    // Skip whitespace and commas
    while (i < argsRaw.length && (argsRaw[i] === " " || argsRaw[i] === ",")) i++;
    if (i >= argsRaw.length) break;

    if (argsRaw[i] === '"' || argsRaw[i] === "'") {
      // Quoted string
      const quote = argsRaw[i];
      i++;
      let str = "";
      while (i < argsRaw.length) {
        if (argsRaw[i] === "\\" && i + 1 < argsRaw.length) {
          const next = argsRaw[i + 1];
          if (next === "n") { str += "\n"; i += 2; }
          else if (next === "t") { str += "\t"; i += 2; }
          else { str += next; i += 2; }
        } else if (argsRaw[i] === quote) {
          i++;
          break;
        } else {
          str += argsRaw[i];
          i++;
        }
      }
      args.push(str);
    } else {
      // Unquoted token (e.g. bare ".")
      let tok = "";
      while (i < argsRaw.length && argsRaw[i] !== "," && argsRaw[i] !== " ") {
        tok += argsRaw[i];
        i++;
      }
      if (tok) args.push(tok);
    }
  }
  return args;
}

// ── Tool executor ─────────────────────────────────────────────────────────────
/**
 * Execute a single parsed tool call against the API.
 * @param {{name: string, args: string[]}} call
 * @returns {Promise<string>} human-readable result
 */
async function executeToolCall(call) {
  const { name, args } = call;
  try {
    if (name === "list_files") {
      const path      = args[0] ?? ".";
      const recursive = args.includes("recursive");
      const ext       = args.find((a) => a !== "recursive" && a !== path) ?? "";
      const params    = new URLSearchParams({ path });
      if (recursive) params.set("recursive", "1");
      if (ext) params.set("ext", ext);
      const res  = await fetch(`/api/localfs/list?${params}`);
      const data = await res.json();
      if (!data.ok) return `Error: ${data.error}`;
      if (data.entries.length === 0) return `Directory "${data.path}" is empty.`;
      const indent = (p) => "  ".repeat((p.split("/").length - 1));
      const lines = data.entries.map((e) =>
        e.type === "dir"
          ? `${indent(e.path)}[dir]  ${e.name}/`
          : `${indent(e.path)}[file] ${e.name}  (${((e.size ?? 0) / 1024).toFixed(1)} KB)`,
      );
      const suffix = data.truncated ? "\n(truncated — use ext filter or narrower path)" : "";
      return `Contents of "${data.path}":\n${lines.join("\n")}${suffix}`;
    }

    if (name === "read_file") {
      const path = args[0] ?? "";
      if (!path) return "Error: path required";
      const res  = await fetch(`/api/localfs/read?path=${encodeURIComponent(path)}`);
      const data = await res.json();
      if (!data.ok) return `Error: ${data.error}`;
      return `File "${data.path}" (${data.sizeBytes} bytes):\n\`\`\`\n${data.content}\n\`\`\``;
    }

    if (name === "read_lines") {
      const path = args[0] ?? "";
      const from = args[1] ?? "1";
      const to   = args[2] ?? String(Number(from) + 99);
      if (!path) return "Error: path required";
      const params = new URLSearchParams({ path, from, to });
      const res  = await fetch(`/api/localfs/read_lines?${params}`);
      const data = await res.json();
      if (!data.ok) return `Error: ${data.error}`;
      return `File "${data.path}" lines ${data.from}–${data.to} (of ${data.totalLines}):\n\`\`\`\n${data.content}\n\`\`\``;
    }

    if (name === "grep_file") {
      const path     = args[0] ?? "";
      const pattern  = args[1] ?? "";
      const ctx      = args[2] ?? "0";
      const useRegex = args.includes("regex");
      if (!path)    return "Error: path required";
      if (!pattern) return "Error: pattern required";
      const params   = new URLSearchParams({ path, pattern, context: ctx });
      if (useRegex) params.set("regex", "1");
      const res  = await fetch(`/api/localfs/grep?${params}`);
      const data = await res.json();
      if (!data.ok) return `Error: ${data.error}`;
      if (data.matchCount === 0) return `No matches for "${pattern}" in "${data.path}".`;
      const blocks = data.matches.map((block) =>
        block.map((l) => `${l.isMatch ? ">" : " "} ${String(l.lineNo).padStart(5)} │ ${l.text}`).join("\n"),
      );
      const suffix = data.truncated ? `\n(showing first ${data.matchCount} matches)` : "";
      return `grep "${pattern}" in "${data.path}" — ${data.matchCount} match(es):\n${blocks.join("\n---\n")}${suffix}`;
    }

    if (name === "write_file") {
      const path    = args[0] ?? "";
      const content = args[1] ?? "";
      if (!path) return "Error: path required";
      const res  = await fetch("/api/localfs/write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, content }),
      });
      const data = await res.json();
      if (!data.ok) return `Error: ${data.error}`;
      return `File "${data.path}" written successfully (${data.sizeBytes} bytes).`;
    }

    if (name === "patch_file") {
      const path    = args[0] ?? "";
      const old_str = args[1] ?? "";
      const new_str = args[2] ?? "";
      if (!path)    return "Error: path required";
      if (!old_str) return "Error: old_str required";
      const res  = await fetch("/api/localfs/patch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, old_str, new_str }),
      });
      const data = await res.json();
      if (!data.ok) return `Error: ${data.error}`;
      return `File "${data.path}" patched successfully (${data.sizeBytes} bytes).`;
    }

    if (name === "delete_file") {
      const path = args[0] ?? "";
      if (!path) return "Error: path required";
      const res  = await fetch(`/api/localfs/delete?path=${encodeURIComponent(path)}`, { method: "DELETE" });
      const data = await res.json();
      if (!data.ok) return `Error: ${data.error}`;
      return `File "${data.path}" deleted successfully.`;
    }

    if (name === "find_files") {
      const pattern = args[0] ?? "*";
      const path    = args[1] ?? ".";
      const params  = new URLSearchParams({ pattern, path });
      const res  = await fetch(`/api/localfs/find?${params}`);
      const data = await res.json();
      if (!data.ok) return `Error: ${data.error}`;
      if (!data.results.length) return `No files matching "${pattern}".`;
      const lines = data.results.map((e) => `${e.path}${e.type === "dir" ? "/" : ""}`).join("\n");
      return `Found ${data.results.length} result(s)${data.truncated ? " (truncated)" : ""}:\n${lines}`;
    }

    if (name === "move_file") {
      const from = args[0] ?? "", to = args[1] ?? "";
      if (!from || !to) return "Error: from and to required";
      const res  = await fetch("/api/localfs/move", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from, to }),
      });
      const data = await res.json();
      if (!data.ok) return `Error: ${data.error}`;
      return `Moved "${data.from}" → "${data.to}".`;
    }

    if (name === "copy_file") {
      const from = args[0] ?? "", to = args[1] ?? "";
      if (!from || !to) return "Error: from and to required";
      const res  = await fetch("/api/localfs/copy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from, to }),
      });
      const data = await res.json();
      if (!data.ok) return `Error: ${data.error}`;
      return `Copied "${data.from}" → "${data.to}".`;
    }

    if (name === "make_dir") {
      const path = args[0] ?? "";
      if (!path) return "Error: path required";
      const res  = await fetch("/api/localfs/mkdir", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
      const data = await res.json();
      if (!data.ok) return `Error: ${data.error}`;
      return `Directory "${data.path}" created.`;
    }

    if (name === "remove_dir") {
      const path      = args[0] ?? "";
      const recursive = String(args[1] ?? "").trim() === "recursive";
      if (!path) return "Error: path required";
      const params = new URLSearchParams({ path, recursive: recursive ? "1" : "0" });
      const res  = await fetch(`/api/localfs/rmdir?${params}`, { method: "DELETE" });
      const data = await res.json();
      if (!data.ok) return `Error: ${data.error}`;
      return `Directory "${data.path}" removed${recursive ? " (recursive)" : ""}.`;
    }

    if (name === "bash") {
      const cmd = args[0] ?? "";
      const cwd = args[1] ?? undefined;
      if (!cmd) return "Error: cmd required";
      const res  = await fetch("/api/localfs/bash", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cmd, cwd }),
      });
      const data = await res.json();
      if (!data.ok && data.error) return `Error: ${data.error}`;
      const parts = [];
      if (data.stdout?.trim()) parts.push(data.stdout.trim());
      if (data.stderr?.trim()) parts.push(`[stderr]\n${data.stderr.trim()}`);
      if (!parts.length) parts.push(data.exitCode === 0 ? "(no output)" : "(no output, non-zero exit)");
      return `Exit ${data.exitCode}:\n${parts.join("\n")}`;
    }

    return `Error: unknown tool "${name}"`;
  } catch (e) {
    return `Error executing ${name}: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// ── Main processor ────────────────────────────────────────────────────────────
/**
 * Scan model text for tool calls, execute them, return enriched text.
 * Returns null if no tool calls found (model reply needs no processing).
 *
 * @param {string} modelText   raw text from model
 * @returns {Promise<{hadTools: boolean, processedText: string, toolResults: string}>}
 */
export async function processToolCalls(modelText) {
  const calls   = parseToolCalls(modelText);
  const patches = parsePatchTags(modelText);
  if (calls.length === 0 && patches.length === 0) {
    return { hadTools: false, processedText: modelText, toolResults: "" };
  }

  let enriched = modelText;
  const resultLines = [];

  // Execute <tool> calls in sequence
  for (const call of calls) {
    const result = await executeToolCall(call);
    resultLines.push(`\n**[Tool: ${call.name}]**\n${result}`);
    enriched = enriched.replace(
      call.raw,
      `\n> 🔧 \`${call.name}(${call.args.map((a) => JSON.stringify(a)).join(", ")})\`\n${result}\n`,
    );
  }

  // Execute <patch> blocks in sequence
  for (const patch of patches) {
    const result = await executePatchTag(patch);
    resultLines.push(`\n**[Patch: ${patch.path}]**\n${result}`);
    enriched = enriched.replace(
      patch.raw,
      `\n> 🔧 \`patch_file("${patch.path}")\`\n${result}\n`,
    );
  }

  return {
    hadTools: true,
    processedText: enriched,
    toolResults: resultLines.join("\n\n"),
  };
}

/**
 * Build the follow-up user message to send back to the model
 * after tool execution, so it can produce a final synthesized answer.
 *
 * @param {string} toolResults
 * @returns {string}
 */
export function buildToolResultMessage(toolResults) {
  return `Tool execution results:\n\n${toolResults}\n\nPlease provide your final answer based on these results.`;
}
