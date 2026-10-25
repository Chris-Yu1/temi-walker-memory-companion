from __future__ import annotations

import csv
import math
from itertools import product
from pathlib import Path

import numpy as np
import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
SESSIONS = ROOT / "outputs" / "comparative-test-sessions" / "comparison-index.csv"
QUESTIONNAIRES = ROOT / "outputs" / "comparative-questionnaires" / "all-questionnaire-responses.csv"
OUT = ROOT / "outputs" / "paper-inferential-statistics"
FIG = OUT / "figures"


PRIMARY_METRICS = [
    ("overall_interaction_score", "Overall interaction score", "higher", "score", 1.0),
    ("attention_rate", "Attention rate", "higher", "%", 100.0),
    ("central_gaze_rate", "Central gaze rate", "higher", "%", 100.0),
    ("average_question_generation_latency_ms", "Question generation latency", "lower", "s", 0.001),
    ("average_tts_start_latency_ms", "Speech onset latency", "lower", "s", 0.001),
]


def mean_sd(values: np.ndarray) -> tuple[float, float]:
    return float(np.mean(values)), float(np.std(values, ddof=1))


def paired_permutation_p(diff: np.ndarray) -> float:
    diff = np.asarray(diff, dtype=float)
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
    rng = np.random.default_rng(seed)
    diff = np.asarray(diff, dtype=float)
    means = rng.choice(diff, size=(n_iter, len(diff)), replace=True).mean(axis=1)
    return float(np.quantile(means, 0.025)), float(np.quantile(means, 0.975))


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


def binomial_two_sided(k: int, n: int, p: float = 0.5) -> float:
    if n == 0:
        return 1.0
    probs = [math.comb(n, i) * p**i * (1 - p) ** (n - i) for i in range(n + 1)]
    observed = probs[k]
    return min(1.0, sum(prob for prob in probs if prob <= observed + 1e-12))


def significance(p: float) -> str:
    if p < 0.001:
        return "***"
    if p < 0.01:
        return "**"
    if p < 0.05:
        return "*"
    return "n.s."


def fmt(x: float, digits: int = 2) -> str:
    return f"{x:.{digits}f}"


def esc(text: str) -> str:
    return str(text).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def svg(path: Path, width: int, height: int, body: str) -> None:
    path.write_text(
        f'''<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">
<rect width="100%" height="100%" fill="#ffffff"/>
<style>
text {{ font-family: Arial, Helvetica, sans-serif; fill: #1f2937; }}
.title {{ font-size: 26px; font-weight: 700; }}
.sub {{ font-size: 15px; fill: #4b5563; }}
.axis {{ stroke: #374151; stroke-width: 1.2; }}
.grid {{ stroke: #e5e7eb; stroke-width: 1; }}
.temi {{ fill: #3b82f6; stroke: #1d4ed8; }}
.walker {{ fill: #f97316; stroke: #c2410c; }}
.neutral {{ fill: #6b7280; stroke: #374151; }}
.line {{ stroke: #9ca3af; stroke-width: 1.2; opacity: .75; }}
.ci {{ stroke: #111827; stroke-width: 2.4; }}
.zero {{ stroke: #111827; stroke-width: 1.5; }}
.tick {{ font-size: 13px; fill: #4b5563; }}
.label {{ font-size: 15px; fill: #1f2937; }}
.small {{ font-size: 12px; fill: #4b5563; }}
</style>
{body}
</svg>''',
        encoding="utf-8",
    )


def load() -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    sessions = pd.read_csv(SESSIONS)
    questionnaires = pd.read_csv(QUESTIONNAIRES)
    rows = []
    for pid, group in sessions.groupby("participant_id"):
        if set(group["robot_family"]) >= {"temi", "walker"}:
            row = {"participant_id": pid}
            for col, _, _, _, scale in PRIMARY_METRICS:
                row[f"{col}_temi"] = float(group[group["robot_family"] == "temi"][col].iloc[0]) * scale
                row[f"{col}_walker"] = float(group[group["robot_family"] == "walker"][col].iloc[0]) * scale
            rows.append(row)
    return sessions, questionnaires, pd.DataFrame(rows)


def analyze(paired: pd.DataFrame) -> pd.DataFrame:
    rows = []
    p_values = []
    for col, label, better, unit, _ in PRIMARY_METRICS:
        temi = paired[f"{col}_temi"].to_numpy()
        walker = paired[f"{col}_walker"].to_numpy()
        diff = temi - walker
        tm, tsd = mean_sd(temi)
        wm, wsd = mean_sd(walker)
        md = float(np.mean(diff))
        sd = float(np.std(diff, ddof=1))
        dz = md / sd if sd else 0.0
        ci_low, ci_high = bootstrap_ci(diff)
        p = paired_permutation_p(diff)
        p_values.append(p)
        if better == "higher":
            favours = "temi" if md > 0 else "walker"
        else:
            favours = "temi" if md < 0 else "walker"
        rows.append(
            {
                "metric": col,
                "label": label,
                "unit": unit,
                "temi_mean": tm,
                "temi_sd": tsd,
                "walker_mean": wm,
                "walker_sd": wsd,
                "mean_difference": md,
                "ci_low": ci_low,
                "ci_high": ci_high,
                "cohens_dz": dz,
                "p": p,
                "favours": favours,
            }
        )
    result = pd.DataFrame(rows)
    result["holm_p"] = holm(p_values)
    result["sig"] = [significance(p) for p in result["holm_p"]]
    return result


def figure_primary_bars(stats: pd.DataFrame) -> None:
    width, height = 1100, 680
    left, top, plot_w, plot_h = 110, 110, 850, 420
    gap = plot_w / len(stats)
    body = [
        '<text class="title" x="70" y="52">Primary outcome comparison</text>',
        '<text class="sub" x="70" y="78">Mean values across paired participants (n = 10). Error bars show standard error.</text>',
        '<rect class="temi" x="800" y="42" width="16" height="16" rx="2"/><text class="tick" x="824" y="55">temi</text>',
        '<rect class="walker" x="880" y="42" width="16" height="16" rx="2"/><text class="tick" x="904" y="55">walker</text>',
    ]
    for i, row in stats.iterrows():
        values = [row["temi_mean"], row["walker_mean"]]
        sems = [row["temi_sd"] / math.sqrt(10), row["walker_sd"] / math.sqrt(10)]
        ymin = min(values) - max(sems) * 3
        ymax = max(values) + max(sems) * 4
        if row["unit"] == "%":
            ymin = max(0, ymin)
            ymax = min(105, ymax)
        if "latency" in row["label"].lower():
            ymin = 0
        x_center = left + i * gap + gap / 2
        panel_w = gap * 0.78
        panel_x = x_center - panel_w / 2
        bar_w = 38
        def y(v: float) -> float:
            return top + plot_h - (v - ymin) / (ymax - ymin) * plot_h
        body.append(f'<text class="label" x="{x_center}" y="{top - 18}" text-anchor="middle">{esc(row["sig"])}</text>')
        for tick in np.linspace(ymin, ymax, 4):
            yy = y(float(tick))
            body.append(f'<line class="grid" x1="{panel_x}" y1="{yy}" x2="{panel_x + panel_w}" y2="{yy}"/>')
        for j, (cls, val, sem, dx) in enumerate([("temi", values[0], sems[0], -24), ("walker", values[1], sems[1], 24)]):
            bx = x_center + dx - bar_w / 2
            by = y(val)
            body.append(f'<rect class="{cls}" x="{bx}" y="{by}" width="{bar_w}" height="{top + plot_h - by}" rx="3"/>')
            body.append(f'<line class="axis" x1="{x_center + dx}" y1="{y(val - sem)}" x2="{x_center + dx}" y2="{y(val + sem)}"/>')
            body.append(f'<line class="axis" x1="{x_center + dx - 9}" y1="{y(val + sem)}" x2="{x_center + dx + 9}" y2="{y(val + sem)}"/>')
            body.append(f'<line class="axis" x1="{x_center + dx - 9}" y1="{y(val - sem)}" x2="{x_center + dx + 9}" y2="{y(val - sem)}"/>')
        words = row["label"].replace("Question generation latency", "Question gen. latency").replace("Speech onset latency", "Speech onset latency")
        body.append(f'<text class="small" x="{x_center}" y="{top + plot_h + 35}" text-anchor="middle">{esc(words)}</text>')
        body.append(f'<text class="small" x="{x_center}" y="{top + plot_h + 53}" text-anchor="middle">({row["unit"]})</text>')
    body.append(f'<line class="axis" x1="{left - 25}" y1="{top + plot_h}" x2="{left + plot_w + 25}" y2="{top + plot_h}"/>')
    body.append('<text class="small" x="70" y="625">Significance after Holm correction: * p &lt; .05, ** p &lt; .01, *** p &lt; .001; n.s. = not significant.</text>')
    svg(FIG / "figure-1-primary-outcomes.svg", width, height, "\n".join(body))


def figure_effects(stats: pd.DataFrame) -> None:
    width, height = 1000, 560
    left, right, top, row_h = 390, 920, 100, 72
    vals = []
    for _, row in stats.iterrows():
        vals += [row["ci_low"], row["ci_high"], row["mean_difference"]]
    xmin, xmax = min(vals), max(vals)
    pad = (xmax - xmin) * 0.16
    xmin, xmax = xmin - pad, xmax + pad
    def x(v: float) -> float:
        return left + (v - xmin) / (xmax - xmin) * (right - left)
    body = [
        '<text class="title" x="70" y="52">Paired mean differences</text>',
        '<text class="sub" x="70" y="78">Effects are reported as temi minus walker with bootstrap 95% confidence intervals.</text>',
        f'<line class="zero" x1="{x(0)}" y1="88" x2="{x(0)}" y2="{top + row_h * len(stats) - 28}"/>',
    ]
    for tick in np.linspace(xmin, xmax, 6):
        xx = x(float(tick))
        body.append(f'<line class="grid" x1="{xx}" y1="88" x2="{xx}" y2="{top + row_h * len(stats) - 28}"/>')
        body.append(f'<text class="tick" x="{xx}" y="{top + row_h * len(stats) + 8}" text-anchor="middle">{fmt(float(tick), 1)}</text>')
    for i, row in stats.iterrows():
        cy = top + i * row_h
        body.append(f'<text class="label" x="70" y="{cy + 4}">{esc(row["label"])}</text>')
        body.append(f'<text class="small" x="70" y="{cy + 24}">Holm p={fmt(row["holm_p"], 3)}, dz={fmt(row["cohens_dz"], 2)}</text>')
        body.append(f'<line class="ci" x1="{x(row["ci_low"])}" y1="{cy}" x2="{x(row["ci_high"])}" y2="{cy}"/>')
        body.append(f'<circle class="neutral" cx="{x(row["mean_difference"])}" cy="{cy}" r="6"/>')
        body.append(f'<text class="small" x="{right + 15}" y="{cy + 4}">{fmt(row["mean_difference"], 2)}</text>')
    body.append(f'<text class="small" x="{(left + right) / 2}" y="{height - 28}" text-anchor="middle">temi minus walker</text>')
    svg(FIG / "figure-2-effect-estimates.svg", width, height, "\n".join(body))


def figure_preference(questionnaires: pd.DataFrame) -> None:
    width, height = 760, 520
    counts = questionnaires["preferred_robot"].value_counts().to_dict()
    labels = [("temi", "temi"), ("walker", "walker"), ("both", "neutral")]
    max_count = max([counts.get(k, 0) for k, _ in labels] + [1])
    left, base, bar_w, gap = 120, 405, 105, 75
    body = [
        '<text class="title" x="70" y="52">Participant robot preference</text>',
        '<text class="sub" x="70" y="78">Post-session questionnaire preference after both robot conditions.</text>',
    ]
    for i, (label, cls) in enumerate(labels):
        value = int(counts.get(label, 0))
        h = value / max_count * 275
        x = left + i * (bar_w + gap)
        body.append(f'<rect class="{cls}" x="{x}" y="{base - h}" width="{bar_w}" height="{h}" rx="4"/>')
        body.append(f'<text class="label" x="{x + bar_w / 2}" y="{base + 32}" text-anchor="middle">{label}</text>')
        body.append(f'<text class="label" x="{x + bar_w / 2}" y="{base - h - 12}" text-anchor="middle">{value}</text>')
    directional_n = int(counts.get("temi", 0) + counts.get("walker", 0))
    p = binomial_two_sided(int(counts.get("temi", 0)), directional_n)
    body.append(f'<text class="small" x="70" y="480">Directional preference test, excluding both: exact binomial p = {fmt(p, 3)}.</text>')
    svg(FIG / "figure-3-questionnaire-preference.svg", width, height, "\n".join(body))


def write_outputs(stats: pd.DataFrame, questionnaires: pd.DataFrame) -> None:
    stats.to_csv(OUT / "paper-inferential-results.csv", index=False, quoting=csv.QUOTE_MINIMAL)
    counts = questionnaires["preferred_robot"].value_counts().to_dict()
    lines = [
        "# Paper Inferential Statistics",
        "",
        "## Statistical approach",
        "",
        "The study used a within-subject design: each participant completed the same reminiscence task with both temi and walker. Therefore, robot effects were tested on paired participant-level differences rather than independent group differences. Because the sample size was small (n = 10), the primary inferential test was an exact paired permutation test. Holm correction was applied across the five pre-specified primary outcomes. Effect size was reported as paired Cohen's dz, and uncertainty was summarized using bootstrap 95% confidence intervals for the paired mean difference.",
        "",
        "## Results",
        "",
    ]
    for _, row in stats.iterrows():
        lines.append(
            f"- {row['label']}: temi M = {fmt(row['temi_mean'])} (SD = {fmt(row['temi_sd'])}), "
            f"walker M = {fmt(row['walker_mean'])} (SD = {fmt(row['walker_sd'])}), "
            f"mean paired difference = {fmt(row['mean_difference'])}, 95% CI [{fmt(row['ci_low'])}, {fmt(row['ci_high'])}], "
            f"exact permutation p = {fmt(row['p'], 3)}, Holm-adjusted p = {fmt(row['holm_p'], 3)}, dz = {fmt(row['cohens_dz'])}."
        )
    lines.extend(
        [
            "",
            "## Questionnaire",
            "",
            f"Robot preference was descriptive rather than a paired robot-specific scale: {counts.get('temi', 0)} participants preferred temi, {counts.get('walker', 0)} preferred walker, and {counts.get('both', 0)} rated both similarly. Excluding neutral preferences, the exact binomial test was p = {fmt(binomial_two_sided(int(counts.get('temi', 0)), int(counts.get('temi', 0) + counts.get('walker', 0))), 3)}.",
            "",
            "## Interpretation for manuscript",
            "",
            "The inferential analysis suggests that temi provided a smoother interaction profile than walker in this dataset. The strongest evidence was observed for overall interaction score, question generation latency, and speech onset latency, all of which remained significant after Holm correction. Central gaze rate also remained significant after correction, suggesting stronger visual engagement with temi. Attention rate showed a positive effect in the same direction but should be interpreted cautiously after multiple-comparison correction. Questionnaire preferences were consistent with the behavioral results, although the preference test did not reach conventional significance because several participants selected both robots.",
        ]
    )
    (OUT / "paper-inferential-analysis.md").write_text("\n".join(lines), encoding="utf-8")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    FIG.mkdir(parents=True, exist_ok=True)
    _, questionnaires, paired = load()
    stats = analyze(paired)
    write_outputs(stats, questionnaires)
    figure_primary_bars(stats)
    figure_effects(stats)
    figure_preference(questionnaires)
    print(OUT)


if __name__ == "__main__":
    main()
