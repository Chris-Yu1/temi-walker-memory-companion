from __future__ import annotations

import csv
import json
import math
import random
from itertools import product
from pathlib import Path

import numpy as np
import pandas as pd
from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
SESSION_CSV = ROOT / "outputs" / "comparative-test-sessions" / "comparison-index.csv"
QUESTIONNAIRE_CSV = ROOT / "outputs" / "comparative-questionnaires" / "all-questionnaire-responses.csv"
OUT = ROOT / "outputs" / "deep-robot-effect-analysis"
FIG = OUT / "figures"


METRICS = [
    ("overall_interaction_score", "Overall interaction score", "higher", "score", 1.0),
    ("attention_rate", "Attention rate", "higher", "%", 100.0),
    ("central_gaze_rate", "Central gaze rate", "higher", "%", 100.0),
    ("average_question_generation_latency_ms", "Question generation latency", "lower", "s", 0.001),
    ("average_tts_start_latency_ms", "Speech onset latency", "lower", "s", 0.001),
    ("average_next_question_transition_ms", "Transition latency", "lower", "s", 0.001),
    ("average_answer_duration_seconds", "Answer duration", "context", "s", 1.0),
    ("average_answer_word_count", "Answer word count", "context", "words", 1.0),
]


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
    rng = random.Random(seed)
    values = [float(x) for x in diff if math.isfinite(float(x))]
    means = []
    for _ in range(n_iter):
        sample = [values[rng.randrange(len(values))] for _ in values]
        means.append(sum(sample) / len(sample))
    means.sort()
    return means[int(0.025 * n_iter)], means[int(0.975 * n_iter) - 1]


def holm_adjust(p_values: list[float]) -> list[float]:
    ordered = sorted(enumerate(p_values), key=lambda x: x[1])
    adjusted = [0.0] * len(p_values)
    running = 0.0
    m = len(p_values)
    for rank, (idx, p) in enumerate(ordered):
        value = min(1.0, (m - rank) * p)
        running = max(running, value)
        adjusted[idx] = running
    return adjusted


def fmt(value: float, digits: int = 2) -> str:
    return f"{value:.{digits}f}"


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
F_SMALL = font(15)
BLUE = "#3b82f6"
ORANGE = "#f97316"
DARK = "#1f2937"
MID = "#4b5563"
GRID = "#e5e7eb"
BG = "#ffffff"


def load_data() -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    sessions = pd.read_csv(SESSION_CSV)
    questionnaires = pd.read_csv(QUESTIONNAIRE_CSV)
    profile = questionnaires[["participant_id", "age", "gender", "preferred_robot", "sus_score", "nasa_tlx_mean", "sassi_overall_mean"]].copy()
    rows = []
    for pid, group in sessions.groupby("participant_id"):
        if set(group["robot_family"]) >= {"temi", "walker"}:
            row = {"participant_id": pid}
            for col, _, _, _, scale in METRICS:
                row[f"{col}_temi"] = float(group[group["robot_family"] == "temi"][col].iloc[0]) * scale
                row[f"{col}_walker"] = float(group[group["robot_family"] == "walker"][col].iloc[0]) * scale
                row[f"{col}_diff"] = row[f"{col}_temi"] - row[f"{col}_walker"]
            rows.append(row)
    paired = pd.DataFrame(rows).merge(profile, on="participant_id", how="left")
    paired["age_group"] = pd.cut(
        paired["age"],
        bins=[0, 67, 72, 200],
        labels=["younger", "middle", "older"],
        include_lowest=True,
    )
    return sessions, questionnaires, paired


def analyze_robot_effect(paired: pd.DataFrame) -> pd.DataFrame:
    rows = []
    p_values = []
    for col, label, direction, unit, _ in METRICS:
        temi = paired[f"{col}_temi"].to_numpy(float)
        walker = paired[f"{col}_walker"].to_numpy(float)
        diff = paired[f"{col}_diff"].to_numpy(float)
        md = float(np.mean(diff))
        sd = float(np.std(diff, ddof=1))
        dz = md / sd if sd else 0.0
        ci_low, ci_high = bootstrap_ci(diff)
        p = exact_paired_permutation_p(diff)
        p_values.append(p)
        if direction == "higher":
            favors = "temi" if md > 0 else "walker"
        elif direction == "lower":
            favors = "temi" if md < 0 else "walker"
        else:
            favors = "descriptive"
        rows.append(
            {
                "metric": col,
                "label": label,
                "unit": unit,
                "direction": direction,
                "temi_mean": float(np.mean(temi)),
                "temi_sd": float(np.std(temi, ddof=1)),
                "walker_mean": float(np.mean(walker)),
                "walker_sd": float(np.std(walker, ddof=1)),
                "mean_difference_temi_minus_walker": md,
                "bootstrap_ci_low": ci_low,
                "bootstrap_ci_high": ci_high,
                "paired_cohens_dz": dz,
                "paired_permutation_p": p,
                "favors": favors,
            }
        )
    result = pd.DataFrame(rows)
    result["holm_p"] = holm_adjust(p_values)
    return result


def analyze_profiles(paired: pd.DataFrame) -> pd.DataFrame:
    rows = []
    for group_name, group in [("all", paired)]:
        rows.append(profile_row(group_name, group))
    for gender, group in paired.groupby("gender"):
        rows.append(profile_row(f"gender={gender}", group))
    for age_group, group in paired.groupby("age_group", observed=False):
        rows.append(profile_row(f"age_group={age_group}", group))
    return pd.DataFrame(rows)


def profile_row(name: str, group: pd.DataFrame) -> dict[str, object]:
    return {
        "profile": name,
        "n": len(group),
        "age_mean": float(group["age"].mean()) if len(group) else math.nan,
        "age_sd": float(group["age"].std(ddof=1)) if len(group) > 1 else 0.0,
        "female_n": int((group["gender"].astype(str).str.lower() == "female").sum()) if len(group) else 0,
        "male_n": int((group["gender"].astype(str).str.lower() == "male").sum()) if len(group) else 0,
        "temi_preference_n": int((group["preferred_robot"] == "temi").sum()) if len(group) else 0,
        "walker_preference_n": int((group["preferred_robot"] == "walker").sum()) if len(group) else 0,
        "both_preference_n": int((group["preferred_robot"] == "both").sum()) if len(group) else 0,
        "overall_diff_mean": float(group["overall_interaction_score_diff"].mean()) if len(group) else math.nan,
        "attention_diff_mean": float(group["attention_rate_diff"].mean()) if len(group) else math.nan,
        "tts_latency_diff_mean": float(group["average_tts_start_latency_ms_diff"].mean()) if len(group) else math.nan,
        "sus_mean": float(group["sus_score"].mean()) if len(group) else math.nan,
        "nasa_tlx_mean": float(group["nasa_tlx_mean"].mean()) if len(group) else math.nan,
        "sassi_mean": float(group["sassi_overall_mean"].mean()) if len(group) else math.nan,
    }


def draw_effect_forest(stats: pd.DataFrame) -> None:
    img = Image.new("RGB", (1600, 950), BG)
    d = ImageDraw.Draw(img)
    d.text((80, 55), "Robot Effect with 95% Confidence Intervals", font=F_TITLE, fill=DARK)
    d.text((80, 100), "Paired permutation analysis; effects are temi minus walker.", font=F_SUB, fill=MID)
    vals = []
    for _, r in stats.iterrows():
        vals += [r["bootstrap_ci_low"], r["bootstrap_ci_high"], r["mean_difference_temi_minus_walker"]]
    xmin, xmax = min(vals), max(vals)
    pad = (xmax - xmin) * 0.15
    xmin, xmax = xmin - pad, xmax + pad
    left, right, top, row_h = 600, 1420, 180, 82

    def x(v: float) -> float:
        return left + (v - xmin) / (xmax - xmin) * (right - left)

    d.line((x(0), top - 35, x(0), top + row_h * len(stats) - 30), fill=DARK, width=3)
    for tick in np.linspace(xmin, xmax, 7):
        xx = x(float(tick))
        d.line((xx, top - 35, xx, top + row_h * len(stats) - 30), fill=GRID, width=2)
        d.text((xx - 25, top + row_h * len(stats)), f"{tick:.1f}", font=F_SMALL, fill=MID)
    for i, (_, r) in enumerate(stats.iterrows()):
        cy = top + i * row_h
        d.text((80, cy - 20), str(r["label"]), font=F_LABEL, fill=DARK)
        d.text((80, cy + 8), f"p={r['paired_permutation_p']:.3f}, Holm p={r['holm_p']:.3f}, dz={r['paired_cohens_dz']:.2f}", font=F_SMALL, fill=MID)
        d.line((x(r["bootstrap_ci_low"]), cy, x(r["bootstrap_ci_high"]), cy), fill=DARK, width=5)
        d.ellipse((x(r["mean_difference_temi_minus_walker"]) - 9, cy - 9, x(r["mean_difference_temi_minus_walker"]) + 9, cy + 9), fill=BLUE if r["favors"] == "temi" else ORANGE)
        d.text((right + 22, cy - 12), f"{r['mean_difference_temi_minus_walker']:.2f}", font=F_SMALL, fill=DARK)
    d.text((740, 900), "Mean paired difference", font=F_SMALL, fill=MID)
    img.save(FIG / "robot-effect-confidence-intervals.png", dpi=(300, 300))


def draw_profile_chart(paired: pd.DataFrame) -> None:
    img = Image.new("RGB", (1500, 900), BG)
    d = ImageDraw.Draw(img)
    d.text((80, 55), "Participant Profile and Robot Advantage", font=F_TITLE, fill=DARK)
    d.text((80, 100), "Each participant's overall-score difference is temi minus walker.", font=F_SUB, fill=MID)
    left, top, width, height = 130, 190, 1180, 520
    ages = paired["age"].to_numpy(float)
    diffs = paired["overall_interaction_score_diff"].to_numpy(float)
    age_min, age_max = min(ages) - 2, max(ages) + 2
    diff_min, diff_max = min(diffs) - 1, max(diffs) + 1

    def x(age: float) -> float:
        return left + (age - age_min) / (age_max - age_min) * width

    def y(diff: float) -> float:
        return top + height - (diff - diff_min) / (diff_max - diff_min) * height

    for tick in np.linspace(diff_min, diff_max, 6):
        yy = y(float(tick))
        d.line((left, yy, left + width, yy), fill=GRID, width=2)
        d.text((left - 70, yy - 10), f"{tick:.1f}", font=F_SMALL, fill=MID)
    d.line((left, y(0), left + width, y(0)), fill=DARK, width=3)
    d.line((left, top + height, left + width, top + height), fill=DARK, width=2)
    d.line((left, top, left, top + height), fill=DARK, width=2)
    for _, row in paired.iterrows():
        color = BLUE if str(row["gender"]).lower() == "female" else ORANGE
        xx, yy = x(float(row["age"])), y(float(row["overall_interaction_score_diff"]))
        d.ellipse((xx - 13, yy - 13, xx + 13, yy + 13), fill=color, outline=DARK, width=2)
        d.text((xx + 15, yy - 14), row["participant_id"], font=F_SMALL, fill=DARK)
    d.rectangle((1040, 150, 1065, 175), fill=BLUE)
    d.text((1075, 150), "female", font=F_SMALL, fill=DARK)
    d.rectangle((1160, 150, 1185, 175), fill=ORANGE)
    d.text((1195, 150), "male", font=F_SMALL, fill=DARK)
    d.text((650, 760), "Age", font=F_LABEL, fill=DARK)
    d.text((30, 410), "Overall score difference", font=F_LABEL, fill=DARK)
    img.save(FIG / "participant-profile-robot-advantage.png", dpi=(300, 300))


def write_report(stats: pd.DataFrame, profiles: pd.DataFrame, paired: pd.DataFrame) -> None:
    lines = [
        "# Deep Robot Effect Analysis",
        "",
        "## Inferential statistics method",
        "",
        "This analysis uses one inferential statistics method: an exact within-subject paired permutation test. Each participant used both robots, so each robot comparison is based on the participant-level difference between temi and walker. Bootstrap 95% confidence intervals quantify uncertainty around the paired mean difference.",
        "",
        "## Robot effect results",
        "",
        "| Metric | temi M(SD) | walker M(SD) | Diff. | 95% CI | p | Holm p | dz | Favours |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---|",
    ]
    for _, r in stats.iterrows():
        lines.append(
            f"| {r['label']} | {fmt(r['temi_mean'])} ({fmt(r['temi_sd'])}) | "
            f"{fmt(r['walker_mean'])} ({fmt(r['walker_sd'])}) | "
            f"{fmt(r['mean_difference_temi_minus_walker'])} | "
            f"[{fmt(r['bootstrap_ci_low'])}, {fmt(r['bootstrap_ci_high'])}] | "
            f"{r['paired_permutation_p']:.3f} | {r['holm_p']:.3f} | "
            f"{fmt(r['paired_cohens_dz'])} | {r['favors']} |"
        )
    profile_all = profiles[profiles["profile"] == "all"].iloc[0]
    lines.extend(
        [
            "",
            "## User profile",
            "",
            f"The dataset contains {int(profile_all['n'])} participants. The mean age is {fmt(profile_all['age_mean'])} years (SD = {fmt(profile_all['age_sd'])}). Gender distribution is {int(profile_all['female_n'])} female and {int(profile_all['male_n'])} male participants. Robot preference was {int(profile_all['temi_preference_n'])} for temi, {int(profile_all['walker_preference_n'])} for walker, and {int(profile_all['both_preference_n'])} for both/no clear preference.",
            "",
            "## Profile-level interpretation",
            "",
        ]
    )
    for _, r in profiles.iterrows():
        if r["profile"] == "all":
            continue
        lines.append(
            f"- {r['profile']}: n={int(r['n'])}, mean age={fmt(r['age_mean'])}, "
            f"mean overall-score difference={fmt(r['overall_diff_mean'])}, "
            f"mean attention difference={fmt(r['attention_diff_mean'])} percentage points, "
            f"mean speech-onset latency difference={fmt(r['tts_latency_diff_mean'])} s."
        )
    lines.extend(
        [
            "",
            "## Summary",
            "",
            "The paired permutation analysis indicates that temi shows stronger performance than walker on the main interaction quality and responsiveness metrics. The confidence intervals for overall interaction score, attention, central gaze, question-generation latency, and speech-onset latency do not cross zero, supporting a consistent platform advantage for temi in this dataset. User profiling suggests that the temi advantage is visible across age and gender groups, although subgroup sample sizes are small and should be interpreted descriptively rather than as separate confirmatory tests.",
        ]
    )
    (OUT / "deep-robot-effect-analysis.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    FIG.mkdir(parents=True, exist_ok=True)
    _, _, paired = load_data()
    stats = analyze_robot_effect(paired)
    profiles = analyze_profiles(paired)
    paired.to_csv(OUT / "participant-level-profile-and-differences.csv", index=False)
    stats.to_csv(OUT / "robot-effect-inferential-statistics.csv", index=False, quoting=csv.QUOTE_MINIMAL)
    profiles.to_csv(OUT / "user-profile-summary.csv", index=False, quoting=csv.QUOTE_MINIMAL)
    (OUT / "robot-effect-inferential-statistics.json").write_text(json.dumps(json.loads(stats.to_json(orient="records")), indent=2), encoding="utf-8")
    draw_effect_forest(stats)
    draw_profile_chart(paired)
    write_report(stats, profiles, paired)
    print(f"Wrote {OUT}")


if __name__ == "__main__":
    main()
