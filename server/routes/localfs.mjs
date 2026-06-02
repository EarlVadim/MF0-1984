/**
 * Local filesystem sandbox API.
 * All operations are confined to LOCALFS_ROOT from .env.
 * Enabled only when LOCALFS_ENABLED=true is set.
 *
 * Routes:
 *   GET  /api/localfs/config                               return root + enabled flag
 *   GET  /api/localfs/list?path=<rel>&recursive=1&ext=js   list files/dirs
 *   GET  /api/localfs/find?pattern=glob&path=<rel>         find files by glob pattern
 *   GET  /api/localfs/read?path=<rel>                      read whole file (text)
 *   GET  /api/localfs/read_lines?path=<rel>&from=1&to=80   read line range
 *   GET  /api/localfs/grep?path=<rel>&pattern=x&context=3  search in file
 *   POST /api/localfs/write   { path, content }            write/overwrite file
 *   POST /api/localfs/patch   { path, old_str, new_str }   replace unique fragment
 *   POST /api/localfs/move    { from, to }                 move/rename file or dir
 *   POST /api/localfs/copy    { from, to }                 copy file
 *   POST /api/localfs/mkdir   { path }                     create directory tree
 *   POST /api/localfs/bash    { cmd, cwd? }                run shell command in sandbox
 *   DELETE /api/localfs/delete?path=<rel>                  delete file (not dir)
 *   DELETE /api/localfs/rmdir?path=<rel>&recursive=1       delete directory
 */
import { Router } from "express";
import {
  existsSync, statSync, readdirSync,
  readFileSync, writeFileSync, unlinkSync,
  mkdirSync, cpSync, renameSync, rmSync,
} from "node:fs";
import { resolve, join, relative, extname, basename, dirname } from "node:path";
import { execSync } from "node:child_process";

const router = Router();

// ── Config ────────────────────────────────────────────────────────────────────
const ENABLED = String(process.env.LOCALFS_ENABLED ?? "").trim().toLowerCase() === "true";
const ROOT    = String(process.env.LOCALFS_ROOT    ?? "").trim();

// Auto-create ROOT directory if it doesn't exist
if (ENABLED && ROOT) {
  const rootAbs = resolve(ROOT);
  if (!existsSync(rootAbs)) {
    try {
      mkdirSync(rootAbs, { recursive: true });
      console.log(`[localfs] Created sandbox root: ${rootAbs}`);
    } catch (e) {
      console.warn(`[localfs] Failed to create sandbox root ${rootAbs}:`, e?.message);
    }
  }
}

/** Max file size for read (4 MB) */
const MAX_READ_BYTES = 4 * 1024 * 1024;
/** Max write size (4 MB) */
const MAX_WRITE_BYTES = 4 * 1024 * 1024;

// ── Sandbox helper ────────────────────────────────────────────────────────────
/**
 * Resolve a user-supplied relative path inside ROOT.
 * Throws if the result escapes the sandbox.
 * @param {string} rel
 * @returns {string} absolute safe path
 */
function safePath(rel) {
  if (!ENABLED || !ROOT) throw new Error("LocalFS not enabled");
  const abs = resolve(join(ROOT, String(rel ?? ".")));
  // Ensure resolved path starts with ROOT (prevent path traversal)
  const rootAbs = resolve(ROOT);
  if (!abs.startsWith(rootAbs + "/") && abs !== rootAbs) {
    throw new Error("Path outside sandbox");
  }
  return abs;
}

function notEnabled(res) {
  return res.status(503).json({ ok: false, error: "LocalFS not enabled. Set LOCALFS_ENABLED=true and LOCALFS_ROOT=/path in .env" });
}

// ── GET /api/localfs/config ───────────────────────────────────────────────────
router.get("/localfs/config", (_req, res) => {
  res.json({
    ok: true,
    enabled: ENABLED,
    root: ENABLED ? ROOT : null,
  });
});

// ── GET /api/localfs/list ─────────────────────────────────────────────────────
// ?path=.  &recursive=1  &ext=js,ts,mjs  &max=200
const MAX_LIST_ENTRIES = 500;

function collectEntries(dirAbs, rootAbs, recursive, extFilter, results, limit) {
  if (results.length >= limit) return;
  let names;
  try { names = readdirSync(dirAbs, { withFileTypes: true }); } catch { return; }
  for (const e of names) {
    if (results.length >= limit) break;
    const absChild = join(dirAbs, e.name);
    const rel = relative(rootAbs, absChild);
    if (e.isDirectory()) {
      results.push({ name: e.name, path: rel, type: "dir", size: null });
      if (recursive) collectEntries(absChild, rootAbs, true, extFilter, results, limit);
    } else if (e.isFile()) {
      if (extFilter.length && !extFilter.includes(extname(e.name).replace(".", ""))) continue;
      results.push({ name: e.name, path: rel, type: "file", size: statSync(absChild).size });
    }
  }
}

router.get("/localfs/list", (req, res) => {
  if (!ENABLED) return notEnabled(res);
  try {
    const abs     = safePath(req.query.path ?? ".");
    const recur   = req.query.recursive === "1" || req.query.recursive === "true";
    const extRaw  = String(req.query.ext ?? "").trim();
    const extFilter = extRaw ? extRaw.split(",").map((s) => s.trim().replace(/^\./, "")) : [];
    const limit   = Math.min(MAX_LIST_ENTRIES, Number(req.query.max) || MAX_LIST_ENTRIES);

    if (!existsSync(abs)) return res.status(404).json({ ok: false, error: "Path not found" });
    const stat = statSync(abs);
    if (!stat.isDirectory()) return res.status(400).json({ ok: false, error: "Not a directory" });

    const rootAbs = resolve(ROOT);
    const relPath = relative(rootAbs, abs) || ".";
    const entries = [];
    collectEntries(abs, rootAbs, recur, extFilter, entries, limit);
    res.json({ ok: true, path: relPath, entries, truncated: entries.length >= limit });
  } catch (e) {
    res.status(400).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

// ── GET /api/localfs/read ─────────────────────────────────────────────────────
router.get("/localfs/read", (req, res) => {
  if (!ENABLED) return notEnabled(res);
  try {
    const abs = safePath(req.query.path ?? "");
    if (!existsSync(abs)) return res.status(404).json({ ok: false, error: "File not found" });
    const stat = statSync(abs);
    if (!stat.isFile()) return res.status(400).json({ ok: false, error: "Not a file" });
    if (stat.size > MAX_READ_BYTES) {
      return res.status(413).json({ ok: false, error: `File too large (max ${MAX_READ_BYTES / 1024}KB)` });
    }
    const content = readFileSync(abs, "utf-8");
    const relPath = relative(resolve(ROOT), abs);
    res.json({ ok: true, path: relPath, content, sizeBytes: stat.size });
  } catch (e) {
    res.status(400).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

// ── POST /api/localfs/write ───────────────────────────────────────────────────
router.post("/localfs/write", (req, res) => {
  if (!ENABLED) return notEnabled(res);
  try {
    const { path: relPath, content } = req.body ?? {};
    if (!relPath) return res.status(400).json({ ok: false, error: "path required" });
    if (content === undefined || content === null) {
      return res.status(400).json({ ok: false, error: "content required" });
    }
    const str = String(content);
    if (Buffer.byteLength(str, "utf-8") > MAX_WRITE_BYTES) {
      return res.status(413).json({ ok: false, error: `Content too large (max ${MAX_WRITE_BYTES / 1024}KB)` });
    }
    const abs = safePath(relPath);
    // Create parent dirs if needed
    const dir = abs.slice(0, abs.lastIndexOf("/"));
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(abs, str, "utf-8");
    const rel = relative(resolve(ROOT), abs);
    res.json({ ok: true, path: rel, sizeBytes: Buffer.byteLength(str, "utf-8") });
  } catch (e) {
    res.status(400).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

// ── GET /api/localfs/read_lines ───────────────────────────────────────────────
// ?path=src/main.js  &from=6590  &to=6640
// Lines are 1-indexed. Returns the requested slice with line numbers.
router.get("/localfs/read_lines", (req, res) => {
  if (!ENABLED) return notEnabled(res);
  try {
    const abs = safePath(req.query.path ?? "");
    if (!existsSync(abs)) return res.status(404).json({ ok: false, error: "File not found" });
    const stat = statSync(abs);
    if (!stat.isFile()) return res.status(400).json({ ok: false, error: "Not a file" });
    if (stat.size > MAX_READ_BYTES) {
      return res.status(413).json({ ok: false, error: `File too large (max ${MAX_READ_BYTES / 1024}KB)` });
    }

    const from = Math.max(1, Number(req.query.from) || 1);
    const to   = Number(req.query.to) || from + 99;   // default: 100 lines
    if (to < from) return res.status(400).json({ ok: false, error: "to must be >= from" });
    if (to - from > 2000) return res.status(400).json({ ok: false, error: "Range too large (max 2000 lines)" });

    const allLines = readFileSync(abs, "utf-8").split("\n");
    const totalLines = allLines.length;
    const slice = allLines.slice(from - 1, to);  // convert to 0-indexed
    const numbered = slice.map((l, i) => `${String(from + i).padStart(5, " ")}\t${l}`).join("\n");
    const relPath = relative(resolve(ROOT), abs);

    res.json({
      ok: true,
      path: relPath,
      from,
      to: Math.min(to, totalLines),
      totalLines,
      content: numbered,
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

// ── GET /api/localfs/grep ─────────────────────────────────────────────────────
// ?path=src/main.js  &pattern=turnPayload  &context=3  &regex=0  &max_matches=50
// Returns matching lines with surrounding context and 1-indexed line numbers.
const MAX_GREP_MATCHES = 200;

router.get("/localfs/grep", (req, res) => {
  if (!ENABLED) return notEnabled(res);
  try {
    const abs = safePath(req.query.path ?? "");
    if (!existsSync(abs)) return res.status(404).json({ ok: false, error: "File not found" });
    const stat = statSync(abs);
    if (!stat.isFile()) return res.status(400).json({ ok: false, error: "Not a file" });
    if (stat.size > MAX_READ_BYTES) {
      return res.status(413).json({ ok: false, error: `File too large (max ${MAX_READ_BYTES / 1024}KB)` });
    }

    const pattern  = String(req.query.pattern ?? "").trim();
    if (!pattern) return res.status(400).json({ ok: false, error: "pattern required" });
    const context  = Math.min(20, Math.max(0, Number(req.query.context) || 0));
    const useRegex = req.query.regex === "1" || req.query.regex === "true";
    const maxMatches = Math.min(MAX_GREP_MATCHES, Number(req.query.max_matches) || 50);

    let re;
    try {
      re = useRegex ? new RegExp(pattern, "i") : null;
    } catch {
      return res.status(400).json({ ok: false, error: "Invalid regex pattern" });
    }

    const lines = readFileSync(abs, "utf-8").split("\n");
    const totalLines = lines.length;
    const matches = [];
    const includedLines = new Set();

    for (let i = 0; i < lines.length && matches.length < maxMatches; i++) {
      const hit = re ? re.test(lines[i]) : lines[i].includes(pattern);
      if (!hit) continue;

      const ctxFrom = Math.max(0, i - context);
      const ctxTo   = Math.min(lines.length - 1, i + context);
      const block = [];

      for (let j = ctxFrom; j <= ctxTo; j++) {
        if (!includedLines.has(j)) {
          block.push({ lineNo: j + 1, text: lines[j], isMatch: j === i });
          includedLines.add(j);
        }
      }
      if (block.length) matches.push(block);
    }

    const relPath = relative(resolve(ROOT), abs);
    res.json({
      ok: true,
      path: relPath,
      pattern,
      totalLines,
      matchCount: matches.length,
      truncated: matches.length >= maxMatches,
      matches,
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

// ── POST /api/localfs/patch ───────────────────────────────────────────────────
// { path, old_str, new_str }
// Replaces exactly one occurrence of old_str with new_str.
// Fails if old_str appears 0 or 2+ times (ambiguous).
router.post("/localfs/patch", (req, res) => {
  if (!ENABLED) return notEnabled(res);
  try {
    const { path: relPath, old_str, new_str } = req.body ?? {};
    if (!relPath)  return res.status(400).json({ ok: false, error: "path required" });
    if (old_str === undefined || old_str === null) {
      return res.status(400).json({ ok: false, error: "old_str required" });
    }
    if (new_str === undefined || new_str === null) {
      return res.status(400).json({ ok: false, error: "new_str required" });
    }

    const abs = safePath(relPath);
    if (!existsSync(abs)) return res.status(404).json({ ok: false, error: "File not found" });
    const stat = statSync(abs);
    if (!stat.isFile()) return res.status(400).json({ ok: false, error: "Not a file" });
    if (stat.size > MAX_READ_BYTES) {
      return res.status(413).json({ ok: false, error: `File too large (max ${MAX_READ_BYTES / 1024}KB)` });
    }

    const original = readFileSync(abs, "utf-8");
    const oldStr = String(old_str);
    const newStr = String(new_str);

    // Count occurrences
    let count = 0;
    let pos = 0;
    while ((pos = original.indexOf(oldStr, pos)) !== -1) { count++; pos += oldStr.length; }

    if (count === 0) {
      return res.status(400).json({ ok: false, error: "old_str not found in file" });
    }
    if (count > 1) {
      return res.status(400).json({ ok: false, error: `old_str appears ${count} times — must be unique` });
    }

    const patched = original.replace(oldStr, newStr);
    const result = Buffer.byteLength(patched, "utf-8");
    if (result > MAX_WRITE_BYTES) {
      return res.status(413).json({ ok: false, error: `Result too large (max ${MAX_WRITE_BYTES / 1024}KB)` });
    }

    writeFileSync(abs, patched, "utf-8");
    const rel = relative(resolve(ROOT), abs);
    res.json({ ok: true, path: rel, sizeBytes: result });
  } catch (e) {
    res.status(400).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

// ── DELETE /api/localfs/delete ────────────────────────────────────────────────
router.delete("/localfs/delete", (req, res) => {
  if (!ENABLED) return notEnabled(res);
  try {
    const abs = safePath(req.query.path ?? "");
    if (!existsSync(abs)) return res.status(404).json({ ok: false, error: "File not found" });
    const stat = statSync(abs);
    if (!stat.isFile()) return res.status(400).json({ ok: false, error: "Can only delete files, not directories" });
    const rel = relative(resolve(ROOT), abs);
    unlinkSync(abs);
    res.json({ ok: true, path: rel, deleted: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

// ── GET /api/localfs/find ─────────────────────────────────────────────────────
// Find files by glob-style pattern (fnmatch via regex). pattern supports * and **
router.get("/localfs/find", (req, res) => {
  if (!ENABLED) return notEnabled(res);
  try {
    const base    = safePath(req.query.path ?? ".");
    const pattern = String(req.query.pattern ?? "*").trim();
    const limit   = Math.min(2000, Number(req.query.max) || 500);
    const rootAbs = resolve(ROOT);

    // Convert glob to regex: ** = any path, * = any filename chars
    const reStr = "^" + pattern
      .replace(/[.+^${}()|[\\\]]/g, "\$&")
      .replace(/\*\*/g, " ")
      .replace(/\*/g, "[^/]*")
      .replace(/ /g, ".*") + "$";
    const re = new RegExp(reStr, "i");

    const results = [];
    function walk(dir) {
      if (results.length >= limit) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (results.length >= limit) break;
        const abs = join(dir, entry.name);
        const rel = relative(rootAbs, abs);
        if (re.test(rel) || re.test(entry.name)) {
          results.push({ path: rel, type: entry.isDirectory() ? "dir" : "file" });
        }
        if (entry.isDirectory()) walk(abs);
      }
    }
    walk(base);
    res.json({ ok: true, pattern, results, truncated: results.length >= limit });
  } catch (e) {
    res.status(400).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

// ── POST /api/localfs/move ────────────────────────────────────────────────────
router.post("/localfs/move", (req, res) => {
  if (!ENABLED) return notEnabled(res);
  try {
    const { from, to } = req.body ?? {};
    if (!from || !to) return res.status(400).json({ ok: false, error: "from and to required" });
    const absFrom = safePath(from);
    const absTo   = safePath(to);
    if (!existsSync(absFrom)) return res.status(404).json({ ok: false, error: "Source not found" });
    const toDir = dirname(absTo);
    if (!existsSync(toDir)) mkdirSync(toDir, { recursive: true });
    renameSync(absFrom, absTo);
    const rootAbs = resolve(ROOT);
    res.json({ ok: true, from: relative(rootAbs, absFrom), to: relative(rootAbs, absTo) });
  } catch (e) {
    res.status(400).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

// ── POST /api/localfs/copy ────────────────────────────────────────────────────
router.post("/localfs/copy", (req, res) => {
  if (!ENABLED) return notEnabled(res);
  try {
    const { from, to } = req.body ?? {};
    if (!from || !to) return res.status(400).json({ ok: false, error: "from and to required" });
    const absFrom = safePath(from);
    const absTo   = safePath(to);
    if (!existsSync(absFrom)) return res.status(404).json({ ok: false, error: "Source not found" });
    const toDir = dirname(absTo);
    if (!existsSync(toDir)) mkdirSync(toDir, { recursive: true });
    const stat = statSync(absFrom);
    if (stat.isDirectory()) {
      cpSync(absFrom, absTo, { recursive: true });
    } else {
      cpSync(absFrom, absTo);
    }
    const rootAbs = resolve(ROOT);
    res.json({ ok: true, from: relative(rootAbs, absFrom), to: relative(rootAbs, absTo) });
  } catch (e) {
    res.status(400).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

// ── POST /api/localfs/mkdir ───────────────────────────────────────────────────
router.post("/localfs/mkdir", (req, res) => {
  if (!ENABLED) return notEnabled(res);
  try {
    const { path: relPath } = req.body ?? {};
    if (!relPath) return res.status(400).json({ ok: false, error: "path required" });
    const abs = safePath(relPath);
    mkdirSync(abs, { recursive: true });
    res.json({ ok: true, path: relative(resolve(ROOT), abs) });
  } catch (e) {
    res.status(400).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

// ── DELETE /api/localfs/rmdir ─────────────────────────────────────────────────
router.delete("/localfs/rmdir", (req, res) => {
  if (!ENABLED) return notEnabled(res);
  try {
    const abs = safePath(req.query.path ?? "");
    if (!existsSync(abs)) return res.status(404).json({ ok: false, error: "Path not found" });
    const stat = statSync(abs);
    if (!stat.isDirectory()) return res.status(400).json({ ok: false, error: "Not a directory" });
    const recursive = req.query.recursive === "1" || req.query.recursive === "true";
    rmSync(abs, { recursive, force: false });
    res.json({ ok: true, path: relative(resolve(ROOT), abs), recursive });
  } catch (e) {
    res.status(400).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

// ── POST /api/localfs/bash ────────────────────────────────────────────────────
// Run a shell command sandboxed inside LOCALFS_ROOT.
// Hard limits: 30s timeout, 512KB output, no network (fire-walled by env, not by this code).
// The cwd is always resolved inside ROOT; PATH traversal in cmd is the user's responsibility.
const BASH_TIMEOUT_MS  = 30_000;
const BASH_MAX_OUTPUT  = 512 * 1024;

// Commands that could escape the sandbox or cause damage — blocked unconditionally.
const BASH_BLOCKED_RE = /(sudo|su|curl|wget|nc|ncat|netcat|ssh|scp|sftp|chmod\s+[0-9]*[sS]|chown|mount|umount|mkfs|dd\s+of=\/|rm\s+-rf\s+\/|>(\/dev\/sd|\/proc|\/sys))/;

router.post("/localfs/bash", (req, res) => {
  if (!ENABLED) return notEnabled(res);
  try {
    const { cmd, cwd: cwdRel } = req.body ?? {};
    if (!cmd || typeof cmd !== "string") return res.status(400).json({ ok: false, error: "cmd required" });
    if (BASH_BLOCKED_RE.test(cmd)) {
      return res.status(403).json({ ok: false, error: "Command contains blocked keywords" });
    }

    const rootAbs = resolve(ROOT);
    const cwd = cwdRel ? safePath(cwdRel) : rootAbs;

    let stdout = "", stderr = "", exitCode = 0;
    try {
      const out = execSync(cmd, {
        cwd,
        timeout: BASH_TIMEOUT_MS,
        maxBuffer: BASH_MAX_OUTPUT,
        env: {
          ...process.env,
          // Prevent accidental network access markers; actual network blocking
          // must be done at OS/firewall level.
          HOME: rootAbs,
          LOCALFS_ROOT: rootAbs,
        },
        shell: "/bin/bash",
      });
      stdout = out.toString("utf-8");
    } catch (e) {
      exitCode = e.status ?? 1;
      stdout   = (e.stdout ?? Buffer.alloc(0)).toString("utf-8");
      stderr   = (e.stderr ?? Buffer.alloc(0)).toString("utf-8");
    }

    // Truncate if huge
    const truncate = (s) => s.length > BASH_MAX_OUTPUT
      ? s.slice(0, BASH_MAX_OUTPUT) + "\n[...truncated]"
      : s;

    res.json({
      ok: true,  // API call succeeded (command may have non-zero exit, but the API is fine)
      exitCode,
      stdout: truncate(stdout),
      stderr: truncate(stderr),
      cwd: relative(rootAbs, cwd),
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});


// ── POST /api/localfs/upload ──────────────────────────────────────────────────
// Upload a single binary file. Relative path (including sub-folders) is passed
// in the X-Upload-Path header. Parent directories are created automatically.
// Max 32 MB per file.
const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;

router.post("/localfs/upload", (req, res) => {
  if (!ENABLED) return notEnabled(res);
  const relPath = String(req.headers["x-upload-path"] ?? "").trim();
  if (!relPath) return res.status(400).json({ ok: false, error: "X-Upload-Path header required" });

  let abs;
  try { abs = safePath(relPath); } catch (e) {
    return res.status(400).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }

  const chunks = [];
  let totalBytes = 0;
  let aborted = false;

  req.on("data", (chunk) => {
    totalBytes += chunk.length;
    if (totalBytes > MAX_UPLOAD_BYTES) {
      aborted = true;
      res.status(413).json({ ok: false, error: `File too large (max ${MAX_UPLOAD_BYTES / 1024 / 1024} MB)` });
      req.destroy();
    } else {
      chunks.push(chunk);
    }
  });

  req.on("end", () => {
    if (aborted || res.headersSent) return;
    try {
      const buf = Buffer.concat(chunks);
      const dir = abs.slice(0, abs.lastIndexOf("/"));
      if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(abs, buf);
      const rel = relative(resolve(ROOT), abs);
      res.json({ ok: true, path: rel, sizeBytes: buf.length });
    } catch (e) {
      res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

  req.on("error", (e) => {
    if (!res.headersSent) res.status(500).json({ ok: false, error: e.message });
  });
});

export { router as default };
