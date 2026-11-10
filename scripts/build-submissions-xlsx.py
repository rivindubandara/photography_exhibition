"""Build an Excel catalogue of all exhibition submissions from Airtable + original docs."""
from __future__ import annotations

import json
import re
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

from concurrent.futures import ThreadPoolExecutor, as_completed
from io import BytesIO
from urllib.request import Request, urlopen

from openpyxl import Workbook
from openpyxl.drawing.image import Image as XLImage
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter
from PIL import Image as PILImage

ROOT = Path(__file__).resolve().parents[1]
SUBMISSION = Path(r"C:\Users\RivinduB\Desktop\Submission")
JSON_PATH = ROOT / "tmp-submissions.json"
OUT_PATH = ROOT / "NT Photography Exhibition 2026 — Submissions.xlsx"
IMG_CACHE = ROOT / "tmp-xlsx-images"
THUMB_MAX = (140, 175)  # px, 4:5-ish
XL_IMG_W, XL_IMG_H = 105, 131  # display size in Excel

FOLDER_ALIASES = {
    "gosia p": "gosia piotrowski",
    "jess amzallag": "jessica amzallag",
    "derek lee": "derek lee cheuk man",
}

W_NS = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}


def norm(s: str) -> str:
    s = (s or "").casefold()
    s = re.sub(r"^title\s*:\s*", "", s)
    s = re.sub(r"[“”\"'`‘’]", "", s)
    s = re.sub(r"[^\w\s]+", " ", s, flags=re.UNICODE)
    return re.sub(r"\s+", " ", s).strip()


def author_key(name: str) -> str:
    k = norm(name)
    return FOLDER_ALIASES.get(k, k)


def docx_text(path: Path) -> str:
    with zipfile.ZipFile(path) as z:
        xml = z.read("word/document.xml")
    root = ET.fromstring(xml)
    parts = []
    for p in root.findall(".//w:p", W_NS):
        texts = [t.text or "" for t in p.findall(".//w:t", W_NS)]
        line = "".join(texts).strip()
        if line:
            parts.append(line)
    return "\n".join(parts)


def txt_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="ignore")


def odt_text(path: Path) -> str:
    with zipfile.ZipFile(path) as z:
        xml = z.read("content.xml").decode("utf-8", errors="ignore")
    text = re.sub(r"<[^>]+>", "\n", xml)
    text = (
        text.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", '"')
        .replace("&#39;", "'")
    )
    lines = [re.sub(r"\s+", " ", l).strip() for l in text.splitlines() if l.strip()]
    return "\n".join(lines)


def title_from_filename(path: Path) -> str:
    stem = path.stem
    stem = re.sub(r"\s*[-–—]\s*blurb\s*$", "", stem, flags=re.I)
    stem = stem.rstrip(" .")
    return stem.strip()


def parse_serena_multi(text: str, folder_author: str, source: str) -> list[dict]:
    """One doc listing Photo 1…N titles / subjects / blurbs / devices."""
    titles, subjects, blurbs, devices = {}, {}, {}, {}
    mode = None
    for raw in text.splitlines():
        line = re.sub(r"\s+", " ", raw).strip()
        if not line:
            continue
        if re.match(r"^title\b", line, re.I):
            mode = "title"
            continue
        if re.match(r"^subject\b", line, re.I):
            mode = "subject"
            continue
        if re.match(r"^blurb\b", line, re.I):
            mode = "blurb"
            continue
        if re.match(r"^device", line, re.I):
            mode = "device"
            continue
        m = re.match(r"^photo\s*(\d+)\s*[:\-–]\s*(.+)$", line, re.I)
        if not m or not mode:
            continue
        n, val = int(m.group(1)), m.group(2).strip()
        if mode == "title":
            titles[n] = val
        elif mode == "subject":
            subjects[n] = val
        elif mode == "blurb":
            blurbs[n] = (blurbs.get(n, "") + " " + val).strip()
        elif mode == "device":
            devices[n] = val
    out = []
    for n in sorted(set(titles) | set(subjects) | set(blurbs) | set(devices)):
        out.append(
            {
                "folder_author": folder_author,
                "title": titles.get(n, ""),
                "subject": subjects.get(n, ""),
                "blurb": blurbs.get(n, ""),
                "device": devices.get(n, ""),
                "source": source,
            }
        )
    return out


def parse_parmdeep_odt(text: str, folder_author: str, source: str) -> list[dict]:
    device = ""
    dm = re.search(r"(?is)Taken with\s+(.+?)(?:\n\n|$)", text)
    if dm:
        device = re.sub(r"\s+", " ", dm.group(1)).strip()
        device = re.sub(r"(?i)^apple\s+", "Apple ", device)
        device = re.sub(r"(?i)\biphone\b", "iPhone", device)

    chunks = re.split(r"(?i)(?=Photo\s+\d)", text)
    rows = []
    for chunk in chunks:
        m = re.match(r"(?is)Photo\s+(\d+(?:\s*&\s*\d+)?)\s*(.*)", chunk.strip())
        if not m:
            continue
        nums = [int(x) for x in re.findall(r"\d+", m.group(1))]
        body = m.group(2).strip()
        body_lines = [l.strip() for l in body.splitlines() if l.strip()]
        title_bits = []
        blurb_bits = []
        for i, line in enumerate(body_lines):
            if re.match(r"(?i)^taken with", line):
                break
            if i < 3 and (line == "-" or len(line) < 40) and not blurb_bits:
                if line != "-":
                    title_bits.append(line)
                continue
            if not title_bits and len(line) < 60:
                title_bits.append(line)
                continue
            blurb_bits.append(line)
        title = " — ".join(title_bits).replace(" - ", " — ")
        title = re.sub(r"\s*—\s*—\s*", " — ", title).strip(" —")
        if nums == [1, 2]:
            paras = [p.strip() for p in re.split(r"(?<=\.)\s+(?=[A-Z])", " ".join(blurb_bits)) if p.strip()]
            for idx, n in enumerate(nums):
                rows.append(
                    {
                        "folder_author": folder_author,
                        "title": "Threshold — Atmosphere" + (" (II)" if n == 2 else ""),
                        "subject": "",
                        "blurb": paras[idx] if idx < len(paras) else " ".join(blurb_bits),
                        "device": device,
                        "source": source,
                    }
                )
        else:
            nice = {
                3: "Threshold — Intersection",
                4: "Threshold — Repetition",
            }.get(nums[0], title or f"Photo {nums[0]}")
            rows.append(
                {
                    "folder_author": folder_author,
                    "title": nice,
                    "subject": "",
                    "blurb": " ".join(blurb_bits),
                    "device": device,
                    "source": source,
                }
            )
    return rows


def is_boilerplate(line: str) -> bool:
    return bool(
        re.match(
            r"^(2026\s+photography\s+exhibition|written\s+submission|please\s+fill|"
            r"device\(s\)?\s*(used|:))",
            line,
            re.I,
        )
    )


def is_device_line(line: str) -> bool:
    if re.match(r"^device\b", line, re.I):
        return True
    if re.search(
        r"\b(iphone|ipad|gopro|canon|nikon|sony|fuji|olympus|pixel|samsung|leica|hasselblad)\b",
        line,
        re.I,
    ) and len(line) < 90:
        return True
    return False


def parse_doc(text: str) -> dict:
    compact = re.search(
        r"([^\n]{3,120}?)\s*Subject\s*:\s*([\s\S]*?)\s*Blurb\s*:\s*([\s\S]*?)(?:\s*Device\s*:|$)",
        text,
        re.I,
    )
    device = ""
    dm = re.search(r"Device\s*:\s*(.+)", text, re.I)
    if dm:
        device = dm.group(1).split("\n")[0].strip()

    if compact and not re.search(r"written submission", compact.group(1), re.I):
        title = re.sub(r"^2026 Photography Exhibition\s*", "", compact.group(1), flags=re.I).strip()
        return {
            "title": title,
            "subject": re.sub(r"\s+", " ", compact.group(2)).strip(),
            "blurb": re.sub(r"\s+", " ", compact.group(3)).strip(),
            "device": device,
        }

    lines = [re.sub(r"\s+", " ", l).strip() for l in text.splitlines() if l.strip()]
    title = subject = ""
    blurb_parts: list[str] = []
    mode = None

    for i, line in enumerate(lines):
        if is_boilerplate(line) and not mode:
            continue
        if re.match(r"^title\b", line, re.I):
            same = re.sub(r"^title\b", "", line, flags=re.I).lstrip(" :–-").strip()
            title = same or (lines[i + 1] if i + 1 < len(lines) else "")
            mode = None
            continue
        if re.match(r"^subject\b", line, re.I):
            same = re.sub(r"^subject\b", "", line, flags=re.I)
            same = re.sub(r"^\s*\(.*?\)\s*", "", same).lstrip(" :–-").strip()
            subject = same or (lines[i + 1] if i + 1 < len(lines) else "")
            mode = None
            continue
        if re.match(r"^blurb\b", line, re.I):
            same = re.sub(r"^blurb\b", "", line, flags=re.I)
            same = re.sub(r"^\s*\(.*?\)\s*", "", same).lstrip(" :–-)").strip()
            blurb_parts = [same] if same else []
            mode = "blurb"
            continue
        if is_device_line(line):
            if re.match(r"^device\b", line, re.I):
                device = re.sub(r"^device\b", "", line, flags=re.I).lstrip(" :–-").strip() or device
            else:
                device = device or line
            mode = None
            continue
        if mode == "blurb":
            blurb_parts.append(line)
            continue
        if not title and not is_boilerplate(line):
            title = line
            continue
        if title and not subject and not is_boilerplate(line) and not is_device_line(line):
            subject = line
            continue
        if title and subject and not is_boilerplate(line) and not is_device_line(line):
            blurb_parts.append(line)

    blurb = re.sub(r"\s+", " ", " ".join(blurb_parts)).strip().lstrip(")")
    if re.match(r"^(title|subject(\s*\(.*\))?)$", title or "", re.I):
        title = ""
    if re.match(r"^(blurb|subject(\s*\(.*\))?)$", blurb or "", re.I):
        blurb = ""
    return {"title": (title or "").strip(), "subject": (subject or "").strip(), "blurb": blurb, "device": device}


def collect_docs() -> list[dict]:
    rows = []
    if not SUBMISSION.is_dir():
        return rows
    for author_dir in sorted(SUBMISSION.iterdir()):
        if not author_dir.is_dir():
            continue
        author = author_dir.name
        for path in author_dir.rglob("*"):
            if not path.is_file() or path.name.startswith("~$"):
                continue
            ext = path.suffix.lower()
            try:
                if ext == ".docx":
                    text = docx_text(path)
                elif ext == ".txt":
                    text = txt_text(path)
                elif ext == ".odt":
                    text = odt_text(path)
                else:
                    continue
            except Exception as e:
                print(f"  skip {path}: {e}")
                continue

            # Multi-photo written submissions
            if author_key(author) == "serena franco" and re.search(r"Photo\s*1\s*:", text, re.I):
                rows.extend(parse_serena_multi(text, author, str(path)))
                continue
            if author_key(author) == "parmdeep thandi" and ext == ".odt":
                rows.extend(parse_parmdeep_odt(text, author, str(path)))
                continue

            parsed = parse_doc(text)
            # Blurb-only .txt (e.g. "defense. - Blurb.txt"): title from filename
            if ext == ".txt" and re.search(r"blurb", path.stem, re.I):
                parsed["title"] = title_from_filename(path)
                parsed["subject"] = ""
                parsed["blurb"] = re.sub(r"\s+", " ", text).strip()
            elif not parsed["title"] and ext == ".txt":
                parsed["title"] = title_from_filename(path)
                if not parsed["blurb"]:
                    parsed["blurb"] = re.sub(r"\s+", " ", text).strip()
            if not parsed["title"] and not parsed["blurb"] and not parsed["device"]:
                continue
            rows.append({"folder_author": author, **parsed, "source": str(path)})
    return rows


def best_doc_match(photo: dict, docs: list[dict]) -> dict | None:
    p_author = author_key(photo["submitter"])
    p_title = norm(photo["title"])
    candidates = [d for d in docs if author_key(d["folder_author"]) == p_author]
    if not candidates:
        # loose: any author if title matches uniquely
        candidates = docs

    exact = [d for d in candidates if norm(d["title"]) == p_title and p_title]
    if len(exact) == 1:
        return exact[0]
    if exact:
        # prefer same author
        same = [d for d in exact if author_key(d["folder_author"]) == p_author]
        return same[0] if same else exact[0]

    # partial title containment
    partial = [
        d
        for d in candidates
        if p_title and norm(d["title"]) and (p_title in norm(d["title"]) or norm(d["title"]) in p_title)
    ]
    if partial:
        same = [d for d in partial if author_key(d["folder_author"]) == p_author]
        pool = same or partial
        pool.sort(key=lambda d: abs(len(norm(d["title"])) - len(p_title)))
        return pool[0]
    return None


def download_thumb(number: str, url: str) -> Path | None:
    if not url:
        return None
    IMG_CACHE.mkdir(exist_ok=True)
    out = IMG_CACHE / f"{number}.jpg"
    if out.exists() and out.stat().st_size > 500:
        return out
    try:
        req = Request(url, headers={"User-Agent": "NT-Exhibition-Catalogue/1.0"})
        with urlopen(req, timeout=45) as r:
            raw = r.read()
        img = PILImage.open(BytesIO(raw))
        if img.mode not in ("RGB", "L"):
            img = img.convert("RGB")
        elif img.mode == "L":
            img = img.convert("RGB")
        img.thumbnail(THUMB_MAX, PILImage.Resampling.LANCZOS)
        img.save(out, format="JPEG", quality=85, optimize=True)
        return out
    except Exception as e:
        print(f"  image fail {number}: {e}")
        return None


def fetch_all_thumbs(rows: list[dict]) -> dict[str, Path]:
    paths: dict[str, Path] = {}
    jobs = [(r["number"], r.get("imageUrl") or r.get("fullUrl") or "") for r in rows]
    print(f"Downloading {len(jobs)} thumbnails…")
    with ThreadPoolExecutor(max_workers=8) as pool:
        futs = {pool.submit(download_thumb, n, u): n for n, u in jobs}
        done = 0
        for fut in as_completed(futs):
            n = futs[fut]
            path = fut.result()
            done += 1
            if path:
                paths[n] = path
            if done % 15 == 0 or done == len(jobs):
                print(f"  {done}/{len(jobs)}")
    return paths


def build_workbook(rows: list[dict], thumbs: dict[str, Path]) -> Workbook:
    wb = Workbook()
    ws = wb.active
    ws.title = "Submissions"

    headers = [
        "Photo",
        "Submission ID",
        "Title",
        "Subject",
        "Blurb",
        "Author",
        "Device",
    ]
    header_font = Font(name="Arial", bold=True, color="FFFFFF", size=11)
    header_fill = PatternFill("solid", fgColor="1F3A2E")
    cell_font = Font(name="Arial", size=10)
    thin = Border(
        left=Side(style="thin", color="D0D0D0"),
        right=Side(style="thin", color="D0D0D0"),
        top=Side(style="thin", color="D0D0D0"),
        bottom=Side(style="thin", color="D0D0D0"),
    )
    alt = PatternFill("solid", fgColor="F4F7F5")

    for col, h in enumerate(headers, 1):
        cell = ws.cell(1, col, h)
        cell.font = header_font
        cell.fill = header_fill
        cell.alignment = Alignment(vertical="center", wrap_text=True)
        cell.border = thin

    for r_i, row in enumerate(rows, 2):
        values = [
            "",  # photo cell — image anchored here
            row["number"],
            row["title"],
            row.get("subject") or "",
            row.get("blurb") or "",
            row["submitter"],
            row.get("device") or "",
        ]
        for c_i, val in enumerate(values, 1):
            cell = ws.cell(r_i, c_i, val)
            cell.font = cell_font
            cell.border = thin
            cell.alignment = Alignment(
                vertical="center" if c_i <= 2 else "top",
                wrap_text=c_i in (3, 4, 5, 7),
                horizontal="center" if c_i <= 2 else "left",
            )
            if r_i % 2 == 0:
                cell.fill = alt

        ws.row_dimensions[r_i].height = 108
        thumb = thumbs.get(row["number"])
        if thumb and thumb.exists():
            xl = XLImage(str(thumb))
            xl.width = XL_IMG_W
            xl.height = XL_IMG_H
            # slight inset so it sits inside the Photo cell
            ws.add_image(xl, f"A{r_i}")

    widths = [16, 14, 32, 36, 58, 22, 24]
    for i, w in enumerate(widths, 1):
        ws.column_dimensions[get_column_letter(i)].width = w
    ws.row_dimensions[1].height = 22
    ws.freeze_panes = "A2"
    ws.auto_filter.ref = f"A1:{get_column_letter(len(headers))}{len(rows) + 1}"

    notes = wb.create_sheet("Notes")
    notes["A1"] = "NT Photography Exhibition 2026 — Submissions catalogue"
    notes["A1"].font = Font(name="Arial", bold=True, size=12)
    notes["A3"] = (
        "Photos are embedded gallery thumbnails from Airtable. "
        "Submission ID, Title, Blurb, and Author are from Airtable. "
        "Subject and Device are enriched from Desktop\\Submission Word/txt files where matched."
    )
    notes["A3"].font = Font(name="Arial", size=10)
    notes["A3"].alignment = Alignment(wrap_text=True)
    notes.column_dimensions["A"].width = 100
    notes.row_dimensions[3].height = 60
    notes["A5"] = f"Total submissions: {len(rows)}"
    notes["A5"].font = Font(name="Arial", size=10)
    notes["A6"] = f"Embedded photos: {len(thumbs)}"
    notes["A6"].font = Font(name="Arial", size=10)
    return wb


def main() -> None:
    photos = json.loads(JSON_PATH.read_text(encoding="utf-8"))
    docs = collect_docs()
    print(f"Airtable photos: {len(photos)}")
    print(f"Parsed docs: {len(docs)}")

    enriched = []
    matched = 0
    for p in photos:
        doc = best_doc_match(p, docs)
        subject = device = ""
        if doc:
            matched += 1
            subject = doc.get("subject") or ""
            device = doc.get("device") or ""
            if not p.get("blurb") and doc.get("blurb"):
                p = {**p, "blurb": doc["blurb"]}
        enriched.append({**p, "subject": subject, "device": device})

    print(f"Matched subject/device for {matched}/{len(photos)}")
    thumbs = fetch_all_thumbs(enriched)
    print(f"Embedded thumbs ready: {len(thumbs)}/{len(enriched)}")

    wb = build_workbook(enriched, thumbs)
    wb.save(OUT_PATH)
    print(f"Wrote {OUT_PATH}")


if __name__ == "__main__":
    main()

