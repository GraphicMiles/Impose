# Source intelligence architecture audit

Date: 2026-09-14

## Existing flow

1. `app.js::routeByIntent` asks the semantic intent engine for goal, constraints, desired output, and capability requirements.
2. `agent/orchestrator.js` resolves capabilities against tool metadata and creates a task plan.
3. `app.js` routes providers marked `executionMode: research-harness` into `agent/harness.js::runAgent`.
4. The harness currently coordinates web search, page reading, image discovery, playable media, and remote files.
5. Relay modules (`search.py`, `images.py`, `videos.py`, `files.py`) contain source-specific adapters and return typed records.
6. `backend/relay/capabilities.py` provides reusable adapter discovery, claim verification, ranking, and deduplication for typed capabilities.
7. Task state, observations, verification, failures, and trace snapshots are persisted by the orchestrator and app.

## Existing strengths retained

- Semantic capability selection precedes compatibility heuristics.
- Tools have structured metadata, prerequisites, permissions, side effects, costs, verification, and failure modes.
- Browser actions remain origin-bounded and approval-gated.
- Media and file artifacts are typed and rendered from deterministic records rather than model HTML.
- Search/read/file relays already include deterministic parsing, URL validation, SSRF controls, redirect checks, and size limits.
- Provider failures and one bounded retry/replan already exist in several capability runners.

## Source/tool coupling found

- Search mechanisms and source providers were represented as one concept inside relay engines.
- Image providers were always raced together; the first technically valid response won regardless of task-specific source fitness.
- Image quality review could reject a result set, fail to obtain a replacement, and then restore the rejected set.
- The image request contract carried only a query and limit, losing semantic artifact constraints such as format, transparency, license requirements, and intended use.
- Provider diagnostics were logged but were not represented as a source plan with candidate scores and fallback decisions.
- Provider performance was not fed back into future selection.
- Provider lists lived in execution code rather than an extensible canonical catalog.
- Generic web search tier ordering was static and source diversity was not an explicit requirement.

## Hardcoded source logic found

- `images.py` had a fixed provider race order: Openverse, Wikimedia, Bing Images, and DuckDuckGo Images.
- `search.py` had fixed SearXNG and HTML-search tiers.
- `files.py` contains deterministic platform URL adapters for GitHub, GitLab, Hugging Face, and Gists. These are transport/normalization adapters, not user-phrase routing, and should remain deterministic.
- Legacy image/media request detectors remain only for third-party callers that do not provide semantic intent. Production supplies semantic intent.
- Image query cleanup had wording-based decoration removal. Semantic `retrievalQuery` and structured artifact requirements should supersede it in production.

## Architectural decision

Introduce source intelligence as a separate primitive:

- **Intent engine:** determines goal and structured requirements.
- **Capability registry:** determines what operation/tool can satisfy each requirement.
- **Provider catalog:** describes where evidence or artifacts may exist.
- **Source router:** ranks providers against task-specific source requirements.
- **Retrieval mechanism:** executes provider adapters in progressive stages.
- **Quality evaluator:** scores actual result relevance, compatibility, attribution, validity, diversity, and constraints.
- **Observation ledger:** updates provider performance from verified outcomes.
- **Planner/trace:** exposes candidates, scores, selection reasons, observations, and fallback decisions.

Provider profiles are data, while adapter code performs deterministic integration. Adding a scenario must not add a request-word branch; adding a provider adds catalog metadata and, only when necessary, a transport adapter.

## Migration sequence

1. Add provider catalog, source requirement schema, intent-specific ranker, progressive stages, conservative provider discovery, and performance observations.
2. Move image discovery onto the source router because the reported failure demonstrates first-response routing is inadequate.
3. Carry structured source requirements from semantic intent through the harness and relay.
4. Expose source planning and quality/fallback evidence in pipeline traces.
5. Migrate generic research and file discovery onto the same primitives without replacing their working security and normalization layers.
6. Build website inspection and higher-level reusable skills on capability plus source requirements rather than scenario triggers.

## Implemented state

Images, general web research, and file discovery now use the shared provider catalog, contextual source requirements, ranked progressive stages, result-quality gates, adaptive observations, and explainable `sourcePlan` traces. The catalog also includes attachable profiles for official and standards discovery, research repositories, datasets, books, package registries, Android distribution, design assets, commerce, and developer sources; profiles without an installed adapter cannot be selected by an executor.

Artifact transformation remains separate from sourcing. A specialist vector source can therefore supply a semantically suitable SVG input when the requested outcome is PNG; the relay converts it, decodes the produced bytes, verifies PNG format and real alpha transparency, and issues a signed, SSRF-checked conversion URL. Alternative retrieval queries are semantic planner outputs used only for bounded recovery, not provider trigger phrases.
