"""Date-aware rules; no guessing on missing or ambiguous applicability."""
from datetime import date

from app.repository import CabinRepository


def active(record, day, end="eff_to"):
    return record["eff_from"] <= day and (not record.get(end) or day <= record[end])


def parts_for_check(tail: str, check_date: date, db: CabinRepository) -> dict:
    tail, day = tail.strip().upper(), check_date.isoformat()
    result = {"tail": tail, "check_date": day, "demo": True, "lines": [], "issues": []}

    def failure(status, message):
        return {**result, "status": status, "message": message}

    aircraft = db.aircraft(tail)
    if not aircraft:
        return failure("UNKNOWN_TAIL", "This tail is not in the dataset.")
    result["aircraft"] = aircraft
    configs = db.configurations(tail, day)
    if not configs:
        return failure("NO_CONFIG", "No configuration on this date.")
    if len(configs) != 1:
        return failure("AMBIGUOUS_CONFIG", "Overlapping configurations; engineering review is required.")
    config = configs[0]
    variants = {v["id"]: v for v in db.variants()}
    variant = variants.get(config["variant_id"])
    if not variant or not variant["released"]:
        return failure("NO_CONFIG", "This variant is planned; no released configuration is available.")
    source = db.document(config["doc_id"])
    if not source or not active(source, day, "expires"):
        return failure("NO_CONFIG", "The configuration source is not effective on this date.")
    if variant["subfleet"] != aircraft["subfleet"]:
        return failure("INVALID_CONFIG", "Aircraft and variant sub-fleets disagree.")
    attrs = {**variant, **aircraft, "variant_id": variant["id"], "carpet": config["carpet"],
             "seam": config["seam"], "cabin_height": config["cabin_height"] or variant["cabin_height"]}
    result["configuration"] = {**config, "variant": variant, "attributes": attrs, "source": source}
    positions = db.positions(variant["id"])
    if not positions:
        return failure("NO_RULES", "No positions are defined for this variant.")
    candidates = []
    for rule in db.rules():
        selectors = rule["selectors"]
        if not selectors or not all(v is not None and attrs.get(k) == v for k, v in selectors.items()):
            continue
        doc = db.document(rule["doc_id"])
        if not active(rule, day) or not doc or not active(doc, day, "expires"):
            continue
        implied = {}
        if selectors.get("variant_id") in variants:
            v = variants[selectors["variant_id"]]
            implied = {k: v[k] for k in ("subfleet", "seat_mfr", "elr", "layout", "power", "cabin_height") if v[k] is not None}
            if config["cabin_height"] and config["cabin_height"] != v["cabin_height"]:
                implied.pop("cabin_height", None)
        candidates.append({**rule, "source": doc, "constraints": {**implied, **selectors}})
    for position in positions:
        matched = [r for r in candidates if r["position_id"] == position["id"]]
        best = [r for r in matched if not any(set(r["constraints"].items()) < set(o["constraints"].items()) for o in matched)]
        if len(best) != 1:
            result["issues"].append({"position": position, "code": "AMBIGUOUS_RULE" if best else "NO_MATCH",
                "message": "Conflicting rules; no part selected." if best else "No effective approved rule matches this position.",
                "sources": [r["source"] for r in best]})
            continue
        rule = best[0]
        substitutes = []
        for sub in db.substitutes(rule["id"]):
            doc = db.document(sub["doc_id"])
            if active(sub, day) and doc and active(doc, day, "expires"):
                substitutes.append({**sub, "source": doc})
        result["lines"].append({k: v for k, v in rule.items() if k != "constraints"} | {"position": position, "substitutes": substitutes})
    result["status"] = ("PARTIAL" if result["lines"] else "NO_RULES") if result["issues"] else "OK"
    result["message"] = {"OK": "Matching parts found for the configured demo positions.", "PARTIAL": "Some positions could not be resolved; review the gaps.", "NO_RULES": "No applicable parts were resolved."}[result["status"]]
    return result
