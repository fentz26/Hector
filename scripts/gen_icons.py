#!/usr/bin/env python3
"""Render the Hector logo to PNG at the sizes the manifest needs.

Pure standard library (zlib + struct), 4x4 supersampled. Run from the repo root:
    python3 scripts/gen_icons.py
"""
import math
import os
import struct
import zlib

BG = (24, 24, 27)       # near-black tile
RING = (82, 82, 91)     # grey edge, so the tile shows on dark toolbars too
FG = (250, 250, 250)    # white mark
DOT = (161, 161, 170)   # grey commit dot
SS = 4                  # supersampling factor


def rounded_rect_dist(u, v, half, radius):
    """Signed distance from (u, v) to a centred rounded square (negative inside)."""
    qx = abs(u - 0.5) - (half - radius)
    qy = abs(v - 0.5) - (half - radius)
    outside = math.hypot(max(qx, 0.0), max(qy, 0.0))
    return outside + min(max(qx, qy), 0.0) - radius


def seg_dist(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy or 1)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def render(size):
    """An "H" drawn as a git graph: two branches (the stems) joined by a
    merge (the bar), with hollow commit nodes where they meet; the right one
    grey. Monochrome: black tile, white mark, grey accents."""
    small = size < 32
    stroke = 0.075 if small else 0.06
    node_r = 0.11 if small else 0.085
    ring = 0.0 if small else 0.018
    segments = [(0.33, 0.24, 0.33, 0.76), (0.67, 0.24, 0.67, 0.76), (0.33, 0.50, 0.67, 0.50)]
    nodes = [((0.33, 0.50), FG), ((0.67, 0.50), DOT)]
    hole = node_r * 0.48

    rows = []
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            acc = [0.0, 0.0, 0.0]
            cover = 0
            for sy in range(SS):
                for sx in range(SS):
                    u = (x + (sx + 0.5) / SS) / size
                    v = (y + (sy + 0.5) / SS) / size
                    d = rounded_rect_dist(u, v, 0.48, 0.2)
                    if d > 0:
                        continue
                    cover += 1
                    node = next(((col, math.hypot(u - nx, v - ny)) for (nx, ny), col in nodes if math.hypot(u - nx, v - ny) <= node_r), None)
                    if node:
                        c = BG if node[1] <= hole and not small else node[0]
                    elif any(seg_dist(u, v, *sg) <= stroke for sg in segments):
                        c = FG
                    elif d > -ring:
                        c = RING
                    else:
                        c = BG
                    for i in range(3):
                        acc[i] += c[i]
            if cover:
                color = [round(acc[i] / cover) for i in range(3)]
            else:
                color = [0, 0, 0]
            row += bytes(color + [round(cover / (SS * SS) * 255)])
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
