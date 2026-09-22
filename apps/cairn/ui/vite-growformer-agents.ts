/**
 * Dev-only growformer agent proxies → `spacekit agent infer`.
 *
 * POST /__spacekit-dev/agents/tagger      { content }
 * POST /__spacekit-dev/agents/summarizer  { content }
 * POST /__spacekit-dev/agents/linker      { content, noteId?, corpus?: { id, title, content }[] }
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";

type AgentKind = "tagger" | "summarizer" | "linker";

type CorpusNote = { id: string; title: string; content: string };

type AgentConfig = {
  kind: AgentKind;
  root: string;
  projectFile: string;
  brainFile: string;
};

const AGENT_PREFIX = "/__spacekit-dev/agents";

const ROUTES: Record<string, AgentKind> = {
  [`${AGENT_PREFIX}/tagger`]: "tagger",
  [`${AGENT_PREFIX}/summarizer`]: "summarizer",
  [`${AGENT_PREFIX}/linker`]: "linker",
};

function resolveSpacekitBin(): string {
  const fromEnv = process.env.SPACEKIT_BIN?.trim();
  if (fromEnv) return fromEnv;
  const release = path.resolve(__dirname, "../../../../target/release/spacekit");
  if (fs.existsSync(release)) return release;
  const cargoBin = path.join(os.homedir(), ".cargo", "bin", "spacekit");
  if (fs.existsSync(cargoBin)) return cargoBin;
  return "spacekit";
}

function augmentPathWithCargoBin(pathEnv: string | undefined): string {
  const cargoBin = path.join(os.homedir(), ".cargo", "bin");
  if (!pathEnv || pathEnv.length === 0) return cargoBin;
  if (pathEnv.split(path.delimiter).includes(cargoBin)) return pathEnv;
  return `${cargoBin}${path.delimiter}${pathEnv}`;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function inferLines(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

function parseJsonArrayLine(stdout: string): string[] {
  const lines = inferLines(stdout);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.startsWith("[")) continue;
    const parsed = JSON.parse(line) as unknown;
    if (!Array.isArray(parsed)) continue;
    return parsed.filter((t): t is string => typeof t === "string" && t.length > 0);
  }
  throw new Error("infer output missing JSON array");
}

function parsePlainText(stdout: string): string {
  const lines = inferLines(stdout);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.startsWith("Brain loaded:")) continue;
    if (line.startsWith("[")) continue;
    return line;
  }
  throw new Error("infer output missing summary text");
}

function buildCorpusBlock(corpus: CorpusNote[]): string {
  const lines = ["Available notes:"];
  for (const note of corpus) {
    const snippet = note.content.replace(/\s+/g, " ").trim().slice(0, 160);
    lines.push(`- ${note.title}: ${snippet}`);
  }
  return lines.join("\n");
}

function buildPrompt(kind: AgentKind, body: Record<string, unknown>): string {
  const content = typeof body.content === "string" ? body.content.trim() : "";
  if (kind === "tagger") return content;
  if (kind === "summarizer") {
    const explicit = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (explicit) return explicit;
    return content ? `summarize: ${content}` : content;
  }
  const corpus = Array.isArray(body.corpus) ? (body.corpus as CorpusNote[]) : [];
  const block = buildCorpusBlock(corpus);
  return content ? `suggest links for:\n${content}\n\n${block}` : block;
}

function runInfer(
  bin: string,
  projectPath: string,
  brainPath: string,
  prompt: string
): { ok: true; stdout: string } | { ok: false; detail: string } {
  const result = spawnSync(
    bin,
    ["agent", "infer", "--project", projectPath, "--brain", brainPath, "--prompt", prompt],
    {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, PATH: augmentPathWithCargoBin(process.env.PATH) },
    }
  );
  if (result.error) return { ok: false, detail: result.error.message };
  if (result.status !== 0) {
    const out = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    return { ok: false, detail: out || `exit code ${result.status ?? "unknown"}` };
  }
  return { ok: true, stdout: result.stdout || "" };
}

function mapLinkerTitles(
  titles: string[],
  corpus: CorpusNote[],
  noteId?: string
): { id: string; title: string; score: number }[] {
  const byTitle = new Map(corpus.map((n) => [n.title.toLowerCase(), n]));
  const out: { id: string; title: string; score: number }[] = [];
  titles.forEach((title, i) => {
    const note = byTitle.get(title.toLowerCase());
    if (!note || note.id === noteId) return;
    out.push({ id: note.id, title: note.title, score: Math.max(1, titles.length - i) });
  });
  return out;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function agentConfig(kind: AgentKind, cairnRoot: string): AgentConfig {
  if (kind === "tagger") {
    return {
      kind,
      root: path.join(cairnRoot, "auto-tag"),
      projectFile: "auto-tag.gf.toml",
      brainFile: "agent/auto-tag-brain.bin",
    };
  }
  if (kind === "summarizer") {
    return {
      kind,
      root: path.join(cairnRoot, "summarize"),
      projectFile: "summarize.gf.toml",
      brainFile: "agent/summarize-brain.bin",
    };
  }
  return {
    kind,
    root: path.join(cairnRoot, "linker"),
    projectFile: "linker.gf.toml",
    brainFile: "agent/linker-brain.bin",
  };
}

function envOverride(kind: AgentKind, field: "project" | "brain"): string | null {
  const key =
    kind === "tagger"
      ? field === "project"
        ? "CAIRN_AUTO_TAG_PROJECT"
        : "CAIRN_AUTO_TAG_BRAIN"
      : kind === "summarizer"
        ? field === "project"
          ? "CAIRN_SUMMARIZE_PROJECT"
          : "CAIRN_SUMMARIZE_BRAIN"
        : field === "project"
          ? "CAIRN_LINKER_PROJECT"
          : "CAIRN_LINKER_BRAIN";
  return process.env[key]?.trim() || null;
}

export function cairnGrowformerAgents(opts?: { cairnRoot?: string }): Plugin {
  const cairnRoot = opts?.cairnRoot ?? path.resolve(__dirname, "..");
  return {
    name: "cairn-growformer-agents",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url ?? "";
        const kind = ROUTES[url.split("?")[0]];
        if (req.method !== "POST" || !kind) {
          next();
          return;
        }

        const cfg = agentConfig(kind, cairnRoot);
        const projectPath =
          envOverride(kind, "project") || path.join(cfg.root, cfg.projectFile);
        const brainPath =
          envOverride(kind, "brain") || path.join(cfg.root, cfg.brainFile);

        if (!fs.existsSync(projectPath)) {
          sendJson(res, 503, { error: "project_missing", detail: projectPath, agent: kind });
          return;
        }
        if (!fs.existsSync(brainPath)) {
          sendJson(res, 503, { error: "brain_missing", detail: brainPath, agent: kind });
          return;
        }

        let body: Record<string, unknown> = {};
        try {
          const raw = await readBody(req);
          body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          sendJson(res, 400, { error: "invalid_json", detail: msg });
          return;
        }

        const prompt = buildPrompt(kind, body);
        const bin = resolveSpacekitBin();
        const t0 = Date.now();
        const ran = runInfer(bin, projectPath, brainPath, prompt);
        if (!ran.ok) {
          console.error(`[cairn-growformer] ${kind} failed\n${ran.detail}`);
          sendJson(res, 502, { error: "infer_failed", detail: ran.detail, agent: kind, binary: bin });
          return;
        }

        try {
          if (kind === "tagger") {
            const tags = parseJsonArrayLine(ran.stdout);
            console.info(`[cairn-growformer] tagger ok tags=${tags.length} ms=${Date.now() - t0}`);
            sendJson(res, 200, { tags, source: "growformer" });
            return;
          }
          if (kind === "summarizer") {
            const summary = parsePlainText(ran.stdout);
            console.info(`[cairn-growformer] summarizer ok ms=${Date.now() - t0}`);
            sendJson(res, 200, { summary, source: "growformer" });
            return;
          }
          const titles = parseJsonArrayLine(ran.stdout);
          const corpus = Array.isArray(body.corpus) ? (body.corpus as CorpusNote[]) : [];
          const noteId = typeof body.noteId === "string" ? body.noteId : undefined;
          const related = mapLinkerTitles(titles, corpus, noteId);
          console.info(
            `[cairn-growformer] linker ok titles=${titles.length} mapped=${related.length} ms=${Date.now() - t0}`
          );
          sendJson(res, 200, { related, titles, source: "growformer" });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          sendJson(res, 502, { error: "parse_failed", detail: msg, agent: kind });
        }
      });
    },
  };
}
