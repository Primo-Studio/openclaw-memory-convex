# Changelog

## v0.4.0 (2026-03-25)
### Fixed
- **Critical: zero auto-captures since v0.1.0** — `extractText()` rejected all messages exceeding `captureMaxChars` (500). Telegram messages with metadata always exceed 500 chars → 0 facts ever captured automatically
- **syncMdEnabled had no effect** — cascade dependency: no captured facts → no sync writes. Fixed by fixing extraction
- **LLM extraction unreachable** — default config pointed to `api.openai.com` with no key. Switched to Ollama `gemma3:4b` (local, free, reliable JSON output)

### Changed
- `extractText()` no longer gates on `captureMaxChars` — extracts all text, truncation happens at LLM prompt stage
- Default LLM: `gpt-5.4-nano` via OpenAI API → `gemma3:4b` via Ollama (http://localhost:11434)
- `captureMaxChars` default recommendation: 500 → 5000

### Documented
- Added JSDoc comment on `storeWithContradictionCheck` in Bureau codebase: it's a Convex **action** (endpoint `/api/action`), not a mutation. Bug caused silent Server Error since creation (commit 94722b0)

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
