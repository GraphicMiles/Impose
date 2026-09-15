# Retrieval reliability: 500-request matrix

Date: 2026-09-15
Seed: `20260915` (deterministic randomization)

## Coverage

The relay contract matrix executes 500 varied requests through the FastAPI application:

| Capability surface | Requests |
|---|---:|
| General web research | 125 |
| Image and brand-asset discovery | 125 |
| Files, documents, templates, datasets, and packages | 125 |
| Live/latest/playable media | 125 |
| **Total** | **500** |

Inputs vary subject, wording, result limits, source diversity, source classes, formats, characteristics, domains, platforms, recency/live flags, and both canonical and plausible planner-generated JSON shapes. Provider network I/O is deterministic in this matrix so failures identify orchestration, normalization, routing, and output-contract defects rather than unrelated internet variance. The file cases execute the real file-discovery engine with deterministic search observations rather than bypassing it.

## Acceptance checks

Every case must:

1. cross the public relay endpoint without an accidental HTTP 400 or 5xx;
2. produce a non-empty typed result;
3. preserve the endpoint's output contract;
4. normalize bounded scalar/array and JSON-object/string variants;
5. retain source-plan evidence where that capability supports it.

## Root defects found and corrected

- File discovery treated every successful outcome as a direct byte download, so legitimate provider-hosted templates could not complete even when a safe template page existed.
- File search expansion was biased toward GitHub instead of being generated from context-ranked provider metadata.
- Structured formats in source requirements were not consistently promoted into artifact filtering.
- Reasonable scalar or JSON-string shapes for domains, platforms, requirements, booleans, and media constraints could produce HTTP 400 rather than bounded normalization.
- The file UI required a fake `downloadUrl`; it could not represent an honest provider-side `Open template` action.
- Public-rate tests depended on suite ordering and became unreliable once broader matrix tests were introduced.
- A nine-second health probe generated false negatives during Render wake-up.

## Architectural correction

The provider catalog now carries provider domains. File discovery uses ranked provider profiles to derive domain-scoped progressive queries. It can return either:

- a canonical, normalized direct download; or
- an attributed provider action with `accessMode: open`, `actionUrl`, and an honest action label.

The UI distinguishes these outcomes and never downloads a landing page as if it were a document. Template providers currently include Microsoft Create, Google Docs, Adobe Express, Canva, and Overleaf, selected through metadata rather than request-word branches.

## Command

```bash
PYTHONPATH=backend python3 -m pytest backend/relay/tests/test_500_request_matrix.py -q
```

The matrix is committed as a permanent regression suite, not a one-time script.
