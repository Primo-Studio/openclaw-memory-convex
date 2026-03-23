# memory-convex — Plugin OpenClaw

Plugin de mémoire persistante pour OpenClaw utilisant Convex comme backend.
Zéro dépendance npm, coût quasi nul (~$0.04/mois).

## Version

**v0.3.0** (22/03/2026)

## Fonctionnalités

### Auto-Recall (before_prompt_build)
- Cherche les faits pertinents dans agentMemory avant chaque message
- Injecte les faits en `prependContext` (le modèle les voit avant le prompt)
- Configurable : `recallLimit` (défaut: 8 faits)
- Skip les heartbeats et commandes

### Auto-Capture (agent_end)
- **Mode regex** : détecte préférences utilisateur et bugs signalés
- **Mode LLM** : extraction de faits durables via LLM (GPT-5.4-nano par défaut)
- **Mode both** : regex + LLM combinés avec dédup croisée
- Filtres anti faux-positifs (patterns vagues rejetés, seuil texte 80 chars)

### Boot Audit (before_prompt_build, 1ère invocation)
- Vérifie la cohérence mémoire au démarrage de session
- Checks : faits existants, récence, fichiers workspace, accumulation erreurs
- Écrit un rapport dans `memory/YYYY-MM-DD.md` si problèmes détectés

### Sync .md étendue (agent_end)
- Synchronise les faits capturés vers les fichiers .md appropriés
- Mapping catégorie → fichier :
  - `chronologie` → MEMORY.md (📅 Chronologie, insertion en haut)
  - `erreur` → MEMORY.md (❌ Erreurs critiques)
  - `savoir` → MEMORY.md (🧠 Savoir)
  - `preference` → USER.md (Personnalité & Communication)
  - `outil` → TOOLS.md (Dev Tools)
- Dédup par overlap de mots (≥60%, ≥3 mots significatifs)
- Sync checkboxes todo-promesses.md (legacy, toujours actif)

### Commande /memory
- Affiche les stats rapides de la mémoire (total, catégories, derniers faits)

## Configuration

```jsonc
// openclaw.json → plugins.entries.memory-convex.config
{
  "convexUrl": "https://your-deployment.convex.cloud",  // Required
  "autoRecall": true,           // Injection auto de faits
  "autoCapture": true,          // Capture auto en fin de message
  "recallLimit": 8,             // Nombre de faits injectés
  "captureMaxChars": 500,       // Taille max message capturé
  "defaultAgent": "koda",       // Nom de l'agent
  
  // Phase 2
  "captureMode": "both",        // "regex" | "llm" | "both"
  "llmUrl": "https://api.openai.com/v1",  // URL du LLM
  "llmModel": "gpt-5.4-nano",  // Modèle d'extraction
  "llmApiKey": "",              // Clé API (fallback: env OPENAI_API_KEY)
  "bootAudit": true,            // Audit cohérence au boot
  "syncMdEnabled": true         // Sync étendue vers .md
}
```

## Points LLM branchables

Le plugin est conçu pour être portable. Trois points utilisent un LLM :

### 1. Auto-capture (extractFactsWithLlm)
- **Config** : `llmUrl` + `llmModel` + `llmApiKey`
- **Défaut** : GPT-5.4-nano (API OpenAI, ~$0.001/jour)
- **Local** : `llmUrl: "http://localhost:11434"`, `llmModel: "glm4"`
- **Détection** : si l'URL contient "11434" ou "ollama" → format Ollama, sinon → OpenAI compatible
- **Contrainte** : le modèle doit supporter le JSON structuré

### 2. Contradiction check (Convex server-side)
- **Fichier** : `convex/agentMemory.ts` → action `storeWithContradictionCheck`
- **Défaut** : GPT-5.4-nano via OpenAI API
- **Local** : modifier la Convex action pour appeler Ollama (nécessite que le serveur Convex puisse joindre l'URL Ollama)

### 3. LCM summaries (plugin lossless-claw, externe)
- **Config** : `env.LCM_SUMMARY_PROVIDER` + `env.LCM_SUMMARY_MODEL`
- **Défaut** : `openai-codex/gpt-5.2` ($0 avec plan Pro)
- **Local** : `ollama/glm4` (qualité moindre pour résumés longs)

## Architecture

```
Message utilisateur
    ↓
[before_prompt_build]
    ├── Boot audit (1ère fois) → rapport dans memory/
    └── Recall → search agentMemory → prependContext (8 faits)
    ↓
Réponse agent
    ↓
[agent_end]
    ├── Regex extraction (préférences, bugs)
    ├── LLM extraction (GPT-5.4-nano, faits durables)
    ├── Store → agentMemory (Convex)
    ├── Sync → todo-promesses.md (checkboxes)
    └── Sync → MEMORY.md / USER.md / TOOLS.md (par catégorie)
```

## Coûts

| Composant | Coût |
|-----------|------|
| GPT-5.4-nano (20 appels/jour) | ~$0.04/mois |
| Convex (free tier) | $0 |
| Avec Ollama local | $0 |

## Fichiers

```
memory-convex/
├── index.ts              # Plugin principal (hooks + extraction)
├── convex-client.ts      # Client HTTP pour l'API Convex
├── openclaw.plugin.json  # Manifest du plugin
└── README.md             # Cette documentation
```

## Changelog

### v0.2.0 (22/03/2026)
- **Point 4** : Auto-capture LLM (GPT-5.4-nano, supporte Ollama fallback)
- **Point 5** : Boot audit (cohérence mémoire au démarrage)
- **Point 6** : Sync .md étendue (5 catégories → 3 fichiers)
- Filtres anti faux-positifs (patterns vagues, seuil texte)
- Format prompt JSON object `{"facts": [...]}` pour compatibilité OpenAI

### v0.1.0 (22/03/2026)
- Auto-recall (before_prompt_build, 5→8 faits)
- Auto-capture regex (agent_end, préférences + bugs)
- Sync checkboxes todo-promesses.md
- Commande /memory

### v0.3.0 (22/03/2026)
- **Temporal scoring** : decay exponentiel pour faits épisodiques, boost faits <24h, catégories protégées
- **Track access** : compteur d'accès + timestamp dernier recall (Convex `trackAccess`)
- **Dédup amélioré** : Levenshtein distance en complément de l'overlap de mots
- **Re-ranking** : fetch 2x le limit, score temporel, retourne les top N
- **Fix contradiction check** : élargi fenêtre de recherche côté recall
