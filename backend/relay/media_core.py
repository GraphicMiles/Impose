"""Provider-neutral intent parsing and canonical playable-media primitives.

This module validates URL shapes and parses provider payloads. Discovery and
ranking belong to registered adapters in :mod:`relay.media_providers`.
"""
import html as html_mod
import json
import os
import re
import xml.etree.ElementTree as ET
from urllib.parse import parse_qs, unquote, urlparse

import httpx
from bs4 import BeautifulSoup

from relay.capabilities import CapabilityRequest
from relay.search import UA, _significant, engine_search

BING_VIDEOS = "https://www.bing.com/videos/search"
YOUTUBE_SEARCH = "https://www.youtube.com/results"
YOUTUBE_FEED = "https://www.youtube.com/feeds/videos.xml"
TWITCH_GQL = "https://gql.twitch.tv/gql"
# Twitch ships this public web-client identifier to every browser. It is not
# a secret; deployments can override it if Twitch rotates the web client.
TWITCH_CLIENT_ID = os.environ.get("TWITCH_CLIENT_ID", "kimne78kx3ncx6brgo4mv6wki5h1ko")
VIDEO_TIMEOUT_SECONDS = 12.0
_VIDEO_GENERIC = {
    "video", "videos", "watch", "latest", "newest", "recent", "upload",
    "uploads", "live", "stream", "streams", "streaming", "official", "channel",
    "youtube", "twitch", "twitchlive", "clip", "clips", "vod", "find", "show", "get",
    "give", "play", "open", "check", "pull", "search", "any", "me",
    "currently", "available", "right", "now",
    "music", "song", "by", "from", "for", "the", "a", "an", "playing",
    "and", "it", "one", "some", "please",
}
_TWITCH_RESERVED = {
    "directory", "downloads", "jobs", "login", "payments", "search",
    "settings", "signup", "subscriptions", "turbo", "videos", "wallet",
}


class VideosFailed(Exception):
    pass


def _youtube_id(url):
    try:
        p = urlparse(str(url or ""))
    except Exception:
        return ""
    host = (p.hostname or "").lower().removeprefix("www.").removeprefix("m.")
    value = ""
    if host == "youtu.be":
        value = p.path.strip("/").split("/")[0]
    elif host in ("youtube.com", "youtube-nocookie.com"):
        if p.path == "/watch":
            value = (parse_qs(p.query).get("v") or [""])[0]
        else:
            m = re.match(r"^/(?:shorts|live|embed)/([A-Za-z0-9_-]{11})(?:/|$)", p.path)
            value = m.group(1) if m else ""
    return value if re.fullmatch(r"[A-Za-z0-9_-]{11}", value or "") else ""


def _youtube_channel_id(url):
    try:
        p = urlparse(str(url or ""))
    except Exception:
        return ""
    host = (p.hostname or "").lower().removeprefix("www.").removeprefix("m.")
    if host != "youtube.com":
        return ""
    m = re.match(r"^/channel/(UC[A-Za-z0-9_-]{20,})(?:/|$)", p.path)
    return m.group(1) if m else ""


def _twitch_target(url):
    try:
        p = urlparse(str(url or ""))
    except Exception:
        return None
    host = (p.hostname or "").lower().removeprefix("www.")
    if host != "twitch.tv":
        return None
    bits = [unquote(x) for x in p.path.split("/") if x]
    if not bits:
        return None
    if len(bits) >= 2 and bits[0].lower() == "videos" and bits[1].isdigit():
        return ("twitch-video", bits[1])
    if len(bits) >= 2 and bits[0].lower() == "clip" and re.fullmatch(r"[A-Za-z0-9_-]+", bits[1]):
        return ("twitch-clip", bits[1])
    if len(bits) >= 3 and bits[1].lower() == "clip" and re.fullmatch(r"[A-Za-z0-9_-]+", bits[2]):
        return ("twitch-clip", bits[2])
    channel = bits[0].lower()
    if channel not in _TWITCH_RESERVED and re.fullmatch(r"[a-z0-9_]{3,25}", channel):
        return ("twitch-channel", channel)
    return None


def _channel_id_from_href(href):
    """Bing wraps a result with a churl query parameter containing its channel."""
    value = html_mod.unescape(str(href or ""))
    try:
        churl = (parse_qs(urlparse(value).query).get("churl") or [""])[0]
    except Exception:
        churl = ""
    m = re.search(r"/channel/(UC[A-Za-z0-9_-]{20,})", unquote(churl))
    return m.group(1) if m else ""


def _supported_result(url, title, thumb="", context="", channel_id=""):
    vid = _youtube_id(url)
    if vid:
        return {
            "title": str(title or "YouTube video").strip()[:200],
            "url": "https://www.youtube.com/watch?v=" + vid,
            "platform": "youtube", "kind": "youtube-video", "id": vid,
            "thumb": str(thumb or "")[:1000], "channelId": channel_id or "",
            "live": False,  # the player itself is authoritative at click time
        }
    twitch = _twitch_target(url)
    if twitch:
        kind, ident = twitch
        if kind == "twitch-channel":
            clean_url = "https://www.twitch.tv/" + ident
        elif kind == "twitch-video":
            clean_url = "https://www.twitch.tv/videos/" + ident
        else:
            clean_url = "https://www.twitch.tv/clip/" + ident
        return {
            "title": str(title or ident).strip()[:200], "url": clean_url,
            "platform": "twitch", "kind": kind, "id": ident,
            "thumb": str(thumb or "")[:1000],
            "live": False,  # avoid stale search-index claims; player shows current state
        }
    return None


def parse_bing_videos(page, query="", limit=8):
    soup = BeautifulSoup(page or "", "html.parser")
    meaningful = [t for t in _significant(query) if t not in _VIDEO_GENERIC]
    required = 1 if len(meaningful) == 1 else min(len(meaningful), max(2, (len(meaningful) * 3 + 3) // 4))
    out, seen = [], set()
    for node in soup.select("[ourl]"):
        url = html_mod.unescape(node.get("ourl") or "")
        image = node.find("img")
        title = (image.get("alt") if image else "") or node.get("aria-label") or "Video"
        context = node.get_text(" ", strip=True)
        blob = (title + " " + context + " " + url).lower()
        matches = sum(bool(re.search(r"\b" + re.escape(token) + r"\b", blob))
                      for token in meaningful)
        if meaningful and matches < required:
            continue
        thumb = ""
        if image:
            thumb = image.get("data-src-hq") or image.get("data-src") or image.get("src") or ""
        wrapper = node.find_parent("a")
        channel_id = _channel_id_from_href(wrapper.get("href") if wrapper else "")
        row = _supported_result(url, title, thumb, context, channel_id)
        if not row or row["url"] in seen:
            continue
        seen.add(row["url"])
        out.append(row)
        if len(out) >= max(1, min(12, int(limit or 8))):
            break
    return out


def _youtube_text(value):
    if not isinstance(value, dict):
        return ""
    if value.get("simpleText"):
        return str(value["simpleText"])
    return "".join(str(run.get("text", "")) for run in value.get("runs", [])
                   if isinstance(run, dict))


def parse_youtube_search(page, query="", limit=8):
    """Extract real video IDs and channel IDs from YouTube's search page."""
    marker = re.search(r"(?:var\s+)?ytInitialData\s*=\s*", page or "")
    if not marker:
        return []
    try:
        data = json.JSONDecoder().raw_decode((page or "")[marker.end():])[0]
    except Exception:
        return []
    meaningful = [token for token in _significant(query) if token not in _VIDEO_GENERIC]
    required = 1 if len(meaningful) == 1 else min(len(meaningful), max(2, (len(meaningful) * 3 + 3) // 4))
    out, seen = [], set()

    def visit(value):
        if len(out) >= max(1, min(12, int(limit or 8))):
            return
        if isinstance(value, dict):
            renderer = value.get("videoRenderer")
            if isinstance(renderer, dict):
                vid = str(renderer.get("videoId", ""))
                title = _youtube_text(renderer.get("title"))
                owner = _youtube_text(renderer.get("ownerText") or renderer.get("longBylineText"))
                blob = (title + " " + owner).lower()
                matches = sum(bool(re.search(r"\b" + re.escape(token) + r"\b", blob))
                              for token in meaningful)
                if (not meaningful or matches >= required) and vid not in seen:
                    owner_runs = (renderer.get("ownerText") or renderer.get("longBylineText") or {}).get("runs", [])
                    browse = (owner_runs[0].get("navigationEndpoint", {}).get("browseEndpoint", {})
                              if owner_runs and isinstance(owner_runs[0], dict) else {})
                    thumbs = renderer.get("thumbnail", {}).get("thumbnails", [])
                    thumb = str(thumbs[-1].get("url", "")) if thumbs else ""
                    row = _supported_result("https://www.youtube.com/watch?v=" + vid,
                                            title, thumb, owner,
                                            str(browse.get("browseId", "")))
                    if row:
                        row["channel"] = owner[:120]
                        row["publishedText"] = _youtube_text(renderer.get("publishedTimeText"))[:80]
                        owner_badges = renderer.get("ownerBadges") or []
                        row["channelVerified"] = any(
                            str((badge.get("metadataBadgeRenderer") or {}).get("style", ""))
                            == "BADGE_STYLE_TYPE_VERIFIED"
                            for badge in owner_badges if isinstance(badge, dict)
                        )
                        out.append(row)
                        seen.add(vid)
            for child in value.values():
                visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)

    visit(data)
    return out


def parse_youtube_feed(payload):
    try:
        root = ET.fromstring(payload)
    except Exception:
        return []
    ns = {
        "a": "http://www.w3.org/2005/Atom",
        "yt": "http://www.youtube.com/xml/schemas/2015",
        "m": "http://search.yahoo.com/mrss/",
    }
    out = []
    for entry in root.findall("a:entry", ns):
        vid = entry.findtext("yt:videoId", default="", namespaces=ns)
        if not re.fullmatch(r"[A-Za-z0-9_-]{11}", vid or ""):
            continue
        title = entry.findtext("a:title", default="YouTube video", namespaces=ns)
        published = entry.findtext("a:published", default="", namespaces=ns)
        thumb_node = entry.find("m:group/m:thumbnail", ns)
        thumb = thumb_node.get("url", "") if thumb_node is not None else ""
        out.append({
            "title": title[:200], "url": "https://www.youtube.com/watch?v=" + vid,
            "platform": "youtube", "kind": "youtube-video", "id": vid,
            "thumb": thumb, "publishedAt": published, "live": False,
        })
    return out


def _direct_urls(text):
    return re.findall(r"https?://[^\s<>\]\[\"']+", str(text or ""), re.I)


async def _latest_from_feed(client, channel_id):
    if not channel_id:
        return None
    try:
        r = await client.get(YOUTUBE_FEED, params={"channel_id": channel_id}, timeout=8.0)
        if r.status_code != 200:
            return None
        rows = parse_youtube_feed(r.content)
        if rows:
            rows[0]["channelId"] = channel_id
            rows[0]["latest"] = True
            return rows[0]
    except Exception:
        return None
    return None


def _video_subject(query):
    value = re.sub(r"['’]s\b", "", str(query or ""), flags=re.IGNORECASE)
    words = re.findall(r"[A-Za-z0-9@_-]+", value)
    generic = _VIDEO_GENERIC | {"most", "recent", "new", "find", "show", "play", "give", "open"}
    kept = [w for w in words if w.lower().lstrip("@") not in generic and not w.lower().startswith("http")]
    return " ".join(kept).strip()


async def _verify_twitch_channel(client, query):
    """Validate the exact handle implied by a named Twitch query.

    Twitch returns HTTP 200 even for missing handles, but existing channels
    put their display name in the document title. This prevents search
    fallbacks from ranking lookalikes such as ``kai_cenat`` ahead of the
    exact ``kaicenat`` account.
    """
    subject = _video_subject(query)
    target = re.sub(r"[^a-z0-9_]", "", subject.lower().lstrip("@"))
    if not re.fullmatch(r"[a-z0-9_]{3,25}", target or ""):
        return None
    try:
        r = await client.get("https://www.twitch.tv/" + target, timeout=8.0)
        if r.status_code != 200:
            return None
        soup = BeautifulSoup(r.text, "html.parser")
        title = soup.title.get_text(" ", strip=True) if soup.title else ""
        display = re.sub(r"\s*-\s*Twitch\s*$", "", title, flags=re.IGNORECASE).strip()
        if re.sub(r"[^a-z0-9_]", "", display.lower()) != target:
            return None
        return _supported_result("https://www.twitch.tv/" + target, title)
    except Exception:
        return None


async def _find_youtube_channel(query):
    for url in _direct_urls(query):
        found = _youtube_channel_id(url.rstrip(".,)"))
        if found:
            return found
    subject = _video_subject(query)
    if not subject:
        return ""
    try:
        out = await engine_search(subject + " official YouTube channel", limit=6,
                                  domains=["youtube.com"])
    except Exception:
        return ""
    wanted = re.sub(r"[^a-z0-9]", "", subject.lower())
    for hit in out.get("results", []):
        channel_id = _youtube_channel_id(hit.get("url"))
        label = re.sub(r"[^a-z0-9]", "", str(hit.get("title", "")).lower())
        if channel_id and (not wanted or wanted in label or label in wanted):
            return channel_id
    return ""


def parse_media_request(query, limit=6):
    """Turn natural media wording into provider-neutral constraints."""
    query = str(query or "").strip()
    cap = max(1, min(10, int(limit or 6)))
    urls = [url.rstrip(".,)") for url in _direct_urls(query)]
    has_twitch_url = any(_twitch_target(url) for url in urls)
    has_youtube_url = any(_youtube_id(url) or _youtube_channel_id(url) for url in urls)
    wants_live = bool(re.search(r"\b(?:live|livestream|live\s+stream|twitchlive)\b", query, re.I))
    wants_latest = bool(re.search(r"\b(?:latest|newest|most recent|recent upload)\b", query, re.I))
    if re.search(r"\btwitch(?:\s*live)?\b", query, re.I) or has_twitch_url:
        platforms = frozenset({"twitch"})
    elif re.search(r"\byoutube\b", query, re.I) or has_youtube_url or wants_latest:
        platforms = frozenset({"youtube"})
    elif wants_live:
        # Twitch exposes an authoritative live directory. A generic live
        # request must use a source that can actually prove the live claim.
        platforms = frozenset({"twitch"})
    else:
        platforms = frozenset({"youtube", "twitch"})
    claims = {"playable"}
    if wants_live:
        claims.add("live")
    if wants_latest:
        claims.add("latest")
    creator_hint = bool(re.search(
        r"\b(?:youtuber|channel|upload|creator)\b|['’]s\s+(?:latest|newest|most recent)",
        query, re.I)) or bool(
            wants_latest
            and re.search(r"\bvideo\b", query, re.I)
            and not re.search(r"\b(?:trailer|teaser|clip|scene)\b", query, re.I)
        )
    return CapabilityRequest(
        capability="media.playable",
        query=query,
        limit=cap,
        subject=_video_subject(query),
        platforms=platforms,
        required_claims=frozenset(claims),
        options={"urls": tuple(urls), "live": wants_live,
                 "latest": wants_latest, "creator_hint": creator_hint},
    )


