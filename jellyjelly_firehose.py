#!/usr/bin/env python3
"""
JellyJelly Firehose — Supabase REST API explorer
Credentials sourced from public client-side JS bundle (intentionally public).
"""

import requests
import json
import sys

SUPABASE_URL = "https://cbtzdoasmkbbiwnyoxvz.supabase.co"
ANON_KEY = (
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"
    ".eyJyb2xlIjoiYW5vbiIsImlhdCI6MTYzNjM4MjEwOCwiZXhwIjoxOTUxOTU4MTA4fQ"
    ".YdFG3RUvDJmRHoUQV4C5TsZcg2moGDDmnr4RNKO-Bcg"
)

HEADERS = {
    "apikey": ANON_KEY,
    "Authorization": f"Bearer {ANON_KEY}",
    "Content-Type": "application/json",
}


def rest(table, params=None):
    """Query a Supabase table via REST API."""
    url = f"{SUPABASE_URL}/rest/v1/{table}"
    r = requests.get(url, headers=HEADERS, params=params)
    r.raise_for_status()
    return r.json()


def discover_tables():
    """List available tables via PostgREST introspection."""
    url = f"{SUPABASE_URL}/rest/v1/"
    r = requests.get(url, headers=HEADERS)
    if r.status_code == 200:
        data = r.json()
        tables = [p["name"] for p in data.get("paths", {}).values()
                  if isinstance(p, dict) and "name" in p]
        # PostgREST returns OpenAPI — extract path names instead
        if not tables:
            import re
            tables = re.findall(r'"(/\w+)"', r.text)
            tables = [t.lstrip("/") for t in tables if not t.startswith("/rpc")]
        return tables
    return []


def fetch_jellies(limit=10, search=None):
    """Fetch recent jellies from the jelly table."""
    params = {
        "limit": limit,
        "order": "created_at.desc",
    }
    if search:
        params["title"] = f"ilike.*{search}*"

    try:
        data = rest("jelly", params)
        return data
    except requests.HTTPError as e:
        print(f"  Error fetching 'jelly': {e.response.status_code} {e.response.text[:200]}")
        return None


def probe_tables(candidates):
    """Try a list of table name candidates and report which respond."""
    print("\n=== Probing tables ===")
    found = []
    for table in candidates:
        try:
            r = requests.get(
                f"{SUPABASE_URL}/rest/v1/{table}",
                headers=HEADERS,
                params={"limit": 1},
            )
            if r.status_code == 200:
                rows = r.json()
                count = len(rows)
                keys = list(rows[0].keys()) if rows else []
                print(f"  [OK] {table:30s} — {count} row(s) returned, columns: {keys}")
                found.append((table, keys))
            else:
                print(f"  [--] {table:30s} — {r.status_code}")
        except Exception as e:
            print(f"  [!!] {table:30s} — {e}")
    return found


def firehose_poll(table="jelly", limit=20, order_col="updated_at"):
    """Poll the most recent rows from a table."""
    print(f"\n=== Firehose: latest {limit} rows from '{table}' ===")
    try:
        rows = rest(table, {"limit": limit, "order": f"{order_col}.desc"})
        for i, row in enumerate(rows, 1):
            print(f"\n--- Row {i} ---")
            print(json.dumps(row, indent=2, default=str))
        if not rows:
            print("  No rows returned (table may be empty or RLS-restricted).")
    except requests.HTTPError as e:
        print(f"  HTTP {e.response.status_code}: {e.response.text[:300]}")


if __name__ == "__main__":
    table_candidates = [
        "jelly", "jellies", "talk", "talks", "post", "posts",
        "video", "videos", "user", "users", "profile", "profiles",
        "feed", "firehose", "transaction", "transactions",
        "payment", "payments", "follow", "follows",
        "like", "likes", "comment", "comments",
        "notification", "notifications", "reward", "rewards",
        "wobble", "wobbles", "badge", "badges",
    ]

    if len(sys.argv) > 1:
        # Usage: python3 jellyjelly_firehose.py <table> [limit]
        tbl = sys.argv[1]
        lim = int(sys.argv[2]) if len(sys.argv) > 2 else 20
        firehose_poll(tbl, lim)
    else:
        # Discovery mode
        found = probe_tables(table_candidates)

        if found:
            print(f"\n=== Pulling latest rows from first accessible table: '{found[0][0]}' ===")
            # profiles uses updated_at; try created_at for others
            order = "updated_at" if found[0][0] == "profiles" else "created_at"
            firehose_poll(found[0][0], limit=5, order_col=order)
        else:
            print("\nNo accessible tables found. The API may require authentication.")
            print("Try logging in via the app and passing your JWT as the Bearer token.")
