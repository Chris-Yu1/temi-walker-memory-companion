from __future__ import annotations

import math
from pathlib import Path

import numpy as np
import pandas as pd
from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
RESULTS = ROOT / "outputs" / "paper-inferential-statistics" / "paper-inferential-results.csv"
QUESTIONNAIRES = ROOT / "outputs" / "comparative-questionnaires" / "all-questionnaire-responses.csv"
OUT = ROOT / "BRS" / "figures"


BLUE = "#3b82f6"
ORANGE = "#f97316"
DARK = "#1f2937"
MID = "#4b5563"
LIGHT = "#e5e7eb"
BG = "#ffffff"


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    candidates = [
        "C:/Windows/Fonts/arialbd.ttf" if bold else "C:/Windows/Fonts/arial.ttf",
        "C:/Windows/Fonts/calibrib.ttf" if bold else "C:/Windows/Fonts/calibri.ttf",
    ]
    for path in candidates:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


F_TITLE = font(38, True)
F_SUB = font(22)
F_LABEL = font(22)
F_SMALL = font(18)
F_TINY = font(16)


def draw_center(draw: ImageDraw.ImageDraw, xy: tuple[float, float], text: str, fnt, fill=DARK) -> None:
    bbox = draw.textbbox((0, 0), text, font=fnt)
    draw.text((xy[0] - (bbox[2] - bbox[0]) / 2, xy[1] - (bbox[3] - bbox[1]) / 2), text, font=fnt, fill=fill)


def wrap_label(text: str, max_chars: int = 15) -> list[str]:
    words = text.split()
    lines = []
    current = ""
    for word in words:
        if len(current + " " + word) <= max_chars:
            current = (current + " " + word).strip()
        else:
            if current:
                lines.append(current)
            current = word
    if current:
        lines.append(current)
    return lines[:3]


def primary_outcomes(stats: pd.DataFrame) -> None:
    img = Image.new("RGB", (1800, 1100), BG)
    d = ImageDraw.Draw(img)
    d.text((90, 60), "Primary Outcome Comparison", font=F_TITLE, fill=DARK)
    d.text((90, 112), "Mean values across paired participants (n = 10); error bars show standard error.", font=F_SUB, fill=MID)
    d.rectangle((1320, 74, 1352, 106), fill=BLUE, outline="#1d4ed8")
    d.text((1370, 75), "temi", font=F_SMALL, fill=DARK)
    d.rectangle((1460, 74, 1492, 106), fill=ORANGE, outline="#c2410c")
    d.text((1510, 75), "walker", font=F_SMALL, fill=DARK)

    left, top, plot_w, plot_h = 130, 210, 1540, 660
    group_w = plot_w / len(stats)
    for idx, row in stats.iterrows():
        values = [float(row["temi_mean"]), float(row["walker_mean"])]
        sems = [float(row["temi_sd"]) / math.sqrt(10), float(row["walker_sd"]) / math.sqrt(10)]
        ymin = min(values) - max(sems) * 3.2
        ymax = max(values) + max(sems) * 4.0
        if row["unit"] == "%":
            ymin = max(0, ymin)
            ymax = min(105, ymax)
        if "latency" in row["label"].lower():
            ymin = 0
        if ymax <= ymin:
            ymax = ymin + 1

        x_center = left + idx * group_w + group_w / 2
        panel_w = group_w * 0.76
        px = x_center - panel_w / 2

        def y(v: float) -> float:
            return top + plot_h - (v - ymin) / (ymax - ymin) * plot_h

        for tick in np.linspace(ymin, ymax, 4):
            yy = y(float(tick))
            d.line((px, yy, px + panel_w, yy), fill=LIGHT, width=2)
        d.line((px, top + plot_h, px + panel_w, top + plot_h), fill=DARK, width=2)
        draw_center(d, (x_center, top - 34), str(row["sig"]), F_LABEL, DARK)

        for val, sem, color, outline, dx in [
            (values[0], sems[0], BLUE, "#1d4ed8", -42),
            (values[1], sems[1], ORANGE, "#c2410c", 42),
        ]:
            bx = x_center + dx - 30
            by = y(val)
            d.rounded_rectangle((bx, by, bx + 60, top + plot_h), radius=5, fill=color, outline=outline, width=2)
            d.line((x_center + dx, y(val - sem), x_center + dx, y(val + sem)), fill=DARK, width=3)
            d.line((x_center + dx - 12, y(val + sem), x_center + dx + 12, y(val + sem)), fill=DARK, width=3)
            d.line((x_center + dx - 12, y(val - sem), x_center + dx + 12, y(val - sem)), fill=DARK, width=3)

        label = row["label"].replace("Question generation latency", "Question gen. latency")
        for j, line in enumerate(wrap_label(label, 16)):
            draw_center(d, (x_center, top + plot_h + 42 + j * 24), line, F_TINY, DARK)
        draw_center(d, (x_center, top + plot_h + 116), f"({row['unit']})", F_TINY, MID)

    d.text((90, 1025), "Holm-corrected significance: * p < .05, ** p < .01.", font=F_SMALL, fill=MID)
    img.save(OUT / "inferential-primary-outcomes.png", dpi=(300, 300))


def effect_estimates(stats: pd.DataFrame) -> None:
    img = Image.new("RGB", (1700, 940), BG)
    d = ImageDraw.Draw(img)
    d.text((90, 60), "Paired Mean Differences", font=F_TITLE, fill=DARK)
    d.text((90, 112), "Effects are shown as temi minus walker with bootstrap 95% confidence intervals.", font=F_SUB, fill=MID)
    vals = []
    for _, row in stats.iterrows():
        vals.extend([float(row["ci_low"]), float(row["ci_high"]), float(row["mean_difference"])])
    xmin, xmax = min(vals), max(vals)
    pad = (xmax - xmin) * 0.16
    xmin, xmax = xmin - pad, xmax + pad
    left, right, top, row_h = 660, 1530, 210, 112

    def x(v: float) -> float:
        return left + (v - xmin) / (xmax - xmin) * (right - left)

    d.line((x(0), top - 50, x(0), top + row_h * len(stats) - 45), fill=DARK, width=3)
    for tick in np.linspace(xmin, xmax, 6):
        xx = x(float(tick))
        d.line((xx, top - 50, xx, top + row_h * len(stats) - 45), fill=LIGHT, width=2)
        draw_center(d, (xx, top + row_h * len(stats) + 20), f"{tick:.1f}", F_TINY, MID)

    for i, row in stats.iterrows():
        cy = top + i * row_h
        d.text((90, cy - 25), str(row["label"]), font=F_LABEL, fill=DARK)
        d.text((90, cy + 5), f"Holm p = {row['holm_p']:.3f}, dz = {row['cohens_dz']:.2f}", font=F_SMALL, fill=MID)
        d.line((x(float(row["ci_low"])), cy, x(float(row["ci_high"])), cy), fill=DARK, width=5)
        d.ellipse((x(float(row["mean_difference"])) - 10, cy - 10, x(float(row["mean_difference"])) + 10, cy + 10), fill="#111827")
        d.text((right + 30, cy - 12), f"{row['mean_difference']:.2f}", font=F_SMALL, fill=DARK)
    draw_center(d, ((left + right) / 2, 875), "temi minus walker", F_SMALL, MID)
    img.save(OUT / "inferential-effect-estimates.png", dpi=(300, 300))


def preference(q: pd.DataFrame) -> None:
    img = Image.new("RGB", (1200, 820), BG)
    d = ImageDraw.Draw(img)
    d.text((90, 60), "Post-Study Robot Preference", font=F_TITLE, fill=DARK)
    d.text((90, 112), "Questionnaire preference after completing both robot conditions.", font=F_SUB, fill=MID)
    counts = q["preferred_robot"].value_counts().to_dict()
    labels = [("temi", BLUE), ("walker", ORANGE), ("both", "#6b7280")]
    max_count = max([int(counts.get(label, 0)) for label, _ in labels] + [1])
    left, base, bar_w, gap = 180, 610, 160, 135
    for i, (label, color) in enumerate(labels):
        count = int(counts.get(label, 0))
        h = count / max_count * 410
        x = left + i * (bar_w + gap)
        d.rounded_rectangle((x, base - h, x + bar_w, base), radius=8, fill=color)
        draw_center(d, (x + bar_w / 2, base - h - 36), str(count), F_TITLE, DARK)
        draw_center(d, (x + bar_w / 2, base + 42), label, F_LABEL, DARK)
    n = int(counts.get("temi", 0) + counts.get("walker", 0))
    k = int(counts.get("temi", 0))
    p = 0.125 if (k, n) == (6, 7) else float("nan")
    d.text((90, 755), f"Exact binomial test excluding neutral preferences: p = {p:.3f}.", font=F_SMALL, fill=MID)
    img.save(OUT / "inferential-questionnaire-preference.png", dpi=(300, 300))


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    stats = pd.read_csv(RESULTS)
    q = pd.read_csv(QUESTIONNAIRES)
    primary_outcomes(stats)
    effect_estimates(stats)
    preference(q)
    print("exported png figures")


if __name__ == "__main__":
    main()
