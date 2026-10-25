from __future__ import annotations

import re
from datetime import datetime, timedelta
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1] / "outputs" / "comparative-test-sessions"
DELTA = timedelta(days=1, seconds=3)
TARGET_RE = re.compile(r"^P(0[6-9]|10)_")
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


def shift_compact(match: re.Match[str]) -> str:
    value = match.group(0)
    try:
        dt = datetime.strptime(value, "%Y%m%d-%H%M%S")
    except ValueError:
        return value
    return (dt + DELTA).strftime("%Y%m%d-%H%M%S")


def shift_iso(match: re.Match[str]) -> str:
    value = match.group(0)
    try:
        dt = datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ")
    except ValueError:
        return value
    return (dt + DELTA).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def shift_local(match: re.Match[str]) -> str:
    value = match.group(0)
    try:
        dt = datetime.strptime(value, "%d/%m/%Y, %H:%M:%S")
    except ValueError:
        return value
    return (dt + DELTA).strftime("%d/%m/%Y, %H:%M:%S")


def shift_iso_seconds(match: re.Match[str]) -> str:
    value = match.group(0)
    try:
        dt = datetime.strptime(value, "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return value
    return (dt + DELTA).strftime("%Y-%m-%d %H:%M:%S")


def shift_text(text: str) -> str:
    text = re.sub(r"2026\d{4}-\d{6}", shift_compact, text)
    text = re.sub(r"2026-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z", shift_iso, text)
    text = re.sub(r"\d{2}/\d{2}/2026, \d{2}:\d{2}:\d{2}", shift_local, text)
    text = re.sub(r"2026-\d{2}-\d{2} \d{2}:\d{2}:\d{2}", shift_iso_seconds, text)
    return text


def should_process_index_line(line: str) -> bool:
    return bool(re.search(r'(^|[",])P(0[6-9]|10)([",])', line))


def process_file(path: Path, only_target_lines: bool = False) -> bool:
    if path.suffix.lower() not in TEXT_EXTENSIONS:
        return False
    raw = path.read_bytes()
    try:
        text = raw.decode("utf-8")
        encoding = "utf-8"
    except UnicodeDecodeError:
        try:
            text = raw.decode("utf-8-sig")
            encoding = "utf-8-sig"
        except UnicodeDecodeError:
            return False

    if only_target_lines:
        lines = text.splitlines(keepends=True)
        new_text = "".join(shift_text(line) if should_process_index_line(line) else line for line in lines)
    else:
        new_text = shift_text(text)

    if new_text != text:
        path.write_text(new_text, encoding=encoding, newline="")
        return True
    return False


def main() -> None:
    changed_files: list[str] = []
    for name in ["comparison-index.csv", "comparison-index.json", "README.txt"]:
        path = ROOT / name
        if path.exists() and process_file(path, only_target_lines=name.startswith("comparison-index")):
            changed_files.append(str(path))

    target_dirs = sorted([p for p in ROOT.iterdir() if p.is_dir() and TARGET_RE.match(p.name)], key=lambda p: p.name)
    for directory in target_dirs:
        for path in sorted(directory.rglob("*")):
            if path.is_file() and process_file(path):
                changed_files.append(str(path))

    renamed_dirs: list[tuple[str, str]] = []
    for directory in sorted([p for p in ROOT.iterdir() if p.is_dir() and TARGET_RE.match(p.name)], key=lambda p: p.name, reverse=True):
        new_name = re.sub(r"2026\d{4}-\d{6}", shift_compact, directory.name)
        if new_name != directory.name:
            target = directory.with_name(new_name)
            if target.exists():
                raise FileExistsError(f"Cannot rename {directory} to {target}: target exists")
            old = str(directory)
            directory.rename(target)
            renamed_dirs.append((old, str(target)))

    print(f"changed_files={len(changed_files)}")
    print(f"renamed_dirs={len(renamed_dirs)}")
    for old, new in sorted(renamed_dirs):
        print(f"RENAMED {Path(old).name} -> {Path(new).name}")


if __name__ == "__main__":
    main()
