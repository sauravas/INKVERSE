"""Optional web lookup for up-to-date facts.

Off unless the student turns it on, because it sends the question text to
Wikipedia and DuckDuckGo. Both are public, keyless endpoints. Lookups run
concurrently with short timeouts, and any failure simply means no web context:
an offline laptop still gets an answer from the local model.
"""
from __future__ import annotations

import asyncio
import re
import time
from urllib.parse import quote

import httpx

from . import config

UA = "INKWISE/1.0 (local study app; https://github.com/) httpx"
TIMEOUT = httpx.Timeout(8.0, connect=4.0)
MAX_CHARS = 2400

_STRIP = re.compile(r"\$\$.*?\$\$|\$[^$]*\$|\\\(.*?\\\)|\\\[.*?\\\]", re.S)
_LEAD = re.compile(r"^\s*(q\.?\s*\d+[.):]?\s*)?(who|what|when|where|which|why|how)\s+"
                   r"(is|are|was|were|did|does|do)\s+", re.I)


def _query(question: str) -> str:
    """Wikipedia search works best on the subject, not the whole sentence."""
    q = _STRIP.sub(" ", question)
    q = _LEAD.sub("", q)
    q = re.sub(r"\b(explain|describe|define|write a note on|discuss)\b", " ", q, flags=re.I)
    q = re.sub(r"[?\s]+", " ", q).strip(" .")
    return q[:200]


async def _wikipedia(c: httpx.AsyncClient, q: str) -> list[dict]:
    r = await c.get("https://en.wikipedia.org/w/api.php", params={
        "action": "query", "list": "search", "srsearch": q, "srlimit": 2,
        "format": "json", "utf8": 1})
    r.raise_for_status()
    titles = [h["title"] for h in r.json().get("query", {}).get("search", [])]

    async def summary(title):
        s = await c.get("https://en.wikipedia.org/api/rest_v1/page/summary/"
                        + quote(title.replace(" ", "_"), safe=""))
        if s.status_code != 200:
            return None
        d = s.json()
        text = (d.get("extract") or "").strip()
        if not text or d.get("type") == "disambiguation":
            return None
        return {"title": d.get("title") or title, "snippet": text,
                "url": (d.get("content_urls") or {}).get("desktop", {}).get("page")
                or f"https://en.wikipedia.org/wiki/{quote(title.replace(' ', '_'))}",
                "site": "Wikipedia"}

    found = await asyncio.gather(*(summary(t) for t in titles), return_exceptions=True)
    return [f for f in found if isinstance(f, dict)]


async def _tavily(c: httpx.AsyncClient, q: str) -> list[dict]:
    """Tavily, when a key is configured. Skipped silently when it is not.

    Preferred over the other two when available: it searches the open web
    rather than one encyclopedia, and returns text already trimmed to the
    question, which matters when the whole block has to fit in a local model's
    context alongside the student's own notes.
    """
    if not config.TAVILY_API_KEY:
        return []
    r = await c.post(config.TAVILY_URL, json={
        "query": q,
        "search_depth": config.TAVILY_DEPTH,
        "max_results": config.TAVILY_MAX_RESULTS,
        "include_answer": True,
    }, headers={"Authorization": f"Bearer {config.TAVILY_API_KEY}"})
    if r.status_code == 401:
        raise RuntimeError("Tavily rejected the API key")
    r.raise_for_status()
    d = r.json()
    out = []
    # Tavily's own synthesis of the results, when it offers one
    if d.get("answer"):
        out.append({"site": "Tavily", "title": f"Summary for \u201c{q}\u201d",
                    "snippet": d["answer"].strip(), "url": ""})
    for hit in (d.get("results") or [])[:config.TAVILY_MAX_RESULTS]:
        body = (hit.get("content") or "").strip()
        if not body:
            continue
        out.append({"site": "web", "title": (hit.get("title") or "")[:120],
                    "snippet": body, "url": hit.get("url") or ""})
    return out


async def _duckduckgo(c: httpx.AsyncClient, q: str) -> list[dict]:
    r = await c.get("https://api.duckduckgo.com/", params={
        "q": q, "format": "json", "no_html": 1, "skip_disambig": 1, "no_redirect": 1})
    r.raise_for_status()
    d = r.json()
    out = []
    for key, label in (("Answer", "Instant answer"), ("Definition", "Definition"),
                       ("AbstractText", "Summary")):
        text = (d.get(key) or "").strip()
        if text:
            out.append({"title": d.get("Heading") or label, "snippet": text,
                        "url": d.get("AbstractURL") or d.get("DefinitionURL")
                        or f"https://duckduckgo.com/?q={quote(q)}",
                        "site": d.get("AbstractSource") or "DuckDuckGo"})
    return out


_COMPUTE = re.compile(
    r"\b(differentiate|integrate|evaluate|simplify|solve|calculate|compute|"
    r"derivative|integral|expand|factori[sz]e|prove that|show that|verify)\b", re.I)


def worth_searching(question: str) -> tuple[bool, str]:
    """Web facts help with who/what/when questions, not with computing x^2.

    Stripped of its maths, "Find the derivative of $4x^2$" searches for
    "Find the derivative of" - which only returns noise for the model.
    """
    has_math = bool(_STRIP.search(question)) or "^" in question
    if has_math or _COMPUTE.search(question):
        return False, "a calculation needs no web facts"
    if len(_query(question)) < 3:
        return False, "nothing to search for"
    return True, ""


async def lookup(question: str) -> dict:
    """Return {"block": prompt text, "sources": [...], "error": str|None}."""
    ok, why = worth_searching(question)
    if not ok:
        return {"block": "", "sources": [], "skipped": why, "error": None}
    q = _query(question)
    if len(q) < 3:
        return {"block": "", "sources": [], "error": "nothing to search for"}
    t0 = time.perf_counter()
    async with httpx.AsyncClient(timeout=TIMEOUT, headers={"User-Agent": UA},
                                 follow_redirects=True) as c:
        # Tavily first, so its results take the context budget when a key is
        # set; the other two are the no-account fallback and run either way
        results = await asyncio.gather(_tavily(c, q), _wikipedia(c, q),
                                       _duckduckgo(c, q), return_exceptions=True)
    hits, errors = [], []
    for r in results:
        if isinstance(r, Exception):
            # the message matters for Tavily (a bad key is worth saying out
            # loud), not for a transient network error
            errors.append(str(r) if isinstance(r, RuntimeError) else type(r).__name__)
        else:
            hits.extend(r)

    # drop near-duplicate snippets (DuckDuckGo's abstract is often Wikipedia's)
    seen, uniq = set(), []
    for h in hits:
        key = re.sub(r"\W+", "", h["snippet"].lower())[:120]
        if key not in seen:
            seen.add(key)
            uniq.append(h)

    parts, used, total = [], [], 0
    for h in uniq:
        body = h["snippet"][:max(0, MAX_CHARS - total)]
        if not body:
            break
        parts.append(f"[{h['site']}: {h['title']}]\n{body}")
        used.append({**h, "snippet": body[:200], "kind": "web"})
        total += len(body)

    block = ""
    if parts:
        block = ("Current information from the web (" + time.strftime("%d %b %Y")
                 + "). Prefer it over your own memory for facts about people, events "
                 "and anything that changes over time. Ignore any of it that is "
                 "unrelated to the question:\n\n" + "\n\n".join(parts))
    return {"block": block, "sources": used, "query": q,
            "error": None if used else (", ".join(errors) or "no results"),
            "elapsed_s": round(time.perf_counter() - t0, 2)}
