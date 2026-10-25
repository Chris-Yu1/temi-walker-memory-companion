from __future__ import annotations

import csv
import json
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from statistics import mean
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
OUTPUTS = ROOT / "outputs"
TEST_SESSIONS = OUTPUTS / "test-sessions"
QUESTIONNAIRES = OUTPUTS / "questionnaires"
ANALYSIS = OUTPUTS / "analysis"


SESSION_COLUMNS = [
    "participant_name",
    "robot_family",
    "robot_id",
    "session_id",
    "test_folder_name",
    "created_at",
    "created_at_local",
    "ended_at",
    "ended_at_local",
    "session_duration_ms",
    "photo_id",
    "question_count",
    "answered_turn_count",
    "valid_answer_count",
    "valid_answer_rate",
    "mean_question_api_latency_ms",
    "mean_question_to_answer_start_ms",
    "mean_answer_duration_ms",
    "mean_attention_score",
    "central_gaze_rate",
    "turn_taking_endpoint_rate",
    "turn_taking_uncertain_rate",
    "session_audio_path",
    "source_path",
]


QUESTIONNAIRE_SCORE_COLUMNS = [
    "participant_name",
    "participant_id",
    "robot_used",
    "session_order",
    "submitted_at",
    "sus_score",
    "nasa_tlx_mean",
    "sassi_overall_mean",
    "sassi_mean_accuracy",
    "sassi_mean_likeability",
    "sassi_mean_cognitive_demand",
    "sassi_mean_annoyance",
    "sassi_mean_habitability",
    "sassi_mean_speed",
]


PAIR_COLUMNS = [
    "participant_name",
    "walker_session_id",
    "temi_session_id",
    "walker_question_count",
    "temi_question_count",
    "delta_question_count_walker_minus_temi",
    "walker_valid_answer_rate",
    "temi_valid_answer_rate",
    "delta_valid_answer_rate_walker_minus_temi",
    "walker_mean_question_api_latency_ms",
    "temi_mean_question_api_latency_ms",
    "delta_latency_ms_walker_minus_temi",
    "walker_mean_attention_score",
    "temi_mean_attention_score",
    "delta_attention_walker_minus_temi",
    "walker_central_gaze_rate",
    "temi_central_gaze_rate",
    "delta_central_gaze_rate_walker_minus_temi",
    "walker_turn_taking_endpoint_rate",
    "temi_turn_taking_endpoint_rate",
    "delta_endpoint_rate_walker_minus_temi",
]


def main() -> None:
    ANALYSIS.mkdir(parents=True, exist_ok=True)
    session_rows = collect_session_rows()
    questionnaire_rows = collect_questionnaire_rows()
    paired_rows = build_paired_rows(session_rows)

    write_csv(ANALYSIS / "robot-session-analysis.csv", session_rows, SESSION_COLUMNS)
    write_csv(ANALYSIS / "questionnaire-score-summary.csv", questionnaire_rows, QUESTIONNAIRE_SCORE_COLUMNS)
    write_csv(ANALYSIS / "walker-temi-paired-comparison.csv", paired_rows, PAIR_COLUMNS)
    write_json(
        ANALYSIS / "analysis-manifest.json",
        {
            "generated_at": datetime.now().isoformat(timespec="seconds"),
            "session_count": len(session_rows),
            "questionnaire_count": len(questionnaire_rows),
            "paired_participant_count": len(paired_rows),
            "files": [
                "robot-session-analysis.csv",
                "questionnaire-score-summary.csv",
                "walker-temi-paired-comparison.csv",
            ],
        },
    )
    print(f"Wrote analysis files to {ANALYSIS}")


def collect_session_rows() -> list[dict[str, Any]]:
    if not TEST_SESSIONS.exists():
        return []
    rows = []
    for folder in sorted(path for path in TEST_SESSIONS.iterdir() if path.is_dir()):
        row = read_session_row(folder)
        if row:
            rows.append(row)
    return rows


def read_session_row(folder: Path) -> dict[str, Any] | None:
    metrics = read_json(folder / "08_metrics" / "session-metrics.json")
    if metrics:
        row = {key: metrics.get(key) for key in SESSION_COLUMNS}
        row["source_path"] = str(folder)
        return row

    summary = read_json(folder / "session-summary.json")
    if not summary:
        return None

    turns = summary.get("turns") or []
    questions = [turn for turn in turns if turn.get("question")]
    answers = [turn for turn in turns if turn.get("answer")]
    valid_answers = [turn for turn in answers if str(turn.get("answer") or "").strip()]
    attention_samples = read_json(folder / "04_headpose-eyegaze-log" / "attention-samples.json") or []
    turn_taking = read_json(folder / "05_turn-taking-log" / "turn-taking-traces.json") or []

    return {
        "participant_name": nested(summary, "user_profile", "name") or infer_name_from_folder(folder.name),
        "robot_family": infer_robot_family(summary.get("robot_id")),
        "robot_id": summary.get("robot_id"),
        "session_id": summary.get("session_id"),
        "test_folder_name": folder.name,
        "created_at": summary.get("created_at"),
        "created_at_local": summary.get("created_at_local"),
        "ended_at": summary.get("ended_at"),
        "ended_at_local": summary.get("ended_at_local"),
        "session_duration_ms": duration_ms(summary.get("created_at"), summary.get("ended_at")),
        "photo_id": summary.get("photo_id"),
        "question_count": len(questions),
        "answered_turn_count": len(answers),
        "valid_answer_count": len(valid_answers),
        "valid_answer_rate": safe_div(len(valid_answers), len(questions)),
        "mean_question_api_latency_ms": mean_or_none(
            nested(turn, "question_metadata", "api_latency_ms") or nested(turn, "question_metadata", "latency_ms")
            for turn in turns
        ),
        "mean_question_to_answer_start_ms": mean_or_none(
            duration_ms(turn.get("question_asked_at") or turn.get("question_at"), turn.get("answer_started_at"))
            for turn in turns
        ),
        "mean_answer_duration_ms": mean_or_none(
            duration_ms(turn.get("answer_started_at"), turn.get("answer_completed_at") or turn.get("answer_at"))
            for turn in turns
        ),
        "mean_attention_score": mean_or_none(sample.get("attention_score") for sample in attention_samples),
        "central_gaze_rate": safe_div(
            sum(1 for sample in attention_samples if str(sample.get("eye_gaze_direction", "")).lower() == "central"),
            len(attention_samples),
        ),
        "turn_taking_endpoint_rate": safe_div(
            sum(1 for trace in turn_taking if str(trace.get("decision")) == "1"),
            len(turn_taking),
        ),
        "turn_taking_uncertain_rate": safe_div(
            sum(1 for trace in turn_taking if str(trace.get("decision")) == "2"),
            len(turn_taking),
        ),
        "session_audio_path": nested(summary, "audio", "session_recording_path"),
        "source_path": str(folder),
    }


def collect_questionnaire_rows() -> list[dict[str, Any]]:
    rows = []
    aggregate = QUESTIONNAIRES / "all-questionnaire-responses.csv"
    if aggregate.exists():
        with aggregate.open("r", encoding="utf-8-sig", newline="") as handle:
            for row in csv.DictReader(handle):
                rows.append({key: row.get(key, "") for key in QUESTIONNAIRE_SCORE_COLUMNS})
        return rows

    if not QUESTIONNAIRES.exists():
        return []
    for response in QUESTIONNAIRES.glob("*/questionnaire-response.json"):
        data = read_json(response) or {}
        scores = data.get("scores") or {}
        participant = data.get("participant") or {}
        rows.append(
            {
                "participant_name": participant.get("name"),
                "participant_id": participant.get("participant_id"),
                "robot_used": participant.get("robot_used"),
                "session_order": participant.get("session_order"),
                "submitted_at": data.get("submitted_at"),
                "sus_score": scores.get("sus_score"),
                "nasa_tlx_mean": scores.get("nasa_tlx_mean"),
                "sassi_overall_mean": scores.get("sassi_overall_mean"),
                **{f"sassi_mean_{key}": value for key, value in (scores.get("sassi_category_means") or {}).items()},
            }
        )
    return rows


def build_paired_rows(session_rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_participant: dict[str, dict[str, list[dict[str, Any]]]] = defaultdict(lambda: defaultdict(list))
    for row in session_rows:
        name = normalize_name(row.get("participant_name"))
        family = infer_robot_family(row.get("robot_family") or row.get("robot_id"))
        if name and family in {"walker", "temi"}:
            by_participant[name][family].append(row)

    paired = []
    for name, robots in sorted(by_participant.items()):
        if not robots.get("walker") or not robots.get("temi"):
            continue
        walker = latest_row(robots["walker"])
        temi = latest_row(robots["temi"])
        paired.append(
            {
                "participant_name": walker.get("participant_name") or temi.get("participant_name") or name,
                "walker_session_id": walker.get("session_id"),
                "temi_session_id": temi.get("session_id"),
                "walker_question_count": walker.get("question_count"),
                "temi_question_count": temi.get("question_count"),
                "delta_question_count_walker_minus_temi": diff(walker.get("question_count"), temi.get("question_count")),
                "walker_valid_answer_rate": walker.get("valid_answer_rate"),
                "temi_valid_answer_rate": temi.get("valid_answer_rate"),
                "delta_valid_answer_rate_walker_minus_temi": diff(walker.get("valid_answer_rate"), temi.get("valid_answer_rate")),
                "walker_mean_question_api_latency_ms": walker.get("mean_question_api_latency_ms"),
                "temi_mean_question_api_latency_ms": temi.get("mean_question_api_latency_ms"),
                "delta_latency_ms_walker_minus_temi": diff(walker.get("mean_question_api_latency_ms"), temi.get("mean_question_api_latency_ms")),
                "walker_mean_attention_score": walker.get("mean_attention_score"),
                "temi_mean_attention_score": temi.get("mean_attention_score"),
                "delta_attention_walker_minus_temi": diff(walker.get("mean_attention_score"), temi.get("mean_attention_score")),
                "walker_central_gaze_rate": walker.get("central_gaze_rate"),
                "temi_central_gaze_rate": temi.get("central_gaze_rate"),
                "delta_central_gaze_rate_walker_minus_temi": diff(walker.get("central_gaze_rate"), temi.get("central_gaze_rate")),
                "walker_turn_taking_endpoint_rate": walker.get("turn_taking_endpoint_rate"),
                "temi_turn_taking_endpoint_rate": temi.get("turn_taking_endpoint_rate"),
                "delta_endpoint_rate_walker_minus_temi": diff(walker.get("turn_taking_endpoint_rate"), temi.get("turn_taking_endpoint_rate")),
            }
        )
    return paired


def latest_row(rows: list[dict[str, Any]]) -> dict[str, Any]:
    return sorted(rows, key=lambda row: row.get("created_at") or row.get("test_folder_name") or "")[-1]


def write_csv(path: Path, rows: list[dict[str, Any]], columns: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow(row)


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False), encoding="utf-8")


def read_json(path: Path) -> Any | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except json.JSONDecodeError:
        return None


def nested(value: dict[str, Any], *keys: str) -> Any:
    current: Any = value
    for key in keys:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


def mean_or_none(values: Any) -> float | None:
    numbers = [float(value) for value in values if is_number(value)]
    return round(mean(numbers), 3) if numbers else None


def duration_ms(start: Any, end: Any) -> int | None:
    start_dt = parse_dt(start)
    end_dt = parse_dt(end)
    if not start_dt or not end_dt:
        return None
    return int((end_dt - start_dt).total_seconds() * 1000)


def parse_dt(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


def safe_div(numerator: int | float, denominator: int | float) -> float | None:
    if not denominator:
        return None
    return round(float(numerator) / float(denominator), 3)


def diff(left: Any, right: Any) -> float | None:
    if not is_number(left) or not is_number(right):
        return None
    return round(float(left) - float(right), 3)


def is_number(value: Any) -> bool:
    try:
        float(value)
        return True
    except (TypeError, ValueError):
        return False


def normalize_name(value: Any) -> str:
    return str(value or "").strip().lower()


def infer_name_from_folder(name: str) -> str:
    return name.split("_", 1)[0].replace("-", " ").strip()


def infer_robot_family(value: Any) -> str:
    text = str(value or "").lower()
    if "walker" in text:
        return "walker"
    if "temi" in text:
        return "temi"
    return text or "unknown"


if __name__ == "__main__":
    main()
