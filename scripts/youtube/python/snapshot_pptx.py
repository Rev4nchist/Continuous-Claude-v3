#!/usr/bin/env python
"""Read-only normalized PPTX snapshot for impact analysis."""
import json
import sys

from pptx import Presentation


presentation = Presentation(sys.argv[1])
slides = []
for index, slide in enumerate(presentation.slides, 1):
    text = []
    charts = []
    for shape in slide.shapes:
        if getattr(shape, "has_text_frame", False):
            value = "\n".join(paragraph.text for paragraph in shape.text_frame.paragraphs).strip()
            if value:
                text.append(value)
        if getattr(shape, "has_chart", False):
            chart = shape.chart
            charts.append({
                "title": chart.chart_title.text_frame.text if chart.has_title else None,
                "series": [series.name for series in chart.series],
            })
    notes = None
    try:
        notes = slide.notes_slide.notes_text_frame.text
    except Exception:
        pass
    slides.append({"slideId": index, "text": text, "notes": notes, "charts": charts})
print(json.dumps({"format": "pptx", "slides": slides}))
