"""Contornos del mapa de la app: costas y fronteras de Europa, simplificados (Natural Earth, dominio público).

Publica mapa/contornos.json  {"v":1, "source":…, "lines":[[lon×100, lat×100, lon×100, lat×100, …], …]}
Uso: python scripts/contornos.py   (lo lanza .github/workflows/pueblos.yml una vez al mes)
"""
import sys
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
from weather.store import Store  # noqa: E402

URL = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson"
# Lo que cubre el mapa (con margen): de Canarias y Azores a Escandinavia, de Islandia a Turquía
BBOX = (-32.0, 26.0, 46.0, 72.0)  # lon_min, lat_min, lon_max, lat_max
TOL = 0.02  # grados: lo que se simplifica (≈ 2 km)


def _dp(pts, tol):
    """Douglas-Peucker: quita los puntos que casi no cambian la forma."""
    if len(pts) < 3:
        return pts
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        (x1, y1), (x2, y2) = pts[a], pts[b]
        dx, dy = x2 - x1, y2 - y1
        n = (dx * dx + dy * dy) ** 0.5 or 1e-12
        best, bi = 0.0, -1
        for i in range(a + 1, b):
            x, y = pts[i]
            d = abs(dy * x - dx * y + x2 * y1 - y2 * x1) / n
            if d > best:
                best, bi = d, i
        if best > tol and bi > 0:
            keep[bi] = True
            stack += [(a, bi), (bi, b)]
    return [p for p, k in zip(pts, keep) if k]


def _rings(geom):
    if geom["type"] == "Polygon":
        return geom["coordinates"]
    if geom["type"] == "MultiPolygon":
        return [r for poly in geom["coordinates"] for r in poly]
    return []


def main():
    gj = requests.get(URL, timeout=120).json()
    lo0, la0, lo1, la1 = BBOX
    lines = []
    for f in gj["features"]:
        for ring in _rings(f["geometry"]):
            # Solo los trozos dentro del recuadro (cortando donde sale y entra)
            seg = []
            for x, y in ring:
                if lo0 <= x <= lo1 and la0 <= y <= la1:
                    seg.append((x, y))
                elif seg:
                    if len(seg) > 1:
                        lines.append(seg)
                    seg = []
            if len(seg) > 1:
                lines.append(seg)
    out = []
    for seg in lines:
        s = _dp(seg, TOL)
        if len(s) < 2:
            continue
        flat = []
        for x, y in s:
            flat += [round(x * 100), round(y * 100)]
        out.append(flat)
    doc = {"v": 1, "source": "Natural Earth (dominio público) — naturalearthdata.com", "bbox": BBOX, "lines": out}
    print(f"contornos: {len(out)} líneas, {sum(len(l) for l in out) // 2} puntos")
    Store().put("mapa/contornos.json", doc, max_age=7 * 86400)


if __name__ == "__main__":
    main()
