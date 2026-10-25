from __future__ import annotations

import csv
import json
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
SESSIONS_ROOT = ROOT / "outputs" / "comparative-test-sessions"
QUESTIONNAIRE_ROOT = ROOT / "outputs" / "comparative-questionnaires"
REPORT_CSV = ROOT / "outputs" / "questionnaire-user-info-sync-report.csv"
REPORT_MD = ROOT / "outputs" / "questionnaire-user-info-sync-report.md"


USER_FIELDS = ["participant_name", "age", "gender"]


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def save_json(path: Path, data: Any) -> None:
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def normalize_gender(value: Any) -> str:
    text = str(value).strip().lower()
    if text in {"m", "male", "man"}:
        return "male"
    if text in {"f", "female", "woman"}:
        return "female"
    return text


def normalize_profile(raw: dict[str, Any], participant_id: str) -> dict[str, Any]:
    return {
        "participant_name": str(raw.get("name") or raw.get("participant_name") or participant_id),
        "age": int(raw["age"]) if raw.get("age") not in (None, "") else "",
        "gender": normalize_gender(raw.get("gender", "")),
    }


def extract_profile_from_session_metadata(path: Path) -> dict[str, Any] | None:
    try:
        data = load_json(path)
    except Exception:
        return None
    participant_id = str(data.get("participant_id") or path.parents[1].name[:3])
    user_profile = data.get("user_profile")
    if not isinstance(user_profile, dict):
        return None
    return normalize_profile(user_profile, participant_id)


def collect_canonical_profiles() -> tuple[dict[str, dict[str, Any]], list[dict[str, str]]]:
    per_participant: dict[str, list[tuple[int, Path, dict[str, Any]]]] = {}
    conflicts: list[dict[str, str]] = []

    for metadata in sorted(SESSIONS_ROOT.glob("P*/01_user-and-session/session-metadata.json")):
        profile = extract_profile_from_session_metadata(metadata)
        if not profile:
            continue
        data = load_json(metadata)
        pid = str(data.get("participant_id") or metadata.parents[1].name[:3])
        test_order = int(data.get("test_order") or 0)
        per_participant.setdefault(pid, []).append((test_order, metadata, profile))

    canonical: dict[str, dict[str, Any]] = {}
    for pid, entries in sorted(per_participant.items()):
        entries = sorted(entries, key=lambda item: item[0])
        base = entries[-1][2].copy()
        canonical[pid] = base
        for _, metadata, profile in entries:
            for field in USER_FIELDS:
                if str(profile.get(field)) != str(base.get(field)):
                    conflicts.append(
                        {
                            "participant_id": pid,
                            "field": field,
                            "canonical_value": str(base.get(field)),
                            "conflicting_value": str(profile.get(field)),
                            "source": str(metadata),
                        }
                    )
    return canonical, conflicts


def update_questionnaire_json(path: Path, profiles: dict[str, dict[str, Any]], changes: list[dict[str, str]]) -> bool:
    data = load_json(path)
    pid = str(data.get("participant_id") or path.parent.name[:3])
    if pid not in profiles:
        return False
    changed = False
    for field, value in profiles[pid].items():
        old = data.get(field)
        if str(old) != str(value):
            data[field] = value
            changed = True
            changes.append(
                {
                    "file": str(path),
                    "participant_id": pid,
                    "field": field,
                    "old_value": str(old),
                    "new_value": str(value),
                }
            )
    if changed:
        save_json(path, data)
    return changed


def update_questionnaire_csv(path: Path, profiles: dict[str, dict[str, Any]], changes: list[dict[str, str]]) -> bool:
    if not path.exists():
        return False
    with path.open("r", encoding="utf-8-sig", newline="") as f:
        rows = list(csv.DictReader(f))
        fieldnames = list(rows[0].keys()) if rows else []
    changed = False
    for row in rows:
        pid = row.get("participant_id", "")
        if pid not in profiles:
            continue
        for field, value in profiles[pid].items():
            old = row.get(field)
            new = str(value)
            if old != new:
                row[field] = new
                changed = True
                changes.append(
                    {
                        "file": str(path),
                        "participant_id": pid,
                        "field": field,
                        "old_value": str(old),
                        "new_value": new,
                    }
                )
    if changed:
        with path.open("w", encoding="utf-8", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(rows)
    return changed


def write_reports(profiles: dict[str, dict[str, Any]], changes: list[dict[str, str]], conflicts: list[dict[str, str]]) -> None:
    with REPORT_CSV.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=["file", "participant_id", "field", "old_value", "new_value"])
        writer.writeheader()
        writer.writerows(changes)

    lines = [
        "# Questionnaire User Info Sync Report",
        "",
        "Source of truth: `outputs/comparative-test-sessions/Pxx_*/01_user-and-session/session-metadata.json`.",
        "",
        "## Canonical user profiles",
        "",
        "| Participant | Name | Age | Gender |",
        "|---|---:|---:|---|",
    ]
    for pid, profile in sorted(profiles.items()):
        lines.append(f"| {pid} | {profile['participant_name']} | {profile['age']} | {profile['gender']} |")
    lines.extend(
        [
            "",
            "## Sync summary",
            "",
            f"- Changed questionnaire fields: {len(changes)}",
            f"- Profile conflicts across duplicate robot sessions: {len(conflicts)}",
        ]
    )
    if conflicts:
        lines.extend(["", "## Conflicts", "", "| Participant | Field | Canonical | Conflicting | Source |", "|---|---|---|---|---|"])
        for item in conflicts:
            lines.append(
                f"| {item['participant_id']} | {item['field']} | {item['canonical_value']} | "
                f"{item['conflicting_value']} | {item['source']} |"
            )
    REPORT_MD.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> None:
    profiles, conflicts = collect_canonical_profiles()
    changes: list[dict[str, str]] = []
    changed_files = 0

    if update_questionnaire_csv(QUESTIONNAIRE_ROOT / "all-questionnaire-responses.csv", profiles, changes):
        changed_files += 1

    for folder in sorted(QUESTIONNAIRE_ROOT.glob("P*_both")):
        json_path = folder / "questionnaire-response.json"
        csv_path = folder / "questionnaire-response.csv"
        if json_path.exists() and update_questionnaire_json(json_path, profiles, changes):
            changed_files += 1
        if csv_path.exists() and update_questionnaire_csv(csv_path, profiles, changes):
            changed_files += 1

    write_reports(profiles, changes, conflicts)
    print(f"profiles={len(profiles)}")
    print(f"changed_files={changed_files}")
    print(f"changed_fields={len(changes)}")
    print(f"conflicts={len(conflicts)}")
    print(f"report={REPORT_MD}")


if __name__ == "__main__":
    main()
