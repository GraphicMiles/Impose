# Web capability architecture

Impose treats web work as typed capabilities, not model prose with guessed URLs. User-goal orchestration, conditional classification, lifecycle, and runtime integration are documented in [intent-orchestration-design.md](./intent-orchestration-design.md); this document describes the lower provider-capability layer.

## Request path

1. **Semantic interpretation** — the intent layer decomposes the goal into canonical requirements using the current registry catalog, conversation, active task, constraints, and failures. It does not match request phrases to tool names.
2. **Tool planning** — the client registry discovers and ranks tools that advertise the required capabilities (`media.playable`, rather than a provider name).
3. **Provider discovery** — inside a selected web/media tool, relay adapters return candidates from independent providers.
4. **Verification claims** — an adapter may attach only claims it can prove, such as `playable`, `live`, or `latest`.
5. **Policy gate** — `CapabilityPipeline` drops every candidate that lacks the request's required claims. Provider outages fail independently.
6. **Presentation** — the client validates canonical IDs and claims, then renders a typed artifact. Structured output preferences control presentation.

The answer model does not create identifiers, URLs, liveness, or recency claims.

## Current playable-media adapters

- `DirectMediaAdapter`: canonical YouTube/Twitch URLs; `playable` only.
- `TwitchLiveAdapter`: Twitch GraphQL live directory, named channel, and game/category discovery; `playable + live` when the live API proves it.
- `YouTubeMediaAdapter`: general video discovery, creator-channel feeds for latest uploads, and current topic search for trailers/teasers.
- `WebMediaAdapter`: canonical IDs discovered through web/video search; `playable` only and therefore ineligible for strict live/latest requests.

## Extension seams

### Add another provider for an existing capability

Implement an adapter with `name`, `capabilities`, `supports(request)`, and async `discover(request, context)`, then register it on the relevant pipeline. Return `Candidate` objects with explicit claims and scores.

### Add another web capability

1. Define its semantic capability name and typed result contract.
2. Register one or more relay adapters on a `CapabilityPipeline`.
3. Register a client tool with that capability and a deterministic `matches` detector.
4. Add a renderer that consumes the typed result. Keep provider data out of executable markup.
5. Add claim-policy, provider-failure, malformed-result, persistence, and mobile rendering tests.

This keeps provider changes below the orchestration boundary and keeps model-generated text outside the trust boundary.
