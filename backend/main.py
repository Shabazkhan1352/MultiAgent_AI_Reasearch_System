"""
FastAPI wrapper around the research pipeline.

Run from the project root:
    uvicorn backend.main:app --reload --port 8000

It re-uses agents.py and tools.py exactly as they are and streams progress
to the browser over Server-Sent Events, one event per pipeline step.
"""
import asyncio
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles

from agents import (  # noqa: E402  (needs the sys.path tweak above)
    build_reader_agent,
    build_search_agent,
    critic_chain,
    writer_chain,
)

app = FastAPI(title="MultiAgent AI Research System")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _text(content) -> str:
    """Agent messages can be a string or a list of content blocks."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict):
                parts.append(block.get("text", ""))
        return "".join(parts)
    return str(content)


def _sse(payload: dict) -> str:
    return f"data: {json.dumps(payload)}\n\n"


# --- the four pipeline steps, mirroring pipeline.py ---------------------------

def _search(topic: str, _state: dict) -> str:
    result = build_search_agent().invoke(
        {"messages": [("user", f"Find recent, reliable and detailed information about: {topic}")]}
    )
    return _text(result["messages"][-1].content)


def _read(topic: str, state: dict) -> str:
    result = build_reader_agent().invoke(
        {
            "messages": [
                (
                    "user",
                    f"Based on the following search results about '{topic}', "
                    f"pick the most relevant URL and scrape it for deeper content.\n\n"
                    f"Search Results:\n{state['search'][:800]}",
                )
            ]
        }
    )
    return _text(result["messages"][-1].content)


def _write(topic: str, state: dict) -> str:
    research = (
        f"SEARCH RESULTS : \n {state['search']} \n\n"
        f"DETAILED SCRAPED CONTENT : \n {state['read']}"
    )
    return _text(writer_chain.invoke({"topic": topic, "research": research}))


def _critic(_topic: str, state: dict) -> str:
    return _text(critic_chain.invoke({"report": state["write"]}))


STEPS = [
    ("search", _search),
    ("read", _read),
    ("write", _write),
    ("critic", _critic),
]


async def _run_step(fn, topic: str, state: dict, box: dict):
    """Run a blocking step in a thread, yielding keep-alive pings while it works."""
    task = asyncio.create_task(asyncio.to_thread(fn, topic, state))
    while True:
        done, _ = await asyncio.wait({task}, timeout=10)
        if done:
            box["value"] = task.result()
            return
        yield ": ping\n\n"


async def _stream(topic: str):
    state: dict = {}
    current = None
    try:
        for name, fn in STEPS:
            current = name
            yield _sse({"type": "step", "step": name, "status": "running"})
            started = time.perf_counter()
            box: dict = {}
            async for ping in _run_step(fn, topic, state, box):
                yield ping
            state[name] = box["value"]
            yield _sse(
                {
                    "type": "step",
                    "step": name,
                    "status": "done",
                    "seconds": round(time.perf_counter() - started, 1),
                    "output": state[name],
                }
            )
        yield _sse({"type": "done", "report": state["write"], "feedback": state["critic"]})
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # surface the failure in the UI instead of a dead stream
        yield _sse({"type": "error", "step": current, "message": str(exc) or exc.__class__.__name__})


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.get("/api/research/stream")
async def research_stream(topic: str = Query(..., min_length=3, max_length=300)):
    topic = topic.strip()
    if len(topic) < 3:
        raise HTTPException(status_code=422, detail="Topic is too short.")
    return StreamingResponse(
        _stream(topic),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# Serve the production build when it exists (after `npm run build` in frontend/).
_dist = ROOT / "frontend" / "dist"
if _dist.is_dir():
    app.mount("/", StaticFiles(directory=_dist, html=True), name="frontend")
