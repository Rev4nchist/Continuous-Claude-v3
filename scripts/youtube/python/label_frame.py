#!/usr/bin/env python
"""Add a high-contrast evidence id and timestamp label to a retained frame."""
import sys
from PIL import Image, ImageDraw


source, destination, label = sys.argv[1:4]
image = Image.open(source).convert("RGB")
draw = ImageDraw.Draw(image)
box = draw.textbbox((0, 0), label)
width = box[2] - box[0] + 20
height = box[3] - box[1] + 16
draw.rectangle((0, 0, width, height), fill="black")
draw.text((10, 8), label, fill="white")
image.save(destination, quality=92)
