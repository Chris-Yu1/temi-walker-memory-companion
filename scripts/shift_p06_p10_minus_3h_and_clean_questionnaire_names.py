from __future__ import annotations

import re
from datetime import datetime, timedelta
from pathlib import Path


SESSIONS_ROOT = Path(__file__).resolve().parents[1] / "outputs" / "comparative-test-sessions"
QUESTIONNAIRE_ROOT = Path(__file__).resolve().parents[1] / "outputs" / "comparative-questionnaires"

SESSION_TARGETS = {"P06", "P07", "P08", "P09", "P10"}
SESSION_DELTA = timedelta(hours=-3)
TEXT_EXTENSIONS = {".csv", ".json", ".jsonl", ".txt", ".md", ".log", ".tsv", ".xml", ".html"}


def participant_from_session_name(name: str) -> str | None:
    match = re.match(r"^(P\d{2})_", name)
    if match and match.group(1) in SESSION_TARGETS:
        return match.group(1)
    return None


def line_participant(line: str) -> str | None:
    match = re.search(r'(^|[",])((?:P\d{2}))([",])', line)
    if match and match.group(2) in SESSION_TARGETS:
        return match.group(2)
    return None


def shift_compact(value: str, delta: timedelta) -> str:
    try:
        dt = datetime.strptime(value, "%Y%m%d-%H%M%S")
    except ValueError:
        return value
    return (dt + delta).strftime("%Y%m%d-%H%M%S")


def shift_iso_ms(value: str, delta: timedelta) -> str:
    try:
        dt = datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ")
    except ValueError:
        return value
    return (dt + delta).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def shift_local(value: str, delta: timedelta) -> str:
    try:
        dt = datetime.strptime(value, "%d/%m/%Y, %H:%M:%S")
    except ValueError:
        return value
    return (dt + delta).strftime("%d/%m/%Y, %H:%M:%S")


def shift_space_datetime(value: str, delta: timedelta) -> str:
    try:
        dt = datetime.strptime(value, "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return value
    return (dt + delta).strftime("%Y-%m-%d %H:%M:%S")


def shift_text(text: str, delta: timedelta) -> str:
    text = re.sub(r"2026\d{4}-\d{6}", lambda m: shift_compact(m.group(0), delta), text)
    text = re.sub(
        r"2026-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z",
        lambda m: shift_iso_ms(m.group(0), delta),
        text,
    )
    text = re.sub(
        r"\d{2}/\d{2}/2026, \d{2}:\d{2}:\d{2}",
        lambda m: shift_local(m.group(0), delta),
        text,
    )
    text = re.sub(
        r"2026-\d{2}-\d{2} \d{2}:\d{2}:\d{2}",
        lambda m: shift_space_datetime(m.group(0), delta),
        text,
    )
    return text


def read_text(path: Path) -> tuple[str, str] | None:
    raw = path.read_bytes()
    for encoding in ("utf-8", "utf-8-sig"):
        try:
            return raw.decode(encoding), encoding
        except UnicodeDecodeError:
            continue
    return None


def write_if_changed(path: Path, text: str, updated: str, encoding: str) -> bool:
    if updated != text:
        path.write_text(updated, encoding=encoding, newline="")
        return True
    return False


def process_file_times(path: Path, delta: timedelta) -> bool:
    if path.suffix.lower() not in TEXT_EXTENSIONS:
        return False
    decoded = read_text(path)
    if decoded is None:
        return False
    text, encoding = decoded
    return write_if_changed(path, text, shift_text(text, delta), encoding)


def process_session_csv_index(path: Path) -> bool:
    decoded = read_text(path)
    if decoded is None:
        return False
    text, encoding = decoded
    changed = False
    lines = []
    for line in text.splitlines(keepends=True):
        participant = line_participant(line)
        if participant:
            new_line = shift_text(line, SESSION_DELTA)
            changed = changed or new_line != line
            lines.append(new_line)
        else:
            lines.append(line)
    if changed:
        path.write_text("".join(lines), encoding=encoding, newline="")
    return changed


def process_session_json_index(path: Path) -> bool:
    decoded = read_text(path)
    if decoded is None:
        return False
    text, encoding = decoded

    def repl(match: re.Match[str]) -> str:
        participant = match.group(1)
        stamp = match.group(2)
        return f"{participant}_{shift_compact(stamp, SESSION_DELTA)}"

    updated = re.sub(r"\b(P06|P07|P08|P09|P10)_(2026\d{4}-\d{6})", repl, text)
    return write_if_changed(path, text, updated, encoding)


def shift_sessions() -> tuple[int, list[tuple[str, str]]]:
    changed_files = 0
    for name, processor in [
        ("comparison-index.csv", process_session_csv_index),
        ("comparison-index.json", process_session_json_index),
    ]:
        path = SESSIONS_ROOT / name
        if path.exists() and processor(path):
            changed_files += 1

    target_dirs = sorted([p for p in SESSIONS_ROOT.iterdir() if p.is_dir() and participant_from_session_name(p.name)])
    for directory in target_dirs:
        for path in sorted(directory.rglob("*")):
            if path.is_file() and process_file_times(path, SESSION_DELTA):
                changed_files += 1

    renamed: list[tuple[str, str]] = []
    for directory in sorted([p for p in SESSIONS_ROOT.iterdir() if p.is_dir() and participant_from_session_name(p.name)], key=lambda p: p.name, reverse=True):
        new_name = re.sub(r"2026\d{4}-\d{6}", lambda m: shift_compact(m.group(0), SESSION_DELTA), directory.name)
        if new_name != directory.name:
            target = directory.with_name(new_name)
            if target.exists():
                raise FileExistsError(f"Cannot rename {directory} to {target}: target exists")
            old_name = directory.name
            directory.rename(target)
            renamed.append((old_name, new_name))
    return changed_files, renamed


def questionnaire_clean_name(name: str) -> str:
    return re.sub(r"\b(P\d{2})_2026\d{4}-\d{6}_both\b", r"\1_both", name)


def clean_questionnaire_file(path: Path) -> bool:
    if path.suffix.lower() not in TEXT_EXTENSIONS:
        return False
    decoded = read_text(path)
    if decoded is None:
        return False
    text, encoding = decoded
    updated = questionnaire_clean_name(text)
    return write_if_changed(path, text, updated, encoding)


def clean_questionnaire_names() -> tuple[int, list[tuple[str, str]]]:
    changed_files = 0
    for path in sorted(QUESTIONNAIRE_ROOT.rglob("*")):
        if path.is_file() and clean_questionnaire_file(path):
            changed_files += 1

    renamed: list[tuple[str, str]] = []
    for directory in sorted([p for p in QUESTIONNAIRE_ROOT.iterdir() if p.is_dir()], key=lambda p: p.name, reverse=True):
        new_name = questionnaire_clean_name(directory.name)
        if new_name != directory.name:
            target = directory.with_name(new_name)
            if target.exists():
                raise FileExistsError(f"Cannot rename {directory} to {target}: target exists")
            old_name = directory.name
            directory.rename(target)
            renamed.append((old_name, new_name))
    return changed_files, renamed


def main() -> None:
    session_changed, session_renamed = shift_sessions()
    questionnaire_changed, questionnaire_renamed = clean_questionnaire_names()
    print(f"session_changed_files={session_changed}")
    print(f"session_renamed_dirs={len(session_renamed)}")
    for old, new in sorted(session_renamed):
        print(f"SESSION_RENAMED {old} -> {new}")
    print(f"questionnaire_changed_files={questionnaire_changed}")
    print(f"questionnaire_renamed_dirs={len(questionnaire_renamed)}")
    for old, new in sorted(questionnaire_renamed):
        print(f"QUESTIONNAIRE_RENAMED {old} -> {new}")


if __name__ == "__main__":
    main()
