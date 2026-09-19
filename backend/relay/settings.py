"""Relay runtime configuration and shared in-memory state.

Split of the monolithic relay.server (modularisation pass): every module
imports these values from ONE place so a test replacing a container sees
the same object the request paths see, and the relay boots identically
whether uvicorn imports ``relay.server:app`` or a test imports a router.
"""
import os
import threading
import time
from pathlib import Path

BASE_DIR = Path(os.environ.get("CP_DIR", str(Path(__file__).resolve().parent)))
ENV_FILE = BASE_DIR / ".env"
if ENV_FILE.exists():
    for line in ENV_FILE.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, _, v = line.partition("=")
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

CONTROL_KEY = os.environ.get("CONTROL_KEY", "")
GATEWAY_URL = os.environ.get("LLM_GATEWAY_URL", "").rstrip("/")
GATEWAY_KEY = os.environ.get("LLM_GATEWAY_KEY", "")
WAKE_STUDIO = os.environ.get("WAKE_STUDIO", "0") == "1"
WAKE_ON_CHAT = os.environ.get("WAKE_ON_CHAT", "1") == "1"
IDLE_MONITOR = os.environ.get("IDLE_MONITOR", "1") == "1"
IDLE_STOP_MINUTES = int(os.environ.get("IDLE_STOP_MINUTES", "5"))
IDLE_CHECK_MINUTES = int(os.environ.get("IDLE_CHECK_MINUTES", "5"))
PORT = int(os.environ.get("PORT", "8000"))
ALLOWED_ORIGINS = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "*").split(",") if o.strip()]
RESTART_SCRIPT = os.environ.get("RESTART_SCRIPT", "bash ~/impose/backend/lightning/restart_all.sh")
PUB_SEARCH_LIMIT = int(os.environ.get("PUB_SEARCH_LIMIT", "10"))

if not CONTROL_KEY:
    print("[relay] WARNING: no CONTROL_KEY, auth disabled (dev only)", flush=True)

_lifecycle_lock = threading.Lock()
_lifecycle_started = False

STARTED_AT = time.time()
_last_activity = STARTED_AT
_wake_lock = threading.Lock()
_waking = False

# Gateway state is a cache, not a question we ask the network on every
# request: an 8 second health round trip per chat completion made every
# message slower and stampeded the box under load. Transport errors mark it
# down at once; any successful probe marks it up.
_GW_TTL = 10.0
_gateway_state = {"up": None, "llm_up": None, "at": 0.0,
                  "status": None, "error": None}
_state_lock = threading.Lock()

# --- auth + proxy rate limiting (per client IP, in memory) ---
_RATE_BUCKETS = {}
_rate_lock = threading.Lock()
_rate_pruned_at = 0.0

_CACHE = {}  # (kind, key) -> (expires_at_epoch, value); a small TTL memo so
             # repeats and regenerates skip the wobbly upstream engines
_cache_lock = threading.Lock()

_MEMBER_CACHE = {}
_member_cache_lock = threading.Lock()

# Public tier: keyless browsers get a small per-IP budget on the retrieval
# routes behind the control key. PUBLIC_TIER=0 turns the whole thing off.
PUBLIC_TIER = os.environ.get("PUBLIC_TIER", "1").strip().lower() not in ("0", "false", "no")
PUB_IMAGES_LIMIT = int(os.environ.get("PUB_IMAGES_LIMIT", "10"))
PUB_VIDEO_LIMIT = int(os.environ.get("PUB_VIDEO_LIMIT", "10"))
PUB_FILES_LIMIT = int(os.environ.get("PUB_FILES_LIMIT", "10"))
PUB_FILE_BYTES_LIMIT = int(os.environ.get("PUB_FILE_BYTES_LIMIT", "20"))
