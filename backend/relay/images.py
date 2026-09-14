"""Keyless image search for the agent: Bing Images HTML, DDG Images,
Openverse, Wikimedia Commons.

Same contract as search.py: parsers are pure functions tested against
fixtures and fetchers raise AttemptFail. Providers execute in context-ranked
progressive stages; results must pass semantic and artifact-quality gates
before a stage can complete. Specialist vector sources may feed the separate
verified conversion capability when the requested output is PNG.

Each result: {title, image (full res), thumb (small), page (source page),
source (domain), w, h}. Only http(s) URLs are ever returned.
"""
import asyncio
import html as html_mod
import json
import re
import time
from urllib.parse import quote, urlparse

import httpx

from relay.search import AttemptFail, UA, _significant
from relay.source_intelligence import ROUTER, SourceRequirements

OPENVERSE = "https://api.openverse.org/v1/images/"
WIKIMEDIA = "https://commons.wikimedia.org/w/api.php"
IMAGE_SEARCH_TIMEOUT_SECONDS = 13.0
_SIMPLE_ICONS_URL = "https://cdn.jsdelivr.net/npm/simple-icons@latest/_data/simple-icons.json"
_simple_icons_cache = {"at": 0.0, "rows": []}
_simple_icons_lock = asyncio.Lock()
IMAGE_GENERIC_TOKENS = {
    "iconic", "classic", "famous", "representative", "related",
    "images", "image", "photos", "photo", "pictures", "picture",
    "photographs", "photograph", "wallpapers", "wallpaper",
}


def _provider_image_query(query):
    """Remove request decoration before asking upstream image engines.

    Bing can return an entirely unrelated result page for a good named subject
    plus adjectives such as “iconic” or “classic”. Keep the original query for
    logs, but send the smallest meaningful subject to providers.
    """
    value = str(query or "")
    for token in IMAGE_GENERIC_TOKENS:
        value = re.sub(r"\b" + re.escape(token) + r"\b", " ", value,
                       flags=re.IGNORECASE)
    value = " ".join(value.split()).strip()
    value = re.sub(r"^(?:(?:show|find|get|search|pull|fetch|give|send|me|some|of|for|to|about)\s+)+",
                   "", value, flags=re.IGNORECASE)
    return value.strip()


def _http_ok(url):
    return bool(url) and urlparse(url).scheme in ("http", "https")


def domain_of(url):
    try:
        host = urlparse(url).hostname or ""
    except Exception:
        return ""
    return host[4:] if host.startswith("www.") else host


def _url_format(url):
    try:
        path = (urlparse(str(url or "")).path or "").lower()
    except Exception:
        return ""
    match = re.search(r"\.([a-z0-9]{2,8})$", path)
    value = match.group(1) if match else ""
    return "jpeg" if value == "jpg" else value


def parse_bing_images(page):
    """Bing Images HTML: <a class="iusc" m="{&quot;murl&quot;:...}"> JSON blobs."""
    out = []
    for blob in re.findall(r'class="iusc"[^>]*? m="([^"]+)"', page):
        try:
            meta = json.loads(html_mod.unescape(blob))
        except Exception:
            continue
        img = meta.get("murl") or ""
        if not _http_ok(img):
            continue
        out.append({
            "title": (meta.get("t") or meta.get("purl") or "image").strip()[:160],
            "image": img,
            "thumb": meta.get("turl") if _http_ok(meta.get("turl")) else img,
            "page": meta.get("purl") if _http_ok(meta.get("purl")) else "",
            "source": domain_of(meta.get("purl") or img),
            "w": int(meta.get("mw") or 0) or None,
            "h": int(meta.get("mh") or 0) or None,
            "format": _url_format(img), "license": None,
        })
    return out


def parse_ddg_images(data):
    """DDG i.js JSON: {results: [{image, thumbnail, width, height, title, url}]}."""
    out = []
    for r in (data.get("results") or []):
        img = r.get("image") or ""
        if not _http_ok(img):
            continue
        out.append({
            "title": (r.get("title") or "image").strip()[:160],
            "image": img,
            "thumb": r.get("thumbnail") if _http_ok(r.get("thumbnail")) else img,
            "page": r.get("url") if _http_ok(r.get("url")) else "",
            "source": domain_of(r.get("url") or img),
            "w": r.get("width") or None,
            "h": r.get("height") or None,
            "format": _url_format(img), "license": None,
        })
    return out


def parse_openverse(data):
    out = []
    for r in (data.get("results") or []):
        img = r.get("url") or ""
        if not _http_ok(img):
            continue
        out.append({
            "title": (r.get("title") or "image").strip()[:160],
            "image": img,
            "thumb": r.get("thumbnail") if _http_ok(r.get("thumbnail")) else img,
            "page": r.get("foreign_landing_url") or "",
            "source": r.get("source") or domain_of(r.get("foreign_landing_url") or img),
            "w": r.get("width") or None,
            "h": r.get("height") or None,
            "format": str(r.get("filetype") or _url_format(img)).lower(),
            "license": r.get("license") or r.get("license_version") or None,
            "creator": r.get("creator") or None,
        })
    return out


def parse_wikimedia(data):
    """Commons generator=search JSON: query.pages.{title, imageinfo[mime,url,
    thumburl, descriptionurl, width, height]}. Non-bitmaps are dropped."""
    out = []
    pages = ((data.get("query") or {}).get("pages") or {})
    for p in pages.values():
        info = (p.get("imageinfo") or [{}])[0]
        if (info.get("mime") or "") not in ("image/jpeg", "image/png", "image/webp", "image/gif"):
            continue
        img = info.get("url") or ""
        if not _http_ok(img):
            continue
        out.append({
            "title": (p.get("title") or "").replace("File:", "").strip()[:160] or "image",
            "image": img,
            "thumb": info.get("thumburl") if _http_ok(info.get("thumburl")) else img,
            "page": info.get("descriptionurl") if _http_ok(info.get("descriptionurl")) else "",
            "source": "wikimedia",
            "w": info.get("width") or None,
            "h": info.get("height") or None,
            "format": (info.get("mime") or "").split("/")[-1].lower(),
            "license": (info.get("extmetadata") or {}).get("LicenseShortName", {}).get("value"),
        })
    return out


def _simple_icon_slug(title):
    # Simple Icons' default slug convention; catalog entries may override it.
    value = html_mod.unescape(str(title or "")).lower().replace("+", "plus").replace("&", "and")
    return "".join(ch for ch in value if ch.isascii() and ch.isalnum())


async def _simple_icons(client, queries, limit):
    now = time.time()
    async with _simple_icons_lock:
        if not _simple_icons_cache["rows"] or now - _simple_icons_cache["at"] > 21600:
            try: response = await client.get(_SIMPLE_ICONS_URL, timeout=12.0)
            except (httpx.TimeoutException, httpx.RequestError): raise AttemptFail("catalog unavailable")
            if response.status_code != 200: raise AttemptFail("catalog http " + str(response.status_code))
            try: rows = response.json()
            except Exception: raise AttemptFail("catalog unreadable")
            if not isinstance(rows, list): raise AttemptFail("catalog malformed")
            _simple_icons_cache.update({"at": now, "rows": rows[:5000]})
        rows = list(_simple_icons_cache["rows"])
    generic = {"logo", "logos", "icon", "icons", "official", "brand", "branding", "image", "images"}
    query = " ".join(str(value) for value in queries if str(value).strip()).lower()
    brand_tokens = lambda value: set(re.findall(r"[a-z0-9]{2,}", str(value).lower())) - generic
    query_tokens = brand_tokens(query)
    ranked = []
    for row in rows:
        title = str(row.get("title") or "")
        aliases = row.get("aliases") or {}
        names = [title] + list(aliases.get("aka") or [])
        token_sets = [brand_tokens(name) for name in names]
        token_sets = [tokens for tokens in token_sets if tokens]
        if not token_sets: continue
        overlap = max(len(query_tokens & tokens) / len(tokens) for tokens in token_sets)
        exact = any(tokens <= query_tokens for tokens in token_sets)
        if not exact and overlap < 1: continue
        ranked.append((1.0 if exact else overlap, title, row))
    ranked.sort(key=lambda item: (-item[0], len(item[1])))
    out = []
    for _, title, row in ranked[:limit]:
        slug = str(row.get("slug") or _simple_icon_slug(title))
        if not slug: continue
        source = str(row.get("source") or "")
        license_data = row.get("license") or {}
        image_url = "https://cdn.simpleicons.org/" + quote(slug, safe="")
        try: artifact = await client.get(image_url, timeout=8.0)
        except (httpx.TimeoutException, httpx.RequestError): continue
        if artifact.status_code != 200 or "svg" not in artifact.headers.get("content-type", "").lower() or b"<svg" not in artifact.content[:500]: continue
        out.append({"title": title + " brand icon", "image": image_url,
                    "thumb": image_url,
                    "page": source if source.startswith("https://") else "https://simpleicons.org/?q=" + quote(title),
                    "source": "simple-icons", "format": "svg", "convertibleTo": ["png"],
                    "license": license_data.get("type"), "brandColor": row.get("hex"),
                    "verifiedClaims": ["artifact_fetch", "source_attribution"]})
    if not out: raise AttemptFail("no matching brand icon")
    return out


async def _iconify(client, queries, limit):
    candidates = [str(value).strip() for value in queries if str(value).strip()][:6]
    primary = candidates[0] if candidates else "image"
    for candidate in candidates:
        try:
            response = await client.get("https://api.iconify.design/search",
                                        params={"query": candidate, "limit": min(limit * 3, 32)}, timeout=8.0)
        except (httpx.TimeoutException, httpx.RequestError):
            continue
        if response.status_code != 200: continue
        try: data = response.json()
        except Exception: continue
        icons = data.get("icons") or []
        collections = data.get("collections") or {}
        if not icons: continue
        out = []
        for icon in icons:
            if ":" not in icon: continue
            prefix, name = icon.split(":", 1)
            metadata = collections.get(prefix) or {}
            license_data = metadata.get("license") or {}
            out.append({"title": name.replace("-", " ").title() + " — result for " + primary,
                        "image": "https://api.iconify.design/" + quote(prefix, safe="") + "/" + quote(name, safe="-") + ".svg",
                        "thumb": "https://api.iconify.design/" + quote(prefix, safe="") + "/" + quote(name, safe="-") + ".svg",
                        "page": "https://icon-sets.iconify.design/" + quote(prefix, safe="") + "/" + quote(name, safe="-") + ".html",
                        "source": "iconify", "format": "svg", "convertibleTo": ["png"],
                        "license": license_data.get("spdx") or license_data.get("title")})
            if len(out) >= limit: break
        if out: return out
    raise AttemptFail("no matching icons")


async def _svg_repo(client, query, limit):
    words = re.findall(r"[A-Za-z0-9]+", query.lower())[:8]
    if not words: return []
    matches = []
    # Provider-native query broadening: exact compound first, then its bounded
    # semantic terms. This is independent of any particular request wording.
    slugs = ["-".join(words)] + [word for word in words if len(word) > 2]
    for slug_query in dict.fromkeys(slugs[:5]):
        try:
            response = await client.get("https://www.svgrepo.com/vectors/" + quote(slug_query, safe="-") + "/",
                                        timeout=10.0)
        except httpx.TimeoutException:
            continue
        except Exception:
            continue
        if response.status_code != 200: continue
        matches = re.findall(r'/show/(\d+)/([A-Za-z0-9_-]+)\.svg', response.text, re.I)
        if matches: break
    out, seen = [], set()
    for ident, slug in matches:
        if ident in seen: continue
        seen.add(ident)
        out.append({"title": slug.replace("-", " ").title() + " vector",
                    "image": "https://www.svgrepo.com/show/" + ident + "/" + quote(slug, safe="-") + ".svg",
                    "thumb": "https://www.svgrepo.com/show/" + ident + "/" + quote(slug, safe="-") + ".svg",
                    "page": "https://www.svgrepo.com/svg/" + ident + "/" + quote(slug, safe="-"),
                    "source": "svg-repo", "format": "svg",
                    "license": "Open-license details on source page", "convertibleTo": ["png"]})
        if len(out) >= limit: break
    if not out: raise AttemptFail("no results parsed")
    return out


async def _bing_images(client, query, limit):
    try:
        r = await client.get("https://www.bing.com/images/search",
                             params={"q": query, "form": "HDRSC2", "count": min(limit * 2, 35)},
                             timeout=10.0)
    except httpx.TimeoutException:
        raise AttemptFail("timed out")
    except Exception:
        raise AttemptFail("unreachable")
    if r.status_code != 200:
        raise AttemptFail("http " + str(r.status_code))
    results = parse_bing_images(r.text)
    if not results:
        raise AttemptFail("no results parsed")
    results = _relevant_images(results, query)
    if not results:
        raise AttemptFail("irrelevant")
    return results[:limit]


async def _ddg_vqd(client, query):
    try:
        r = await client.get("https://duckduckgo.com/",
                             params={"q": query, "iax": "images", "ia": "images"}, timeout=10.0)
    except Exception:
        raise AttemptFail("vqd unreachable")
    m = re.search(r'vqd=["\']?([\d-]+)["\']?', r.text)
    if not m:
        raise AttemptFail("no vqd token")
    return m.group(1)


async def _ddg_images(client, query, limit):
    vqd = await _ddg_vqd(client, query)
    try:
        r = await client.get("https://duckduckgo.com/i.js",
                             params={"l": "us-en", "o": "json", "q": query,
                                     "vqd": vqd, "f": ",,,", "p": "1"},
                             headers={"Referer": "https://duckduckgo.com/"}, timeout=10.0)
    except httpx.TimeoutException:
        raise AttemptFail("timed out")
    except Exception:
        raise AttemptFail("unreachable")
    if r.status_code != 200:
        raise AttemptFail("http " + str(r.status_code))
    try:
        data = r.json()
    except Exception:
        raise AttemptFail("bad json")
    results = parse_ddg_images(data)
    if not results:
        raise AttemptFail("no results parsed")
    results = _relevant_images(results, query)
    if not results:
        raise AttemptFail("irrelevant")
    return results[:limit]


async def _openverse(client, query, limit):
    try:
        r = await client.get(OPENVERSE, params={"q": query, "page_size": min(limit, 20)},
                             timeout=12.0)
    except httpx.TimeoutException:
        raise AttemptFail("timed out")
    except Exception:
        raise AttemptFail("unreachable")
    if r.status_code != 200:
        raise AttemptFail("http " + str(r.status_code))
    try:
        results = parse_openverse(r.json())
    except Exception:
        raise AttemptFail("bad json")
    if not results:
        raise AttemptFail("no results parsed")
    results = _relevant_images(results, query)
    if not results:
        raise AttemptFail("irrelevant")
    return results[:limit]


async def _wikimedia(client, query, limit):
    try:
        r = await client.get(WIKIMEDIA, params={
            "action": "query", "format": "json", "generator": "search",
            "gsrsearch": query + " filetype:bitmap", "gsrnamespace": 6,
            "gsrlimit": min(limit * 2, 20), "prop": "imageinfo",
            "iiprop": "url|size|mime|extmetadata", "iiurlwidth": 600,
        }, headers={
            "User-Agent": "Impose/1.0 (https://impose-web.onrender.com; contact: rfarouq69@gmail.com)",
            "Api-User-Agent": "Impose/1.0 (https://impose-web.onrender.com; contact: rfarouq69@gmail.com)",
        }, timeout=12.0)
    except httpx.TimeoutException:
        raise AttemptFail("timed out")
    except Exception:
        raise AttemptFail("unreachable")
    if r.status_code != 200:
        raise AttemptFail("http " + str(r.status_code))
    try:
        results = parse_wikimedia(r.json())
    except Exception:
        raise AttemptFail("bad json")
    if not results:
        raise AttemptFail("no results parsed")
    results = _relevant_images(results, query)
    if not results:
        raise AttemptFail("irrelevant")
    return results[:limit]


def _relevant_images(results, query):
    """Keep only results that carry every significant query token on a word
    boundary. AND instead of OR on purpose: an image query is a subject
    ("mark rober"), and 'check mark icon' or a whisky bottle share the token
    'mark' without being the subject. Word boundaries keep 'checkmark' from
    matching 'mark'. Generic request adjectives such as “iconic” are ignored;
    queries without meaningful subject tokens pass untouched."""
    toks = [t for t in _significant(query) if t not in IMAGE_GENERIC_TOKENS]
    if not toks:
        return results
    keep = []
    for r in results:
        blob = " ".join([r.get("title", ""), r.get("source", ""),
                         r.get("page", "")]).lower()
        if all(re.search(r"\b" + re.escape(t) + r"\b", blob) for t in toks):
            keep.append(r)
    return keep


class ImagesFailed(Exception):
    pass


def _normalized_formats(values):
    out = set()
    for value in values or []:
        value = str(value).lower().lstrip(".")
        out.add("jpeg" if value == "jpg" else value)
    return out


def _source_query(query, raw_requirements):
    """Use semantic retrieval terms supplied by intent decomposition.

    No request phrase is mapped to a provider. The intent layer may provide a
    concise retrievalQuery and explicit artifact characteristics; providers
    all receive the same requirement-derived representation.
    """
    explicit = str((raw_requirements or {}).get("retrievalQuery") or "").strip()
    return explicit[:500] or str(query or "").strip()


def _evaluate_image_results(results, request, raw_requirements, limit):
    wanted_formats = _normalized_formats(request.formats)
    required_terms = [str(x).lower() for x in (raw_requirements.get("requiredTerms") or []) if str(x).strip()][:12]
    excluded_terms = [str(x).lower() for x in (raw_requirements.get("excludedTerms") or []) if str(x).strip()][:12]
    min_width = max(0, int(raw_requirements.get("minimumWidth") or 0))
    min_height = max(0, int(raw_requirements.get("minimumHeight") or 0))
    scored, rejected = [], {"format": 0, "semantic": 0, "dimensions": 0, "duplicate": 0}
    seen = set()
    for row in results or []:
        image = str(row.get("image") or "")
        key = image.rstrip("/").lower()
        if not key or key in seen:
            rejected["duplicate"] += 1; continue
        seen.add(key)
        fmt = str(row.get("format") or _url_format(image)).lower()
        fmt = "jpeg" if fmt == "jpg" else fmt
        convertible = _normalized_formats(row.get("convertibleTo") or [])
        if wanted_formats and fmt not in wanted_formats and not (wanted_formats & convertible):
            rejected["format"] += 1; continue
        blob = " ".join([str(row.get("title") or ""), str(row.get("source") or ""),
                         str(row.get("page") or "")]).lower()
        if required_terms and not all(term in blob for term in required_terms):
            rejected["semantic"] += 1; continue
        if excluded_terms and any(term in blob for term in excluded_terms):
            rejected["semantic"] += 1; continue
        width, height = int(row.get("w") or 0), int(row.get("h") or 0)
        if (min_width and width and width < min_width) or (min_height and height and height < min_height):
            rejected["dimensions"] += 1; continue
        score = 0.34
        if not wanted_formats or fmt in wanted_formats: score += 0.2
        if row.get("page"): score += 0.12
        if row.get("license"): score += 0.12
        if width and height:
            score += 0.12 if min(width, height) >= 600 else 0.06
        if required_terms: score += 0.1
        clean = dict(row); clean["format"] = fmt or None; clean["qualityScore"] = round(min(1, score), 3)
        scored.append(clean)
    scored.sort(key=lambda row: row.get("qualityScore", 0), reverse=True)
    selected = scored[:limit]
    quality = sum(row.get("qualityScore", 0) for row in selected) / len(selected) if selected else 0.0
    valid_ratio = len(selected) / max(1, len(results or []))
    return selected, {"quality": round(quality, 3), "validRatio": round(valid_ratio, 3),
                      "accepted": len(selected), "received": len(results or []), "rejected": rejected,
                      "constraintsSatisfied": bool(selected)}


async def engine_images(query, limit=8, requirements=None):
    """Select sources by intent fit, execute progressively, and stop only
    after actual results satisfy artifact constraints."""
    started_at = time.time()
    raw_requirements = requirements if isinstance(requirements, dict) else {}
    source_request = SourceRequirements.from_mapping("discover_images", {
        **raw_requirements, "artifactType": raw_requirements.get("artifactType") or "image",
        "requiredCapabilities": raw_requirements.get("requiredCapabilities") or ["search", "preview", "source_attribution"],
    })
    planning_requirements = dict(raw_requirements)
    requested_formats = planning_requirements.get("formats") or planning_requirements.get("format") or []
    if isinstance(requested_formats, str): requested_formats = [requested_formats]
    # A reusable vector conversion capability makes SVG a valid retrieval
    # input for a PNG outcome; the final binary is still verified as PNG.
    if "png" in {str(value).lower().lstrip(".") for value in requested_formats}:
        planning_requirements["formats"] = list(requested_formats) + ["svg"]
    planning_request = SourceRequirements.from_mapping("discover_images", {
        **planning_requirements, "artifactType": planning_requirements.get("artifactType") or "image",
        "requiredCapabilities": planning_requirements.get("requiredCapabilities") or ["search", "preview", "source_attribution"],
    })
    source_plan = ROUTER.plan(planning_request, ["openverse", "wikimedia", "bing-images", "ddg-images", "svg-repo", "iconify", "simple-icons"])
    source_plan["retrievalInputFormats"] = source_plan["requirements"].get("formats", [])
    source_plan["requirements"]["formats"] = sorted(source_request.formats)
    provider_query = _source_query(query, raw_requirements)
    alternatives = raw_requirements.get("alternativeQueries") or []
    if isinstance(alternatives, str): alternatives = [alternatives]
    provider_queries = [provider_query] + [str(value)[:160] for value in alternatives[:5] if str(value).strip()]
    attempts, fallback_decisions = [], []
    async with httpx.AsyncClient(headers=UA, follow_redirects=True, max_redirects=3) as client:
        provider_jobs = {
            "openverse": partial_open(client, provider_query, limit),
            "wikimedia": partial_wiki(client, provider_query, limit),
            "bing-images": partial_bing(client, provider_query, limit),
            "ddg-images": partial_ddg(client, provider_query, limit),
            "svg-repo": partial_svg_repo(client, provider_query, limit),
            "iconify": partial_iconify(client, provider_queries, limit),
            "simple-icons": partial_simple_icons(client, provider_queries, limit),
        }
        for stage in source_plan["stages"]:
            jobs = [(name, provider_jobs[name]) for name in stage["providers"] if name in provider_jobs]
            try:
                runs = await asyncio.wait_for(asyncio.gather(*[_run(name, job) for name, job in jobs]),
                                                  timeout=IMAGE_SEARCH_TIMEOUT_SECONDS)
            except asyncio.TimeoutError:
                attempts.append({"provider": "overall", "ok": False, "stage": stage["stage"],
                                 "error": "deadline exceeded", "ms": int(IMAGE_SEARCH_TIMEOUT_SECONDS * 1000)})
                fallback_decisions.append({"stage": stage["stage"], "decision": "broaden",
                                           "reason": "stage deadline exceeded"})
                continue
            accepted = []
            rank_score = {row["provider"]: row["score"] for row in source_plan["candidates"]}
            for provider, ok, payload, elapsed_ms in runs:
                if not ok:
                    attempts.append({"provider": provider, "ok": False, "stage": stage["stage"],
                                     "error": payload, "ms": elapsed_ms})
                    ROUTER.observe(provider, success=False, result_quality=0, valid_ratio=0, latency_ms=elapsed_ms)
                    continue
                selected, evaluation = _evaluate_image_results(payload, source_request, raw_requirements, limit)
                ROUTER.observe(provider, success=bool(selected), result_quality=evaluation["quality"],
                               valid_ratio=evaluation["validRatio"], latency_ms=elapsed_ms)
                attempts.append({"provider": provider, "ok": bool(selected), "stage": stage["stage"],
                                 "ms": elapsed_ms,
                                 "error": None if selected else "result quality or artifact constraints failed",
                                 "evaluation": evaluation})
                if selected:
                    combined = evaluation["quality"] * 0.65 + rank_score.get(provider, 0) * 0.35
                    accepted.append((combined, provider, selected, evaluation))
            if accepted:
                _, provider, selected, evaluation = max(accepted, key=lambda item: item[0])
                total_ms = int((time.time() - started_at) * 1000)
                source_plan["selectedProviders"] = [provider]
                source_plan["fallbackDecisions"] = fallback_decisions
                source_plan["resultEvaluation"] = evaluation
                print("[relay] images '%s' via %s -> %d (%dms)" % (query[:60], provider, len(selected), total_ms), flush=True)
                return {"results": selected, "provider": provider, "query": query, "retrievalQuery": provider_query,
                        "count": len(selected), "ms": total_ms, "attempts": attempts, "sourcePlan": source_plan}
            fallback_decisions.append({"stage": stage["stage"], "decision": "broaden",
                                       "reason": "providers returned no candidates satisfying artifact and quality requirements"})

    detail = "; ".join(item["provider"] + "=" + str(item.get("error") or "rejected") for item in attempts)
    raise ImagesFailed("all image providers failed: " + detail)


def partial_bing(client, query, limit):
    async def job():
        return await _bing_images(client, query, limit)
    return job


def partial_simple_icons(client, queries, limit):
    async def job():
        return await _simple_icons(client, queries, limit)
    return job


def partial_iconify(client, queries, limit):
    async def job():
        return await _iconify(client, queries, limit)
    return job


def partial_svg_repo(client, query, limit):
    async def job():
        return await _svg_repo(client, query, limit)
    return job


def partial_ddg(client, query, limit):
    async def job():
        return await _ddg_images(client, query, limit)
    return job


def partial_open(client, query, limit):
    async def job():
        return await _openverse(client, query, limit)
    return job


def partial_wiki(client, query, limit):
    async def job():
        return await _wikimedia(client, query, limit)
    return job


async def _run(name, job):
    start = time.time()
    try:
        results = await job()
    except AttemptFail as e:
        return (name, False, str(e), int((time.time() - start) * 1000))
    except Exception as e:
        return (name, False, "error: " + str(e)[:100], int((time.time() - start) * 1000))
    return (name, True, results, int((time.time() - start) * 1000))
