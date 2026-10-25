from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

OUT = Path("BRS/figures")
OUT.mkdir(parents=True, exist_ok=True)

BG = "#f7f9fa"
DARK = "#102a33"
MID = "#5f747c"
GRID = "#d7e2e7"
TEAL = "#176f73"
ORANGE = "#c35d3f"
GREY = "#8a989f"


def font(size, bold=False):
    names = ["arialbd.ttf", "arial.ttf"] if bold else ["arial.ttf", "segoeui.ttf"]
    for name in names:
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            pass
    return ImageFont.load_default()


F_AXIS = font(32)
F_LABEL = font(34, True)
F_VALUE = font(31)
F_SMALL = font(27)
F_TINY = font(24)


def text_center(draw, xy, text, fnt, fill=DARK):
    box = draw.textbbox((0, 0), text, font=fnt)
    draw.text((xy[0] - (box[2] - box[0]) / 2, xy[1] - (box[3] - box[1]) / 2), text, font=fnt, fill=fill)


def fmt_pct(v):
    return f"{v:.1f}%"


def paired_panel(path, left_title, right_title, left_vals, right_vals, left_range, right_range, left_unit="", right_unit="%"):
    img = Image.new("RGB", (1500, 620), BG)
    draw = ImageDraw.Draw(img)
    charts = [
        (90, 80, 600, 390, left_title, left_vals, left_range, left_unit),
        (810, 80, 600, 390, right_title, right_vals, right_range, right_unit),
    ]
    for x0, y0, w, h, title, vals, yrange, unit in charts:
        ymin, ymax = yrange
        draw.text((x0, y0 - 52), title, font=F_LABEL, fill=DARK)
        for step in range(4):
            val = ymin + step * (ymax - ymin) / 3
            yy = y0 + h - (val - ymin) / (ymax - ymin) * h
            draw.line((x0, yy, x0 + w, yy), fill=GRID, width=2)
            label = fmt_pct(val) if unit == "%" else f"{val:.0f}"
            draw.text((x0 - 70, yy - 16), label, font=F_TINY, fill=MID)
        draw.line((x0, y0 + h, x0 + w, y0 + h), fill="#6e7f86", width=3)
        tx, wx = x0 + 180, x0 + 420
        for temi, walker in vals:
            ty = y0 + h - (temi - ymin) / (ymax - ymin) * h
            wy = y0 + h - (walker - ymin) / (ymax - ymin) * h
            draw.line((tx, ty, wx, wy), fill="#aebbc0", width=3)
            draw.ellipse((tx - 8, ty - 8, tx + 8, ty + 8), fill=TEAL)
            draw.ellipse((wx - 8, wy - 8, wx + 8, wy + 8), fill=ORANGE)
        temi_mean = sum(v[0] for v in vals) / len(vals)
        walker_mean = sum(v[1] for v in vals) / len(vals)
        draw.text((tx - 82, y0 + h + 28), "Temi", font=F_SMALL, fill=DARK)
        draw.text((wx - 92, y0 + h + 28), "Walker", font=F_SMALL, fill=DARK)
        mean1 = fmt_pct(temi_mean) if unit == "%" else f"{temi_mean:.1f}"
        mean2 = fmt_pct(walker_mean) if unit == "%" else f"{walker_mean:.1f}"
        text_center(draw, (tx, y0 + h + 86), mean1, F_VALUE, TEAL)
        text_center(draw, (wx, y0 + h + 86), mean2, F_VALUE, ORANGE)
    img.save(OUT / path, dpi=(300, 300))


def responsiveness():
    img = Image.new("RGB", (1500, 620), BG)
    draw = ImageDraw.Draw(img)
    labels = ["Question API", "Speech onset", "Transition"]
    temi = [1.99, 1.37, 8.5]
    walker = [2.54, 1.89, 9.0]
    x0, y0, w = 430, 105, 840
    row_h = 128
    maxv = 10.0
    for tick in [0, 2.5, 5, 7.5, 10]:
        xx = x0 + tick / maxv * w
        draw.line((xx, 75, xx, 455), fill=GRID, width=2)
        text_center(draw, (xx, 505), f"{tick:g}s", F_TINY, MID)
    for i, label in enumerate(labels):
        y = y0 + i * row_h
        draw.text((95, y + 13), label, font=F_LABEL, fill=DARK)
        tw = temi[i] / maxv * w
        ww = walker[i] / maxv * w
        draw.rounded_rectangle((x0, y, x0 + tw, y + 34), radius=7, fill=TEAL)
        draw.rounded_rectangle((x0, y + 47, x0 + ww, y + 81), radius=7, fill=ORANGE)
        draw.text((x0 + tw + 12, y + 2), f"{temi[i]:.1f}s", font=F_VALUE, fill=DARK)
        draw.text((x0 + ww + 12, y + 49), f"{walker[i]:.1f}s", font=F_VALUE, fill=DARK)
    draw.rectangle((930, 30, 956, 56), fill=TEAL)
    draw.text((972, 27), "Temi", font=F_SMALL, fill=DARK)
    draw.rectangle((1100, 30, 1126, 56), fill=ORANGE)
    draw.text((1142, 27), "Walker", font=F_SMALL, fill=DARK)
    draw.text((95, 565), "No-speech timeout: Temi 0.0%, Walker 7.5%", font=F_VALUE, fill=DARK)
    img.save(OUT / "figure-3-system-responsiveness.png", dpi=(300, 300))


def questionnaire():
    img = Image.new("RGB", (1500, 620), BG)
    draw = ImageDraw.Draw(img)
    rows = [
        ("SUS usability", 83.0, 100, "83.0/100", TEAL),
        ("NASA-TLX workload", 3.53, 7, "3.53/7", ORANGE),
        ("SASSI overall", 3.15, 5, "3.15/5", TEAL),
        ("SASSI likeability", 4.30, 5, "4.30/5", TEAL),
        ("SASSI speed", 3.05, 5, "3.05/5", TEAL),
    ]
    x0, y0, w = 455, 65, 565
    for i, (label, value, maxv, shown, color) in enumerate(rows):
        y = y0 + i * 88
        draw.text((90, y - 2), label, font=F_LABEL, fill=DARK)
        draw.rounded_rectangle((x0, y, x0 + w, y + 34), radius=7, fill="#d8e3e6")
        draw.rounded_rectangle((x0, y, x0 + value / maxv * w, y + 34), radius=7, fill=color)
        draw.text((x0 + w + 30, y - 2), shown, font=F_VALUE, fill=DARK)
    px, py, pw = 455, 535, 620
    draw.text((90, py - 5), "Preference", font=F_LABEL, fill=DARK)
    segments = [(6, TEAL, "Temi 6"), (1, ORANGE, "Walker 1"), (3, GREY, "Both 3")]
    cur = px
    for count, color, text in segments:
        sw = pw * count / 10
        draw.rounded_rectangle((cur, py, cur + sw, py + 36), radius=6, fill=color)
        text_center(draw, (cur + sw / 2, py + 18), str(count), F_SMALL, "#ffffff")
        draw.rectangle((cur, py, cur + 6, py + 36), fill=color)
        cur += sw
    lx = 1220
    for i, (_, color, text) in enumerate(segments):
        draw.rectangle((lx, 130 + i * 72, lx + 30, 160 + i * 72), fill=color)
        draw.text((lx + 48, 121 + i * 72), text, font=F_VALUE, fill=DARK)
    img.save(OUT / "figure-4-questionnaire-outcomes.png", dpi=(300, 300))


def round_box(draw, xy, label, fill, outline=None, text_fill="#ffffff", width=0):
    draw.rounded_rectangle(xy, radius=20, fill=fill, outline=outline or fill, width=width)
    x1, y1, x2, y2 = xy
    text_center(draw, ((x1 + x2) / 2, (y1 + y2) / 2), label, F_LABEL, text_fill)


def arrow(draw, start, end, color="#60757d"):
    draw.line((start[0], start[1], end[0], end[1]), fill=color, width=5)
    ex, ey = end
    sx, sy = start
    if abs(ex - sx) > abs(ey - sy):
        sign = 1 if ex > sx else -1
        pts = [(ex, ey), (ex - sign * 20, ey - 12), (ex - sign * 20, ey + 12)]
    else:
        sign = 1 if ey > sy else -1
        pts = [(ex, ey), (ex - 12, ey - sign * 20), (ex + 12, ey - sign * 20)]
    draw.polygon(pts, fill=color)


def system_architecture():
    img = Image.new("RGB", (1800, 760), BG)
    draw = ImageDraw.Draw(img)
    round_box(draw, (70, 285, 300, 425), "User", "#ffffff", "#b9c9ce", DARK, 4)
    round_box(draw, (390, 100, 760, 240), "Angular UI", "#176f73")
    round_box(draw, (390, 310, 760, 450), "Socket.io", "#e9f4f2", "#176f73", DARK, 4)
    round_box(draw, (390, 520, 760, 660), "Camera + Audio", "#e9f4f2", "#176f73", DARK, 4)
    round_box(draw, (875, 90, 1245, 230), "Node Backend", "#12343b")
    round_box(draw, (875, 300, 1245, 440), "LLM Services", "#ffffff", "#b9c9ce", DARK, 4)
    round_box(draw, (875, 510, 1245, 650), "Structured Logs", "#ffffff", "#b9c9ce", DARK, 4)
    round_box(draw, (1370, 175, 1690, 315), "Temi Driver", "#c35d3f")
    round_box(draw, (1370, 445, 1690, 585), "Walker Driver", "#d6a84b")
    for start, end in [
        ((300, 355), (390, 355)),
        ((760, 170), (875, 160)),
        ((760, 380), (875, 160)),
        ((760, 590), (875, 580)),
        ((1060, 230), (1060, 300)),
        ((1245, 160), (1370, 245)),
        ((1245, 580), (1370, 515)),
    ]:
        arrow(draw, start, end)
    draw.text((420, 260), "registration, upload, dialogue", font=F_TINY, fill=MID)
    draw.text((905, 255), "image, questions, TTS, STT", font=F_TINY, fill=MID)
    draw.text((1380, 340), "speech and sensing", font=F_TINY, fill=MID)
    draw.text((1380, 610), "ROSBridge adapter", font=F_TINY, fill=MID)
    img.save(OUT / "system-architecture.png", dpi=(300, 300))


def experimental_method():
    img = Image.new("RGB", (1800, 760), BG)
    draw = ImageDraw.Draw(img)
    y = 295
    boxes = [
        (70, "Register"),
        (330, "Calibrate"),
        (590, "Upload"),
        (850, "Photo 1"),
        (1110, "Photo 2"),
        (1370, "Survey"),
    ]
    for x, label in boxes:
        round_box(draw, (x, y, x + 205, y + 130), label, "#ffffff", "#b9c9ce", DARK, 4)
    for (x, _), (nx, _) in zip(boxes, boxes[1:]):
        arrow(draw, (x + 205, y + 65), (nx, y + 65))
    round_box(draw, (730, 95, 1010, 205), "Temi first", "#176f73")
    round_box(draw, (1060, 95, 1340, 205), "Walker first", "#c35d3f")
    arrow(draw, (870, 205), (920, y))
    arrow(draw, (1200, 205), (970, y))
    draw.text((690, 485), "Counterbalanced robot order", font=F_LABEL, fill=DARK)
    draw.text((676, 535), "same users, photos, and protocol", font=F_SMALL, fill=MID)
    round_box(draw, (380, 600, 685, 700), "Objective Logs", "#e9f4f2", "#176f73", DARK, 4)
    round_box(draw, (745, 600, 1050, 700), "Audio + Attention", "#e9f4f2", "#176f73", DARK, 4)
    round_box(draw, (1110, 600, 1415, 700), "Paired Analysis", "#e9f4f2", "#176f73", DARK, 4)
    img.save(OUT / "experimental-method.png", dpi=(300, 300))


def main():
    score_pairs = [(89.4, 82.9), (90.0, 83.4), (89.6, 86.5), (92.9, 88.1), (91.8, 87.5), (89.5, 86.3), (93.3, 87.3), (92.3, 87.6), (89.7, 85.5), (90.3, 85.7)]
    valid_pairs = [(100, 100), (100, 100), (100, 75), (100, 100), (100, 100), (100, 100), (100, 75), (100, 100), (100, 100), (100, 75)]
    attention_pairs = [(87, 77), (88, 80), (88, 81), (89, 85), (91, 85), (92, 86), (93, 88), (94, 90), (97, 90), (99, 90)]
    gaze_pairs = [(87, 78), (88, 81), (91, 82), (93, 83), (94, 84), (94, 86), (95, 89), (95, 91), (96, 92), (96, 93)]
    system_architecture()
    experimental_method()
    paired_panel("figure-1-task-effectiveness.png", "Overall score", "Valid answers", score_pairs, valid_pairs, (80, 96), (70, 100), "", "%")
    paired_panel("figure-2-engagement-attention.png", "Attention rate", "Central gaze", attention_pairs, gaze_pairs, (70, 100), (70, 100), "%", "%")
    responsiveness()
    questionnaire()
    for stem in [
        "figure-1-task-effectiveness",
        "figure-2-engagement-attention",
        "figure-4-questionnaire-outcomes",
    ]:
        Image.open(OUT / f"{stem}.png").convert("RGB").save(OUT / f"{stem}.pdf", resolution=300.0)


if __name__ == "__main__":
    main()
