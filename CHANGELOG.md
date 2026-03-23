# Changelog

## v0.3.0 (2026-03-22)
- Temporal scoring au recall (decay exponentiel, boost récents)
- Track access : compteur accessCount + lastAccessedAt
- Levenshtein dedup (<100 chars) en plus du factHash + keywordHash
- storeWithContradictionCheck : GPT-5.4-nano, clé lue depuis agentSecrets
- Sync .md étendue : faits capturés écrits dans les fichiers workspace

## v0.2.0 (2026-03-15)
- Auto-recall (before_prompt_build)
- Auto-capture regex + LLM
- Boot audit
- Support Convex agentMemory API

## v0.1.0 (2026-03-14)
- Initial release
- Basic recall/capture hooks
