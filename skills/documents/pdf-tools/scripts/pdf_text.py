#!/usr/bin/env python3
"""Extract text from a PDF: python pdf_text.py file.pdf [--pages 1-5] [--out file.txt]"""
import argparse
import shutil
import subprocess
import sys


def page_range(spec: str | None, n: int) -> list[int]:
    if not spec:
        return list(range(1, n + 1))
    out: list[int] = []
    for part in spec.split(","):
        a, _, b = part.partition("-")
        out.extend(range(int(a), int(b or a) + 1))
    return [p for p in out if 1 <= p <= n]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf")
    ap.add_argument("--pages")
    ap.add_argument("--out")
    a = ap.parse_args()
    pages: list[str] = []
    if shutil.which("pdftotext") and shutil.which("pdfinfo"):
        info = subprocess.run(["pdfinfo", a.pdf], capture_output=True, text=True).stdout
        n = int(next((l.split()[-1] for l in info.splitlines() if l.startswith("Pages:")), "0"))
        for p in page_range(a.pages, n):
            r = subprocess.run(["pdftotext", "-layout", "-f", str(p), "-l", str(p), a.pdf, "-"], capture_output=True, text=True)
            pages.append(r.stdout)
    else:
        try:
            from pypdf import PdfReader
        except ImportError:
            sys.exit("Install poppler-utils (pdftotext) or `pip install pypdf`.")
        reader = PdfReader(a.pdf)
        for p in page_range(a.pages, len(reader.pages)):
            pages.append(reader.pages[p - 1].extract_text() or "")
    empty = [i + 1 for i, t in enumerate(pages) if len(t.strip()) < 20]
    text = "\n\n".join(f"--- page {i + 1} ---\n{t.strip()}" for i, t in enumerate(pages))
    if a.out:
        open(a.out, "w", encoding="utf-8").write(text)
        print(f"wrote {a.out} ({len(text)} chars, {len(pages)} pages)")
    else:
        print(text)
    if empty:
        print(f"\n[note] pages with little/no text (scanned? try OCR): {empty}", file=sys.stderr)


if __name__ == "__main__":
    main()
