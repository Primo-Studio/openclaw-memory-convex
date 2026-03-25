# memory-convex — Plugin OpenClaw

Plugin de mémoire persistante pour OpenClaw utilisant Convex comme backend.
Zéro dépendance npm, coût quasi nul (~$0.04/mois).

**Compatible OpenClaw 2026.3.23+** (plugin-sdk/core)

## Version

**v0.3.0** (24/03/2026)

## Compatibilité

| OpenClaw | Status |
|----------|--------|
| 2026.3.23+ | ✅ Testé, compatible |
| 2026.3.13–2026.3.22 | ✅ Compatible |
| < 2026.3.13 | ⚠️ Non testé |

Le plugin utilise l'API stable `openclaw/plugin-sdk/core` (import type).
Pattern d'export : `register()` + `export default` (compatible extensions locales `.ts`).

> **Note SDK** : `definePluginEntry` (nouveau dans 2026.3.22+) n'est utilisable que pour les plugins **compilés en JS** (packages npm). Les extensions locales `.ts` doivent rester sur le pattern `register()`.

## Fonctionnalités

### Auto-Recall (before_prompt_build)
- Cherche les faits pertinents dans agentMemory avant chaque message
- Injecte en `prependContext` avec **temporal scoring** (decay exponentiel, boost récence)
- Configurable : `recallLimit` (défaut: 8 faits)

### Auto-Capture (agent_end)
- **Mode regex** : détecte préférences et bugs
- **Mode LLM** : extraction via GPT-5.4-nano ou Ollama local ($0)
- **Mode both** : regex + LLM avec dédup croisée
- Dédup : overlap mots + Levenshtein distance

### Boot Audit
- Vérifie la cohérence mémoire au démarrage de session
- Rapport auto dans `memory/YYYY-MM-DD.md`

### Sync .md étendue
- `chronologie` → MEMORY.md | `erreur` → MEMORY.md | `savoir` → MEMORY.md
- `preference` → USER.md | `outil` → TOOLS.md

### Commande /memory
- Stats rapides de la mémoire persistante

## Configuration

```jsonc
// openclaw.json → plugins.entries.memory-convex.config
{
  "convexUrl": "https://your-deployment.convex.cloud",
  "autoRecall": true,
  "autoCapture": true,
  "recallLimit": 8,
  "captureMode": "both",       // "regex" | "llm" | "both"
  "llmUrl": "http://localhost:11434",  // Ollama local = $0
  "llmModel": "glm4",
  "bootAudit": true,
  "syncMdEnabled": true
}
```

## Plugin SDK — Patterns

**Extensions locales (.ts)** — ce que memory-convex utilise :
```typescript
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";

const myPlugin = {
  id: "my-plugin",
  name: "My Plugin",
  register(api: OpenClawPluginApi) {
    api.on("before_prompt_build", async (event) => { /* ... */ });
  },
};
export default myPlugin;
```

**Plugins compilés (npm)** — pour publication :
```typescript
import { definePluginEntry } from "openclaw/plugin-sdk/core";

export default definePluginEntry({
  id: "my-plugin",
  registerFull(api) { /* ... */ },
});
```

## Architecture

```
Message → [before_prompt_build] → Recall (temporal scoring) → prependContext
       → [agent_end] → Extract (regex+LLM) → Store (Convex) → Sync (.md)
```

## Changelog

### v0.3.0 (22/03/2026)
- Temporal scoring, track access, Levenshtein dedup, re-ranking
- Compat OpenClaw 2026.3.23+

### v0.2.0
- Auto-capture LLM, boot audit, sync .md étendue

### v0.1.0
- Auto-recall, auto-capture regex, /memory
