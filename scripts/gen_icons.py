#!/usr/bin/env python3
"""Render the HectaTree logo to PNG at the sizes the manifest needs.

Pure standard library (zlib + struct), 4x4 supersampled. Run from the repo root:
    python3 scripts/gen_icons.py
"""
import math
import os
import struct
import zlib

BG = (15, 138, 98)      # hexagon fill
FG = (255, 255, 255)    # tree glyph
SS = 4                  # supersampling factor


def hexagon(cx, cy, r):
    return [(cx + r * math.cos(math.radians(a)), cy + r * math.sin(math.radians(a))) for a in range(-90, 270, 60)]


def inside(poly, x, y):
    hit = False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            hit = not hit
        j = i
    return hit


def seg_dist(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy or 1)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def render(size):
    poly = hexagon(0.5, 0.5, 0.48)
    # Tree glyph in unit coordinates: trunk + two branches ending in nodes.
    segments = [(0.38, 0.27, 0.38, 0.73), (0.38, 0.50, 0.63, 0.50), (0.38, 0.73, 0.63, 0.73)]
    nodes = [(0.38, 0.27), (0.63, 0.50), (0.63, 0.73)]
    stroke = 0.05 if size >= 32 else 0.07
    node_r = 0.085 if size >= 32 else 0.1

    rows = []
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            bg_hits = fg_hits = 0
            for sy in range(SS):
                for sx in range(SS):
                    u = (x + (sx + 0.5) / SS) / size
                    v = (y + (sy + 0.5) / SS) / size
                    if not inside(poly, u, v):
                        continue
                    bg_hits += 1
                    on_line = any(seg_dist(u, v, *s) <= stroke for s in segments)
                    on_node = any(math.hypot(u - nx, v - ny) <= node_r for nx, ny in nodes)
                    if on_line or on_node:
                        fg_hits += 1
            total = SS * SS
            alpha = bg_hits / total
            if bg_hits:
                f = fg_hits / bg_hits
                color = [round(BG[i] * (1 - f) + FG[i] * f) for i in range(3)]
            else:
                color = [0, 0, 0]
            row += bytes(color + [round(alpha * 255)])
        rows.append(bytes(row))
    return rows


def write_png(path, size, rows):
    def chunk(tag, data):
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(b''.join(rows), 9))
    png += chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(png)


if __name__ == '__main__':
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'icons')
    for size in (16, 32, 48, 128):
        write_png(os.path.join(out, f'icon{size}.png'), size, render(size))
        print(f'icons/icon{size}.png')
