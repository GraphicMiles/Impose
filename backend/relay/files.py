"""Provider-neutral remote file discovery and canonical URL normalization.

Search supplies untrusted candidate URLs. Adapters only emit deterministic HTTPS
source/preview/download URLs; the relay re-validates any URL again before bytes
are fetched. New source platforms belong here, not in intent routing.
"""
from __future__ import annotations

import asyncio
import mimetypes
import re
from pathlib import PurePosixPath
from urllib.parse import parse_qsl, quote, unquote, urlencode, urlparse, urlunparse

import httpx

from relay.search import SearchFailed, engine_search
from relay.source_intelligence import CATALOG, ROUTER, SourceRequirements

_FILE_EXT = re.compile(r"\.([a-z0-9][a-z0-9.+_-]{0,15})$", re.I)
_SAFE_EXT = re.compile(r"^[a-z0-9][a-z0-9.+_-]{0,15}$", re.I)
_NON_FORMAT_VALUES = {"file", "document", "template", "resume", "cv", "image", "audio", "video", "software", "dataset"}


def _https(url: str) -> str:
    try:
        p = urlparse(str(url or "").strip())
    except Exception:
        return ""
    if p.scheme.lower() != "https" or not p.hostname or p.username or p.password:
        return ""
    return urlunparse(("https", p.netloc.lower(), p.path, "", p.query, ""))


def _name(path: str, fallback: str = "download") -> str:
    value = unquote(PurePosixPath(path or "").name).strip()
    value = re.sub(r"[\x00-\x1f\\/:*?\"<>|]+", "_", value)[:180]
    return value or fallback


def _kind(name: str, mime: str) -> str:
    ext = PurePosixPath(name).suffix.lower()
    if mime.startswith("image/"): return "image"
    if mime.startswith("audio/"): return "audio"
    if mime.startswith("video/"): return "video"
    if mime == "application/pdf": return "pdf"
    if mime.startswith("text/") or ext in {".md", ".json", ".yaml", ".yml", ".toml", ".xml", ".csv", ".js", ".ts", ".tsx", ".jsx", ".py", ".rb", ".go", ".rs", ".java", ".c", ".cpp", ".h", ".css", ".html", ".sh"}: return "text"
    if ext in {".zip", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar", ".tar"}: return "archive"
    if ext in {".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".odt", ".ods", ".odp"}: return "document"
    return "binary"


def _record(source_url: str, download_url: str, title: str = "", *, size=None,
            platform: str = "Web", preview_url: str = "") -> dict | None:
    source_url, download_url = _https(source_url), _https(download_url)
    preview_url = _https(preview_url or download_url)
    if not source_url or not download_url or not preview_url:
        return None
    filename = _name(urlparse(download_url).path, _name(urlparse(source_url).path))
    mime = mimetypes.guess_type(filename)[0] or "application/octet-stream"
    return {"name": filename, "title": str(title or filename)[:180], "sourceUrl": source_url,
            "previewUrl": preview_url, "downloadUrl": download_url, "platform": platform,
            "mime": mime, "extension": PurePosixPath(filename).suffix.lower().lstrip("."),
            "kind": _kind(filename, mime), "size": size if isinstance(size, int) and size >= 0 else None}


def _action_record(source_url: str, title: str, provider_id: str) -> dict | None:
    """Represent a verified template/catalog page whose legitimate completion
    action happens on the provider, rather than pretending its HTML is a file."""
    source_url = _https(source_url)
    if source_url:
        parsed = urlparse(source_url)
        tracking = {"gclid", "fbclid", "msclkid", "msockid", "ref", "source"}
        clean_query = urlencode([(key, value) for key, value in parse_qsl(parsed.query) if key.lower() not in tracking and not key.lower().startswith("utm_")])
        source_url = urlunparse((parsed.scheme, parsed.netloc, parsed.path, "", clean_query, ""))
    profile = CATALOG.get(provider_id)
    if not source_url or not profile: return None
    label = str(title or "Open artifact")[:180]
    return {"name": label, "title": label, "sourceUrl": source_url, "previewUrl": source_url,
            "downloadUrl": "", "actionUrl": source_url, "accessMode": "open",
            "actionLabel": "Open template" if "template" in profile.artifact_types else "Open source",
            "platform": provider_id, "providerId": provider_id, "mime": "text/html",
            "extension": "", "kind": "template" if "template" in profile.artifact_types else "web",
            "size": None, "verifiedClaims": ["source_attribution", "provider_domain"]}


def _catalog_page_candidate(url: str, title: str = "", formats=()) -> dict | None:
    clean = _https(url)
    host = (urlparse(clean).hostname or "").lower().removeprefix("www.") if clean else ""
    if not host: return None
    for profile in CATALOG.providers():
        if not profile.domains: continue
        if any(host == domain or host.endswith("." + domain) for domain in profile.domains):
            requested = {str(value).lower().lstrip(".") for value in formats or []}
            if requested and profile.formats and not (requested & profile.formats): continue
            if "template" in profile.artifact_types or "document" in profile.artifact_types:
                row = _action_record(clean, title, profile.id)
                if row and requested: row["requestedFormats"] = sorted(requested)
                return row
    return None


def normalize_candidate(url: str, title: str = "") -> dict | None:
    """Normalize a direct file page without making a network request."""
    clean = _https(url)
    if not clean:
        return None
    p = urlparse(clean)
    host, parts = (p.hostname or "").lower(), [unquote(x) for x in p.path.split("/") if x]
    if host in {"github.com", "www.github.com"} and len(parts) >= 5 and parts[2] == "blob":
        owner, repo, branch = parts[0], parts[1], parts[3]
        rel = "/".join(parts[4:])
        raw = "https://raw.githubusercontent.com/%s/%s/%s/%s" % tuple(quote(x, safe="/-._~") for x in (owner, repo, branch, rel))
        return _record(clean, raw, title, platform="GitHub")
    if host.endswith("gitlab.com") and "/-/blob/" in p.path:
        return _record(clean, clean.replace("/-/blob/", "/-/raw/", 1), title, platform="GitLab")
    if host == "huggingface.co" and "/blob/" in p.path:
        return _record(clean, clean.replace("/blob/", "/resolve/", 1), title, platform="Hugging Face")
    if host in {"gist.github.com", "www.gist.github.com"}:
        raw = clean.rstrip("/") + "/raw"
        return _record(clean, raw, title, platform="GitHub Gist")
    if host in {"raw.githubusercontent.com", "cdn.jsdelivr.net", "raw.gitmirror.com"} or _FILE_EXT.search(p.path):
        return _record(clean, clean, title, platform=host.replace("www.", ""))
    return None


async def _github_tree(url: str, client: httpx.AsyncClient, limit: int) -> list[dict]:
    """Turn a GitHub tree/repository result into immediate downloadable files."""
    clean = _https(url)
    p = urlparse(clean)
    if (p.hostname or "").lower() not in {"github.com", "www.github.com"}:
        return []
    parts = [unquote(x) for x in p.path.split("/") if x]
    if len(parts) < 2:
        return []
    owner, repo = parts[0], parts[1].removesuffix(".git")
    branch, rel = "", ""
    if len(parts) >= 4 and parts[2] == "tree":
        branch, rel = parts[3], "/".join(parts[4:])
    elif len(parts) > 2:
        return []
    endpoint = f"https://api.github.com/repos/{quote(owner)}/{quote(repo)}/contents"
    if rel: endpoint += "/" + quote(rel, safe="/")
    params = {"ref": branch} if branch else None
    try:
        response = await client.get(endpoint, params=params, headers={"Accept": "application/vnd.github+json", "User-Agent": "Impose-file-discovery/1"})
        if response.status_code != 200: return []
        payload = response.json()
    except Exception:
        return []
    rows = payload if isinstance(payload, list) else [payload]
    out = []
    for row in rows:
        if not isinstance(row, dict) or row.get("type") != "file" or not row.get("download_url"): continue
        item = _record(row.get("html_url") or clean, row["download_url"], row.get("name") or "", size=row.get("size"), platform="GitHub")
        if item: out.append(item)
        if len(out) >= limit: break
    return out


async def _github_repository_search(query: str, extensions: list[str], limit: int) -> list[dict]:
    """Search GitHub's public repository surface, then inspect repository root
    listings for real files. This is a source adapter, used when broad web
    providers do not expose blob URLs."""
    headers = {"User-Agent": "Mozilla/5.0 (compatible; Impose-file-discovery/1)", "Accept": "text/html"}
    try:
        async with httpx.AsyncClient(timeout=10.0, follow_redirects=False, headers=headers) as client:
            words = query.split()
            search_queries = [query]
            # Generic leave-one-term-out broadening recovers repositories whose
            # own names omit one descriptive request term.
            if 3 <= len(words) <= 8:
                search_queries += [" ".join(words[:i] + words[i + 1:]) for i in range(len(words))]
            responses = await asyncio.gather(*[client.get("https://github.com/search", params={"q": q, "type": "repositories"}) for q in search_queries], return_exceptions=True)
            repos, reserved = [], {"search", "topics", "sponsors", "settings", "collections", "marketplace"}
            for response in responses:
                if isinstance(response, Exception) or response.status_code != 200: continue
                hrefs = re.findall(r'href="/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)"', response.text)
                added = 0
                for repo in hrefs:
                    if repo.split("/", 1)[0].lower() in reserved or repo in repos: continue
                    repos.append(repo); added += 1
                    if added >= 4 or len(repos) >= 20: break
                if len(repos) >= 20: break
            pages = await asyncio.gather(*[client.get("https://github.com/" + repo) for repo in repos], return_exceptions=True)
    except Exception:
        return []
    out, seen = [], set()
    generic_docs = {"readme.md", "changelog.md", "contributing.md", "license.md", "license"}
    for response in pages:
        if isinstance(response, Exception) or response.status_code != 200: continue
        links = re.findall(r'href="(/[^\"?#]+/blob/[^\"?#]+)"', response.text)
        for link in links:
            full = "https://github.com" + link
            item = normalize_candidate(full)
            if not item or item["downloadUrl"] in seen: continue
            if extensions and item["extension"].lower() not in extensions: continue
            if item["name"].lower() in generic_docs: continue
            seen.add(item["downloadUrl"]); out.append(item)
    terms = {term.lower() for term in re.findall(r"[a-z0-9]+", query) if len(term) > 2}
    def relevance(item):
        name = item["name"].lower()
        haystack = (name + " " + item["sourceUrl"].lower())
        score = sum(1 for term in terms if term in haystack)
        stem = PurePosixPath(name).stem
        if stem in terms: score += 4
        return score
    out = [item for item in out if not item["name"].startswith(".") and relevance(item) > 0]
    out.sort(key=relevance, reverse=True)
    return out[:limit]


async def discover_files(query: str, limit: int = 8, extensions=None, platforms=None, requirements=None) -> dict:
    query = str(query or "").strip()
    if not query: raise ValueError("query is required")
    limit = max(1, min(12, int(limit)))
    exts = []
    if isinstance(extensions, str): extensions = extensions.split(",")
    for value in extensions or []:
        ext = str(value or "").lower().strip().lstrip(".")
        if _SAFE_EXT.fullmatch(ext) and ext not in _NON_FORMAT_VALUES and ext not in exts: exts.append(ext)
    if isinstance(platforms, str): platforms = platforms.split(",")
    platform_names = [str(x).strip() for x in (platforms or []) if str(x).strip()][:4]
    raw_requirements = requirements if isinstance(requirements, dict) else {}
    requested_formats = raw_requirements.get("formats") or raw_requirements.get("format") or []
    if isinstance(requested_formats, str): requested_formats = [requested_formats]
    for value in requested_formats[:8]:
        ext = str(value or "").lower().strip().lstrip(".")
        if _SAFE_EXT.fullmatch(ext) and ext not in _NON_FORMAT_VALUES and ext not in exts: exts.append(ext)
    source_request = SourceRequirements.from_mapping("discover_files", {
        **raw_requirements, "artifactType": raw_requirements.get("artifactType") or "file",
        "formats": exts,
        "requiredCapabilities": raw_requirements.get("requiredCapabilities") or ["search", "preview", "download"],
    })
    available_sources = ["github-public", "gitlab-public", "huggingface-public", "bing-html", "ddg-lite",
                         "microsoft-create", "canva-templates", "adobe-express", "overleaf-templates", "google-docs-gallery"]
    source_plan = ROUTER.plan(source_request, available_sources)
    # Query expansion comes from typed formats and the ranked provider catalog,
    # never from request-word branches or a globally preferred website.
    queries = [query]
    if exts:
        queries += [f"{query} filetype:{ext}" for ext in exts[:3]]
    for candidate in source_plan.get("candidates", [])[:5]:
        profile = CATALOG.get(candidate.get("provider", ""))
        if profile and profile.domains:
            queries.append(f"{query} site:{sorted(profile.domains)[0]}")
    for platform in platform_names:
        queries.append(f"{query} {platform}")
    candidates, seen_urls, providers = [], set(), []
    for q in queries[:5]:
        try:
            result = await engine_search(q, limit=max(limit, 8))
        except SearchFailed:
            continue
        if result.get("provider"): providers.append(str(result["provider"]))
        for row in result.get("results", []):
            url = _https(row.get("url", ""))
            if url and url not in seen_urls:
                seen_urls.add(url); candidates.append(row)
        if len(candidates) >= limit * 2: break
    files, seen_downloads, trees = [], set(), []
    for row in candidates:
        item = normalize_candidate(row.get("url", ""), row.get("title", ""))
        if not item:
            item = _catalog_page_candidate(row.get("url", ""), row.get("title", ""), exts)
        if item and exts and item.get("accessMode") != "open" and item["extension"].lower() not in exts:
            item = None
        artifact_url = (item.get("downloadUrl") or item.get("actionUrl")) if item else ""
        if item and artifact_url and artifact_url not in seen_downloads:
            seen_downloads.add(artifact_url); files.append(item)
        elif "github.com/" in str(row.get("url", "")):
            trees.append(str(row.get("url", "")))
        if len(files) >= limit: break
    if len(files) < limit and trees:
        async with httpx.AsyncClient(timeout=8.0, follow_redirects=False) as client:
            expanded = await asyncio.gather(*[_github_tree(url, client, limit) for url in trees[:4]])
        for group in expanded:
            for item in group:
                if exts and item["extension"].lower() not in exts: continue
                if item["downloadUrl"] in seen_downloads: continue
                seen_downloads.add(item["downloadUrl"]); files.append(item)
                if len(files) >= limit: break
            if len(files) >= limit: break
    if len(files) < limit:
        github_rows = await _github_repository_search(query, exts, limit - len(files))
        for item in github_rows:
            if item["downloadUrl"] in seen_downloads: continue
            seen_downloads.add(item["downloadUrl"]); files.append(item)
            if len(files) >= limit: break
    files = files[:limit]
    platform_ids = {"GitHub": "github-public", "GitLab": "gitlab-public", "Hugging Face": "huggingface-public",
                    "GitHub Gist": "github-public"}
    selected = list(dict.fromkeys(item.get("providerId") or platform_ids.get(item.get("platform"), "") for item in files))
    selected = [provider for provider in selected if provider]
    for provider in selected:
        rows = [item for item in files if (item.get("providerId") or platform_ids.get(item.get("platform"))) == provider]
        ROUTER.observe(provider, success=True, result_quality=min(1, 0.55 + len(rows) / max(1, limit) * 0.45),
                       valid_ratio=1, latency_ms=0)
    source_plan["selectedProviders"] = selected
    source_plan["resultEvaluation"] = {"accepted": len(files), "requestedFormats": sorted(exts),
        "formatCompatible": sum(not exts or item.get("extension") in exts for item in files),
        "downloadable": sum(bool(item.get("downloadUrl")) for item in files),
        "actionable": sum(bool(item.get("actionUrl")) for item in files),
        "constraintsSatisfied": bool(files)}
    source_plan["fallbackDecisions"] = ([] if files else [{"stage": 1, "decision": "broaden",
        "reason": "known source adapters and broad web discovery returned no verified file"}])
    return {"query": query, "provider": "+".join(dict.fromkeys(providers)) or "web", "results": files,
            "sourcePlan": source_plan}
