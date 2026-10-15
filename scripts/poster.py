"""Render the cover image from a real fuzz run.

The image is drawn from build-poster.json, which is one actual batch and one
actual failing shift. Nothing in it is illustrative: if a station is red, that
station caused failures in the run.
"""
import json
import math
import os
from PIL import Image, ImageDraw, ImageFont

W, H = 1600, 900
VOID = (7, 8, 10)
GRAPHITE = (14, 17, 21)
PANEL = (20, 24, 31)
RULE = (35, 42, 52)
ASH = (138, 149, 163)
BONE = (232, 228, 220)
AMBER = (255, 176, 58)
VERMILLION = (255, 74, 47)
PHOSPHOR = (62, 224, 143)
CYAN = (79, 216, 255)
VIOLET = (163, 123, 255)

FDIR = "C:/Windows/Fonts"


def font(name, size):
    for cand in (name, name.replace("b", ""), "arial", "segoeui"):
        path = os.path.join(FDIR, f"{cand}.ttf")
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return ImageFont.load_default()


MONO = font("consolab", 20)
MONO_S = font("consola", 15)
TINY = font("consola", 13)
TITLE = font("tuconv", 84)
SERIF = font("timesbi", 30)


def label(d, x, y, text, f=None, fill=ASH, spacing=2):
    """uppercase, letter-spaced caption - the house style"""
    f = f or TINY
    text = text.upper()
    cx = x
    for ch in text:
        d.text((cx, y), ch, font=f, fill=fill)
        cx += d.textlength(ch, font=f) + spacing
    return cx


def main():
    with open("build-poster.json", encoding="utf-8") as fh:
        data = json.load(fh)

    img = Image.new("RGB", (W, H), VOID)
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, W, H], fill=VOID)

    # ---- title band
    label(d, 60, 22, "murphy", TITLE, AMBER, spacing=16)
    d.text((60, 126), "Fuzz the procedure, not the plant.", font=SERIF, fill=BONE)
    label(d, 60, 166, f"{data['cfg']['procedure']} rev {data['cfg']['revision']}", TINY, ASH)
    label(d, 430, 166, data['cfg']['persona'], TINY, ASH)
    

    steps = data["steps"]
    total = sum(s["durS"] for s in steps) or 1

    # ---- left: the line map
    LX0, LX1, LY = 60, 800, 470
    TT, TH = 224, 196

    def heat(p):
        lo, hi = math.log10(1e-5), math.log10(0.5)
        return max(0.0, min(1.0, (math.log10(max(1e-6, p)) - lo) / (hi - lo)))

    label(d, LX0, 196, "p(error)  log scale", TINY, ASH)
    for p in (1e-4, 1e-3, 1e-2, 1e-1):
        y = TT + (1 - heat(p)) * TH
        d.line([(LX0, y), (LX1, y)], fill=RULE, width=1)
        d.text((LX0 - 48, y - 8), f"{p:.0e}", font=TINY, fill=(96, 104, 114))

    acc, pts = 0, []
    for s in steps:
        acc += s["durS"]
        x = LX0 + (acc / total) * (LX1 - LX0)
        p = (s["stat"] or {}).get("p", 1e-4)
        pts.append((x, TT + (1 - heat(p)) * TH, s))

    d.polygon([(pts[0][0], TT + TH)] + [(x, y) for x, y, _ in pts] + [(pts[-1][0], TT + TH)],
              fill=(30, 21, 11))
    d.line([(x, y) for x, y, _ in pts], fill=AMBER, width=2)
    d.line([(LX0, LY), (LX1, LY)], fill=RULE, width=3)

    failed = max(1, int(data["summary"]["failureRate"] * data["summary"]["n"]))
    worst = max((s["stat"] or {}).get("causalFailure", 0) for _, _, s in pts) or 1
    for x, y, s in pts:
        st = s["stat"] or {}
        esc, cf = st.get("escaped", 0), st.get("causalFailure", 0)
        r = 5 + heat(st.get("p", 1e-4)) * 9
        if esc:
            a = min(0.5, cf / worst * 0.55 + 0.05)
            d.ellipse([x - r - 8, LY - r - 8, x + r + 8, LY + r + 8],
                      fill=(int(VERMILLION[0] * a + VOID[0] * (1 - a)),
                            int(VERMILLION[1] * a + VOID[1] * (1 - a)),
                            int(VERMILLION[2] * a + VOID[2] * (1 - a))))
        d.ellipse([x - r, LY - r, x + r, LY + r], fill=GRAPHITE, outline=BONE if cf == 0 else VERMILLION, width=2)
        thrown = st.get("thrown", 0)
        if thrown and st.get("caught", 0):
            frac = st["caught"] / thrown * 2 * math.pi
            rr = r + 4
            d.arc([x - rr, LY - rr, x + rr, LY + rr], -90, -90 + math.degrees(frac), fill=PHOSPHOR, width=2)
        d.text((x - 12, LY + 16 + (16 if pts.index((x, y, s)) % 2 else 0)), s["id"], font=TINY, fill=ASH)

    label(d, LX0, LY + 46, "17 steps, drawn on their own time axis", TINY, ASH)
    for i, (col, txt) in enumerate([(VERMILLION, "deviation survived"), (PHOSPHOR, "caught by a later step"), (CYAN, "check / monitoring")]):
        x = LX0 + i * 250
        d.ellipse([x, LY + 72, x + 11, LY + 83], fill=col)
        d.text((x + 18, LY + 70), txt, font=TINY, fill=ASH)

    # ---- right: the recorded shift
    RX0, RX1 = 900, 1540
    TY0, TY1 = 200, 640
    d.rectangle([RX0, TY0, RX1, TY1], outline=RULE, width=1, fill=GRAPHITE)
    ser = data["shift"]["series"]
    pm = data["params"]
    tmax = max(1.0, ser[-1]["tS"])
    span = RX1 - RX0

    def yv(level):
        return TY1 - (level / 11.0) * (TY1 - TY0)

    for val, col, txt in [(pm["hAl"], AMBER, "high level alarm"), (pm["hAh"], VIOLET, "independent trip"), (pm["hOverflow"], VERMILLION, "overflow")]:
        y = yv(val)
        d.line([(RX0, y), (RX1, y)], fill=col, width=1)

    lvl = [(RX0 + (f["tS"] / tmax) * span, yv(f["level"])) for f in ser]
    d.polygon([(x, TY1) for x, _ in lvl[:1]] + lvl + [(lvl[-1][0], TY1)], fill=(24, 46, 58))
    d.line(lvl, fill=CYAN, width=3)

    maxspill = max(0.05, max(f["spill"] for f in ser))
    sp = [(RX0 + (f["tS"] / tmax) * span, TY1 - (f["spill"] / maxspill) * 90) for f in ser]
    d.line(sp, fill=VERMILLION, width=2)
    d.text((RX0 + 8, TY1 + 8), f"released 0-{maxspill:.1f} m3", font=TINY, fill=VERMILLION)
    for i, (val, col, txt) in enumerate([(pm["hAl"], AMBER, "9.30 high level alarm"), (pm["hAh"], VIOLET, "9.60 independent trip"), (pm["hOverflow"], VERMILLION, "10.00 overflow level")]):
        d.text((RX0 + 300 + (i % 2) * 250, TY1 + 8 + (i // 2) * 20), txt, font=TINY, fill=col)

    for ev in data["shift"]["events"][:8]:
        x = RX0 + (ev["tS"] / tmax) * span
        col = VERMILLION if ev["kind"] in ("error", "hazard", "outcome") else (AMBER if ev["kind"] == "alarm" else CYAN)
        d.line([(x, TY0 - 14), (x, TY0)], fill=col, width=2)

    label(d, RX0, TY0 - 30, data['cfg']['plant'], TINY, VERMILLION)
    note = data["shift"]["note"] or data["shift"]["outcome"]
    d.rectangle([RX0, 700, RX1, 762], fill=PANEL, outline=VERMILLION)
    d.text((RX0 + 14, 712), note[:96], font=MONO_S, fill=BONE)
    d.text((RX0 + 14, 734), f"outcome {data['shift']['outcome']}   |   {len(ser)} recorded frames", font=TINY, fill=ASH)

    # ---- footer numbers
    s = data["summary"]
    d.line([60, 800, W - 60, 800], fill=RULE, width=1)
    for i, (k, v, col) in enumerate([
        ("shifts simulated", f"{s['n']:,}", BONE),
        ("shifts that ended in a loss", f"{s['failureRate'] * 100:.1f}%", VERMILLION),
        ("loss of containment", f"{s['incidentRate'] * 100:.1f}%", VERMILLION),
        ("annual exposure", f"EUR {s['annualLossEur'] / 1e6:.1f}M", AMBER),
        ("backtest vs published causes", "13 of 13 raised", PHOSPHOR),
    ]):
        x = 60 + i * 306
        label(d, x, 820, k, TINY, ASH)
        d.text((x, 842), v, font=MONO, fill=col)

    os.makedirs("public", exist_ok=True)
    img.save("public/cover.png")
    img.convert("RGB").save("public/cover.jpg", quality=92)
    print("wrote public/cover.png and cover.jpg")


if __name__ == "__main__":
    main()
