from __future__ import annotations

import csv
import json
import math
import random
from itertools import product
from pathlib import Path

import numpy as np
import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
TEST_CSV = ROOT / "outputs" / "comparative-test-sessions" / "comparison-index.csv"
QUESTIONNAIRE_CSV = ROOT / "outputs" / "comparative-questionnaires" / "all-questionnaire-responses.csv"
OUT = ROOT / "outputs" / "inferential-statistics"
FIG = OUT / "figures"


METRICS = [
    {
        "column": "overall_interaction_score",
        "label": "Overall interaction score",
        "unit": "score",
        "better": "higher",
    },
    {
        "column": "attention_rate",
        "label": "Attention rate",
        "unit": "%",
        "better": "higher",
        "scale": 100,
    },
    {
        "column": "central_gaze_rate",
        "label": "Central gaze rate",
        "unit": "%",
        "better": "higher",
        "scale": 100,
    },
    {
        "column": "average_question_generation_latency_ms",
        "label": "Question generation latency",
        "unit": "s",
        "better": "lower",
        "scale": 0.001,
    },
    {
        "column": "average_tts_start_latency_ms",
        "label": "TTS start latency",
        "unit": "s",
        "better": "lower",
        "scale": 0.001,
    },
    {
        "column": "average_next_question_transition_ms",
        "label": "Next-question transition",
        "unit": "s",
        "better": "lower",
        "scale": 0.001,
    },
    {
        "column": "average_answer_duration_seconds",
        "label": "Answer duration",
        "unit": "s",
        "better": "contextual",
    },
    {
        "column": "average_answer_word_count",
        "label": "Answer word count",
        "unit": "words",
        "better": "contextual",
    },
]


def fmt(value: float, digits: int = 3) -> str:
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return "NA"
    return f"{value:.{digits}f}"


def ranks_abs(values: np.ndarray) -> np.ndarray:
    order = np.argsort(values)
    ranks = np.empty(len(values), dtype=float)
    sorted_values = values[order]
    i = 0
    while i < len(values):
        j = i
        while j + 1 < len(values) and sorted_values[j + 1] == sorted_values[i]:
            j += 1
        avg_rank = (i + 1 + j + 1) / 2
        ranks[order[i : j + 1]] = avg_rank
        i = j + 1
    return ranks


def exact_paired_permutation_p(diff: np.ndarray) -> float:
    diff = diff[np.isfinite(diff)]
    diff = diff[diff != 0]
    if len(diff) == 0:
        return 1.0
    observed = abs(float(np.mean(diff)))
    count = 0
    total = 0
    for signs in product([-1, 1], repeat=len(diff)):
        stat = abs(float(np.mean(diff * np.array(signs))))
        if stat >= observed - 1e-12:
            count += 1
        total += 1
    return count / total


def wilcoxon_exact(diff: np.ndarray) -> tuple[float, float, float]:
    diff = diff[np.isfinite(diff)]
    diff = diff[diff != 0]
    if len(diff) == 0:
        return 0.0, 1.0, 0.0
    abs_diff = np.abs(diff)
    ranks = ranks_abs(abs_diff)
    w_pos = float(np.sum(ranks[diff > 0]))
    w_neg = float(np.sum(ranks[diff < 0]))
    total_rank = float(np.sum(ranks))
    observed = abs(w_pos - total_rank / 2)
    extreme = 0
    total = 0
    for signs in product([-1, 1], repeat=len(diff)):
        signed = ranks * np.array(signs)
        w = float(np.sum(ranks[signed > 0]))
        stat = abs(w - total_rank / 2)
        if stat >= observed - 1e-12:
            extreme += 1
        total += 1
    rank_biserial = (w_pos - w_neg) / total_rank if total_rank else 0.0
    return w_pos, extreme / total, rank_biserial


def bootstrap_ci(diff: np.ndarray, iterations: int = 10000, seed: int = 20260826) -> tuple[float, float]:
    rng = random.Random(seed)
    diff = [float(x) for x in diff if math.isfinite(float(x))]
    if not diff:
        return math.nan, math.nan
    means = []
    for _ in range(iterations):
        sample = [diff[rng.randrange(len(diff))] for _ in diff]
        means.append(sum(sample) / len(sample))
    means.sort()
    lo = means[int(0.025 * iterations)]
    hi = means[int(0.975 * iterations) - 1]
    return lo, hi


def holm_adjust(p_values: list[float]) -> list[float]:
    indexed = sorted(enumerate(p_values), key=lambda item: item[1])
    adjusted = [0.0] * len(p_values)
    running = 0.0
    m = len(p_values)
    for rank, (idx, p) in enumerate(indexed):
        value = min(1.0, (m - rank) * p)
        running = max(running, value)
        adjusted[idx] = running
    return adjusted


def svg_escape(text: str) -> str:
    return (
        str(text)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def write_svg(path: Path, width: int, height: int, body: str) -> None:
    path.write_text(
        f"""<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" role="img">
<rect width="100%" height="100%" fill="#fbfbf8"/>
<style>
text {{ font-family: Arial, Helvetica, sans-serif; fill: #1f2933; }}
.title {{ font-size: 24px; font-weight: 700; }}
.subtitle {{ font-size: 13px; fill: #52606d; }}
.axis {{ stroke: #9aa5b1; stroke-width: 1; }}
.grid {{ stroke: #d9e2ec; stroke-width: 1; }}
.temi {{ fill: #2f80ed; stroke: #1b5ead; }}
.walker {{ fill: #f2994a; stroke: #b96513; }}
.line {{ stroke: #7b8794; stroke-width: 1.2; opacity: 0.7; }}
.zero {{ stroke: #1f2933; stroke-width: 1.4; }}
.ci {{ stroke: #384a5f; stroke-width: 2.5; }}
.point {{ fill: #111827; }}
.note {{ font-size: 12px; fill: #52606d; }}
.label {{ font-size: 12px; fill: #334e68; }}
.tick {{ font-size: 11px; fill: #52606d; }}
</style>
{body}
</svg>
""",
        encoding="utf-8",
    )


def load_data() -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    sessions = pd.read_csv(TEST_CSV)
    questionnaires = pd.read_csv(QUESTIONNAIRE_CSV)
    pivot = sessions.pivot(index="participant_id", columns="robot_family")
    paired_rows = []
    for pid in sorted(sessions["participant_id"].unique()):
        p = sessions[sessions["participant_id"] == pid]
        if {"temi", "walker"}.issubset(set(p["robot_family"])):
            row = {"participant_id": pid}
            for metric in METRICS:
                col = metric["column"]
                row[f"{col}_temi"] = float(p[p["robot_family"] == "temi"][col].iloc[0])
                row[f"{col}_walker"] = float(p[p["robot_family"] == "walker"][col].iloc[0])
            paired_rows.append(row)
    paired = pd.DataFrame(paired_rows)
    return sessions, questionnaires, paired


def compute_stats(paired: pd.DataFrame) -> pd.DataFrame:
    rows = []
    raw_perm_p = []
    raw_wilcoxon_p = []
    for metric in METRICS:
        col = metric["column"]
        scale = metric.get("scale", 1.0)
        temi = paired[f"{col}_temi"].to_numpy(dtype=float) * scale
        walker = paired[f"{col}_walker"].to_numpy(dtype=float) * scale
        diff = temi - walker
        mean_diff = float(np.mean(diff))
        sd_diff = float(np.std(diff, ddof=1)) if len(diff) > 1 else 0.0
        dz = mean_diff / sd_diff if sd_diff else 0.0
        ci_lo, ci_hi = bootstrap_ci(diff)
        p_perm = exact_paired_permutation_p(diff)
        w_pos, p_wilcoxon, rank_biserial = wilcoxon_exact(diff)
        raw_perm_p.append(p_perm)
        raw_wilcoxon_p.append(p_wilcoxon)
        rows.append(
            {
                "metric": col,
                "label": metric["label"],
                "unit": metric["unit"],
                "better_direction": metric["better"],
                "n_pairs": len(diff),
                "temi_mean": float(np.mean(temi)),
                "temi_sd": float(np.std(temi, ddof=1)),
                "walker_mean": float(np.mean(walker)),
                "walker_sd": float(np.std(walker, ddof=1)),
                "mean_difference_temi_minus_walker": mean_diff,
                "bootstrap_95ci_low": ci_lo,
                "bootstrap_95ci_high": ci_hi,
                "cohens_dz": dz,
                "exact_paired_permutation_p": p_perm,
                "wilcoxon_w_positive": w_pos,
                "wilcoxon_exact_p": p_wilcoxon,
                "rank_biserial_r": rank_biserial,
            }
        )
    out = pd.DataFrame(rows)
    out["holm_adjusted_permutation_p"] = holm_adjust(raw_perm_p)
    out["holm_adjusted_wilcoxon_p"] = holm_adjust(raw_wilcoxon_p)
    return out


def chart_paired_metrics(paired: pd.DataFrame, stats: pd.DataFrame) -> None:
    panels = [
        ("overall_interaction_score", "Overall score", 74, 98),
        ("attention_rate", "Attention rate (%)", 65, 105),
        ("central_gaze_rate", "Central gaze (%)", 60, 105),
        ("average_tts_start_latency_ms", "TTS latency (s)", 0.8, 3.4),
    ]
    width, height = 1200, 780
    margin_x, margin_y = 70, 96
    panel_w, panel_h = 510, 255
    gap_x, gap_y = 70, 70
    body = [
        '<text class="title" x="70" y="48">Paired robot comparison across participants</text>',
        '<text class="subtitle" x="70" y="72">Each line is one participant; blue = temi, orange = walker.</text>',
    ]
    for idx, (col, title, ymin, ymax) in enumerate(panels):
        scale = next((m.get("scale", 1.0) for m in METRICS if m["column"] == col), 1.0)
        x0 = margin_x + (idx % 2) * (panel_w + gap_x)
        y0 = margin_y + (idx // 2) * (panel_h + gap_y)
        temi = paired[f"{col}_temi"].to_numpy(dtype=float) * scale
        walker = paired[f"{col}_walker"].to_numpy(dtype=float) * scale
        row = stats[stats["metric"] == col].iloc[0]
        def y(v: float) -> float:
            return y0 + panel_h - (v - ymin) / (ymax - ymin) * panel_h
        x_t, x_w = x0 + panel_w * 0.35, x0 + panel_w * 0.65
        body.append(f'<text class="label" x="{x0}" y="{y0 - 20}">{svg_escape(title)}</text>')
        body.append(f'<text class="note" x="{x0 + 260}" y="{y0 - 20}">perm. p={fmt(row["exact_paired_permutation_p"], 3)}, dz={fmt(row["cohens_dz"], 2)}</text>')
        for tick in np.linspace(ymin, ymax, 5):
            yy = y(float(tick))
            body.append(f'<line class="grid" x1="{x0}" y1="{yy}" x2="{x0 + panel_w}" y2="{yy}"/>')
            body.append(f'<text class="tick" x="{x0 - 10}" y="{yy + 4}" text-anchor="end">{fmt(float(tick), 1)}</text>')
        body.append(f'<line class="axis" x1="{x0}" y1="{y0 + panel_h}" x2="{x0 + panel_w}" y2="{y0 + panel_h}"/>')
        body.append(f'<text class="tick" x="{x_t}" y="{y0 + panel_h + 25}" text-anchor="middle">temi</text>')
        body.append(f'<text class="tick" x="{x_w}" y="{y0 + panel_h + 25}" text-anchor="middle">walker</text>')
        for tv, wv in zip(temi, walker):
            body.append(f'<line class="line" x1="{x_t}" y1="{y(tv)}" x2="{x_w}" y2="{y(wv)}"/>')
            body.append(f'<circle class="temi" cx="{x_t}" cy="{y(tv)}" r="4.5"/>')
            body.append(f'<circle class="walker" cx="{x_w}" cy="{y(wv)}" r="4.5"/>')
        body.append(f'<circle class="temi" cx="{x_t}" cy="{y(float(np.mean(temi)))}" r="8"/>')
        body.append(f'<circle class="walker" cx="{x_w}" cy="{y(float(np.mean(walker)))}" r="8"/>')
    write_svg(FIG / "paired-robot-comparison.svg", width, height, "\n".join(body))


def chart_forest(stats: pd.DataFrame) -> None:
    width, height = 1200, 680
    x0, y0, plot_w, row_h = 470, 92, 610, 62
    body = [
        '<text class="title" x="70" y="48">Effect estimates for temi minus walker</text>',
        '<text class="subtitle" x="70" y="72">Mean paired differences with bootstrap 95% confidence intervals.</text>',
    ]
    rows = stats.copy()
    labels = []
    values = []
    for _, r in rows.iterrows():
        label = r["label"]
        unit = r["unit"]
        labels.append(f"{label} ({unit})")
        values.extend([r["bootstrap_95ci_low"], r["bootstrap_95ci_high"], r["mean_difference_temi_minus_walker"]])
    xmin, xmax = min(values), max(values)
    pad = (xmax - xmin) * 0.18 if xmax > xmin else 1
    xmin, xmax = xmin - pad, xmax + pad
    def x(v: float) -> float:
        return x0 + (v - xmin) / (xmax - xmin) * plot_w
    zero_x = x(0)
    body.append(f'<line class="zero" x1="{zero_x}" y1="88" x2="{zero_x}" y2="{height - 75}"/>')
    for tick in np.linspace(xmin, xmax, 7):
        xx = x(float(tick))
        body.append(f'<line class="grid" x1="{xx}" y1="88" x2="{xx}" y2="{height - 75}"/>')
        body.append(f'<text class="tick" x="{xx}" y="{height - 42}" text-anchor="middle">{fmt(float(tick), 1)}</text>')
    for i, (_, r) in enumerate(rows.iterrows()):
        cy = y0 + i * row_h
        lo, hi, md = r["bootstrap_95ci_low"], r["bootstrap_95ci_high"], r["mean_difference_temi_minus_walker"]
        body.append(f'<text class="label" x="70" y="{cy + 5}">{svg_escape(r["label"])}</text>')
        body.append(f'<text class="note" x="70" y="{cy + 24}">p={fmt(r["exact_paired_permutation_p"], 3)}; Holm p={fmt(r["holm_adjusted_permutation_p"], 3)}; dz={fmt(r["cohens_dz"], 2)}</text>')
        body.append(f'<line class="ci" x1="{x(lo)}" y1="{cy}" x2="{x(hi)}" y2="{cy}"/>')
        body.append(f'<circle class="point" cx="{x(md)}" cy="{cy}" r="5.5"/>')
        body.append(f'<text class="tick" x="{x(hi) + 8}" y="{cy + 4}">{fmt(md, 2)}</text>')
    body.append(f'<text class="tick" x="{x0 + plot_w / 2}" y="{height - 18}" text-anchor="middle">Mean difference: temi minus walker</text>')
    write_svg(FIG / "effect-size-forest.svg", width, height, "\n".join(body))


def chart_latency(sessions: pd.DataFrame) -> None:
    width, height = 980, 610
    metrics = [
        ("average_question_generation_latency_ms", "Question generation"),
        ("average_tts_start_latency_ms", "TTS start"),
        ("average_next_question_transition_ms", "Transition"),
    ]
    means = {}
    for robot in ["temi", "walker"]:
        sub = sessions[sessions["robot_family"] == robot]
        means[robot] = [float(sub[m].mean()) / 1000 for m, _ in metrics]
    max_v = max(max(v) for v in means.values()) * 1.18
    x0, y0, plot_w, plot_h = 120, 90, 760, 390
    group_w = plot_w / len(metrics)
    bar_w = 62
    def y(v: float) -> float:
        return y0 + plot_h - v / max_v * plot_h
    body = [
        '<text class="title" x="70" y="48">Latency profile by robot platform</text>',
        '<text class="subtitle" x="70" y="72">Lower latency supports smoother turn-taking and perceived responsiveness.</text>',
    ]
    for tick in np.linspace(0, max_v, 6):
        yy = y(float(tick))
        body.append(f'<line class="grid" x1="{x0}" y1="{yy}" x2="{x0 + plot_w}" y2="{yy}"/>')
        body.append(f'<text class="tick" x="{x0 - 10}" y="{yy + 4}" text-anchor="end">{fmt(float(tick), 1)}</text>')
    for i, (_, label) in enumerate(metrics):
        gx = x0 + i * group_w + group_w / 2
        for robot, cls, dx in [("temi", "temi", -bar_w / 2 - 5), ("walker", "walker", 5)]:
            v = means[robot][i]
            body.append(f'<rect class="{cls}" x="{gx + dx}" y="{y(v)}" width="{bar_w}" height="{y0 + plot_h - y(v)}" rx="3"/>')
            body.append(f'<text class="tick" x="{gx + dx + bar_w / 2}" y="{y(v) - 8}" text-anchor="middle">{fmt(v, 2)}s</text>')
        body.append(f'<text class="label" x="{gx}" y="{y0 + plot_h + 38}" text-anchor="middle">{svg_escape(label)}</text>')
    body.append('<rect class="temi" x="710" y="42" width="16" height="16" rx="2"/><text class="tick" x="733" y="55">temi</text>')
    body.append('<rect class="walker" x="790" y="42" width="16" height="16" rx="2"/><text class="tick" x="813" y="55">walker</text>')
    body.append(f'<text class="tick" x="34" y="{y0 + plot_h / 2}" transform="rotate(-90 34 {y0 + plot_h / 2})" text-anchor="middle">Seconds</text>')
    write_svg(FIG / "latency-profile.svg", width, height, "\n".join(body))


def chart_questionnaire(questionnaires: pd.DataFrame) -> None:
    width, height = 1100, 610
    preferred = questionnaires["preferred_robot"].value_counts().to_dict()
    labels = ["temi", "walker", "both"]
    counts = [int(preferred.get(x, 0)) for x in labels]
    total = sum(counts) or 1
    x0, y0, plot_w, plot_h = 90, 120, 360, 350
    max_count = max(counts + [1])
    body = [
        '<text class="title" x="70" y="48">Questionnaire outcomes</text>',
        '<text class="subtitle" x="70" y="72">Subjective measures are summarized because the questionnaire was completed once after both robot sessions.</text>',
    ]
    for i, (label, count) in enumerate(zip(labels, counts)):
        x = x0 + i * 115
        h = count / max_count * plot_h
        cls = "temi" if label == "temi" else "walker" if label == "walker" else "point"
        body.append(f'<rect class="{cls}" x="{x}" y="{y0 + plot_h - h}" width="72" height="{h}" rx="4"/>')
        body.append(f'<text class="label" x="{x + 36}" y="{y0 + plot_h + 28}" text-anchor="middle">{label}</text>')
        body.append(f'<text class="tick" x="{x + 36}" y="{y0 + plot_h - h - 10}" text-anchor="middle">{count}/{total}</text>')
    body.append(f'<line class="axis" x1="{x0 - 20}" y1="{y0 + plot_h}" x2="{x0 + plot_w}" y2="{y0 + plot_h}"/>')
    q_metrics = [
        ("SUS", "sus_score", 0, 100),
        ("NASA-TLX", "nasa_tlx_mean", 1, 7),
        ("SASSI overall", "sassi_overall_mean", 1, 5),
        ("Likeability", "sassi_mean_likeability", 1, 5),
        ("Annoyance", "sassi_mean_annoyance", 1, 5),
    ]
    sx, sy = 580, 118
    body.append('<text class="label" x="580" y="102">Scale distributions</text>')
    for i, (label, col, min_v, max_v) in enumerate(q_metrics):
        y = sy + i * 80
        values = questionnaires[col].astype(float).to_numpy()
        mean = float(np.mean(values))
        sd = float(np.std(values, ddof=1))
        x1, x2 = sx + 160, sx + 450
        mx = x1 + (mean - min_v) / (max_v - min_v) * (x2 - x1)
        body.append(f'<text class="label" x="{sx}" y="{y + 4}">{label}</text>')
        body.append(f'<line class="grid" x1="{x1}" y1="{y}" x2="{x2}" y2="{y}"/>')
        body.append(f'<circle class="point" cx="{mx}" cy="{y}" r="6"/>')
        body.append(f'<text class="tick" x="{x2 + 18}" y="{y + 4}">M={fmt(mean, 2)}, SD={fmt(sd, 2)}</text>')
    write_svg(FIG / "questionnaire-summary.svg", width, height, "\n".join(body))


def write_report(stats: pd.DataFrame, questionnaires: pd.DataFrame) -> None:
    preferred = questionnaires["preferred_robot"].value_counts().to_dict()
    directional_preference_n = int(preferred.get("temi", 0) + preferred.get("walker", 0))
    temi_preference_n = int(preferred.get("temi", 0))
    preference_p = exact_binomial_two_sided(temi_preference_n, directional_preference_n, 0.5)
    n = int(stats["n_pairs"].max()) if len(stats) else 0
    best_rows = []
    for _, r in stats.iterrows():
        direction = r["better_direction"]
        md = r["mean_difference_temi_minus_walker"]
        if direction == "higher":
            advantage = "temi" if md > 0 else "walker"
        elif direction == "lower":
            advantage = "temi" if md < 0 else "walker"
        else:
            advantage = "contextual"
        best_rows.append((r["label"], advantage, r))
    lines = [
        "# Inferential Statistics Report",
        "",
        "Data source: `outputs/comparative-test-sessions/comparison-index.csv` and "
        "`outputs/comparative-questionnaires/all-questionnaire-responses.csv`.",
        f"Design: within-subject paired comparison, n = {n} participants, each using both temi and walker.",
        "",
        "## Method",
        "",
        "- Primary inferential test: exact paired permutation test on participant-level temi-minus-walker differences.",
        "- Robustness check: exact Wilcoxon signed-rank test.",
        "- Multiple comparison control: Holm correction across the tested behavioral metrics.",
        "- Effect sizes: paired Cohen's dz and rank-biserial r.",
        "- Intervals: non-parametric bootstrap 95% CI for the paired mean difference.",
        "",
        "## Main Results",
        "",
        "| Metric | temi mean | walker mean | Difference | 95% CI | Permutation p | Holm p | dz | Interpretation |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---|",
    ]
    for label, advantage, r in best_rows:
        lines.append(
            f"| {label} | {fmt(r['temi_mean'], 2)} | {fmt(r['walker_mean'], 2)} | "
            f"{fmt(r['mean_difference_temi_minus_walker'], 2)} | "
            f"[{fmt(r['bootstrap_95ci_low'], 2)}, {fmt(r['bootstrap_95ci_high'], 2)}] | "
            f"{fmt(r['exact_paired_permutation_p'], 3)} | {fmt(r['holm_adjusted_permutation_p'], 3)} | "
            f"{fmt(r['cohens_dz'], 2)} | {advantage} advantage |"
        )
    lines.extend(
        [
            "",
            "## Questionnaire Summary",
            "",
            f"- Preferred robot counts: temi = {preferred.get('temi', 0)}, walker = {preferred.get('walker', 0)}, both = {preferred.get('both', 0)}.",
            f"- Among participants with a directional preference, exact binomial p = {fmt(preference_p, 3)} "
            f"({temi_preference_n}/{directional_preference_n} preferred temi).",
            f"- SUS: M = {fmt(float(questionnaires['sus_score'].mean()), 2)}, SD = {fmt(float(questionnaires['sus_score'].std(ddof=1)), 2)}.",
            f"- NASA-TLX mean: M = {fmt(float(questionnaires['nasa_tlx_mean'].mean()), 2)}, SD = {fmt(float(questionnaires['nasa_tlx_mean'].std(ddof=1)), 2)}.",
            f"- SASSI overall: M = {fmt(float(questionnaires['sassi_overall_mean'].mean()), 2)}, SD = {fmt(float(questionnaires['sassi_overall_mean'].std(ddof=1)), 2)}.",
            "",
            "## Paper-Ready Interpretation",
            "",
            "The paired design supports participant-normalized comparison between robots. The behavioral logs indicate which platform produced higher attention and smoother timing, while the questionnaire provides subjective usability and preference context. Because the sample is small, exact tests and effect sizes should be emphasized over binary significance claims.",
        ]
    )
    (OUT / "inferential-statistics-report.md").write_text("\n".join(lines), encoding="utf-8")


def exact_binomial_two_sided(k: int, n: int, p: float = 0.5) -> float:
    if n <= 0:
        return 1.0
    probs = []
    for i in range(n + 1):
        prob = math.comb(n, i) * (p**i) * ((1 - p) ** (n - i))
        probs.append(prob)
    observed = probs[k]
    return min(1.0, sum(prob for prob in probs if prob <= observed + 1e-12))


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    FIG.mkdir(parents=True, exist_ok=True)
    sessions, questionnaires, paired = load_data()
    stats = compute_stats(paired)
    stats.to_csv(OUT / "inferential-statistics.csv", index=False, quoting=csv.QUOTE_MINIMAL)
    paired.to_csv(OUT / "paired-analysis-table.csv", index=False)
    with (OUT / "inferential-statistics.json").open("w", encoding="utf-8") as f:
        json.dump(json.loads(stats.to_json(orient="records")), f, indent=2)
    chart_paired_metrics(paired, stats)
    chart_forest(stats)
    chart_latency(sessions)
    chart_questionnaire(questionnaires)
    write_report(stats, questionnaires)
    print(f"Wrote inferential statistics outputs to {OUT}")


if __name__ == "__main__":
    main()
