"""Read-only snapshot of a session: messages (oldest first) and a fingerprint.

Usage: python3 -I scripts/snapshot.py <sessionID> [--full]
Reads via `opencode api`; never writes.
"""

import hashlib
import json
import subprocess
import sys


def api(path):
    out = subprocess.run(["opencode", "api", "get", path], capture_output=True, text=True, check=True).stdout
    data = json.loads(out)
    return data.get("data", data)


def text_of(m):
    if m.get("type") in ("user", "synthetic", "system"):
        return m.get("text", "")
    if m.get("type") == "assistant":
        return "".join(p.get("text", "") for p in m.get("content", []) if p.get("type") in ("text", "reasoning"))
    return ""


def main():
    sid = sys.argv[1]
    full = "--full" in sys.argv
    info = api(f"/api/session/{sid}")
    msgs = sorted(api(f"/api/session/{sid}/message"), key=lambda m: m["id"])
    blob = json.dumps(msgs, sort_keys=True, ensure_ascii=False).encode()
    print(json.dumps({
        "session": sid,
        "title": info.get("title"),
        "parentID": info.get("parentID"),
        "time": info.get("time"),
        "count": len(msgs),
        "sha256": hashlib.sha256(blob).hexdigest()[:16],
        "messages": [
            {"id": m["id"], "type": m["type"], "text": (text_of(m) if full else text_of(m)[:60])}
            for m in msgs
        ],
    }, ensure_ascii=False, indent=1))


main()
