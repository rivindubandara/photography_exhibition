"""Merge cleaned Subject/Blurb/Device from Downloads workbook into the image Excel."""
from __future__ import annotations

import re
import shutil
from pathlib import Path

from openpyxl import load_workbook

CLEAN = Path(r"C:\Users\RivinduB\Downloads\NT Photography Exhibition 2026 — Submissions.xlsx")
TARGET = Path(r"E:\Files\EXHIBITION\NT Photography Exhibition 2026 — Submissions.xlsx")
BACKUP = TARGET.with_name(TARGET.stem + " — before merge.xlsx")


def norm(s: str) -> str:
    s = str(s or "").casefold()
    s = re.sub(r"^title\s*:\s*", "", s)
    s = re.sub(r"[^\w\s]+", " ", s, flags=re.UNICODE)
    return re.sub(r"\s+", " ", s).strip()


def key(author: str, title: str) -> str:
    return f"{norm(author)}|{norm(title)}"


def is_bad_device(s: str) -> bool:
    s = (s or "").strip()
    if not s:
        return True
    return bool(re.match(r"^\(?s\)?\s*used to take", s, re.I)) or s.lower() in {
        "device",
        "device(s) used to take the photo",
        "(s) used to take the photo",
    }


def main() -> None:
    clean_wb = load_workbook(CLEAN, data_only=True)
    clean = clean_wb.active
    # Clean layout: ID, Title, Subject, Blurb, Author, Device, Image URL
    clean_map: dict[str, dict] = {}
    for r in range(2, clean.max_row + 1):
        row = {
            "title": clean.cell(r, 2).value or "",
            "subject": (clean.cell(r, 3).value or "").strip(),
            "blurb": (clean.cell(r, 4).value or "").strip(),
            "author": clean.cell(r, 5).value or "",
            "device": (clean.cell(r, 6).value or "").strip(),
        }
        k = key(row["author"], row["title"])
        if k in clean_map:
            print(f"WARN duplicate clean key: {k}")
        clean_map[k] = row

    # Keep formulas/images: load without data_only
    shutil.copy2(TARGET, BACKUP)
    print(f"Backup: {BACKUP}")

    wb = load_workbook(TARGET)
    ws = wb.active
    # Target layout: Photo, ID, Title, Subject, Blurb, Author, Device
    changes = {"subject": 0, "blurb": 0, "device": 0}
    unmatched = []
    matched = 0

    for r in range(2, ws.max_row + 1):
        title = ws.cell(r, 3).value or ""
        author = ws.cell(r, 6).value or ""
        sid = ws.cell(r, 2).value
        c = clean_map.get(key(author, title))
        if not c:
            unmatched.append(f"{sid}  {author}  |  {title}")
            continue
        matched += 1

        # Subject — take cleaned if present and different
        cur_subj = (ws.cell(r, 4).value or "").strip()
        if c["subject"] and c["subject"] != cur_subj:
            ws.cell(r, 4).value = c["subject"]
            changes["subject"] += 1

        # Blurb — prefer cleaned when it has content and differs
        cur_blurb = (ws.cell(r, 5).value or "").strip()
        if c["blurb"] and c["blurb"] != cur_blurb:
            ws.cell(r, 5).value = c["blurb"]
            changes["blurb"] += 1

        # Device — take cleaned if good; also replace bad placeholder devices
        cur_dev = (ws.cell(r, 7).value or "").strip()
        if c["device"] and not is_bad_device(c["device"]):
            if cur_dev != c["device"] or is_bad_device(cur_dev):
                if cur_dev != c["device"]:
                    changes["device"] += 1
                ws.cell(r, 7).value = c["device"]
        elif is_bad_device(cur_dev):
            ws.cell(r, 7).value = ""

    out = TARGET
    try:
        wb.save(out)
    except PermissionError:
        out = TARGET.with_name(TARGET.stem + " (merged).xlsx")
        wb.save(out)
        print(f"Target locked (close it in Excel/Cursor) — wrote alternate file instead.")

    print(f"Matched {matched}/{ws.max_row - 1}")
    print(f"Updated: {changes}")
    if unmatched:
        print(f"Unmatched in new (kept as-is): {len(unmatched)}")
        for u in unmatched:
            print(f"  {u}")

    only_clean = []
    new_keys = {
        key(ws.cell(r, 6).value or "", ws.cell(r, 3).value or "")
        for r in range(2, ws.max_row + 1)
    }
    for k, row in clean_map.items():
        if k not in new_keys:
            only_clean.append(f"{row['author']} | {row['title']}")
    if only_clean:
        print(f"Only in cleaned (not in new gallery): {len(only_clean)}")
        for u in only_clean:
            print(f"  {u}")
    print(f"Wrote {out}")


if __name__ == "__main__":
    main()
