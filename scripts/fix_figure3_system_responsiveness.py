from __future__ import annotations

import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
SUMMARY = ROOT / "outputs" / "combined-robot-analysis" / "combined-summary.json"
OUT = ROOT / "BRS" / "figures" / "figure-3-system-responsiveness.png"


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    candidates = [
        "C:/Windows/Fonts/arialbd.ttf" if bold else "C:/Windows/Fonts/arial.ttf",
        "C:/Windows/Fonts/calibrib.ttf" if bold else "C:/Windows/Fonts/calibri.ttf",
    ]
    for path in candidates:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


F_TITLE = font(34, True)
F_SUB = font(20)
F_LABEL = font(18)
F_SMALL = font(16)
F_TINY = font(14)

BG = "#fbfcfd"
INK = "#182a33"
MUTED = "#62747e"
GRID = "#d7e2e7"
TEMI = "#176b72"
WALKER = "#c15b3e"


def draw_text(draw: ImageDraw.ImageDraw, xy: tuple[int, int], value: str, fnt, fill=INK, anchor="la") -> None:
    draw.text(xy, value, font=fnt, fill=fill, anchor=anchor)


def stat(summary: dict, key: str) -> dict:
    for row in summary["objective_stats"]:
        if row["metric"] == key:
            return row
    raise KeyError(key)


def main() -> None:
    summary = json.loads(SUMMARY.read_text(encoding="utf-8"))
    rows = [
        ("Question API latency", stat(summary, "average_question_generation_latency_ms")),
        ("TTS start latency", stat(summary, "average_tts_start_latency_ms")),
        ("Transition time", stat(summary, "average_next_question_transition_ms")),
    ]
    timeout = stat(summary, "no_speech_timeout_rate")

    img = Image.new("RGB", (1400, 900), BG)
    draw = ImageDraw.Draw(img)
    draw_text(draw, (70, 70), "System Responsiveness", F_TITLE)
    draw_text(draw, (70, 110), "Latency measures from backend logs and robot speech-control events.", F_SUB, MUTED)

    draw.rectangle((1015, 54, 1035, 74), fill=TEMI)
    draw_text(draw, (1052, 71), "Temi", F_SMALL)
    draw.rectangle((1140, 54, 1160, 74), fill=WALKER)
    draw_text(draw, (1177, 71), "Walker", F_SMALL)
    draw_text(draw, (700, 158), "Latency in seconds; lower is better", F_LABEL, MUTED, "ma")

    x0, y0, width = 395, 235, 700
    max_ms = 10000
    for tick in range(0, 10001, 2500):
        x = x0 + tick / max_ms * width
        draw.line((x, 190, x, 620), fill=GRID, width=2)
        draw_text(draw, (int(x), 665), f"{tick / 1000:.1f}s", F_TINY, MUTED, "ma")

    for i, (label, row) in enumerate(rows):
        y = y0 + i * 126
        temi_w = row["temi_mean"] / max_ms * width
        walker_w = row["walker_mean"] / max_ms * width
        draw_text(draw, (360, y + 18), label, F_LABEL, INK, "ra")
        draw.rounded_rectangle((x0, y, x0 + temi_w, y + 27), radius=5, fill=TEMI)
        draw.rounded_rectangle((x0, y + 41, x0 + walker_w, y + 68), radius=5, fill=WALKER)
        draw_text(draw, (int(x0 + temi_w + 12), y + 22), f"{row['temi_mean'] / 1000:.1f}s", F_SMALL)
        draw_text(draw, (int(x0 + walker_w + 12), y + 63), f"{row['walker_mean'] / 1000:.1f}s", F_SMALL)
        diff = row["mean_difference_temi_minus_walker"] / 1000
        ci_low = row["ci95_low"] / 1000
        ci_high = row["ci95_high"] / 1000
        draw_text(draw, (x0, y + 96), f"Temi-Walker: {diff:.1f}s; 95% CI {ci_low:.1f} to {ci_high:.1f}s", F_TINY, MUTED)

    draw.line((x0, 645, x0 + width, 645), fill=GRID, width=2)
    draw_text(draw, (x0, 706), f"No-speech timeout: Temi {timeout['temi_mean'] * 100:.1f}%, Walker {timeout['walker_mean'] * 100:.1f}%.", F_LABEL)
    draw_text(draw, (x0, 738), "Lower question latency and faster speech onset explain most responsiveness differences.", F_SMALL, MUTED)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    img.save(OUT, dpi=(300, 300))


if __name__ == "__main__":
    main()
