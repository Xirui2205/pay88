"""Render stable bilingual operator and field PDFs from maintained Markdown."""

from __future__ import annotations

import html
import re
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    BaseDocTemplate,
    Frame,
    KeepTogether,
    PageBreak,
    PageTemplate,
    Paragraph,
    Preformatted,
    Spacer,
)

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "output" / "pdf"

DOCS = [
    (ROOT / "docs/en/field-phone-installation.md", OUT / "telebirr-field-phone-installation-en.pdf", "EN", "field"),
    (ROOT / "docs/zh-CN/field-phone-installation.md", OUT / "telebirr-field-phone-installation-zh-CN.pdf", "ZH", "field"),
    (ROOT / "docs/en/phone-installation.md", OUT / "telebirr-phone-installation-en.pdf", "EN", "operator"),
    (ROOT / "docs/zh-CN/phone-installation.md", OUT / "telebirr-phone-installation-zh-CN.pdf", "ZH", "operator"),
    (ROOT / "docs/en/operations.md", OUT / "telebirr-operations-runbook-en.pdf", "EN", "operator"),
    (ROOT / "docs/zh-CN/operations.md", OUT / "telebirr-operations-runbook-zh-CN.pdf", "ZH", "operator"),
    (ROOT / "docs/zh-CN/deployment.md", OUT / "telebirr-deployment-guide-zh-CN.pdf", "ZH", "operator"),
]


class ManualDocTemplate(BaseDocTemplate):
    def __init__(self, filename: str, title: str, font: str, copy_label: str):
        super().__init__(
            filename,
            pagesize=A4,
            leftMargin=20 * mm,
            rightMargin=20 * mm,
            topMargin=22 * mm,
            bottomMargin=18 * mm,
            title=title,
            author="Telebirr P2P Platform",
        )
        self.manual_title = title
        self.font_name = font
        self.copy_label = copy_label
        frame = Frame(self.leftMargin, self.bottomMargin, self.width, self.height, id="body")
        self.addPageTemplates([PageTemplate(id="manual", frames=[frame], onPage=self._page)])

    def _page(self, canvas, doc):
        canvas.saveState()
        canvas.setStrokeColor(colors.HexColor("#DDE5E2"))
        canvas.setLineWidth(0.5)
        canvas.line(20 * mm, A4[1] - 15 * mm, A4[0] - 20 * mm, A4[1] - 15 * mm)
        canvas.setFont(self.font_name, 8)
        canvas.setFillColor(colors.HexColor("#5F6F69"))
        canvas.drawString(20 * mm, A4[1] - 11.5 * mm, self.copy_label)
        canvas.drawRightString(A4[0] - 20 * mm, 10 * mm, f"Page {doc.page}")
        canvas.restoreState()


def register_fonts() -> None:
    pdfmetrics.registerFont(TTFont("ManualLatin", r"C:\Windows\Fonts\arial.ttf"))
    pdfmetrics.registerFont(TTFont("ManualLatinBold", r"C:\Windows\Fonts\arialbd.ttf"))
    variable_cjk = Path(r"C:\Windows\Fonts\NotoSansSC-VF.ttf")
    font_cache = ROOT / "tmp" / "fonts"
    regular_cjk = font_cache / "NotoSansSC-Regular.ttf"
    bold_cjk = font_cache / "NotoSansSC-Bold.ttf"
    try:
        if not regular_cjk.exists() or not bold_cjk.exists():
            from fontTools.ttLib import TTFont as FontToolsTTFont
            from fontTools.varLib.instancer import instantiateVariableFont

            font_cache.mkdir(parents=True, exist_ok=True)
            for target, weight in ((regular_cjk, 400), (bold_cjk, 700)):
                variable_font = FontToolsTTFont(str(variable_cjk))
                instantiateVariableFont(variable_font, {"wght": weight}, inplace=True)
                variable_font.save(str(target))
                variable_font.close()
    except (ImportError, OSError):
        # The variable font still embeds and renders correctly; only the
        # visual weight differs when fontTools is unavailable.
        regular_cjk = variable_cjk
        bold_cjk = variable_cjk
    pdfmetrics.registerFont(TTFont("ManualCJK", str(regular_cjk)))
    pdfmetrics.registerFont(TTFont("ManualCJKBold", str(bold_cjk)))


def styles(font: str, bold: str, field: bool = False):
    base = getSampleStyleSheet()
    body_size = 10.6 if field else 9.4
    body_leading = 16.2 if field else 14.2
    bullet_size = 10.5 if field else 9.2
    bullet_leading = 16.4 if field else 14
    return {
        "title": ParagraphStyle(
            "ManualTitle", parent=base["Title"], fontName=bold, fontSize=23,
            leading=29, textColor=colors.HexColor("#125A43"), alignment=TA_LEFT,
            spaceAfter=12 * mm,
        ),
        "h1": ParagraphStyle(
            "H1", parent=base["Heading1"], fontName=bold, fontSize=17 if field else 15,
            leading=22 if field else 20, textColor=colors.HexColor("#125A43"), spaceBefore=7 * mm,
            spaceAfter=3 * mm, keepWithNext=True,
        ),
        "h2": ParagraphStyle(
            "H2", parent=base["Heading2"], fontName=bold, fontSize=13 if field else 12,
            leading=18 if field else 16, textColor=colors.HexColor("#2B6B58"), spaceBefore=5 * mm,
            spaceAfter=2 * mm, keepWithNext=True,
        ),
        "body": ParagraphStyle(
            "Body", parent=base["BodyText"], fontName=font, fontSize=body_size,
            leading=body_leading, textColor=colors.HexColor("#26332F"), spaceAfter=1.8 * mm,
        ),
        "bullet": ParagraphStyle(
            "Bullet", parent=base["BodyText"], fontName=font, fontSize=bullet_size,
            leading=bullet_leading, leftIndent=7 * mm, firstLineIndent=-5 * mm,
            bulletIndent=1 * mm, textColor=colors.HexColor("#26332F"), spaceAfter=1.2 * mm,
        ),
        "note": ParagraphStyle(
            "Note", parent=base["BodyText"], fontName=bold, fontSize=10.4 if field else 9.2,
            leading=15.5 if field else 14, leftIndent=5 * mm, rightIndent=5 * mm, borderWidth=0.7,
            borderColor=colors.HexColor("#E1A95F"), borderPadding=7,
            backColor=colors.HexColor("#FFF8EA"), textColor=colors.HexColor("#5C421D"),
            spaceBefore=2 * mm, spaceAfter=4 * mm,
        ),
        "stop": ParagraphStyle(
            "Stop", parent=base["BodyText"], fontName=bold, fontSize=10.6 if field else 9.2,
            leading=16 if field else 14, leftIndent=5 * mm, rightIndent=5 * mm, borderWidth=1,
            borderColor=colors.HexColor("#C43E53"), borderPadding=8,
            backColor=colors.HexColor("#FFF0F2"), textColor=colors.HexColor("#8C2436"),
            spaceBefore=2 * mm, spaceAfter=4 * mm,
        ),
        "code": ParagraphStyle(
            "Code", fontName=font, fontSize=8, leading=11,
            leftIndent=4 * mm, rightIndent=4 * mm, borderPadding=6,
            backColor=colors.HexColor("#F1F5F3"), textColor=colors.HexColor("#173D31"),
            spaceBefore=2 * mm, spaceAfter=3 * mm,
        ),
        "cover": ParagraphStyle(
            "Cover", fontName=font, fontSize=10, leading=16, alignment=TA_CENTER,
            textColor=colors.HexColor("#5F6F69"),
        ),
    }


def inline(text: str) -> str:
    value = html.escape(text.strip())
    value = re.sub(
        r"\[([^\]]+)\]\((https?://[^)]+)\)",
        r"<link href='\2' color='#0E6B4E'><u>\1</u></link>",
        value,
    )
    value = re.sub(r"`([^`]+)`", r"<font color='#0E6B4E'>\1</font>", value)
    value = re.sub(r"\*\*([^*]+)\*\*", r"<b>\1</b>", value)
    return value


def parse_markdown(markdown: str, style_map: dict[str, Paragraph], field: bool = False, language: str = "EN"):
    lines = markdown.splitlines()
    story = []
    code: list[str] = []
    in_code = False
    title_seen = False

    for raw in lines:
        line = raw.rstrip()
        if line.startswith("```"):
            if in_code:
                story.append(Preformatted("\n".join(code), style_map["code"]))
                code = []
            in_code = not in_code
            continue
        if in_code:
            code.append(line)
            continue
        if not line.strip():
            continue
        if line.strip() == "<!-- pagebreak -->":
            story.append(PageBreak())
            continue
        if line.startswith("# "):
            if title_seen:
                story.append(PageBreak())
            story.append(Spacer(1, 12 * mm))
            story.append(Paragraph(inline(line[2:]), style_map["title"]))
            if field:
                cover_text = "简单逐步手机安装" if language == "ZH" else "Simple step-by-step phone setup"
            else:
                cover_text = "Version 1.0 - Verified 10 July 2026 - Controlled copy"
            story.append(Paragraph(cover_text, style_map["cover"]))
            story.append(Spacer(1, 8 * mm))
            title_seen = True
        elif line.startswith("## "):
            story.append(Paragraph(inline(line[3:]), style_map["h1"]))
        elif line.startswith("### "):
            story.append(Paragraph(inline(line[4:]), style_map["h2"]))
        elif line.startswith("> "):
            note_text = line[2:]
            style = "stop" if re.match(r"(?iu)^(?:STOP|DANGER|DO NOT|停止|危险|禁止)", note_text) else "note"
            story.append(Paragraph(inline(note_text), style_map[style]))
        elif re.match(r"^- \[[ xX]\]\s", line):
            checked = line[3].lower() == "x"
            text = line[6:]
            story.append(Paragraph(inline(text), style_map["bullet"], bulletText="[X]" if checked else "[ ]"))
        elif re.match(r"^\d+\.\s", line):
            number, text = line.split(".", 1)
            # Keep list numbers in the paragraph text. ReportLab's separate
            # bulletText font subset can intermittently omit digits in CJK PDFs.
            story.append(Paragraph(inline(f"{number}. {text}"), style_map["bullet"]))
        elif line.startswith("- "):
            story.append(Paragraph(inline(line[2:]), style_map["bullet"], bulletText="-"))
        else:
            story.append(Paragraph(inline(line), style_map["body"]))

    return story


def build(source: Path, target: Path, language: str, variant: str) -> None:
    markdown = source.read_text(encoding="utf-8")
    first = markdown.splitlines()[0].removeprefix("# ")
    font = "ManualCJK" if language == "ZH" else "ManualLatin"
    bold = "ManualCJKBold" if language == "ZH" else "ManualLatinBold"
    field = variant == "field"
    copy_label = "TELEBIRR PHONE - SIMPLE SETUP GUIDE" if field else "TELEBIRR P2P - CONTROLLED COPY"
    document = ManualDocTemplate(str(target), first, font, copy_label)
    document.build(parse_markdown(markdown, styles(font, bold, field), field, language))


def main() -> None:
    register_fonts()
    OUT.mkdir(parents=True, exist_ok=True)
    for source, target, language, variant in DOCS:
        if not source.exists():
            print(f"SKIP (source not found): {source.relative_to(ROOT)}")
            continue
        build(source, target, language, variant)
        print(target.relative_to(ROOT))


if __name__ == "__main__":
    main()
