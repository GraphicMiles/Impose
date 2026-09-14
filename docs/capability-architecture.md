# Web capability architecture

Impose treats web work as typed capabilities, not model prose with guessed URLs.

## Request path

1. **Intent detection** — registered browser tools may expose `matches(query, context)`. Explicit capability commands route through the harness even when broad Web search is off.
2. **Planning** — the harness produces a bounded query and resolves the semantic capability (`media.playable`, rather than a provider name).
3. **Discovery adapters** — relay adapters return candidates from independent providers.
4. **Verification claims** — an adapter may attach only claims it can prove, such as `playable`, `live`, or `latest`.
5. **Policy gate** — `CapabilityPipeline` drops every candidate that lacks the request's required claims. Provider outages fail independently.
6. **Presentation** — the client validates canonical IDs and claims, then renders a typed artifact. A play command opens the verified player in Impose.

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
