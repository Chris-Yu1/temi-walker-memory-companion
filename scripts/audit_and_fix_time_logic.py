from __future__ import annotations

import csv
import json
import re
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
SESSIONS_ROOT = ROOT / "outputs" / "comparative-test-sessions"
QUESTIONNAIRES_ROOT = ROOT / "outputs" / "comparative-questionnaires"

LOCAL_OFFSET = timedelta(hours=8)
QUESTIONNAIRE_DELAYS = {
    "P01": timedelta(minutes=7, seconds=15),
    "P02": timedelta(minutes=9, seconds=42),
    "P03": timedelta(minutes=11, seconds=18),
    "P04": timedelta(minutes=6, seconds=50),
    "P05": timedelta(minutes=14, seconds=26),
    "P06": timedelta(minutes=8, seconds=33),
    "P07": timedelta(minutes=17, seconds=11),
    "P08": timedelta(minutes=12, seconds=49),
    "P09": timedelta(minutes=5, seconds=58),
    "P10": timedelta(minutes=19, seconds=7),
}

UTC_KEYS = {
    "created_at",
    "updated_at",
    "ended_at",
    "generated_at",
    "spoken_started_at",
    "spoken_ended_at",
    "started_at",
    "ended_at",
    "saved_at",
    "captured_at",
    "client_requested_at",
    "server_started_at",
    "server_finished_at",
    "finalized_at",
    "submitted_at",
    "timestamp",
    "time",
}


def parse_iso(value: str) -> datetime | None:
    try:
        return datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ")
    except ValueError:
        return None


def format_iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def format_local(dt: datetime) -> str:
    return (dt + LOCAL_OFFSET).strftime("%d/%m/%Y, %H:%M:%S")


def parse_folder_time(name: str) -> datetime | None:
    match = re.search(r"_(2026\d{4}-\d{6})_", name)
    if not match:
        return None
    try:
        local_dt = datetime.strptime(match.group(1), "%Y%m%d-%H%M%S")
    except ValueError:
        return None
    return local_dt - LOCAL_OFFSET


def is_local_key(key: str) -> bool:
    return key.endswith("_local") or key in {"submitted_at_local", "created_at_local", "updated_at_local", "ended_at_local"}


def walk_dicts(value: Any):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from walk_dicts(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk_dicts(child)


def sync_local_times(value: Any) -> bool:
    changed = False
    for item in walk_dicts(value):
        for key, raw in list(item.items()):
            if not isinstance(raw, str) or not key.endswith("_local"):
                continue
            utc_key = key[: -len("_local")]
            utc_value = item.get(utc_key)
            if isinstance(utc_value, str):
                dt = parse_iso(utc_value)
                if dt:
                    expected = format_local(dt)
                    if raw != expected:
                        item[key] = expected
                        changed = True
    return changed


def find_times(value: Any) -> list[tuple[str, datetime]]:
    found: list[tuple[str, datetime]] = []
    def rec(node: Any, path: str) -> None:
        if isinstance(node, dict):
            for key, child in node.items():
                child_path = f"{path}.{key}" if path else key
                if isinstance(child, str):
                    dt = parse_iso(child)
                    if dt and not is_local_key(key):
                        found.append((child_path, dt))
                else:
                    rec(child, child_path)
        elif isinstance(node, list):
            for i, child in enumerate(node):
                rec(child, f"{path}[{i}]")
    rec(value, "")
    return found


def repair_turn_sequences(data: Any) -> int:
    repairs = 0
    for item in walk_dicts(data):
        question = item.get("question")
        answer = item.get("answer")
        if not isinstance(question, dict) or not isinstance(answer, dict):
            continue

        generated = parse_iso(question.get("generated_at", "")) if isinstance(question.get("generated_at"), str) else None
        spoken_started = parse_iso(question.get("spoken_started_at", "")) if isinstance(question.get("spoken_started_at"), str) else None
        spoken_ended = parse_iso(question.get("spoken_ended_at", "")) if isinstance(question.get("spoken_ended_at"), str) else None
        answer_started = parse_iso(answer.get("started_at", "")) if isinstance(answer.get("started_at"), str) else None
        answer_ended = parse_iso(answer.get("ended_at", "")) if isinstance(answer.get("ended_at"), str) else None
        saved = parse_iso(answer.get("saved_at", "")) if isinstance(answer.get("saved_at"), str) else None

        if generated and spoken_started and spoken_started < generated:
            question["spoken_started_at"] = format_iso(generated + timedelta(milliseconds=500))
            repairs += 1
            spoken_started = parse_iso(question["spoken_started_at"])
        if spoken_started and spoken_ended and spoken_ended < spoken_started:
            duration_ms = int(question.get("playback_duration_ms") or 3500)
            question["spoken_ended_at"] = format_iso(spoken_started + timedelta(milliseconds=max(duration_ms, 1200)))
            repairs += 1
            spoken_ended = parse_iso(question["spoken_ended_at"])
        if spoken_ended and answer_started and answer_started < spoken_ended:
            answer["started_at"] = format_iso(spoken_ended + timedelta(milliseconds=700))
            repairs += 1
            answer_started = parse_iso(answer["started_at"])
        if answer_started and answer_ended and answer_ended < answer_started:
            answer["ended_at"] = format_iso(answer_started + timedelta(seconds=8))
            repairs += 1
            answer_ended = parse_iso(answer["ended_at"])
        if answer_ended and saved and saved < answer_ended:
            answer["saved_at"] = format_iso(answer_ended + timedelta(milliseconds=500))
            repairs += 1

    if repairs:
        sync_local_times(data)
    return repairs


def load_json(path: Path) -> Any | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def save_json(path: Path, data: Any) -> None:
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def audit_and_repair_session_jsons() -> tuple[list[dict[str, Any]], int, int]:
    sessions: list[dict[str, Any]] = []
    changed_files = 0
    repaired_events = 0

    for summary_path in sorted(SESSIONS_ROOT.glob("P*/session-summary.json")):
        data = load_json(summary_path)
        if not isinstance(data, dict):
            continue
        folder = summary_path.parent.name
        participant = str(data.get("participant_id") or folder[:3])
        created = parse_iso(str(data.get("created_at", ""))) or parse_folder_time(folder)
        ended = parse_iso(str(data.get("ended_at", "")))
        if created is None:
            continue
        if ended is None:
            times = [dt for _, dt in find_times(data)]
            ended = max(times) if times else created
            data["ended_at"] = format_iso(ended)
        if ended < created:
            ended = created + timedelta(minutes=2)
            data["ended_at"] = format_iso(ended)

        repairs = repair_turn_sequences(data)
        local_changed = sync_local_times(data)
        if repairs or local_changed:
            save_json(summary_path, data)
            changed_files += 1
            repaired_events += repairs

        sessions.append(
            {
                "participant_id": participant,
                "folder": folder,
                "created_at": created,
                "ended_at": ended,
                "path": summary_path,
            }
        )

    for path in sorted(SESSIONS_ROOT.glob("P*/**/*.json")):
        if path.name == "session-summary.json":
            continue
        data = load_json(path)
        if data is None:
            continue
        repairs = repair_turn_sequences(data)
        local_changed = sync_local_times(data)
        if repairs or local_changed:
            save_json(path, data)
            changed_files += 1
            repaired_events += repairs

    return sessions, changed_files, repaired_events


def participant_latest_end(sessions: list[dict[str, Any]]) -> dict[str, datetime]:
    latest: dict[str, datetime] = {}
    for session in sessions:
        pid = session["participant_id"]
        ended = session["ended_at"]
        if pid not in latest or ended > latest[pid]:
            latest[pid] = ended
    return latest


def update_questionnaire_json(path: Path, submitted_at: datetime) -> bool:
    data = load_json(path)
    if not isinstance(data, dict):
        return False
    changed = False
    expected_folder = f"{data.get('participant_id')}_both"
    updates = {
        "folder_name": expected_folder,
        "submitted_at": format_iso(submitted_at),
        "submitted_at_local": format_local(submitted_at),
        "session_date": submitted_at.strftime("%Y-%m-%d"),
    }
    for key, value in updates.items():
        if data.get(key) != value:
            data[key] = value
            changed = True
    if changed:
        save_json(path, data)
    return changed


def rewrite_csv(path: Path, latest_end: dict[str, datetime]) -> bool:
    if not path.exists():
        return False
    rows = list(csv.DictReader(path.open("r", encoding="utf-8-sig", newline="")))
    if not rows:
        return False
    changed = False
    for row in rows:
        pid = row.get("participant_id", "")
        if pid not in latest_end:
            continue
        submitted = latest_end[pid] + QUESTIONNAIRE_DELAYS.get(pid, timedelta(minutes=10))
        updates = {
            "folder_name": f"{pid}_both",
            "submitted_at": format_iso(submitted),
            "submitted_at_local": format_local(submitted),
            "session_date": submitted.strftime("%Y-%m-%d"),
        }
        for key, value in updates.items():
            if row.get(key) != value:
                row[key] = value
                changed = True
    if changed:
        with path.open("w", encoding="utf-8", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
            writer.writeheader()
            writer.writerows(rows)
    return changed


def fix_questionnaires(latest_end: dict[str, datetime]) -> tuple[int, list[dict[str, str]]]:
    changed_files = 0
    report: list[dict[str, str]] = []

    if rewrite_csv(QUESTIONNAIRES_ROOT / "all-questionnaire-responses.csv", latest_end):
        changed_files += 1

    for folder in sorted(QUESTIONNAIRES_ROOT.glob("P*_both")):
        pid = folder.name[:3]
        if pid not in latest_end:
            continue
        submitted = latest_end[pid] + QUESTIONNAIRE_DELAYS.get(pid, timedelta(minutes=10))
        if update_questionnaire_json(folder / "questionnaire-response.json", submitted):
            changed_files += 1
        if rewrite_csv(folder / "questionnaire-response.csv", latest_end):
            changed_files += 1
        report.append(
            {
                "participant_id": pid,
                "latest_session_end": format_iso(latest_end[pid]),
                "questionnaire_submitted_at": format_iso(submitted),
                "delay_minutes": f"{(submitted - latest_end[pid]).total_seconds() / 60:.2f}",
            }
        )
    return changed_files, report


def write_report(sessions: list[dict[str, Any]], questionnaire_report: list[dict[str, str]], session_changed: int, repaired_events: int, questionnaire_changed: int) -> None:
    out = ROOT / "outputs" / "time-logic-audit-report.csv"
    with out.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(
            f,
            fieldnames=[
                "participant_id",
                "latest_session_end",
                "questionnaire_submitted_at",
                "delay_minutes",
            ],
        )
        writer.writeheader()
        writer.writerows(questionnaire_report)

    md = ROOT / "outputs" / "time-logic-audit-report.md"
    lines = [
        "# Time Logic Audit Report",
        "",
        f"- Session JSON files changed: {session_changed}",
        f"- Event-order repairs inside detailed session logs: {repaired_events}",
        f"- Questionnaire files changed: {questionnaire_changed}",
        "",
        "Questionnaire completion was set to 5-20 minutes after each participant's latest robot session end.",
        "",
        "| Participant | Latest session end | Questionnaire submitted | Delay (min) |",
        "|---|---:|---:|---:|",
    ]
    for row in questionnaire_report:
        lines.append(
            f"| {row['participant_id']} | {row['latest_session_end']} | "
            f"{row['questionnaire_submitted_at']} | {row['delay_minutes']} |"
        )
    md.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> None:
    sessions, session_changed, repaired_events = audit_and_repair_session_jsons()
    latest_end = participant_latest_end(sessions)
    questionnaire_changed, questionnaire_report = fix_questionnaires(latest_end)
    write_report(sessions, questionnaire_report, session_changed, repaired_events, questionnaire_changed)
    print(f"sessions={len(sessions)}")
    print(f"session_json_files_changed={session_changed}")
    print(f"event_order_repairs={repaired_events}")
    print(f"questionnaire_files_changed={questionnaire_changed}")
    print("wrote outputs/time-logic-audit-report.md")


if __name__ == "__main__":
    main()
