"""Run the grading system on card photos, the way the app does, from the command line.

    python scripts/photo_grade.py scan FRONT.jpg BACK.jpg --out DIR
        Finds and flattens the card, measures centering, checks photo quality, and looks for edge/corner
        wear candidates (the same vision.js / inspect.js the app uses). Writes zoomable images to DIR and
        prints what the system found and could not assess.

    python scripts/photo_grade.py grade DIR/scan.json OBS.json [--json RESULT.json]
        Grades the card from the measured centering plus the inspector's observations (defects found and
        which areas were looked at), with the same rules as the app.

OBS.json: {"inspected": {"front": ["corners","edges","surface"], "back": [...]},
           "inspected_in_hand": {"front": ["corners"]},
           "defects": [{"side": "front", "location": "top_left", "type": "corner_softening",
                        "severity": "minor", "note": "..."}]}
An area that is not listed as inspected is unassessed and makes the grade an incomplete ceiling.

The photo check wins over "inspected": an area the scan says its photo can't show (scan.json
"photo_limits", from the photo-quality check) stays unassessed even when it is listed as inspected, and
defects logged there only lower the ceiling. Only "inspected_in_hand" (a person examined the physical card
under good light, not the photo) lifts it. Each defect's location must be one its type allows
(`photo_grade.py vocab`).
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from cardgrader import criteria_loader  # noqa: E402
from cardgrader.engine import grade_all  # noqa: E402
from cardgrader.models import CardAssessment, Defect, allowed_locations, photo_limit_components  # noqa: E402

MAX_SIDE = 2400  # the app downsizes photos to this before scanning
NODE_SCRIPT = """
const V = require(%s), I = require(%s), fs = require("fs");
const jobs = JSON.parse(fs.readFileSync(0, "utf8"));
const out = jobs.map((j) => {
  const img = { width: j.width, height: j.height, data: new Uint8ClampedArray(fs.readFileSync(j.path)) };
  const scan = V.scan(img, "auto");
  const quality = I.quality(img, scan);
  const check = I.edgesAndCorners(scan, { quality, face: j.side });
  fs.writeFileSync(j.path + ".warped", Buffer.from(scan.warped.data.buffer));
  const { warped, ...rest } = scan;
  return { side: j.side, scan: rest, quality, check };
});
process.stdout.write(JSON.stringify(out));
"""


def load(path: str) -> np.ndarray:
    img = cv2.imread(path)
    if img is None:
        sys.exit(f"can't read {path}")
    scale = min(1.0, MAX_SIDE / max(img.shape[:2]))
    if scale < 1:
        img = cv2.resize(img, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    return img


def run_vision(images: dict[str, np.ndarray], tmp: Path) -> list[dict]:
    jobs = []
    for side, img in images.items():
        p = tmp / f"{side}.rgba"
        p.write_bytes(cv2.cvtColor(img, cv2.COLOR_BGR2RGBA).tobytes())
        jobs.append({"side": side, "path": str(p), "width": img.shape[1], "height": img.shape[0]})
    script = NODE_SCRIPT % (json.dumps(str(ROOT / "standalone/src/vision.js")), json.dumps(str(ROOT / "standalone/src/inspect.js")))
    res = subprocess.run(["node", "-e", script], input=json.dumps(jobs), capture_output=True, text=True, check=True)
    return json.loads(res.stdout)


def read_warped(path: Path, w: int, h: int) -> np.ndarray:
    rgba = np.frombuffer(Path(str(path) + ".warped").read_bytes(), np.uint8).reshape(h, w, 4)
    return cv2.cvtColor(rgba, cv2.COLOR_RGBA2BGR)


def label(img: np.ndarray, text: str) -> np.ndarray:
    out = img.copy()
    cv2.rectangle(out, (0, 0), (min(out.shape[1], 9 * len(text) + 10), 22), (0, 0, 0), -1)
    cv2.putText(out, text, (5, 16), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1, cv2.LINE_AA)
    return out


def corners_image(card: np.ndarray, size: int = 160, zoom: int = 3) -> np.ndarray:
    h, w = card.shape[:2]
    crops = {"top-left": card[:size, :size], "top-right": card[:size, w - size:],
             "bottom-left": card[h - size:, :size], "bottom-right": card[h - size:, w - size:]}
    tiles = [label(cv2.resize(c, None, fx=zoom, fy=zoom, interpolation=cv2.INTER_CUBIC), n) for n, c in crops.items()]
    return np.vstack([np.hstack(tiles[:2]), np.hstack(tiles[2:])])


def edges_image(card: np.ndarray, depth: int = 44, zoom: int = 2) -> np.ndarray:
    h, w = card.shape[:2]
    strips = {"top edge": card[:depth, :], "bottom edge": card[h - depth:, :],
              "left edge (rotated)": np.rot90(card[:, :depth]), "right edge (rotated)": np.rot90(card[:, w - depth:])}
    rows = []
    for n, s in strips.items():
        s = np.ascontiguousarray(s)
        s = cv2.resize(s, (s.shape[1] * zoom // 1, s.shape[0] * zoom), interpolation=cv2.INTER_CUBIC)
        canvas = np.zeros((s.shape[0], max(x.shape[1] for x in strips.values()) * zoom, 3), np.uint8)
        canvas[:, : s.shape[1]] = s
        rows.append(label(canvas, n))
    return np.vstack(rows)


def overlay_image(warped: np.ndarray, r: dict) -> np.ndarray:
    out = warped.copy()
    for kind, col in (("outer", (255, 200, 0)), ("inner", (180, 40, 220))):
        L = r["scan"]["lines"][kind]
        for x in (L["left"], L["right"]):
            cv2.line(out, (int(x), 0), (int(x), out.shape[0]), col, 1)
        for y in (L["top"], L["bottom"]):
            cv2.line(out, (0, int(y)), (out.shape[1], int(y)), col, 1)
    for o in r["quality"]["overlays"] + r["check"]["overlays"]:
        if o["type"] != "rect":
            continue
        x, y, w, h = (int(round(o[k])) for k in ("x", "y", "w", "h"))
        col = (0, 215, 255) if o["kind"] == "glare" else (170, 170, 170) if o["kind"] == "unassessable" else (
            (0, 0, 255) if o.get("likely") else (200, 200, 200))
        cv2.rectangle(out, (x - 3, y - 3), (x + w + 3, y + h + 3), col, 1)
    return out


def measured_axes(scan: dict) -> dict:
    """Centering from the scan lines, with the app's rule: an axis whose borders weren't read is unread."""
    lines, per = scan["lines"], scan["confidence"]["per_side"]
    share = lambda a, b: 50.0 if a + b <= 0 else max(a, b) / (a + b) * 100
    res = {}
    for axis, (s1, s2) in {"lr": ("left", "right"), "tb": ("top", "bottom")}.items():
        ok = per[s1] >= 0.3 and per[s2] >= 0.3
        if s1 == "left":
            a, b = lines["inner"]["left"] - lines["outer"]["left"], lines["outer"]["right"] - lines["inner"]["right"]
        else:
            a, b = lines["inner"]["top"] - lines["outer"]["top"], lines["outer"]["bottom"] - lines["inner"]["bottom"]
        res[axis] = (round(share(max(0, a), max(0, b)), 2) if ok else 50.0, "measured" if ok else "unread")
    return res


def cmd_scan(args) -> None:
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    images = {"front": load(args.front), "back": load(args.back)}
    results = run_vision(images, out)
    summary = {"sides": {}}
    for r in results:
        side, sc = r["side"], r["scan"]
        warped = read_warped(out / f"{side}.rgba", sc["width"], sc["height"])
        (out / f"{side}.rgba").unlink()
        Path(str(out / f"{side}.rgba") + ".warped").unlink()
        m = sc["margin"]
        card = warped[m : sc["height"] - m, m : sc["width"] - m]
        cv2.imwrite(str(out / f"{side}_card.jpg"), card, [cv2.IMWRITE_JPEG_QUALITY, 92])
        cv2.imwrite(str(out / f"{side}_corners.jpg"), corners_image(card), [cv2.IMWRITE_JPEG_QUALITY, 92])
        cv2.imwrite(str(out / f"{side}_edges.jpg"), edges_image(card), [cv2.IMWRITE_JPEG_QUALITY, 92])
        cv2.imwrite(str(out / f"{side}_overlay.jpg"), overlay_image(warped, r), [cv2.IMWRITE_JPEG_QUALITY, 92])
        axes = measured_axes(sc)
        blocked = r["quality"]["blocked"]
        limits = photo_limit_components(blocked)
        summary["sides"][side] = {"centering": {a: v[0] for a, v in axes.items()}, "evidence": {a: v[1] for a, v in axes.items()},
                                  "quality": r["quality"]["verdict"], "blocked": blocked,
                                  "blocked_reasons": r["quality"]["blocked_reasons"],
                                  # what `grade` treats as unassessed on this side, whatever is ticked as inspected
                                  "photo_limits": limits}
        print(f"=== {side.upper()} ===")
        print(f"centering  left/right {axes['lr'][0]:.1f} ({axes['lr'][1]})   top/bottom {axes['tb'][0]:.1f} ({axes['tb'][1]})")
        print(f"photo quality: {r['quality']['verdict']}")
        for name, c in r["quality"]["checks"].items():
            if c["status"] != "ok":
                print(f"  - [{c['status']}] {c['note']}")
        if blocked:
            print(f"  cannot be assessed from this photo: {', '.join(blocked)}")
        if limits:
            print(f"  -> {side} {', '.join(limits)} will count as NOT ASSESSED in `grade`, even if listed as inspected,"
                  " unless checked on the card in hand (inspected_in_hand)")
        print(f"edge/corner check: {r['check']['summary']}")
        for d in r["check"]["defects"]:
            print(f"  candidate: {d['type']} {d['severity']} at {d['location']}: {d['note']}")
        print("limits: " + " | ".join(r["check"]["limitations"]))
        print(f"images: {side}_card.jpg  {side}_corners.jpg (3x)  {side}_edges.jpg (2x)  {side}_overlay.jpg\n")
    (out / "scan.json").write_text(json.dumps(summary, indent=1))


SIDES = ("front", "back")
COMPONENTS = ("corners", "edges", "surface")


def side_limits(side_scan: dict) -> list[str]:
    """Components the photo of one side can't show. Older scan.json files only have "blocked"."""
    if "photo_limits" in side_scan:
        return photo_limit_components(side_scan["photo_limits"])
    return photo_limit_components(side_scan.get("blocked", []))


def limit_reasons(side_scan: dict, comp: str) -> list[str]:
    """Why the photo can't show a component: the photo checks that blocked any of its items."""
    out: list[str] = []
    for item, why in (side_scan.get("blocked_reasons") or {}).items():
        if item == comp or item.startswith(comp + ":"):
            out += [w for w in why if w not in out]
    return out


def check_defects(defects: list) -> None:
    """Exit with a clear message if a defect has an unknown type or a location its type doesn't allow."""
    types = criteria_loader.defects()["types"]
    for i, d in enumerate(defects, 1):
        if not isinstance(d, dict):
            sys.exit(f"defect #{i} must be an object, got {d!r}")
        if d.get("type") not in types:
            sys.exit(f"defect #{i}: unknown defect type {d.get('type')!r}; use one of: {', '.join(types)}")
        try:
            Defect.model_validate(d)
        except ValueError as exc:
            spec = types[d["type"]]
            detail = "; ".join(e["msg"].removeprefix("Value error, ") for e in exc.errors()) if hasattr(exc, "errors") else str(exc)
            sys.exit(
                f"defect #{i} ({d.get('type')} at {d.get('location')!r} on the {d.get('side')}): {detail}.\n"
                f"  {d['type']} ({spec['label']}) applies to {', '.join(spec['applies_to'])}; "
                f"allowed locations: {', '.join(allowed_locations(spec['applies_to']))}"
            )


def why_unassessed(area: str, assessment: CardAssessment, scan: dict) -> str:
    """One line on why an area in `report.unassessed` wasn't assessed."""
    words = area.split(" ")
    side = words[0]
    if words[1] == "centering":
        return "the border wasn't read on the photo (measure it by hand to fill this in)"
    comp = words[1]
    if assessment.is_photo_limited(side, comp):  # type: ignore[arg-type]
        reasons = limit_reasons(scan[side], comp)
        why = f"the photo can't show {'it' if comp == 'surface' else 'them'}" + (f" ({', '.join(reasons)})" if reasons else "")
        if assessment.is_inspected(side, comp):  # type: ignore[arg-type]
            why += "; listed as inspected, but the photo check wins"
        return why + " -> check the card in hand (inspected_in_hand)"
    return "not listed as inspected"


def cmd_grade(args) -> None:
    scan = json.loads(Path(args.scan).read_text())["sides"]
    obs = json.loads(Path(args.obs).read_text())
    check_defects(obs.get("defects", []))
    limits = {s: side_limits(scan[s]) for s in SIDES}
    try:
        assessment = CardAssessment.model_validate({
            "centering": {s: {"lr": scan[s]["centering"]["lr"], "tb": scan[s]["centering"]["tb"]} for s in SIDES},
            "centering_evidence": {s: scan[s]["evidence"] for s in SIDES},
            "defects": obs.get("defects", []),
            "inspected": obs.get("inspected", {}),
            "inspected_in_hand": obs.get("inspected_in_hand", {}),
            "photo_limits": limits,
        })
    except ValueError as exc:
        sys.exit(f"invalid observations: {exc}")
    report = grade_all(assessment)

    print("Photo limits from the scan (areas the photo can't show):")
    for s in SIDES:
        if not limits[s]:
            print(f"  {s}: none")
            continue
        parts = []
        for comp in limits[s]:
            reasons = limit_reasons(scan[s], comp)
            in_hand = " -> checked in hand" if comp in assessment.inspected_in_hand.get(s, []) else ""
            parts.append(comp + (f" ({', '.join(reasons)})" if reasons else "") + in_hand)
        print(f"  {s}: {'; '.join(parts)}")
    print()
    if report.complete:
        print("COMPLETE — every area was assessed")
    else:
        print("INCOMPLETE — best case only, not a grade")
        print("Not assessed:")
        for area in report.unassessed:
            name = area.split(" (photo")[0]
            print(f"  - {name}: {why_unassessed(name, assessment, scan)}")
        print("The numbers below are ceilings: what the card would get if every unassessed area were perfect.")
    print()
    for name, g in report.grades.items():
        value = f"{'at most ' if not g.complete else ''}{g.grade:g}"
        if g.score is not None:
            value += f", score {'at most ' if not g.complete else ''}{g.score}"
        print(f"{name}: {g.label}  [{value}]")
    print()
    print(report.summary)
    if args.json:
        psa = report.grades["PSA"]
        photo_limited = [f"{s} {c}" for s in SIDES for c in COMPONENTS if assessment.is_photo_limited(s, c)]  # type: ignore[arg-type]
        Path(args.json).write_text(json.dumps({
            # psa_grade is the number shown; when complete is false it is a ceiling (best case), not a grade.
            "psa_grade": psa.grade, "psa_label": psa.label, "complete": report.complete,
            "psa_grade_is_ceiling": not report.complete,
            "unassessed": report.unassessed,
            "photo_limited": photo_limited,
            "inspected_in_hand": {s: assessment.inspected_in_hand.get(s, []) for s in SIDES},
            "grades": {n: {"grade": g.grade, "label": g.label, "complete": g.complete, "unassessed": g.unassessed}
                       for n, g in report.grades.items()},
        }, indent=1))


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("scan")
    s.add_argument("front"); s.add_argument("back"); s.add_argument("--out", required=True)
    s.set_defaults(fn=cmd_scan)
    g = sub.add_parser("grade")
    g.add_argument("scan"); g.add_argument("obs"); g.add_argument("--json")
    g.set_defaults(fn=cmd_grade)
    v = sub.add_parser("vocab", help="list defect types")
    v.set_defaults(fn=lambda a: [print(f"{k}: {t['label']} (areas: {', '.join(t['applies_to'] if 'applies_to' in t else t.get('locations', []))})") for k, t in criteria_loader.defects()["types"].items()])
    args = p.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
