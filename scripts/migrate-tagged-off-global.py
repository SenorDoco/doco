#!/usr/bin/env python3
"""
Migrate tagged rules off #global per decision_01KS2N0KQ9Y31XDKXT5DDC95YJ.

For each tagged rule currently in #global:
  1. Pick a destination from {#deployments, #user-flows, #important} based on summary keywords.
  2. PATCH lifecycle → drafted (unfreezes the claim).
  3. PATCH scope_names_add: [destination], scope_names_remove: ["#global"].
  4. PATCH lifecycle → original.

Logs every step to /tmp/migration.jsonl and prints a summary at the end.
"""
import json
import os
import sys
import time
import urllib.request
import urllib.error

TOKEN = open('/tmp/doco-token.txt').read().strip()
HOST = "https://doco.to"
HANDLE = "meta-doco"
LOG_PATH = "/tmp/migration.jsonl"

# Already-migrated in earlier test:
ALREADY_DONE = {"rule_01KS2JZZDFD339FATXJC37BDKF"}


def classify(summary: str) -> str:
    s = (summary or "").lower()
    deploy_kw = ["alpha", "deploy", "live in production", "push to", "commit and push",
                 "automatically committed", "vercel", "shipped", "deployed to prod",
                 "is live", "before being declared done"]
    flow_kw = ["recipe", "bootstrap", "user-flow", "setup agent", "anonymous",
               "invite", "redeem", "onboarding"]
    if any(k in s for k in deploy_kw):
        return "#deployments"
    if any(k in s for k in flow_kw):
        return "#user-flows"
    return "#important"


def api(method: str, path: str, body=None):
    url = f"{HOST}{path}"
    data = None
    headers = {"Authorization": f"Bearer {TOKEN}"}
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read())
        except Exception:
            return e.code, {"error": e.reason}


def fetch_rule(rid: str):
    code, data = api("GET", f"/{HANDLE}/api/rules/{rid}.json")
    if code != 200:
        return None
    p = data.get("parsed", {})
    return {
        "id": rid,
        "kind": p.get("kind") or "tagged",
        "lifecycle": p.get("lifecycle") or data.get("lifecycle") or "active",
        "summary": p.get("summary") or data.get("summary") or "",
        "scopes": p.get("scopes") or [],
    }


def migrate(rule: dict, dest: str, log):
    rid = rule["id"]
    original_lc = rule["lifecycle"]
    log_entry = {"id": rid, "summary": rule["summary"][:120], "dest": dest, "orig_lifecycle": original_lc, "steps": []}

    # Step 1: drafted
    code, data = api("PATCH", f"/{HANDLE}/api/rules/{rid}.json", {"lifecycle": "drafted"})
    log_entry["steps"].append({"op": "lifecycle=drafted", "code": code, "ok": data.get("ok"), "err": data.get("error")})
    if code != 200:
        log_entry["status"] = "failed_step1"
        log.write(json.dumps(log_entry) + "\n")
        log.flush()
        return False

    # Step 2: scope swap
    code, data = api("PATCH", f"/{HANDLE}/api/rules/{rid}.json",
                     {"scope_names_add": [dest], "scope_names_remove": ["#global"]})
    log_entry["steps"].append({"op": f"+{dest} -#global", "code": code, "ok": data.get("ok"), "err": data.get("error")})
    if code != 200:
        # Try to restore lifecycle even on failure
        api("PATCH", f"/{HANDLE}/api/rules/{rid}.json", {"lifecycle": original_lc})
        log_entry["status"] = "failed_step2"
        log.write(json.dumps(log_entry) + "\n")
        log.flush()
        return False

    # Step 3: restore lifecycle
    code, data = api("PATCH", f"/{HANDLE}/api/rules/{rid}.json", {"lifecycle": original_lc})
    log_entry["steps"].append({"op": f"lifecycle={original_lc}", "code": code, "ok": data.get("ok"), "err": data.get("error")})
    if code != 200:
        log_entry["status"] = "failed_step3"
        log.write(json.dumps(log_entry) + "\n")
        log.flush()
        return False

    log_entry["status"] = "ok"
    log.write(json.dumps(log_entry) + "\n")
    log.flush()
    return True


def main():
    # Load the previously-classified set; re-confirm kind by fetching live.
    with open("/tmp/classified.json") as f:
        classified = json.load(f)

    tagged_ids = [rid for rid, info in classified.items() if info.get("kind") == "tagged"]
    targets = [rid for rid in tagged_ids if rid not in ALREADY_DONE]
    print(f"Total tagged in #global from earlier scan: {len(tagged_ids)}")
    print(f"Already migrated: {len(ALREADY_DONE)}")
    print(f"Targets this run: {len(targets)}\n")

    counts = {"#deployments": 0, "#user-flows": 0, "#important": 0}
    results = {"ok": 0, "skip_not_tagged": 0, "skip_not_in_global": 0, "fail": 0}

    with open(LOG_PATH, "w") as log:
        for i, rid in enumerate(targets, 1):
            live = fetch_rule(rid)
            if live is None:
                print(f"[{i}/{len(targets)}] {rid} — fetch failed, skipping")
                results["fail"] += 1
                continue
            if live["kind"] != "tagged":
                print(f"[{i}/{len(targets)}] {rid} — kind is now {live['kind']}, skipping")
                results["skip_not_tagged"] += 1
                continue
            global_id = "scope_01KRFFRD3SQ80T93RSE3T4GHG2"
            if global_id not in live["scopes"]:
                print(f"[{i}/{len(targets)}] {rid} — not in #global anymore, skipping")
                results["skip_not_in_global"] += 1
                continue
            dest = classify(live["summary"])
            counts[dest] += 1
            print(f"[{i}/{len(targets)}] {rid} → {dest:14s} [{live['lifecycle']}] {live['summary'][:80]}")
            if migrate(live, dest, log):
                results["ok"] += 1
            else:
                results["fail"] += 1
            # Polite delay
            time.sleep(0.15)

    print("\n=== Results ===")
    for k, v in results.items():
        print(f"  {k}: {v}")
    print(f"\n  Destinations:")
    for k, v in counts.items():
        print(f"    {k}: {v}")
    print(f"\nFull log: {LOG_PATH}")


if __name__ == "__main__":
    main()
