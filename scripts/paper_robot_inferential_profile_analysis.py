from __future__ import annotations

import csv
import json
import math
import random
from itertools import product
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
SESSION_ROOT = ROOT / "outputs" / "comparative-test-sessions"
SESSION_INDEX = SESSION_ROOT / "comparison-index.csv"
QUESTIONNAIRE_INDEX = ROOT / "outputs" / "comparative-questionnaires" / "all-questionnaire-responses.csv"
OUT = ROOT / "outputs" / "paper-robot-inferential-profile-analysis"
FIG = OUT / "figures"


PRIMARY_METRICS = [
    ("overall_interaction_score", "Overall score", "higher", "score", 1.0),
    ("attention_rate", "Attention", "higher", "%", 100.0),
    ("central_gaze_rate", "Central gaze", "higher", "%", 100.0),
    ("average_question_generation_latency_ms", "Question latency", "lower", "s", 0.001),
    ("average_tts_start_latency_ms", "Speech onset", "lower", "s", 0.001),
]


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
F_LABEL = font(19)
F_SMALL = font(16)
F_TINY = font(14)

BLUE = "#2563eb"
ORANGE = "#ea580c"
GREEN = "#059669"
PURPLE = "#7c3aed"
DARK = "#111827"
MID = "#4b5563"
LIGHT = "#e5e7eb"
BG = "#ffffff"


def fmt(value: float, digits: int = 2) -> str:
    return f"{value:.{digits}f}"


def exact_paired_permutation_p(diff: np.ndarray) -> float:
    diff = diff[np.isfinite(diff)]
    if len(diff) == 0:
        return 1.0
    observed = abs(float(np.mean(diff)))
    total = 0
    extreme = 0
    for signs in product([-1, 1], repeat=len(diff)):
        stat = abs(float(np.mean(diff * np.array(signs))))
        if stat >= observed - 1e-12:
            extreme += 1
        total += 1
    return extreme / total


def bootstrap_ci(diff: np.ndarray, seed: int = 20260826, n_iter: int = 10000) -> tuple[float, float]:
    values = [float(x) for x in diff if math.isfinite(float(x))]
    rng = random.Random(seed)
    means = []
    for _ in range(n_iter):
        sample = [values[rng.randrange(len(values))] for _ in values]
        means.append(sum(sample) / len(sample))
    means.sort()
    return means[int(0.025 * n_iter)], means[int(0.975 * n_iter) - 1]


def holm(p_values: list[float]) -> list[float]:
    ordered = sorted(enumerate(p_values), key=lambda item: item[1])
    adjusted = [0.0] * len(p_values)
    running = 0.0
    m = len(p_values)
    for rank, (idx, p) in enumerate(ordered):
        value = min(1.0, (m - rank) * p)
        running = max(running, value)
        adjusted[idx] = running
    return adjusted


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def collect_true_profiles() -> pd.DataFrame:
    rows = []
    seen = {}
    for metadata in sorted(SESSION_ROOT.glob("P*/01_user-and-session/session-metadata.json")):
        data = load_json(metadata)
        pid = str(data["participant_id"])
        profile = data["user_profile"]
        row = {
            "participant_id": pid,
            "participant_name": str(profile.get("name", pid)),
            "age": int(profile["age"]),
            "gender": str(profile["gender"]).strip().lower(),
        }
        if pid in seen and seen[pid] != row:
            raise ValueError(f"Conflicting user profile for {pid}: {seen[pid]} vs {row}")
        seen[pid] = row
    rows = [seen[pid] for pid in sorted(seen)]
    return pd.DataFrame(rows)


def load_paired_data() -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    sessions = pd.read_csv(SESSION_INDEX)
    questionnaires = pd.read_csv(QUESTIONNAIRE_INDEX)
    profiles = collect_true_profiles()

    rows = []
    for pid, group in sessions.groupby("participant_id"):
        if set(group["robot_family"]) >= {"temi", "walker"}:
            row = {"participant_id": pid}
            for column, _, _, _, scale in PRIMARY_METRICS:
                temi = float(group[group["robot_family"] == "temi"][column].iloc[0]) * scale
                walker = float(group[group["robot_family"] == "walker"][column].iloc[0]) * scale
                row[f"{column}_temi"] = temi
                row[f"{column}_walker"] = walker
                row[f"{column}_diff"] = temi - walker
            rows.append(row)
    paired = pd.DataFrame(rows).merge(profiles, on="participant_id", how="left")
    pref = questionnaires[["participant_id", "preferred_robot", "sus_score", "nasa_tlx_mean", "sassi_overall_mean"]]
    paired = paired.merge(pref, on="participant_id", how="left")
    return paired, sessions, questionnaires


def analyze_effects(paired: pd.DataFrame) -> pd.DataFrame:
    rows = []
    raw_p = []
    for column, label, direction, unit, _ in PRIMARY_METRICS:
        temi = paired[f"{column}_temi"].to_numpy(float)
        walker = paired[f"{column}_walker"].to_numpy(float)
        diff = paired[f"{column}_diff"].to_numpy(float)
        mean_diff = float(np.mean(diff))
        sd_diff = float(np.std(diff, ddof=1))
        dz = mean_diff / sd_diff if sd_diff else 0.0
        ci_low, ci_high = bootstrap_ci(diff)
        p = exact_paired_permutation_p(diff)
        raw_p.append(p)
        if direction == "higher":
            favours = "temi" if mean_diff > 0 else "walker"
        else:
            favours = "temi" if mean_diff < 0 else "walker"
        rows.append(
            {
                "metric": column,
                "label": label,
                "unit": unit,
                "direction": direction,
                "temi_mean": float(np.mean(temi)),
                "temi_sd": float(np.std(temi, ddof=1)),
                "walker_mean": float(np.mean(walker)),
                "walker_sd": float(np.std(walker, ddof=1)),
                "mean_difference": mean_diff,
                "ci_low": ci_low,
                "ci_high": ci_high,
                "paired_cohens_dz": dz,
                "permutation_p": p,
                "favours": favours,
            }
        )
    stats = pd.DataFrame(rows)
    stats["holm_p"] = holm(raw_p)
    return stats


def summarize_profiles(paired: pd.DataFrame) -> pd.DataFrame:
    rows = [profile_summary("All participants", paired)]
    for gender, group in paired.groupby("gender"):
        rows.append(profile_summary(f"Gender: {gender}", group))
    paired = paired.copy()
    paired["age_group"] = pd.cut(
        paired["age"],
        bins=[0, 29, 35, 200],
        labels=["22-29", "30-35", "36-41"],
        include_lowest=True,
    )
    for age_group, group in paired.groupby("age_group", observed=False):
        rows.append(profile_summary(f"Age: {age_group}", group))
    return pd.DataFrame(rows)


def profile_summary(name: str, group: pd.DataFrame) -> dict[str, Any]:
    return {
        "profile": name,
        "n": len(group),
        "age_mean": float(group["age"].mean()) if len(group) else math.nan,
        "age_sd": float(group["age"].std(ddof=1)) if len(group) > 1 else 0.0,
        "female_n": int((group["gender"] == "female").sum()) if len(group) else 0,
        "male_n": int((group["gender"] == "male").sum()) if len(group) else 0,
        "temi_preference_n": int((group["preferred_robot"] == "temi").sum()) if len(group) else 0,
        "walker_preference_n": int((group["preferred_robot"] == "walker").sum()) if len(group) else 0,
        "both_preference_n": int((group["preferred_robot"] == "both").sum()) if len(group) else 0,
        "overall_diff_mean": float(group["overall_interaction_score_diff"].mean()) if len(group) else math.nan,
        "attention_diff_mean": float(group["attention_rate_diff"].mean()) if len(group) else math.nan,
        "speech_latency_diff_mean": float(group["average_tts_start_latency_ms_diff"].mean()) if len(group) else math.nan,
        "sus_mean": float(group["sus_score"].mean()) if len(group) else math.nan,
        "nasa_tlx_mean": float(group["nasa_tlx_mean"].mean()) if len(group) else math.nan,
    }


def center_text(draw: ImageDraw.ImageDraw, xy: tuple[float, float], text: str, fnt: ImageFont.FreeTypeFont, fill: str = DARK) -> None:
    box = draw.textbbox((0, 0), text, font=fnt)
    draw.text((xy[0] - (box[2] - box[0]) / 2, xy[1] - (box[3] - box[1]) / 2), text, font=fnt, fill=fill)


def significance(p: float) -> str:
    if p < 0.001:
        return "***"
    if p < 0.01:
        return "**"
    if p < 0.05:
        return "*"
    return "n.s."


def draw_primary_outcomes(stats: pd.DataFrame) -> None:
    img = Image.new("RGB", (1800, 1050), BG)
    draw = ImageDraw.Draw(img)
    draw.text((90, 60), "Robot Performance Comparison", font=F_TITLE, fill=DARK)
    draw.text((90, 108), "Means across paired participants (n=10). Error bars show standard error.", font=F_SUB, fill=MID)
    draw.rectangle((1325, 76, 1355, 106), fill=BLUE)
    draw.text((1370, 78), "temi", font=F_SMALL, fill=DARK)
    draw.rectangle((1455, 76, 1485, 106), fill=ORANGE)
    draw.text((1500, 78), "walker", font=F_SMALL, fill=DARK)

    left, top, plot_w, plot_h = 125, 215, 1550, 610
    group_w = plot_w / len(stats)
    for i, row in stats.iterrows():
        values = [row["temi_mean"], row["walker_mean"]]
        sems = [row["temi_sd"] / math.sqrt(10), row["walker_sd"] / math.sqrt(10)]
        ymin = min(values) - max(sems) * 3.5
        ymax = max(values) + max(sems) * 4
        if row["unit"] == "%":
            ymin = max(0, ymin)
            ymax = min(105, ymax)
        if row["direction"] == "lower":
            ymin = 0
        if ymax <= ymin:
            ymax = ymin + 1

        x_center = left + i * group_w + group_w / 2
        panel_w = group_w * 0.78
        panel_x = x_center - panel_w / 2

        def y(v: float) -> float:
            return top + plot_h - (v - ymin) / (ymax - ymin) * plot_h

        for tick in np.linspace(ymin, ymax, 4):
            yy = y(float(tick))
            draw.line((panel_x, yy, panel_x + panel_w, yy), fill=LIGHT, width=2)
        draw.line((panel_x, top + plot_h, panel_x + panel_w, top + plot_h), fill=DARK, width=2)
        center_text(draw, (x_center, top - 38), significance(row["holm_p"]), F_LABEL)

        for val, sem, color, dx in [(values[0], sems[0], BLUE, -42), (values[1], sems[1], ORANGE, 42)]:
            bx = x_center + dx - 29
            by = y(val)
            draw.rounded_rectangle((bx, by, bx + 58, top + plot_h), radius=5, fill=color)
            draw.line((x_center + dx, y(val - sem), x_center + dx, y(val + sem)), fill=DARK, width=3)
            draw.line((x_center + dx - 12, y(val + sem), x_center + dx + 12, y(val + sem)), fill=DARK, width=3)
            draw.line((x_center + dx - 12, y(val - sem), x_center + dx + 12, y(val - sem)), fill=DARK, width=3)

        label_lines = str(row["label"]).split()
        if len(label_lines) > 1:
            center_text(draw, (x_center, top + plot_h + 45), " ".join(label_lines[:-1]), F_TINY)
            center_text(draw, (x_center, top + plot_h + 68), label_lines[-1], F_TINY)
        else:
            center_text(draw, (x_center, top + plot_h + 45), str(row["label"]), F_TINY)
        center_text(draw, (x_center, top + plot_h + 96), f"({row['unit']})", F_TINY, MID)

    draw.text((90, 985), "Holm-corrected paired permutation tests: * p<.05, ** p<.01, n.s.=not significant.", font=F_SMALL, fill=MID)
    img.save(FIG / "figure-robot-primary-outcomes.png", dpi=(300, 300))


def draw_effect_ci(stats: pd.DataFrame) -> None:
    img = Image.new("RGB", (1600, 850), BG)
    draw = ImageDraw.Draw(img)
    draw.text((90, 60), "Paired Effects and Confidence Intervals", font=F_TITLE, fill=DARK)
    draw.text((90, 108), "Mean differences are temi minus walker; horizontal bars are bootstrap 95% CIs.", font=F_SUB, fill=MID)
    vals = []
    for _, row in stats.iterrows():
        vals += [row["ci_low"], row["ci_high"], row["mean_difference"]]
    xmin, xmax = min(vals), max(vals)
    pad = (xmax - xmin) * 0.17
    xmin, xmax = xmin - pad, xmax + pad
    left, right, top, row_h = 610, 1420, 200, 95

    def x(v: float) -> float:
        return left + (v - xmin) / (xmax - xmin) * (right - left)

    draw.line((x(0), top - 55, x(0), top + row_h * len(stats) - 50), fill=DARK, width=3)
    for tick in np.linspace(xmin, xmax, 7):
        xx = x(float(tick))
        draw.line((xx, top - 55, xx, top + row_h * len(stats) - 50), fill=LIGHT, width=2)
        center_text(draw, (xx, top + row_h * len(stats) - 15), f"{tick:.1f}", F_TINY, MID)
    for i, (_, row) in enumerate(stats.iterrows()):
        cy = top + i * row_h
        draw.text((90, cy - 26), row["label"], font=F_LABEL, fill=DARK)
        draw.text((90, cy + 3), f"Holm p={row['holm_p']:.3f}; dz={row['paired_cohens_dz']:.2f}", font=F_SMALL, fill=MID)
        draw.line((x(row["ci_low"]), cy, x(row["ci_high"]), cy), fill=DARK, width=5)
        color = BLUE if row["favours"] == "temi" else ORANGE
        draw.ellipse((x(row["mean_difference"]) - 10, cy - 10, x(row["mean_difference"]) + 10, cy + 10), fill=color, outline=DARK, width=1)
        draw.text((right + 25, cy - 12), f"{row['mean_difference']:.2f}", font=F_SMALL, fill=DARK)
    center_text(draw, ((left + right) / 2, 810), "temi minus walker", F_SMALL, MID)
    img.save(FIG / "figure-robot-effect-ci.png", dpi=(300, 300))


def draw_user_profile(paired: pd.DataFrame) -> None:
    img = Image.new("RGB", (1650, 980), BG)
    draw = ImageDraw.Draw(img)
    draw.text((90, 60), "User Profile and Individual Robot Advantage", font=F_TITLE, fill=DARK)
    draw.text((90, 108), "Age and gender are extracted from each session's user-and-session metadata.", font=F_SUB, fill=MID)

    left, top, width, height = 205, 220, 1230, 540
    ages = paired["age"].to_numpy(float)
    diffs = paired["overall_interaction_score_diff"].to_numpy(float)
    xmin, xmax = min(ages) - 2, max(ages) + 2
    ymin, ymax = min(diffs) - 1.2, max(diffs) + 1.2

    def x(age: float) -> float:
        return left + (age - xmin) / (xmax - xmin) * width

    def y(diff: float) -> float:
        return top + height - (diff - ymin) / (ymax - ymin) * height

    for tick in np.linspace(ymin, ymax, 6):
        yy = y(float(tick))
        draw.line((left, yy, left + width, yy), fill=LIGHT, width=2)
        draw.text((left - 82, yy - 9), f"{tick:.1f}", font=F_TINY, fill=MID)
    draw.line((left, y(0), left + width, y(0)), fill=DARK, width=3)
    draw.line((left, top, left, top + height), fill=DARK, width=2)
    draw.line((left, top + height, left + width, top + height), fill=DARK, width=2)
    for tick in range(int(math.ceil(xmin / 5) * 5), int(xmax) + 1, 5):
        xx = x(float(tick))
        draw.line((xx, top + height, xx, top + height + 9), fill=DARK, width=2)
        center_text(draw, (xx, top + height + 32), str(tick), F_TINY, MID)

    for _, row in paired.iterrows():
        color = PURPLE if row["gender"] == "female" else GREEN
        xx, yy = x(float(row["age"])), y(float(row["overall_interaction_score_diff"]))
        draw.ellipse((xx - 14, yy - 14, xx + 14, yy + 14), fill=color, outline=DARK, width=2)
        draw.text((xx + 17, yy - 13), row["participant_id"], font=F_TINY, fill=DARK)
    draw.rectangle((1140, 160, 1166, 186), fill=PURPLE)
    draw.text((1180, 161), "female", font=F_SMALL, fill=DARK)
    draw.rectangle((1265, 160, 1291, 186), fill=GREEN)
    draw.text((1305, 161), "male", font=F_SMALL, fill=DARK)
    center_text(draw, (left + width / 2, top + height + 74), "Age (years)", F_LABEL)
    draw.text((55, 415), "Overall score", font=F_LABEL, fill=DARK)
    draw.text((55, 440), "difference", font=F_LABEL, fill=DARK)
    draw.text((55, 468), "(temi - walker)", font=F_SMALL, fill=MID)
    img.save(FIG / "figure-user-profile-advantage.png", dpi=(300, 300))


def write_report(stats: pd.DataFrame, profiles: pd.DataFrame, paired: pd.DataFrame) -> None:
    all_profile = profiles[profiles["profile"] == "All participants"].iloc[0]
    lines = [
        "# Paper-Ready Robot Effect and User Profile Analysis",
        "",
        "## Inferential method",
        "",
        "A single inferential statistics method was used: the exact within-subject paired permutation test. This is appropriate because each participant completed the task with both robots. Effects are reported as paired differences (temi minus walker), bootstrap 95% confidence intervals, Holm-corrected p-values, and paired Cohen's dz.",
        "",
        "## Robot comparison",
        "",
        "| Outcome | temi M(SD) | walker M(SD) | Difference | 95% CI | p | Holm p | dz | Interpretation |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---|",
    ]
    for _, row in stats.iterrows():
        direction = "temi better" if row["favours"] == "temi" else "walker better"
        lines.append(
            f"| {row['label']} | {fmt(row['temi_mean'])} ({fmt(row['temi_sd'])}) | "
            f"{fmt(row['walker_mean'])} ({fmt(row['walker_sd'])}) | "
            f"{fmt(row['mean_difference'])} | [{fmt(row['ci_low'])}, {fmt(row['ci_high'])}] | "
            f"{row['permutation_p']:.3f} | {row['holm_p']:.3f} | {fmt(row['paired_cohens_dz'])} | {direction} |"
        )
    lines.extend(
        [
            "",
            "## User profile",
            "",
            f"The user profile was extracted from `01_user-and-session/session-metadata.json`, not from the questionnaire table. The dataset contains {int(all_profile['n'])} users, with a mean age of {fmt(all_profile['age_mean'])} years (SD={fmt(all_profile['age_sd'])}). Gender is balanced: {int(all_profile['female_n'])} female and {int(all_profile['male_n'])} male users.",
            "",
            "| Profile | n | Age M(SD) | Female | Male | Mean overall advantage | Mean attention advantage | Mean speech-onset advantage |",
            "|---|---:|---:|---:|---:|---:|---:|---:|",
        ]
    )
    for _, row in profiles.iterrows():
        lines.append(
            f"| {row['profile']} | {int(row['n'])} | {fmt(row['age_mean'])} ({fmt(row['age_sd'])}) | "
            f"{int(row['female_n'])} | {int(row['male_n'])} | {fmt(row['overall_diff_mean'])} | "
            f"{fmt(row['attention_diff_mean'])} pp | {fmt(row['speech_latency_diff_mean'])} s |"
        )
    lines.extend(
        [
            "",
            "## Interpretation",
            "",
            "The paired inferential analysis shows a clear platform effect. Temi achieved higher overall interaction scores and central gaze rates, while also producing faster question generation and faster speech onset. The confidence intervals for these outcomes do not cross zero, indicating stable effects in the observed paired dataset. Attention also favoured temi, although the Holm-corrected result should be interpreted more cautiously. User profiling shows that the temi advantage appears across both male and female users and across the observed age range, but subgroup results should remain descriptive because each subgroup is small.",
        ]
    )
    (OUT / "paper-robot-inferential-profile-analysis.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    FIG.mkdir(parents=True, exist_ok=True)
    paired, _, _ = load_paired_data()
    stats = analyze_effects(paired)
    profile_summary_df = summarize_profiles(paired)

    paired.to_csv(OUT / "participant-profile-and-paired-effects.csv", index=False)
    stats.to_csv(OUT / "robot-inferential-statistics.csv", index=False, quoting=csv.QUOTE_MINIMAL)
    profile_summary_df.to_csv(OUT / "user-profile-summary.csv", index=False, quoting=csv.QUOTE_MINIMAL)
    (OUT / "robot-inferential-statistics.json").write_text(json.dumps(json.loads(stats.to_json(orient="records")), indent=2), encoding="utf-8")

    draw_primary_outcomes(stats)
    draw_effect_ci(stats)
    draw_user_profile(paired)
    write_report(stats, profile_summary_df, paired)
    print(f"Wrote {OUT}")


if __name__ == "__main__":
    main()
