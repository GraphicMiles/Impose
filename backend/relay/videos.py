"""Verified, embeddable video search for Impose.

Bing Videos supplies public result URLs without an API key. YouTube channel
feeds are then used for "latest" requests, so the result is an actual upload
rather than a model's guess. Only URL shapes the client knows how to embed are
returned: YouTube videos and Twitch channels/VODs/clips.
"""
import html as html_mod
import re
import xml.etree.ElementTree as ET
from urllib.parse import parse_qs, unquote, urlparse

import httpx
from bs4 import BeautifulSoup

from relay.search import UA, _significant, engine_search

BING_VIDEOS = "https://www.bing.com/videos/search"
YOUTUBE_FEED = "https://www.youtube.com/feeds/videos.xml"
VIDEO_TIMEOUT_SECONDS = 12.0
_VIDEO_GENERIC = {
    "video", "videos", "watch", "latest", "newest", "recent", "upload",
    "uploads", "live", "stream", "streams", "streaming", "official", "channel",
    "youtube", "twitch", "find", "show", "get", "give", "any", "me",
    "currently", "available", "right", "now",
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
    out, seen = [], set()
    for node in soup.select("[ourl]"):
        url = html_mod.unescape(node.get("ourl") or "")
        image = node.find("img")
        title = (image.get("alt") if image else "") or node.get("aria-label") or "Video"
        context = node.get_text(" ", strip=True)
        blob = (title + " " + context + " " + url).lower()
        if meaningful and not any(re.search(r"\b" + re.escape(t) + r"\b", blob) for t in meaningful):
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


def _rank_twitch(rows, query):
    generic = _VIDEO_GENERIC | {"official", "open", "find", "show", "play"}
    words = [w for w in re.findall(r"[a-z0-9]+", str(query or "").lower())
             if len(w) > 1 and w not in generic]
    target = "".join(words)
    def score(row):
        if row.get("kind") != "twitch-channel":
            return 0
        raw_ident = row.get("id", "")
        ident = raw_ident.replace("_", "")
        if target and raw_ident == target:
            return 120
        if target and ident == target:
            return 100
        if target and (ident.startswith(target) or target.startswith(ident)):
            return 70
        return 10
    return sorted(rows, key=score, reverse=True)


async def engine_videos(query, limit=6):
    """Return verified embeddable results, preferring channel RSS for latest."""
    query = str(query or "").strip()
    cap = max(1, min(10, int(limit or 6)))
    direct = []
    for url in _direct_urls(query):
        row = _supported_result(url.rstrip(".,)"), "Open video or stream")
        if row:
            direct.append(row)
    headers = dict(UA)
    headers["Accept-Language"] = "en-US,en;q=0.8"
    try:
        async with httpx.AsyncClient(headers=headers, follow_redirects=True, max_redirects=3) as client:
            r = await client.get(BING_VIDEOS, params={"q": query, "FORM": "HDRSC4"}, timeout=VIDEO_TIMEOUT_SECONDS)
            searched = parse_bing_videos(r.text, query, cap) if r.status_code == 200 else []
            wants_twitch = bool(re.search(r"\btwitch\b", query, re.I))
            wants_live = bool(re.search(r"\b(?:live|livestream|live\s+stream)\b", query, re.I))
            subject = _video_subject(query)
            if wants_twitch:
                searched = [row for row in searched if row.get("platform") == "twitch"]
            # Search-index cards cannot establish that a channel is live.
            # A generic "find any live stream" query also tends to turn its
            # request words into fake-looking channel handles such as
            # /currently_available. Without a named subject or direct URL,
            # return no typed player rather than presenting one as verified.
            if wants_live and not subject and not direct:
                searched = []
            if not searched and not (wants_live and not subject):
                try:
                    domains = ["twitch.tv"] if wants_twitch else ["youtube.com", "twitch.tv"]
                    web = await engine_search(query, limit=cap, domains=domains)
                    for hit in web.get("results", []):
                        row = _supported_result(hit.get("url"), hit.get("title"), "", hit.get("snippet", ""))
                        if row:
                            searched.append(row)
                except Exception:
                    pass
            searched = _rank_twitch(searched, query)
            rows = direct + searched
            if re.search(r"\b(latest|newest|most recent|recent upload)\b", query, re.I):
                channel_id = await _find_youtube_channel(query)
                latest = await _latest_from_feed(client, channel_id)
                if latest:
                    rows = [latest]  # authoritative answer for singular “latest” intent
    except Exception as exc:
        if not direct:
            raise VideosFailed("video search unavailable") from exc
        rows = direct
    clean, seen = [], set()
    for row in rows:
        if row["url"] in seen:
            continue
        seen.add(row["url"])
        clean.append(row)
        if len(clean) >= cap:
            break
    if not clean:
        raise VideosFailed("no verified video results")
    return {"results": clean, "provider": "bing-videos", "query": query, "count": len(clean)}
