"""Collect every text of the guided tour into one Markdown file.

    python scripts/export_tour.py            # writes README_TOUR.md
"""
import json
from pathlib import Path

root = Path(__file__).resolve().parent.parent
tour = json.loads((root / "web" / "tour.json").read_text(encoding="utf-8"))
out = ["# Экскурсия NeuroFly: тексты", "",
       "Все тексты экскурсии в порядке показа. Источник: `web/tour.json`; этот файл собирается",
       "командой `python scripts/export_tour.py`, править нужно JSON.", ""]
n = 0
for part in tour["parts"]:
    out += [f"## Часть: {part['name']}", ""]
    for st in part["steps"]:
        n += 1
        out += [f"### {n}. {st['title']}", "", st["text"], ""]
        if st.get("action"):
            out += [f"**Кнопка:** {st['action']}", ""]
        if st.get("after"):
            out += [f"**После действия:** {st['after']}", ""]
        if st.get("next"):
            out += [f"**Переход:** {st['next']}", ""]
(root / "README_TOUR.md").write_text("\n".join(out), encoding="utf-8")
print(f"{n} steps -> README_TOUR.md")
