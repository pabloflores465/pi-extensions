/**
 * openrouter-rag — Hybrid BM25 + OpenRouter vector embeddings for Pi.
 * Uses qwen/qwen3-embedding-8b via the OpenRouter embeddings API.
 *
 * Storage:  ~/.pi/openrouter-rag/
 *
 * Tools:
 *   rag_index   – Index a file or directory
 *   rag_query   – Search the index
 *   rag_status  – Show index stats
 *   rag_rebuild – Re-index changed files & prune deleted
 *   rag_clear   – Wipe the entire index
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import { createHash } from "node:crypto";
import {
  readdirSync, readFileSync, statSync,
  existsSync, mkdirSync, writeFileSync, rmSync,
} from "node:fs";
import { join, resolve, extname } from "node:path";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";

// ── constants ──────────────────────────────────────────
const STORAGE_DIR = join(process.env.HOME ?? "~", ".pi", "openrouter-rag");
const INDEX_FILE  = join(STORAGE_DIR, "index.json");
const CONFIG_FILE = join(STORAGE_DIR, "config.json");
const EMBEDDING_MODEL = "qwen/qwen3-embedding-8b";
const API_BASE  = "https://openrouter.ai/api/v1";
const CHUNK_MAX = 50;            // lines per chunk
const BATCH_MAX = 32;            // embeddings per API call — smaller for large codebases
const CHUNK_BYTE_MAX = 8000;    // max bytes per chunk (skip larger)
const MAX_RETRY = 3;            // retries per batch
const RETRY_BASE_MS = 1000;     // exponential backoff base
const PROGRESS_EVERY = 50;      // chunk count for progress updates
const WARN_CHUNKS_MIN = 50;      // suggest grep below this many chunks
const WARN_FILES_MIN = 10;       // suggest grep below this many files
const SKIP_DIRS = new Set(["node_modules",".git",".next",".nuxt","dist","build","target",".venv","venv","__pycache__",".cache","vendor",".idea",".vscode","sessions","large-messages","bin","logs","logs-llm","out","coverage",".turbo",".husky",".circleci",".github/workflows"]);
const SKIP_EXTS = new Set([
  ".png",".jpg",".jpeg",".gif",".bmp",".ico",".svg",".webp",
  ".mp3",".mp4",".wav",".avi",".mov",".webm",
  ".zip",".tar",".gz",".rar",".7z",".bz2",".xz",
  ".pdf",".doc",".docx",".xls",".xlsx",".ppt",".pptx",
  ".pyc",".pyo",".pyd",".so",".dll",".dylib",
  ".class",".jar",".war",
  ".exe",".msi",".app",
  ".lock",".wasm",".ttf",".otf",".woff",".woff2",
]);

// ── types ──────────────────────────────────────────────
interface Chunk {
  id: string;
  filePath: string;
  fileHash: string;
  lineStart: number;
  lineEnd: number;
  content: string;
  embedding: number[];
}

interface IndexData {
  version: 1;
  model: string;
  chunks: Chunk[];
  fileHashes: Record<string, string>;  // abs path → sha256
}

interface RagConfig {
  openrouterApiKey: string;
  topK: number;
  alpha: number;
}

// ── persistence ────────────────────────────────────────
function ensureDir()  { if (!existsSync(STORAGE_DIR)) mkdirSync(STORAGE_DIR, { recursive: true }); }
function loadIndex():  IndexData {
  return existsSync(INDEX_FILE) ? JSON.parse(readFileSync(INDEX_FILE, "utf-8")) : { version:1, model:EMBEDDING_MODEL, chunks:[], fileHashes:{} };
}
function saveIndex(ix: IndexData) { ensureDir(); writeFileSync(INDEX_FILE, JSON.stringify(ix), "utf-8"); }
function loadConfig(): RagConfig {
  if (!existsSync(CONFIG_FILE)) { const c: RagConfig = { openrouterApiKey:"", topK:5, alpha:0.4 }; saveConfig(c); return c; }
  return JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
}
function saveConfig(c: RagConfig) { ensureDir(); writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2), "utf-8"); }
function apiKey(cfg: RagConfig): string { return cfg.openrouterApiKey || process.env.OPENROUTER_API_KEY || process.env.OR_API_KEY || ""; }

// ── http helpers ───────────────────────────────────────
function httpJson(url: string, body: string, key: string): Promise<unknown> {
  return new Promise((ok, fail) => {
    const u = new URL(url);
    const reqFn = u.protocol === "https:" ? httpsRequest : httpRequest;
    const req = reqFn(u, {  // use parsed URL, not string
      method: "POST",
      headers: {
        "Content-Type":"application/json",
        "Content-Length": Buffer.byteLength(body),
        Authorization: `Bearer ${key}`,
        "HTTP-Referer":"https://github.com/badlogic/pi-mono",
        "X-Title":"Pi OpenRouter RAG",
      },
      timeout: 120_000,
    }, res => {
      const parts: Buffer[] = [];
      res.on("data", (c: Buffer) => parts.push(c));
      res.on("end", () => {
        const txt = Buffer.concat(parts).toString("utf-8");
        if ((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300) {
          try { ok(JSON.parse(txt)); }
          catch (e) { fail(new Error(`JSON parse error: ${e}. Body: ${txt.slice(0, 500)}`)); }
        }
        else fail(new Error(`HTTP ${res.statusCode}: ${txt.slice(0, 500)}`));
      });
    });
    req.on("error", fail);
    req.write(body);
    req.end();
  });
}

async function httpJsonWithRetry(url: string, body: string, key: string, retries = MAX_RETRY): Promise<unknown> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try { return await httpJson(url, body, key); }
    catch (e: any) {
      const msg = String(e);
      // retryable: timeouts, 5xx, network errors
      const retryable = msg.includes("timeout") || msg.includes("ETIMEDOUT") || msg.includes("ECONNRESET") || msg.includes("ECONNREFUSED") || /HTTP [5]/.test(msg);
      if (!retryable || attempt >= retries) throw e;
      const delay = RETRY_BASE_MS * Math.pow(2, attempt) + Math.random() * 500;
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

async function getEmbeddings(
  key: string,
  texts: string[],
  onUpdate?: (u: { content: { type: string; text: string }[] }) => void,
  initialOffset = 0,
): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH_MAX) {
    const batch = texts.slice(i, i + BATCH_MAX);
    const done = initialOffset + i;
    if (onUpdate && (i % Math.max(PROGRESS_EVERY - (PROGRESS_EVERY % BATCH_MAX), BATCH_MAX) === 0 || i === 0))
      onUpdate({ content: [{ type:"text", text: `Embedding ${done + batch.length}/${texts.length}…` }] });
    let resp; try {
      resp = await httpJsonWithRetry(`${API_BASE}/embeddings`, JSON.stringify({ model: EMBEDDING_MODEL, input: batch }), key) as { data?: { index:number; embedding:number[] }[] };
    } catch (e: any) {
      const msg = String(e);
      // Try progressive degradation: reduce batch
      if (batch.length > 1 && /HTTP [45]|timeout|ETIMEDOUT|ECONN/i.test(msg)) {
        // Retry with half-size batches
        const half = Math.max(1, Math.ceil(batch.length / 2));
        const sub1 = await getEmbeddings(key, batch.slice(0, half), undefined, initialOffset + i);
        const sub2 = await getEmbeddings(key, batch.slice(half), onUpdate, initialOffset + i + half);
        out.push(...sub1, ...sub2);
        continue;
      } throw e;
    }
    if (!resp?.data) throw new Error("Embedding API returned unexpected response: " + JSON.stringify(resp).slice(0, 300));
    resp.data.sort((a, b) => a.index - b.index).forEach(d => out.push(d.embedding));
  }
  return out;
}

// ── misc helpers ───────────────────────────────────────
function sha256(path: string) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }

function shouldSkip(p: string) {
  const e = extname(p).toLowerCase();
  return SKIP_EXTS.has(e);
}

function collectFiles(dir: string): string[] {
  const r: string[] = [];
  (function walk(d: string) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const f = join(d, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(f); }
      else if (e.isFile() && !shouldSkip(f)) r.push(f);
    }
  })(dir);
  return r;
}

function chunkText(text: string): { content: string; lineStart: number; lineEnd: number }[] {
  const lines = text.split("\n"); const out: { content: string; lineStart: number; lineEnd: number }[] = [];
  for (let i = 0; i < lines.length; i += CHUNK_MAX) {
    const slice = lines.slice(i, i + CHUNK_MAX);
    out.push({ content: slice.join("\n"), lineStart: i + 1, lineEnd: Math.min(i + CHUNK_MAX, lines.length) });
  }
  return out;
}

// ── BM25 (simplified single-doc) ───────────────────────
function tokenize(s: string) { return s.toLowerCase().replace(/[^\w\s-]/g, " ").split(/\s+/).filter(Boolean); }

function bm25(query: string, doc: string): number {
  const qt = tokenize(query); const dt = tokenize(doc);
  const freq: Record<string, number> = {};
  for (const t of dt) freq[t] = (freq[t] || 0) + 1;
  let score = 0;
  for (const q of qt) { const tf = freq[q] || 0; score += tf / (tf + 2.25); }
  return score;
}

// ── cosine ─────────────────────────────────────────────
function cosine(a: number[], b: number[]): number {
  let dot = 0, ma = 0, mb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; ma += a[i]*a[i]; mb += b[i]*b[i]; }
  return (ma === 0 || mb === 0) ? 0 : dot / (Math.sqrt(ma) * Math.sqrt(mb));
}

// ── extension ──────────────────────────────────────────
export default function (pi: ExtensionAPI) {

  // ── rag_index ───────────────────────────────────
  pi.registerTool({
    name: "rag_index",
    label: "Index Files (OpenRouter RAG)",
    description: "Index files or directories into the OpenRouter RAG pipeline using qwen/qwen3-embedding-8b embeddings.",
    promptSnippet: "Index files or directories into the RAG pipeline for semantic search",
    promptGuidelines: ["Use this tool before querying to ensure files are indexed."],
    parameters: Type.Object({
      path: Type.String({ description: "File or directory path to index" }),
    }),
    async execute(_tc, params, _sig, onUpdate) {
      const cfg = loadConfig();
      const key = apiKey(cfg);
      if (!key) throw new Error("No OpenRouter API key. Set openrouterApiKey in ~/.pi/openrouter-rag/config.json or OPENROUTER_API_KEY env var.");

      const abs = resolve(params.path);
      const files = statSync(abs).isDirectory() ? collectFiles(abs) : [abs];

      const index = loadIndex();
      let indexedCount = 0, skipped = 0;

      // remove deleted
      const cur = new Set(files);
      for (const old of Object.keys(index.fileHashes)) {
        if (!cur.has(old)) { index.chunks = index.chunks.filter(c => c.filePath !== old); delete index.fileHashes[old]; }
      }

      const pending: { file: string; fileId: string; ch: { content:string; lineStart:number; lineEnd:number }; idx: number }[] = [];
      let idx = 0;
      for (const f of files) {
        try {
          const h = sha256(f);
          if (index.fileHashes[f] === h) { skipped++; continue; }
          index.chunks = index.chunks.filter(c => c.filePath !== f);
          index.fileHashes[f] = h;
          const cont = readFileSync(f, "utf-8");
          const fid = h.slice(0, 12);
          for (const c of chunkText(cont)) pending.push({ file: f, fileId: fid, ch: c, idx: idx++ });
          indexedCount++;
        } catch { skipped++; }
      }

      // Save index with empty embeddings first (progressive)
      saveIndex(index);

      if (pending.length > 0) {
        onUpdate?.({ content: [{ type:"text", text: `Preparing ${pending.length} chunks from ${indexedCount} file(s)…` }] });

        // Warning: small codebase — grep is faster & cheaper
        if (pending.length < WARN_CHUNKS_MIN && indexedCount < WARN_FILES_MIN) {
          const warn = `⚠ Small codebase: ${indexedCount} file(s), ${pending.length} chunk(s).\n` +
            `grep + read will be faster and free.\n` +
            `Embedding is worth it for 50+ chunks or 10+ files.\n` +
            `Proceeding anyway…`;
          onUpdate?.({ content: [{ type:"text", text: warn }] });
        }
      } else if (skipped > 0 && pending.length === 0) {
        return { content: [{ type:"text", text: `All files already indexed. Nothing to do.` }] };
      }

      // Embed in progressive batches with save checkpoints
      let embedded = 0;
      for (let i = 0; i < pending.length; i += PROGRESS_EVERY) {
        const slice = pending.slice(i, i + PROGRESS_EVERY);
        onUpdate?.({ content: [{ type:"text", text: `Embedding batch ${i + slice.length}/${pending.length}…` }] });
        const embs = await getEmbeddings(key, slice.map(p => p.ch.content), onUpdate, i);

        for (let j = 0; j < slice.length; j++) {
          const p = slice[j];
          index.chunks.push({
            id: `${p.fileId}-${p.ch.lineStart}`,
            filePath: p.file, fileHash: index.fileHashes[p.file],
            lineStart: p.ch.lineStart, lineEnd: p.ch.lineEnd,
            content: p.ch.content, embedding: embs[j],
          });
        }
        embedded += slice.length;

        // Save after each checkpoint — resume on crash
        saveIndex(index);
      }

      return { content: [{ type:"text", text: `Indexed ${indexedCount} file(s), ${skipped} skipped, ${embedded} new chunks stored. Total: ${index.chunks.length} chunks.` }],
             details: { indexed: indexedCount, skipped, chunks: embedded, total: index.chunks.length } };
    },
    renderResult(result, _opts, theme) {
      return new Text(theme.fg("success", `✓ ${result.content[0]?.text ?? "done"}`), 0, 0);
    },
  });

  // ── rag_query ───────────────────────────────────
  pi.registerTool({
    name: "rag_query",
    label: "Query RAG (OpenRouter)",
    description: "Search the OpenRouter RAG index using hybrid BM25 + vector similarity.",
    promptSnippet: "Search indexed files with hybrid BM25 + semantic vector search",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      limit: Type.Optional(Type.Integer({ description: "Max results (default 5)" })),
    }),
    async execute(_tc, params, _sig, onUpdate) {
      const cfg = loadConfig();
      const key = apiKey(cfg);
      if (!key) throw new Error("No OpenRouter API key configured.");

      const index = loadIndex();
      if (index.chunks.length === 0) throw new Error("Index is empty. Run rag_index first.");

      const qEmb = (await getEmbeddings(key, [params.query]))[0];
      if (!qEmb) throw new Error("Failed to get query embedding.");

      const limit = params.limit ?? cfg.topK;
      const alpha = cfg.alpha;
      const maxB = 0.001, maxV = 0.001;

      type Raw = { chunk: Chunk; bm25: number; vec: number };
      const raw: Raw[] = [];
      for (const c of index.chunks) {
        raw.push({ chunk: c, bm25: bm25(params.query, c.content), vec: cosine(qEmb, c.embedding) });
      }

      raw.sort((a, b) => {
        const sa = alpha * a.bm25 + (1-alpha) * a.vec;
        const sb = alpha * b.bm25 + (1-alpha) * b.vec;
        return sb - sa;
      });

      const hits = raw.slice(0, limit);
      const lines = hits.map((r, i) => {
        const preview = r.chunk.content.length > 300 ? r.chunk.content.slice(0, 300) + "…" : r.chunk.content;
        return `[${i+1}] ${r.chunk.filePath}:${r.chunk.lineStart}-${r.chunk.lineEnd} (score: ${r.bm25.toFixed(3)} bm25, ${r.vec.toFixed(3)} vec)\n${preview}`;
      }).join("\n\n");

      return { content: [{ type:"text", text: lines || "No results." }],
             details: { query: params.query, count: hits.length } };
    },
    renderResult(result, _opts, theme) {
      return new Text(theme.fg("accent", `${result.content[0]?.text ?? "no results"}`), 0, 0);
    },
  });

  // ── rag_status ──────────────────────────────────
  pi.registerTool({
    name: "rag_status",
    label: "RAG Status (OpenRouter)",
    description: "Show OpenRouter RAG index statistics and configuration.",
    promptSnippet: "Show RAG index statistics",
    parameters: Type.Object({}),
    async execute() {
      const cfg = loadConfig();
      const ix = loadIndex();
      const key = apiKey(cfg);
      const hasKey = !!key;
      const keyPreview = hasKey ? `${key.slice(0, 8)}…${key.slice(-4)}` : "none";
      const stats = `Files: ${Object.keys(ix.fileHashes).length}\nChunks: ${ix.chunks.length}\nModel: ${ix.model}\nTotal dims/chunk: ${ix.chunks.length ? ix.chunks[0].embedding.length : "n/a"}\n\nConfig:\n  topK:  ${cfg.topK}\n  alpha: ${cfg.alpha}\n  API key: ${keyPreview}`;
      return { content: [{ type:"text", text: stats }],
             details: { files: Object.keys(ix.fileHashes).length, chunks: ix.chunks.length, hasKey } };
    },
    renderResult(result, _opts, theme) {
      return new Text(theme.fg("accent", result.content[0]?.text ?? ""), 0, 0);
    },
  });

  // ── rag_rebuild ─────────────────────────────────
  pi.registerTool({
    name: "rag_rebuild",
    label: "Rebuild RAG Index (OpenRouter)",
    description: "Re-index all files, removing deleted files and updating changed ones.",
    promptSnippet: "Rebuild the RAG index",
    parameters: Type.Object({
      path: Type.String({ description: "Root directory to rebuild from" }),
    }),
    async execute(_tc, params, _sig, onUpdate) {
      const cfg = loadConfig();
      const key = apiKey(cfg);
      if (!key) throw new Error("No OpenRouter API key configured.");

      const abs = resolve(params.path);
      const files = statSync(abs).isDirectory() ? collectFiles(abs) : [abs];
      const index = loadIndex();

      // clear old index
      index.chunks = [];
      index.fileHashes = {};

      const pending: { file: string; fileId: string; ch: { content:string; lineStart:number; lineEnd:number } }[] = [];
      for (const f of files) {
        try {
          const h = sha256(f);
          index.fileHashes[f] = h;
          const cont = readFileSync(f, "utf-8");
          const fid = h.slice(0, 12);
          for (const c of chunkText(cont)) pending.push({ file: f, fileId: fid, ch: c });
        } catch { /* skip unreadable */ }
      }

      // Save skeleton
      saveIndex(index);

      if (pending.length > 0) {
        onUpdate?.({ content: [{ type:"text", text: `Rebuilding: preparing ${pending.length} chunks…` }] });

        // Warning: small codebase
        if (pending.length < WARN_CHUNKS_MIN && files.length < WARN_FILES_MIN) {
          const warn = `⚠ Small codebase: ${files.length} file(s), ${pending.length} chunk(s).\n` +
            `grep + read will be faster and free.\n` +
            `Proceeding anyway…`;
          onUpdate?.({ content: [{ type:"text", text: warn }] });
        }

        // Progressive embedding with saves
        for (let i = 0; i < pending.length; i += PROGRESS_EVERY) {
          const slice = pending.slice(i, i + PROGRESS_EVERY);
          onUpdate?.({ content: [{ type:"text", text: `Rebuilding: embedding ${i + slice.length}/${pending.length}…` }] });
          const embs = await getEmbeddings(key, slice.map(p => p.ch.content), onUpdate, i);
          for (let j = 0; j < slice.length; j++) {
            const p = slice[j];
            index.chunks.push({
              id: `${p.fileId}-${p.ch.lineStart}`, filePath: p.file,
              fileHash: index.fileHashes[p.file],
              lineStart: p.ch.lineStart, lineEnd: p.ch.lineEnd,
              content: p.ch.content, embedding: embs[j],
            });
          }
          // Checkpoint save
          saveIndex(index);
        }
      }

      return { content: [{ type:"text", text: `Rebuilt: ${index.chunks.length} chunks from ${Object.keys(index.fileHashes).length} files.` }] };
    },
    renderResult(result, _opts, theme) {
      return new Text(theme.fg("success", `✓ ${result.content[0]?.text}`), 0, 0);
    },
  });

  // ── rag_config ──────────────────────────────────
  pi.registerTool({
    name: "rag_config",
    label: "Configure RAG (OpenRouter)",
    description: "Set OpenRouter RAG configuration (API key, topK, alpha).",
    parameters: Type.Object({
      apiKey: Type.Optional(Type.String({ description: "Your OpenRouter API key" })),
      topK: Type.Optional(Type.Integer({ description: "Max results to return" })),
      alpha: Type.Optional(Type.Number({ description: "BM25/vector blend (0=pure vector, 1=pure BM25)" })),
    }),
    async execute(_tc, params) {
      const cfg = loadConfig();
      if (params.apiKey !== undefined) cfg.openrouterApiKey = params.apiKey;
      if (params.topK !== undefined && params.topK > 0) cfg.topK = params.topK;
      if (params.alpha !== undefined) cfg.alpha = Math.max(0, Math.min(1, params.alpha));
      saveConfig(cfg);
      const msg = `Config updated:\n  topK:  ${cfg.topK}\n  alpha: ${cfg.alpha}\n  API key: ${cfg.openrouterApiKey ? "set ✓" : "missing ✗"}`;
      return { content: [{ type:"text", text: msg }],
             details: { topK: cfg.topK, alpha: cfg.alpha, hasKey: !!cfg.openrouterApiKey } };
    },
    renderResult(result, _opts, theme) {
      return new Text(theme.fg("success", `✓ ${result.content[0]?.text}`), 0, 0);
    },
  });

  // ── rag_clear ───────────────────────────────────
  pi.registerTool({
    name: "rag_clear",
    label: "Clear RAG Index (OpenRouter)",
    description: "Wipe the entire OpenRouter RAG index.",
    parameters: Type.Object({}),
    async execute() {
      if (existsSync(INDEX_FILE)) unlinkSync(INDEX_FILE);
      const ix: IndexData = { version:1, model:EMBEDDING_MODEL, chunks:[], fileHashes:{} };
      saveIndex(ix);
      return { content: [{ type:"text", text: "Index cleared." }] };
    },
    renderResult(result, _opts, theme) {
      return new Text(theme.fg("warning", `✓ ${result.content[0]?.text}`), 0, 0);
    },
  });
}
