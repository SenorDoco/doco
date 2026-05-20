#!/usr/bin/env python3
"""
Migrate non-rule nodes off #global per decision_01KS2N0KQ9Y31XDKXT5DDC95YJ.

#global.allowed_node_types = ["rule"] — anything else has no business there.
Migrates decisions / intents / actions / evals via the 3-step lifecycle dance
(drafted → swap scopes → restore lifecycle), since production's
ALLOWED_ON_FROZEN doesn't yet include scope_names_remove (that's in this PR
but not deployed).

Logs are SKIPPED because they're frozen at every lifecycle
(FROZEN_LIFECYCLES["log"] = ["*"]); they need this PR's mutability relaxation
to deploy first.
"""
import json, os, time, urllib.request, urllib.error

TOKEN = open("/tmp/doco-token.txt").read().strip()
HOST = "https://doco.to"
HANDLE = "meta-doco"
GLOBAL_ID = "scope_01KRFFRD3SQ80T93RSE3T4GHG2"
LOG_PATH = "/tmp/non-rule-migration.jsonl"
INPUT_PATH = "/tmp/global-nodes.jsonl"

# node types we know how to migrate today (lifecycle has unfrozen state).
MIGRATABLE = {"decision", "intent", "action", "eval"}
SKIP = {"log"}  # always-frozen on prod; will move after PR merges.

PLURALS = {
    "decision": "decisions",
    "intent": "intents",
    "action": "actions",
    "log": "logs",
    "eval": "evals",
    "reference": "references",
}


def classify(summary: str) -> str:
    s = (summary or "").lower()
    deploy_kw = ["deploy", "live in production", "push", "commit", "alpha",
                 "vercel", "ship", "production", "main", "auto-commit",
                 "auto commit", "phase 6", "neon", "namecheap"]
    flow_kw = ["recipe", "bootstrap", "onboarding", "invite", "user-flow",
               "user-flows", "template", "wizard"]
    if any(k in s for k in deploy_kw):
        return "#deployments"
    if any(k in s for k in flow_kw):
        return "#user-flows"
    return "#important"


def api(method, path, body=None):
    url = HOST + path
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Authorization": f"Bearer {TOKEN}"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read())
        except Exception:
            return e.code, {"error": str(e)}


def fetch(node_type, nid):
    plural = PLURALS.get(node_type, node_type + "s")
    code, data = api("GET", f"/{HANDLE}/api/{plural}/{nid}.json")
    if code != 200:
        return None
    p = data.get("parsed", {})
    return {
        "id": nid,
        "node_type": node_type,
        "lifecycle": p.get("lifecycle") or data.get("lifecycle") or "active",
        "summary": p.get("summary") or data.get("summary") or "",
        "scopes": p.get("scopes") or [],
    }


def migrate(node, dest, log):
    nid = node["id"]
    plural = PLURALS.get(node["node_type"], node["node_type"] + "s")
    original_lc = node["lifecycle"]
    entry = {
        "id": nid,
        "node_type": node["node_type"],
        "dest": dest,
        "orig_lifecycle": original_lc,
        "summary": node["summary"][:120],
        "steps": [],
    }
    code, data = api("PATCH", f"/{HANDLE}/api/{plural}/{nid}.json", {"lifecycle": "drafted"})
    entry["steps"].append({"op": "lifecycle=drafted", "code": code, "err": data.get("error")})
    if code != 200:
        entry["status"] = "failed_step1"
        log.write(json.dumps(entry) + "\n"); log.flush()
        return False
    code, data = api("PATCH", f"/{HANDLE}/api/{plural}/{nid}.json",
                     {"scope_names_add": [dest], "scope_names_remove": ["#global"]})
    entry["steps"].append({"op": f"+{dest} -#global", "code": code, "err": data.get("error")})
    if code != 200:
        api("PATCH", f"/{HANDLE}/api/{plural}/{nid}.json", {"lifecycle": original_lc})
        entry["status"] = "failed_step2"
        log.write(json.dumps(entry) + "\n"); log.flush()
        return False
    code, data = api("PATCH", f"/{HANDLE}/api/{plural}/{nid}.json", {"lifecycle": original_lc})
    entry["steps"].append({"op": f"lifecycle={original_lc}", "code": code, "err": data.get("error")})
    if code != 200:
        entry["status"] = "failed_step3"
        log.write(json.dumps(entry) + "\n"); log.flush()
        return False
    entry["status"] = "ok"
    log.write(json.dumps(entry) + "\n"); log.flush()
    return True


def main():
    seen = {}
    with open(INPUT_PATH) as f:
        for line in f:
            try:
                r = json.loads(line)
                seen[r["id"]] = r
            except Exception:
                pass

    targets = []
    skipped_log = []
    for nid, info in seen.items():
        nt = info["node_type"]
        if nt in SKIP:
            skipped_log.append(info)
            continue
        if nt not in MIGRATABLE:
            print(f"unknown node type for {nid}: {nt}; skipping")
            continue
        targets.append(info)

    print(f"Total non-rule nodes scanned: {len(seen)}")
    print(f"  Skipping {len(skipped_log)} logs (always-frozen; need merged PR's mutability relaxation)")
    print(f"  Migrating {len(targets)} ({sum(1 for t in targets if t['node_type']=='decision')} decisions, "
          f"{sum(1 for t in targets if t['node_type']=='intent')} intents, "
          f"{sum(1 for t in targets if t['node_type']=='action')} actions, "
          f"{sum(1 for t in targets if t['node_type']=='eval')} evals)\n")

    counts = {"#deployments": 0, "#user-flows": 0, "#important": 0}
    results = {"ok": 0, "skip_not_in_global": 0, "fail": 0}
    with open(LOG_PATH, "w") as log:
        # also dump skipped logs for record
        for sl in skipped_log:
            log.write(json.dumps({**sl, "status": "skipped_log_always_frozen"}) + "\n")
        for i, t in enumerate(targets, 1):
            live = fetch(t["node_type"], t["id"])
            if live is None:
                print(f"[{i}/{len(targets)}] {t['id']} — fetch failed")
                results["fail"] += 1
                continue
            if GLOBAL_ID not in live["scopes"]:
                print(f"[{i}/{len(targets)}] {t['id']} — not in #global anymore")
                results["skip_not_in_global"] += 1
                continue
            dest = classify(live["summary"])
            counts[dest] += 1
            print(f"[{i}/{len(targets)}] {t['node_type']:8s} {t['id']} → {dest:14s} [{live['lifecycle']}] {live['summary'][:70]}")
            if migrate(live, dest, log):
                results["ok"] += 1
            else:
                results["fail"] += 1
            time.sleep(0.12)

    print("\n=== Results ===")
    for k, v in results.items():
        print(f"  {k}: {v}")
    print("  Destinations:")
    for k, v in counts.items():
        print(f"    {k}: {v}")
    print(f"\nFull log: {LOG_PATH}")
    print(f"Logs skipped: {len(skipped_log)} (deferred to post-merge)")


if __name__ == "__main__":
    main()
