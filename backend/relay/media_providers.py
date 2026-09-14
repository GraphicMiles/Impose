"""Playable-media adapters registered on the generic capability pipeline."""
import re

import httpx

from relay.capabilities import Candidate, CapabilityPipeline
from relay.search import UA, engine_search
from relay.media_core import (
    BING_VIDEOS, YOUTUBE_SEARCH, VIDEO_TIMEOUT_SECONDS,
    _direct_urls, _find_youtube_channel, _latest_from_feed,
    _supported_result, _twitch_target, _verify_twitch_channel,
    parse_bing_videos, parse_media_request, parse_youtube_channels, parse_youtube_search,
    TWITCH_CLIENT_ID, TWITCH_GQL, VideosFailed,
)


def _candidate(row, provider, claims, score):
    value = dict(row)
    value["verifiedClaims"] = sorted(claims)
    value["verificationSource"] = provider
    return Candidate(value=value, provider=provider,
                     claims=frozenset(claims), score=score)


class DirectMediaAdapter:
    name = "direct-url"
    capabilities = frozenset({"media.playable"})

    def supports(self, request):
        return bool(request.options.get("urls"))

    async def discover(self, request, _client):
        out = []
        for index, url in enumerate(request.options.get("urls", ())):
            row = _supported_result(url, "Open video or stream")
            if row:
                out.append(_candidate(row, self.name, {"playable"}, 1200 - index))
        return out


async def _twitch_graphql(client, query, variables=None):
    response = await client.post(
        TWITCH_GQL,
        headers={"Client-ID": TWITCH_CLIENT_ID, "Content-Type": "application/json"},
        json={"query": query, "variables": variables or {}},
        timeout=VIDEO_TIMEOUT_SECONDS,
    )
    if response.status_code != 200:
        return {}
    payload = response.json()
    if payload.get("errors"):
        return {}
    return payload.get("data") or {}


def _twitch_live_row(node):
    broadcaster = (node or {}).get("broadcaster") or {}
    login = str(broadcaster.get("login") or (node or {}).get("login") or "").lower()
    if not re.fullmatch(r"[a-z0-9_]{3,25}", login):
        return None
    display = str(broadcaster.get("displayName") or (node or {}).get("displayName") or login)
    stream = (node or {}).get("stream") if "stream" in (node or {}) else node
    if not stream:
        return None
    title = str(stream.get("title") or (display + " — live on Twitch"))
    row = _supported_result("https://www.twitch.tv/" + login, title)
    if not row:
        return None
    row["live"] = True
    row["channel"] = display[:120]
    row["viewers"] = max(0, int(stream.get("viewersCount") or 0))
    game = stream.get("game") or {}
    if game.get("name"):
        row["category"] = str(game["name"])[:120]
    return row


class TwitchLiveAdapter:
    name = "twitch-gql"
    capabilities = frozenset({"media.playable"})
    _user_query = """query($login:String!){user(login:$login){login displayName
      stream{id title viewersCount game{name}}}}"""
    _game_query = """query($name:String!){game(name:$name){name streams(first:10){
      edges{node{id title viewersCount broadcaster{login displayName}}}}}}"""
    _top_query = """query{streams(first:10){edges{node{id title viewersCount
      broadcaster{login displayName}}}}}"""

    def supports(self, request):
        return "twitch" in request.platforms

    async def discover(self, request, client):
        subject = request.subject.strip()
        wants_live = bool(request.options.get("live"))
        out = []
        if wants_live:
            target = re.sub(r"[^a-z0-9_]", "", subject.lower().lstrip("@"))
            if target:
                data = await _twitch_graphql(client, self._user_query, {"login": target})
                row = _twitch_live_row(data.get("user"))
                if row:
                    return [_candidate(row, self.name, {"playable", "live"}, 2000)]
                data = await _twitch_graphql(client, self._game_query, {"name": subject})
                edges = (((data.get("game") or {}).get("streams") or {}).get("edges") or [])
            else:
                data = await _twitch_graphql(client, self._top_query)
                edges = ((data.get("streams") or {}).get("edges") or [])
            for edge in edges:
                row = _twitch_live_row((edge or {}).get("node"))
                if row:
                    out.append(_candidate(row, self.name, {"playable", "live"},
                                          1000 + row.get("viewers", 0)))
            return out

        # A named Twitch request may legitimately target an offline channel;
        # verify the exact account, but never attach a live guarantee.
        exact = await _verify_twitch_channel(client, request.query) if subject else None
        if exact:
            out.append(_candidate(exact, "twitch-page", {"playable"}, 800))
        return out


class YouTubeMediaAdapter:
    name = "youtube-search"
    capabilities = frozenset({"media.playable"})

    def supports(self, request):
        return "youtube" in request.platforms

    async def discover(self, request, client):
        # Search the subject, not conversational framing such as “find me a
        # YouTube tutorial on …”. Typed constraints determine live/latest;
        # exact YouTube renderer metadata proves live state.
        wants_live = bool(request.options.get("live"))
        discovery_query = request.subject or ("live" if wants_live else request.query)
        if wants_live and request.subject:
            discovery_query = request.subject + " live"
        response = await client.get(
            YOUTUBE_SEARCH,
            params={"search_query": discovery_query},
            timeout=VIDEO_TIMEOUT_SECONDS,
        )
        if response.status_code != 200:
            return []
        rows = parse_youtube_search(response.text, discovery_query, 12 if wants_live else request.limit)
        if wants_live:
            live_rows = [row for row in rows if row.get("live") is True][:request.limit]
            return [_candidate(row, "youtube-live-search", {"playable", "live"}, 2800 - index)
                    for index, row in enumerate(live_rows)]
        if request.options.get("latest"):
            wanted = re.sub(r"[^a-z0-9]", "", request.subject.lower())
            channel_id = ""
            for channel in parse_youtube_channels(response.text):
                label = re.sub(r"[^a-z0-9]", "", str(channel.get("title", "")).lower())
                if wanted and label == wanted:
                    channel_id = channel["channelId"]
                    break
            for row in rows:
                owner = re.sub(r"[^a-z0-9]", "", str(row.get("channel", "")).lower())
                if not channel_id and row.get("channelId") and wanted and owner == wanted:
                    channel_id = row["channelId"]
                    break
            if (not channel_id and request.options.get("creator_hint")
                    and rows and rows[0].get("channelId")):
                channel_id = rows[0]["channelId"]
            if not channel_id and request.options.get("creator_hint"):
                channel_id = await _find_youtube_channel(request.query)
            latest = await _latest_from_feed(client, channel_id)
            if latest:
                return [_candidate(latest, "youtube-feed", {"playable", "latest"}, 3000)]

            # Topic requests such as "latest movie trailer" do not name a
            # creator channel. YouTube's current query ranking supplies the
            # relevant release; reject obvious fan/concept substitutions and
            # expose the weaker provenance explicitly.
            for row in rows:
                label = (str(row.get("title", "")) + " " + str(row.get("channel", ""))).lower()
                if not row.get("channelVerified") or re.search(
                        r"\b(?:fan[- ]?made|concept|reaction|breakdown|ai concept)\b", label):
                    continue
                row = dict(row)
                row["latest"] = True
                row["latestBasis"] = "current result from a verified YouTube channel"
                return [_candidate(row, self.name, {"playable", "latest"}, 2500)]
            return []

        return [_candidate(row, self.name, {"playable"}, 700 - index)
                for index, row in enumerate(rows)]


class WebMediaAdapter:
    name = "web-video-search"
    capabilities = frozenset({"media.playable"})

    def supports(self, request):
        # Search snippets can discover canonical IDs, but cannot prove live or
        # latest claims. The central pipeline enforces that distinction.
        return not request.options.get("live") and not request.options.get("latest")

    async def discover(self, request, client):
        out = []
        discovery_query = request.subject or request.query
        try:
            response = await client.get(
                BING_VIDEOS,
                params={"q": discovery_query, "FORM": "HDRSC4"},
                timeout=VIDEO_TIMEOUT_SECONDS,
            )
            if response.status_code == 200:
                for index, row in enumerate(parse_bing_videos(
                        response.text, discovery_query, request.limit)):
                    if row.get("platform") in request.platforms:
                        out.append(_candidate(row, "bing-videos", {"playable"},
                                              500 - index))
        except Exception:
            pass
        if out:
            return out
        try:
            domain_map = {"youtube": "youtube.com", "twitch": "twitch.tv"}
            web = await engine_search(
                discovery_query,
                limit=request.limit,
                domains=[domain_map[p] for p in request.platforms if p in domain_map],
            )
            for index, hit in enumerate(web.get("results", [])):
                row = _supported_result(hit.get("url"), hit.get("title"), "",
                                        hit.get("snippet", ""))
                if row and row.get("platform") in request.platforms:
                    out.append(_candidate(row, web.get("provider") or self.name,
                                          {"playable"}, 300 - index))
        except Exception:
            pass
        return out


_MEDIA_PIPELINE = CapabilityPipeline()


def register_media_adapter(adapter):
    """Public extension seam for another playable-media provider."""
    return _MEDIA_PIPELINE.register(adapter)


register_media_adapter(DirectMediaAdapter())
register_media_adapter(TwitchLiveAdapter())
register_media_adapter(YouTubeMediaAdapter())
register_media_adapter(WebMediaAdapter())


async def engine_videos(query, limit=6, constraints=None):
    """Discover and verify playable media through registered adapters."""
    request = parse_media_request(query, limit, constraints)
    headers = dict(UA)
    headers["Accept-Language"] = "en-US,en;q=0.8"
    try:
        async with httpx.AsyncClient(headers=headers, follow_redirects=True,
                                     max_redirects=3) as client:
            candidates = await _MEDIA_PIPELINE.run(request, client)
    except Exception as exc:
        raise VideosFailed("video search unavailable") from exc
    if not candidates:
        raise VideosFailed("no verified video results")
    providers = list(dict.fromkeys(candidate.provider for candidate in candidates))
    results = [candidate.value for candidate in candidates]
    return {"results": results, "provider": ",".join(providers),
            "query": request.query, "count": len(results)}
