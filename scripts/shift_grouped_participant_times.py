from __future__ import annotations

import re
from datetime import datetime, timedelta
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1] / "outputs" / "comparative-test-sessions"

OFFSETS = {
    "P01": timedelta(minutes=4),
    "P04": timedelta(minutes=4),
    "P06": timedelta(minutes=4),
    "P09": timedelta(minutes=4),
    "P02": timedelta(minutes=-9),
    "P03": timedelta(minutes=-9),
    "P07": timedelta(minutes=-9),
    "P05": timedelta(minutes=7),
    "P08": timedelta(minutes=7),
    "P10": timedelta(minutes=7),
}

TEXT_EXTENSIONS = {
    ".csv",
    ".json",
    ".jsonl",
    ".txt",
    ".md",
    ".log",
    ".tsv",
    ".xml",
    ".html",
}


def participant_from_name(name: str) -> str | None:
    match = re.match(r"^(P\d{2})_", name)
    return match.group(1) if match and match.group(1) in OFFSETS else None


def line_participant(line: str) -> str | None:
    match = re.search(r'(^|[",])((?:P\d{2}))([",])', line)
    if match and match.group(2) in OFFSETS:
        return match.group(2)
    return None


def shift_compact(value: str, delta: timedelta) -> str:
    try:
        dt = datetime.strptime(value, "%Y%m%d-%H%M%S")
    except ValueError:
        return value
    return (dt + delta).strftime("%Y%m%d-%H%M%S")


def shift_iso(value: str, delta: timedelta) -> str:
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
        lambda m: shift_iso(m.group(0), delta),
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
            pass
    return None


def process_file(path: Path, delta: timedelta) -> bool:
    if path.suffix.lower() not in TEXT_EXTENSIONS:
        return False
    decoded = read_text(path)
    if decoded is None:
        return False
    text, encoding = decoded
    updated = shift_text(text, delta)
    if updated != text:
        path.write_text(updated, encoding=encoding, newline="")
        return True
    return False


def process_csv_index(path: Path) -> bool:
    decoded = read_text(path)
    if decoded is None:
        return False
    text, encoding = decoded
    updated_lines = []
    changed = False
    for line in text.splitlines(keepends=True):
        participant = line_participant(line)
        if participant:
            new_line = shift_text(line, OFFSETS[participant])
            changed = changed or new_line != line
            updated_lines.append(new_line)
        else:
            updated_lines.append(line)
    if changed:
        path.write_text("".join(updated_lines), encoding=encoding, newline="")
    return changed


def process_json_index(path: Path) -> bool:
    decoded = read_text(path)
    if decoded is None:
        return False
    text, encoding = decoded

    def repl(match: re.Match[str]) -> str:
        participant = match.group(1)
        stamp = match.group(2)
        return f"{participant}_{shift_compact(stamp, OFFSETS[participant])}"

    updated = re.sub(r"\b(P01|P02|P03|P04|P05|P06|P07|P08|P09|P10)_(2026\d{4}-\d{6})", repl, text)
    if updated != text:
        path.write_text(updated, encoding=encoding, newline="")
        return True
    return False


def main() -> None:
    changed_files: list[str] = []
    csv_index = ROOT / "comparison-index.csv"
    json_index = ROOT / "comparison-index.json"
    if csv_index.exists() and process_csv_index(csv_index):
        changed_files.append(str(csv_index))
    if json_index.exists() and process_json_index(json_index):
        changed_files.append(str(json_index))

    target_dirs = sorted([p for p in ROOT.iterdir() if p.is_dir() and participant_from_name(p.name)])
    for directory in target_dirs:
        participant = participant_from_name(directory.name)
        assert participant is not None
        delta = OFFSETS[participant]
        for path in sorted(directory.rglob("*")):
            if path.is_file() and process_file(path, delta):
                changed_files.append(str(path))

    renamed: list[tuple[str, str]] = []
    for directory in sorted([p for p in ROOT.iterdir() if p.is_dir() and participant_from_name(p.name)], key=lambda p: p.name, reverse=True):
        participant = participant_from_name(directory.name)
        assert participant is not None
        new_name = re.sub(r"2026\d{4}-\d{6}", lambda m: shift_compact(m.group(0), OFFSETS[participant]), directory.name)
        if new_name != directory.name:
            target = directory.with_name(new_name)
            if target.exists():
                raise FileExistsError(f"Cannot rename {directory} to {target}: target exists")
            old_name = directory.name
            directory.rename(target)
            renamed.append((old_name, new_name))

    print(f"changed_files={len(changed_files)}")
    print(f"renamed_dirs={len(renamed)}")
    for old, new in sorted(renamed):
        print(f"RENAMED {old} -> {new}")


if __name__ == "__main__":
    main()
