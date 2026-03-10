import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk/explore";

/** Resolve the Anthropic API key from auth-profiles.json. */
function resolveAnthropicKey(configDir: string): string | undefined {
  const authFile = path.join(configDir, "agents", "main", "agent", "auth-profiles.json");
  try {
    const data = JSON.parse(fs.readFileSync(authFile, "utf8"));
    const profiles = data?.profiles ?? {};
    for (const profile of Object.values(profiles)) {
      const p = profile as Record<string, unknown>;
      if (p.provider !== "anthropic") continue;
      const creds = p.credentials as Array<Record<string, unknown>> | undefined;
      if (creds) {
        for (const cred of creds) {
          const token = (cred.access ?? cred.token) as string | undefined;
          if (token) return token;
        }
      }
      // Flat profile format
      const token = (p.access ?? p.token) as string | undefined;
      if (token) return token;
    }
  } catch {
    // ignore
  }
  return process.env.ANTHROPIC_API_KEY;
}

/** Run a shell command and return stdout (truncated to maxLen). */
function shell(cmd: string, cwd: string, maxLen = 8000): string {
  try {
    const out = execSync(cmd, { cwd, encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024 });
    return out.length > maxLen ? `${out.slice(0, maxLen)}\n... (truncated)` : out;
  } catch {
    return "";
  }
}

/** Pre-gather codebase context relevant to the query using grep/find. */
function gatherContext(query: string, scopeDir: string): string {
  const parts: string[] = [];

  const stopWords = new Set([
    "the",
    "how",
    "does",
    "what",
    "where",
    "which",
    "this",
    "that",
    "with",
    "from",
    "for",
    "and",
    "are",
    "was",
    "were",
    "been",
    "have",
    "has",
    "had",
    "not",
    "but",
    "can",
    "all",
    "use",
    "used",
    "using",
    "find",
    "show",
    "about",
    "work",
    "works",
  ]);
  const keywords = query
    .toLowerCase()
    .replace(/[^a-z0-9_\-./]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !stopWords.has(w));

  const uniqueKeywords = [...new Set(keywords)].slice(0, 5);

  for (const kw of uniqueKeywords) {
    const grepResult = shell(
      `rg --no-heading -n -l "${kw}" --type ts --type js --max-count 5 2>/dev/null | head -20`,
      scopeDir,
    );
    if (grepResult.trim()) {
      parts.push(`## Files matching "${kw}":\n${grepResult}`);
    }

    const lines = shell(
      `rg --no-heading -n -C1 "${kw}" --type ts --type js --max-count 3 2>/dev/null | head -60`,
      scopeDir,
    );
    if (lines.trim()) {
      parts.push(`## Code matching "${kw}":\n${lines}`);
    }
  }

  const tree = shell(
    `find . -name "*.ts" -not -path "*/node_modules/*" -not -path "*/dist/*" | head -50`,
    scopeDir,
  );
  if (tree.trim()) {
    parts.push(`## TypeScript files in scope:\n${tree}`);
  }

  return parts.join("\n\n").slice(0, 30_000);
}

const ExploreToolSchema = Type.Object({
  query: Type.String({ description: "What to explore in the codebase." }),
  scope: Type.Optional(
    Type.String({ description: "Directory to scope the search to. Defaults to workspace root." }),
  ),
});

export function createExploreTool(api: OpenClawPluginApi): AnyAgentTool {
  const workspaceDir =
    (api.config as Record<string, Record<string, Record<string, string>>>)?.agents?.defaults
      ?.workspace ?? api.resolvePath("~/.openclaw/workspace");
  const configDir = api.resolvePath("~/.openclaw");

  return {
    name: "explore",
    label: "Explore",
    description:
      "Explore the codebase using a fast, cheap sub-agent (Haiku). Pre-gathers relevant code via grep/find, then sends it to Haiku for analysis. Use this for codebase research, finding files, understanding how things work, or answering questions about the code.",
    parameters: ExploreToolSchema,
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as { query: string; scope?: string };
      const scopeDir = params.scope ? path.resolve(workspaceDir, params.scope) : workspaceDir;

      // Phase 1: gather context via grep/find
      const context = gatherContext(params.query, scopeDir);

      if (!context.trim()) {
        return {
          content: [{ type: "text", text: "No relevant files found for this query." }],
        };
      }

      // Phase 2: call Anthropic API directly via official SDK (bypasses pi-ai entirely)
      const apiKey = resolveAnthropicKey(configDir);
      if (!apiKey) {
        return {
          content: [{ type: "text", text: "Error: no Anthropic API key found." }],
        };
      }

      try {
        const Anthropic = (await import("@anthropic-ai/sdk")).default;
        const client = new Anthropic({ apiKey });

        const response = await client.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 4096,
          messages: [
            {
              role: "user",
              content: `You are a codebase explorer. Analyze the gathered code context and answer the query.

Be concise and direct. Include:
- Key files involved
- How the code works (brief explanation)
- Relevant code snippets (only the most important, 5-15 lines max)

WORKSPACE: ${workspaceDir}

GATHERED CONTEXT:
${context}

QUERY:
${params.query}`,
            },
          ],
        });

        const text = response.content
          .filter((block): block is { type: "text"; text: string } => block.type === "text")
          .map((block) => block.text)
          .join("\n")
          .trim();

        if (!text) {
          return {
            content: [{ type: "text", text: "Explorer returned no findings." }],
          };
        }

        return {
          content: [{ type: "text", text }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        api.logger.error(`explore: ${msg}`);
        return {
          content: [{ type: "text", text: `Explore error: ${msg}` }],
        };
      }
    },
  };
}
