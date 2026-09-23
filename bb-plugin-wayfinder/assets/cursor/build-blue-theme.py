#!/usr/bin/env python3
"""Recolor Cua 0.28.2's native MIT dotLottie theme to BB blue (#2383e2).

Upstream: https://github.com/trycua/cua/blob/681bc44807d1be81a4357f8e158f1c74a81d5a5b/libs/cua-driver/rust/crates/cursor-overlay/assets/cua.default.lottie
Only vector color and public theme metadata change; the native animation, hotspot,
and semantic states are preserved. Build the compiled artifact with
`cua-driver cursor-theme build bb.wayfinder.blue.lottie --output bb.wayfinder.blue.cua-theme`.
"""
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile
import json

ROOT = Path(__file__).resolve().parent
FROM = [94 / 255, 192 / 255, 232 / 255, 1]
TO = [35 / 255, 131 / 255, 226 / 255, 1]

def recolor(value):
    if isinstance(value, list):
        return TO if value == FROM else [recolor(part) for part in value]
    if isinstance(value, dict):
        return {key: recolor(part) for key, part in value.items()}
    return value

with ZipFile(ROOT / 'cua.default.lottie') as original, ZipFile(ROOT / 'bb.wayfinder.blue.lottie', 'w', compression=ZIP_DEFLATED) as output:
    for name in original.namelist():
        content = json.loads(original.read(name))
        if name == 'cua/theme.json':
            content.update(id='app.getbb.wayfinder.blue', name='Wayfinder Solid Blue', author='BB (adapted from Cua, MIT)', version='1.0.0')
        elif name.startswith('a/'):
            content = recolor(content)
        output.writestr(name, json.dumps(content, separators=(',', ':')))
