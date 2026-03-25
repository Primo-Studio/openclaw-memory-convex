/**
 * memory-convex — OpenClaw plugin for auto-recall/capture via Convex agentMemory.
 *
 * v0.3.0 — Phase 2:
 *   - Point 4: LLM-based fact extraction (Ollama GLM4, $0)
 *   - Point 5: Boot audit (coherence check on first message)
 *   - Point 6: Extended .md sync (MEMORY.md, USER.md, TOOLS.md)
 *
 * Hooks:
 *   before_prompt_build → search Convex for relevant facts, inject via prependContext
 *                       → on first call: run boot audit if enabled
 *   agent_end           → extract facts (regex + LLM), store in Convex, sync .md files
 *   after_compaction    → log compaction events for debugging
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { ConvexMemoryClient } from "./convex-client.js";
import { readFile, writeFile, appendFile } from "node:fs/promises";

// ─── Config ───

type MemoryConvexConfig = {
  convexUrl: string;
  autoRecall: boolean;
  autoCapture: boolean;
  recallLimit: number;
  captureMaxChars: number;
  defaultAgent: string;
  // Phase 2
  captureMode: "regex" | "llm" | "both";
  llmUrl: string;
  llmModel: string;
  llmApiKey: string;
  bootAudit: boolean;
  syncMdEnabled: boolean;
};

function parseConfig(raw: Record<string, unknown> | undefined): MemoryConvexConfig {
  return {
    convexUrl: (raw?.convexUrl as string) || "",
    autoRecall: raw?.autoRecall !== false, // default true
    autoCapture: raw?.autoCapture !== false, // default true
    recallLimit: (raw?.recallLimit as number) || 5,
    captureMaxChars: (raw?.captureMaxChars as number) || 500,
    defaultAgent: (raw?.defaultAgent as string) || "koda",
    // Phase 2 defaults
    captureMode: (raw?.captureMode as MemoryConvexConfig["captureMode"]) || "regex",
    llmUrl: (raw?.llmUrl as string) || "https://api.openai.com/v1",
    llmModel: (raw?.llmModel as string) || "gpt-5.4-nano",
    llmApiKey: (raw?.llmApiKey as string) || "",
    bootAudit: (raw?.bootAudit as boolean) ?? false,
    syncMdEnabled: (raw?.syncMdEnabled as boolean) ?? false,
  };
}

// ─── Constants ───

const WORKSPACE = process.env.OPENCLAW_WORKSPACE || `${process.env.HOME}/.openclaw/workspace`;

const LLM_EXTRACT_PROMPT = `Tu es un extracteur de faits. Analyse le message ci-dessous et extrais UNIQUEMENT les faits DURABLES (qui seront vrais demain). Ignore les actions temporaires, les salutations, les confirmations courtes.

Règles:
- Chaque fait doit être UNE phrase complète et autonome
- Catégories: savoir (fait technique), erreur (bug/leçon), preference (choix utilisateur), outil (config/tool), chronologie (événement daté)
- confidence: 0.7 minimum
- Maximum 3 faits par message
- Si rien de durable → retourne {"facts": []}

Message:
"{TEXT}"

Réponds UNIQUEMENT en JSON, rien d autre:
{"facts": [{"fact": "phrase complète", "category": "...", "confidence": 0.X}]}`;

// ─── Formatting ───

function formatRecallContext(facts: Array<{ fact: string; category: string; confidence: number }>): string {
  if (facts.length === 0) return "";

  const lines = facts.map((f) => {
    const conf = f.confidence >= 0.9 ? "" : ` (confiance: ${Math.round(f.confidence * 100)}%)`;
    return `- [${f.category}] ${f.fact}${conf}`;
  });

  return [
    "## 🧠 Mémoire persistante (agentMemory)",
    "Ces faits proviennent de la mémoire long terme. Ils sont fiables et à jour.",
    "En cas de conflit avec un résumé LCM, la mémoire persistante a priorité.",
    "",
    ...lines,
    "",
  ].join("\n");
}

// ─── Temporal Scoring (decay + recency boost) ───

/**
 * Apply temporal decay to recalled facts.
 * - Savoir, erreur, preference = protégés (pas de decay)
 * - Chronologie, outil = decay avec demi-vie configurable
 * - Faits <24h = boost
 * - Faits très vieux (>90j) avec faible confidence = pénalisés
 *
 * Config switchable: si on branche un modèle local, ce scoring reste identique.
 */
const DECAY_CONFIG = {
  halfLifeDays: 14,           // Demi-vie pour faits épisodiques
  halfLifeProjectDays: 30,    // Demi-vie plus lente pour outils/projets
  recentBoostHours: 24,       // Fenêtre "boost récent"
  recentBoostFactor: 1.3,     // +30% pour faits <24h
  protectedCategories: ["savoir", "erreur", "preference", "rh"],
  staleThresholdDays: 90,     // Au-delà = potentiellement stale
  stalePenalty: 0.7,          // -30% pour vieux faits à faible confiance
};

interface ScoredFact extends MemoryFact {
  temporalScore: number;
  ageHours: number;
}

function applyTemporalScoring(facts: MemoryFact[]): ScoredFact[] {
  const now = Date.now();

  return facts.map((fact) => {
    const ageMs = now - (fact.updatedAt || fact.createdAt);
    const ageHours = ageMs / (1000 * 60 * 60);
    const ageDays = ageHours / 24;

    let score = 1.0;

    // Protected categories: no decay
    if (DECAY_CONFIG.protectedCategories.includes(fact.category)) {
      // Still boost if very recent
      if (ageHours < DECAY_CONFIG.recentBoostHours) {
        score *= DECAY_CONFIG.recentBoostFactor;
      }
      return { ...fact, temporalScore: score, ageHours };
    }

    // Exponential decay for episodic categories
    const halfLife = fact.category === "outil"
      ? DECAY_CONFIG.halfLifeProjectDays
      : DECAY_CONFIG.halfLifeDays;
    score *= Math.pow(0.5, ageDays / halfLife);

    // Recent boost
    if (ageHours < DECAY_CONFIG.recentBoostHours) {
      score *= DECAY_CONFIG.recentBoostFactor;
    }

    // Stale penalty for old low-confidence facts
    if (ageDays > DECAY_CONFIG.staleThresholdDays && fact.confidence < 0.8) {
      score *= DECAY_CONFIG.stalePenalty;
    }

    return { ...fact, temporalScore: score, ageHours };
  })
    .sort((a, b) => b.temporalScore - a.temporalScore);
}

// ─── Dedup: improved with Levenshtein distance ───

/**
 * Check if two strings are near-duplicates using:
 * 1. Word overlap (original, ≥60% + ≥3 words)
 * 2. Normalized Levenshtein (for short similar phrases, ≤0.3 distance)
 */
function isNearDuplicate(a: string, b: string): boolean {
  const aClean = a.toLowerCase().replace(/[^a-zà-ÿ0-9\s]/g, "");
  const bClean = b.toLowerCase().replace(/[^a-zà-ÿ0-9\s]/g, "");

  // Method 1: word overlap (original)
  const aWords = aClean.split(/\s+/).filter((w) => w.length > 4);
  const bLower = bClean;
  const matchCount = aWords.filter((w) => bLower.includes(w)).length;
  const matchRatio = aWords.length > 0 ? matchCount / aWords.length : 0;
  if (matchRatio >= 0.6 && matchCount >= 3) return true;

  // Method 2: normalized edit distance for short strings
  if (aClean.length < 100 && bClean.length < 100) {
    const maxLen = Math.max(aClean.length, bClean.length);
    if (maxLen === 0) return true;
    const dist = levenshteinDistance(aClean, bClean);
    const normalizedDist = dist / maxLen;
    if (normalizedDist <= 0.3) return true;
  }

  return false;
}

/** Simple Levenshtein (no deps, O(n*m) — fine for <100 char strings) */
function levenshteinDistance(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix: number[][] = [];

  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      const cost = b[i - 1] === a[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );
    }
  }

  return matrix[b.length][a.length];
}

// ─── Fact Extraction: Regex (original, cheap) ───

function extractSimpleFacts(
  text: string,
  _agentName: string,
): Array<{ fact: string; category: string; confidence: number }> {
  const facts: Array<{ fact: string; category: string; confidence: number }> = [];

  const prefPatterns = [
    /je (?:ne )?(?:suis|sais) pas fan (?:de |des |du )(.+)/i,
    /je (?:pré|pref)(?:è|e)re (.+)/i,
    /(?:j'aime|jaime) pas (.+)/i,
    /je (?:ne )?veu[xt] (?:pas|plus) (?:de |des |du )(.+)/i,
    /(?:arr[eê]te|stop) (?:de |les |avec )(.+)/i,
  ];

  for (const pat of prefPatterns) {
    const m = text.match(pat);
    if (m) {
      facts.push({
        fact: `Neto préfère : ${m[0].trim()}`,
        category: "preference",
        confidence: 0.8,
      });
    }
  }

  const errorPatterns = [
    /(?:ça|ca) (?:marche|fonctionne) (?:pas|plus)/i,
    /(?:bug|crash|erreur|broken|cassé)/i,
  ];

  for (const pat of errorPatterns) {
    if (pat.test(text) && text.length < 200) {
      facts.push({
        fact: `Bug signalé : ${text.slice(0, 150)}`,
        category: "erreur",
        confidence: 0.6,
      });
      break;
    }
  }

  return facts;
}

// ─── Fact Extraction: LLM (Point 4) ───

type ExtractedFact = { fact: string; category: string; confidence: number };

async function extractFactsWithLlm(
  text: string,
  cfg: MemoryConvexConfig,
  logger: { info?: (...a: unknown[]) => void; warn: (...a: unknown[]) => void },
): Promise<ExtractedFact[]> {
  // Skip very short messages (no useful facts)
  if (text.length < 30) return [];

  // Skip messages that are just commands or heartbeats
  if (/^(heartbeat|HEARTBEAT|\/\w+|ok|oui|non|yes|no|merci|👍)/i.test(text.trim())) return [];

  const prompt = LLM_EXTRACT_PROMPT.replace("{TEXT}", text.slice(0, 1500));

  try {
    // Detect API type: Ollama (localhost:11434) vs OpenAI-compatible
    const isOllama = cfg.llmUrl.includes("11434") || cfg.llmUrl.includes("ollama");

    let raw: string;

    if (isOllama) {
      // Ollama API
      const res = await fetch(`${cfg.llmUrl}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: cfg.llmModel,
          prompt,
          stream: false,
          options: { temperature: 0.1, num_predict: 512 },
        }),
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) {
        logger.warn(`memory-convex: Ollama extract failed (HTTP ${res.status})`);
        return [];
      }

      const data = await res.json();
      raw = (data.response || "").trim();
    } else {
      // OpenAI-compatible API (GPT-5.4-nano)
      const apiKey = cfg.llmApiKey || process.env.OPENAI_API_KEY || "";
      if (!apiKey) {
        logger.warn("memory-convex: no API key for OpenAI extraction");
        return [];
      }

      const res = await fetch(`${cfg.llmUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: cfg.llmModel,
          messages: [{ role: "user", content: prompt }],
          max_completion_tokens: 512,
          response_format: { type: "json_object" },
        }),
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) {
        logger.warn(`memory-convex: OpenAI extract failed (HTTP ${res.status})`);
        return [];
      }

      const data = await res.json();
      raw = (data.choices?.[0]?.message?.content || "").trim();
    }

    // Parse JSON (handle markdown code blocks)
    let jsonStr = raw;
    if (jsonStr.startsWith("```")) {
      jsonStr = jsonStr.split("\n", 2)[1] || jsonStr;
      jsonStr = jsonStr.split("```")[0] || jsonStr;
    }
    jsonStr = jsonStr.trim();

    const parsed = JSON.parse(jsonStr);

    // Handle both {"facts": [...]} and [...] formats
    const facts: ExtractedFact[] = Array.isArray(parsed) ? parsed : (parsed.facts || []);

    // Validate structure
    if (!Array.isArray(facts)) return [];

    // Vague patterns to reject (LLM false positives)
    const vaguePatterns = [
      /^l['']?(?:utilisateur|assistant|user) (?:a |est |va |veut )/i,
      /^(?:une |un |le |la |les )(?:action|tâche|demande|réponse) /i,
      /^il (?:a |est |va )/i,
    ];

    // Filter valid facts
    return facts.filter(
      (f) =>
        f &&
        typeof f.fact === "string" &&
        f.fact.length > 20 &&
        typeof f.category === "string" &&
        ["savoir", "erreur", "preference", "outil", "chronologie", "rh", "client"].includes(f.category) &&
        typeof f.confidence === "number" &&
        f.confidence >= 0.7 &&
        !vaguePatterns.some((p) => p.test(f.fact)),
    );
  } catch (err) {
    // Non-blocking — if Ollama is down or JSON is bad, return empty
    const errStr = String(err);
    if (!errStr.includes("AbortError") && !errStr.includes("ECONNREFUSED")) {
      logger.warn(`memory-convex: LLM extract error: ${errStr.slice(0, 100)}`);
    }
    return [];
  }
}

// ─── Sync .md Files (Point 6) ───

/**
 * Category → file mapping for extended .md sync.
 * Each category knows which file to update and how.
 */
const CATEGORY_MD_MAP: Record<
  string,
  {
    file: string;
    section: string; // section header to find
    format: (fact: string) => string; // how to format the line
  }
> = {
  chronologie: {
    file: "MEMORY.md",
    section: "## 📅 Chronologie",
    format: (f) => {
      const now = new Date();
      const dateStr = `${String(now.getDate()).padStart(2, "0")}/${String(now.getMonth() + 1).padStart(2, "0")}`;
      return `- **${dateStr}** : ${f}`;
    },
  },
  preference: {
    file: "USER.md",
    section: "## Personnalité & Communication",
    format: (f) => `- ${f}`,
  },
  outil: {
    file: "TOOLS.md",
    section: "## Dev Tools",
    format: (f) => `- ${f}`,
  },
  erreur: {
    file: "MEMORY.md",
    section: "## ❌ Erreurs critiques",
    format: (f) => `- ❌ ${f}`,
  },
  savoir: {
    file: "MEMORY.md",
    section: "## 🧠 Savoir",
    format: (f) => `- ${f}`,
  },
};

/**
 * Sync a stored fact to the appropriate .md file.
 * Inserts the fact after the section header, checking for duplicates.
 */
async function syncFactToMd(
  fact: string,
  category: string,
  logger: { info?: (...a: unknown[]) => void; warn: (...a: unknown[]) => void },
): Promise<{ synced: boolean; file?: string; reason?: string }> {
  const mapping = CATEGORY_MD_MAP[category];
  if (!mapping) return { synced: false, reason: `no mapping for category '${category}'` };

  const filePath = `${WORKSPACE}/${mapping.file}`;

  try {
    const content = await readFile(filePath, "utf-8");

    // Duplicate check using improved isNearDuplicate (word overlap + Levenshtein)
    const lines = content.split("\n");
    for (const line of lines) {
      // Strip markdown bullet/formatting for comparison
      const cleanLine = line.replace(/^[\s\-*•❌]+/, "").replace(/\*\*/g, "").trim();
      if (cleanLine.length > 10 && isNearDuplicate(fact, cleanLine)) {
        return { synced: false, file: mapping.file, reason: "duplicate detected" };
      }
    }

    // Find the section and insert after it
    const sectionIdx = lines.findIndex((l) => l.startsWith(mapping.section));
    if (sectionIdx === -1) {
      // Section not found — append at end
      const formatted = `\n${mapping.section}\n${mapping.format(fact)}\n`;
      await writeFile(filePath, content + formatted, "utf-8");
      logger.info?.(`memory-convex: synced to ${mapping.file} (new section)`);
      return { synced: true, file: mapping.file };
    }

    // Find the first non-empty line after section header (skip blank lines)
    let insertIdx = sectionIdx + 1;
    while (insertIdx < lines.length && lines[insertIdx].trim() === "") {
      insertIdx++;
    }

    // For chronologie, insert at top (most recent first)
    // For others, insert at bottom of section (before next section or EOF)
    if (category === "chronologie") {
      // Insert right after the section header + blank line
      lines.splice(insertIdx, 0, mapping.format(fact));
    } else {
      // Find end of section (next ## or EOF)
      let endIdx = insertIdx;
      while (endIdx < lines.length && !lines[endIdx].startsWith("## ")) {
        endIdx++;
      }
      // Insert before the next section (or at end)
      // Go back past any trailing blank lines
      let insertBefore = endIdx;
      while (insertBefore > insertIdx && lines[insertBefore - 1].trim() === "") {
        insertBefore--;
      }
      lines.splice(insertBefore, 0, mapping.format(fact));
    }

    await writeFile(filePath, lines.join("\n"), "utf-8");
    logger.info?.(`memory-convex: synced to ${mapping.file} section "${mapping.section}"`);
    return { synced: true, file: mapping.file };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { synced: false, file: mapping.file, reason: "file not found" };
    }
    logger.warn(`memory-convex: md sync failed for ${mapping.file}: ${String(err)}`);
    return { synced: false, file: mapping.file, reason: String(err) };
  }
}

/**
 * Legacy checkbox sync for todo-promesses.md
 */
async function syncMdCheckboxes(
  fact: string,
  logger: { info?: (...a: unknown[]) => void; warn: (...a: unknown[]) => void },
): Promise<void> {
  const completionSignals = /(?:terminé|fait|implémenté|complet|deployed|fixé|résolu|en place|installé)/i;
  if (!completionSignals.test(fact)) return;

  const todoPath = `${WORKSPACE}/projects/todo-promesses.md`;

  try {
    const content = await readFile(todoPath, "utf-8");
    const lines = content.split("\n");
    let changed = false;

    const factWords = fact
      .toLowerCase()
      .replace(/[^a-zà-ÿ0-9\s]/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 3);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.match(/^\s*- \[ \]/)) continue;

      const lineLower = line.toLowerCase();
      const matchCount = factWords.filter((w) => lineLower.includes(w)).length;
      const matchRatio = factWords.length > 0 ? matchCount / factWords.length : 0;

      if (matchRatio >= 0.4 && matchCount >= 2) {
        lines[i] = line.replace("- [ ]", "- [x]");
        changed = true;
        logger.info?.(`memory-convex: synced checkbox → [x] line ${i + 1}: ${line.trim().slice(0, 60)}...`);
      }
    }

    if (changed) {
      await writeFile(todoPath, lines.join("\n"), "utf-8");
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.warn(`memory-convex: checkbox sync failed: ${String(err)}`);
    }
  }
}

// ─── Boot Audit (Point 5) ───

async function runBootAudit(
  client: ConvexMemoryClient,
  logger: { info?: (...a: unknown[]) => void; warn: (...a: unknown[]) => void },
): Promise<string | null> {
  try {
    const stats = await client.stats();
    const recent = await client.recent({ hours: 24, limit: 5 });

    // Basic coherence: check that we have facts and they're not stale
    const issues: string[] = [];

    if (stats.total === 0) {
      issues.push("⚠️ agentMemory vide — aucun fait stocké");
    }

    if (recent.length === 0 && stats.total > 10) {
      issues.push("⚠️ Aucun fait dans les dernières 24h malgré " + stats.total + " faits au total");
    }

    // Check workspace files exist
    const criticalFiles = ["MEMORY.md", "USER.md", "TOOLS.md"];
    for (const f of criticalFiles) {
      try {
        await readFile(`${WORKSPACE}/${f}`, "utf-8");
      } catch {
        issues.push(`⚠️ Fichier ${f} introuvable dans le workspace`);
      }
    }

    // Check for stale facts (category count mismatch)
    const catCounts = stats.categories;
    if ((catCounts["erreur"] ?? 0) > 20) {
      issues.push(`⚠️ ${catCounts["erreur"]} erreurs en mémoire — possible accumulation non nettoyée`);
    }

    if (issues.length === 0) {
      logger.info?.(`memory-convex: boot audit OK (${stats.total} facts, ${recent.length} recent)`);
      return null;
    }

    const report = [
      "## 🔍 Audit mémoire (boot)",
      `Faits: ${stats.total} | Récents 24h: ${recent.length}`,
      "",
      ...issues,
    ].join("\n");

    // Write audit to today's memory file
    const today = new Date().toISOString().slice(0, 10);
    const memPath = `${WORKSPACE}/memory/${today}.md`;
    try {
      await appendFile(memPath, `\n\n## Auto — Audit boot\n${issues.join("\n")}\n`, "utf-8");
    } catch {
      // File might not exist yet, create it
      await writeFile(memPath, `# ${today}\n\n## Auto — Audit boot\n${issues.join("\n")}\n`, "utf-8");
    }

    logger.warn(`memory-convex: boot audit found ${issues.length} issue(s)`);
    return report;
  } catch (err) {
    logger.warn(`memory-convex: boot audit failed: ${String(err)}`);
    return null;
  }
}

// ─── Plugin ───

const memoryConvexPlugin = {
  id: "memory-convex",
  name: "Memory (Convex)",
  description: "Auto-recall and auto-capture via Convex agentMemory. Zero deps, zero cost.",

  register(api: OpenClawPluginApi) {
    const cfg = parseConfig(api.pluginConfig as Record<string, unknown>);

    if (!cfg.convexUrl) {
      api.logger.warn("memory-convex: no convexUrl configured, plugin disabled");
      return;
    }

    const client = new ConvexMemoryClient(cfg.convexUrl);

    // Track boot audit state per session
    let bootAuditDone = false;

    api.logger.info(
      `memory-convex: v0.3.0 registered (recall=${cfg.autoRecall}, capture=${cfg.captureMode}, audit=${cfg.bootAudit}, syncMd=${cfg.syncMdEnabled}, agent=${cfg.defaultAgent})`,
    );

    // ════════════════════════════════════════════════════════════════════════
    // HOOK: before_prompt_build — Auto-Recall + Boot Audit
    // ════════════════════════════════════════════════════════════════════════

    if (cfg.autoRecall) {
      api.on("before_prompt_build", async (event, _ctx) => {
        const prompt = event.prompt;
        if (!prompt || prompt.length < 5) return;

        if (/^(heartbeat|HEARTBEAT|\/\w+)/.test(prompt.trim())) return;

        // ── Boot Audit (Point 5) ──
        let auditContext = "";
        if (cfg.bootAudit && !bootAuditDone) {
          bootAuditDone = true;
          const auditReport = await runBootAudit(client, api.logger);
          if (auditReport) {
            auditContext = auditReport + "\n\n";
          }
        }

        // ── Auto-Recall (with temporal scoring) ──
        try {
          // Fetch more than needed, then re-rank with temporal scoring
          const fetchLimit = Math.min(cfg.recallLimit * 2, 20);
          const facts = await client.search(prompt, { limit: fetchLimit });

          if (!facts || facts.length === 0) {
            return auditContext ? { prependContext: auditContext } : undefined;
          }

          const relevant = facts.filter((f) => f.confidence >= 0.5);
          if (relevant.length === 0) {
            return auditContext ? { prependContext: auditContext } : undefined;
          }

          // Apply temporal scoring and take top N
          const scored = applyTemporalScoring(relevant);
          const topFacts = scored.slice(0, cfg.recallLimit);

          const context = formatRecallContext(topFacts);

          // Track access for usage-based scoring
          const accessIds = topFacts.map((f) => f._id).filter(Boolean);
          client.trackAccess(accessIds).catch(() => {}); // fire & forget

          api.logger.info?.(
            `memory-convex: recall injected ${topFacts.length}/${relevant.length} facts (temporal scored) for "${prompt.slice(0, 50)}..."`,
          );

          return { prependContext: auditContext + context };
        } catch (err) {
          api.logger.warn(`memory-convex: recall failed: ${String(err)}`);
          return auditContext ? { prependContext: auditContext } : undefined;
        }
      });
    }

    // ════════════════════════════════════════════════════════════════════════
    // HOOK: agent_end — Auto-Capture (regex + LLM + sync .md)
    // ════════════════════════════════════════════════════════════════════════

    if (cfg.autoCapture) {
      api.on("agent_end", async (event, _ctx) => {
        if (!event.success || !event.messages || event.messages.length === 0) return;

        try {
          // Collect texts from both user AND assistant messages
          const userTexts: string[] = [];
          const assistantTexts: string[] = [];

          for (const msg of event.messages) {
            if (!msg || typeof msg !== "object") continue;
            const m = msg as Record<string, unknown>;
            const role = m.role as string;

            const extractText = (content: unknown): string | null => {
              // Extract text regardless of length — truncation happens later at LLM call
              // captureMaxChars no longer gates extraction (was filtering ALL real messages)
              if (typeof content === "string" && content.length > 0) {
                return content;
              }
              if (Array.isArray(content)) {
                for (const part of content) {
                  if (part && typeof part === "object" && (part as any).type === "text") {
                    const text = (part as any).text;
                    if (typeof text === "string" && text.length > 0) {
                      return text;
                    }
                  }
                }
              }
              return null;
            };

            const text = extractText(m.content);
            if (text) {
              if (role === "user") userTexts.push(text);
              else if (role === "assistant") assistantTexts.push(text);
            }
          }

          const allFacts: ExtractedFact[] = [];

          // ── Regex extraction (user messages only, original behavior) ──
          if (cfg.captureMode === "regex" || cfg.captureMode === "both") {
            for (const text of userTexts) {
              allFacts.push(...extractSimpleFacts(text, cfg.defaultAgent));
            }
          }

          // ── LLM extraction (both user + assistant, richer) ──
          if (cfg.captureMode === "llm" || cfg.captureMode === "both") {
            // Combine the last user + assistant messages for context
            const combinedText = [
              ...userTexts.slice(-1).map((t) => `[Utilisateur] ${t}`),
              ...assistantTexts.slice(-1).map((t) => `[Assistant] ${t}`),
            ].join("\n\n");

            if (combinedText.length > 80) {
              const llmFacts = await extractFactsWithLlm(combinedText, cfg, api.logger);
              // Deduplicate against regex facts
              for (const lf of llmFacts) {
                const isDupe = allFacts.some((af) => {
                  const overlap = lf.fact
                    .toLowerCase()
                    .split(/\s+/)
                    .filter((w) => w.length > 4 && af.fact.toLowerCase().includes(w));
                  return overlap.length >= 3;
                });
                if (!isDupe) {
                  allFacts.push(lf);
                }
              }

              if (llmFacts.length > 0) {
                api.logger.info?.(`memory-convex: LLM extracted ${llmFacts.length} facts`);
              }
            }
          }

          // ── Store facts + sync ──
          let stored = 0;
          for (const fact of allFacts) {
            try {
              await client.store({
                ...fact,
                agent: cfg.defaultAgent,
                source: cfg.captureMode === "regex" ? "auto-capture" : `auto-capture-${cfg.captureMode}`,
              });
              stored++;

              // Checkbox sync (todo-promesses.md) — always
              await syncMdCheckboxes(fact.fact, api.logger);

              // Extended .md sync (Point 6) — if enabled
              if (cfg.syncMdEnabled) {
                const syncResult = await syncFactToMd(fact.fact, fact.category, api.logger);
                if (syncResult.synced) {
                  api.logger.info?.(
                    `memory-convex: synced fact to ${syncResult.file}`,
                  );
                }
              }
            } catch (storeErr) {
              api.logger.warn(`memory-convex: capture store failed: ${String(storeErr)}`);
            }
          }

          if (stored > 0) {
            api.logger.info?.(`memory-convex: auto-captured ${stored} facts (mode: ${cfg.captureMode})`);
          }
        } catch (err) {
          api.logger.warn(`memory-convex: capture failed: ${String(err)}`);
        }
      });
    }

    // ════════════════════════════════════════════════════════════════════════
    // HOOK: after_compaction — Log compaction events
    // ════════════════════════════════════════════════════════════════════════

    api.on("after_compaction", async (event, _ctx) => {
      api.logger.info?.(
        `memory-convex: compaction complete — ${event.compactedCount} messages compacted, ${event.messageCount} remaining`,
      );
    });

    // ════════════════════════════════════════════════════════════════════════
    // COMMAND: /memory — Quick memory status
    // ════════════════════════════════════════════════════════════════════════

    api.registerCommand({
      name: "memory",
      description: "Affiche les stats de la mémoire persistante (agentMemory)",
      requireAuth: true,
      handler: async (_ctx) => {
        try {
          const stats = await client.stats();
          const recent = await client.recent({ hours: 24, limit: 5 });

          let text = `🧠 **Mémoire Convex** (v0.3.0)\n`;
          text += `Total: ${stats.total} faits | Hashés: ${stats.withHash}\n`;
          text += `Mode capture: ${cfg.captureMode} | Recall: ${cfg.recallLimit}\n`;
          text += `Audit boot: ${cfg.bootAudit ? "ON" : "OFF"} | Sync .md: ${cfg.syncMdEnabled ? "ON" : "OFF"}\n`;
          text += `Catégories: ${Object.entries(stats.categories).map(([k, v]) => `${k}(${v})`).join(", ")}\n`;

          if (recent.length > 0) {
            text += `\n📌 Dernières 24h:\n`;
            for (const f of recent.slice(0, 5)) {
              text += `- [${f.category}] ${f.fact.slice(0, 80)}${f.fact.length > 80 ? "..." : ""}\n`;
            }
          }

          return { text };
        } catch (err) {
          return { text: `❌ Erreur mémoire: ${String(err)}` };
        }
      },
    });
  },
};

export default memoryConvexPlugin;
