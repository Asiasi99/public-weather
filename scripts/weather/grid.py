"""Rejilla de España: el tiempo en cualquier punto, no solo en las ciudades.

Cada modelo se lee también en una rejilla de puntos cada 0,25° (≈ 25 km) sobre la península, Baleares y Canarias.
Después se mezclan los modelos en una sola serie cada 3 h y se publican «teselas» de 1° × 1°:

    grid/index.json             qué teselas hay, cuándo se generaron y con qué modelos
    grid/tiles/<lat>_<lon>.json los 5 × 5 puntos de esa tesela (con borde compartido con la vecina)

La app coge la tesela donde está la persona, mezcla los 4 puntos de alrededor y corrige la temperatura por la
altitud de su pueblo (6,5 °C por km). La altura de referencia de cada punto («elev») es la media de la de los
modelos: antes de mezclarlos, la temperatura de cada modelo se lleva a esa altura.

Lo que se lee de cada modelo se guarda en out/grid-cache/<modelo>.json.gz para la siguiente ejecución (GitHub
Actions lo conserva con actions/cache): así cada hora solo se vuelve a leer el modelo que tiene pasada nueva.
"""

import gzip
import json
import math
from datetime import datetime, timedelta, timezone

import numpy as np

from .common import LAPSE_RATE, OUT_DIR, City

RES = 0.25
STEP_H = 3
HOURS = 168
CACHE_DIR = OUT_DIR / "grid-cache"
# Recuadros (lat_min, lat_max, lon_min, lon_max): península (con Portugal) y Baleares, Canarias,
# Francia (con Córcega) y Madeira y Azores. Prueba antes de abrir a toda Europa.
BOXES = [
    (35.75, 44.0, -9.75, 4.5),      # península ibérica y Baleares
    (27.5, 29.5, -18.25, -13.25),   # Canarias
    (41.25, 51.25, -5.25, 9.75),    # Francia y Córcega
    (32.5, 33.25, -17.5, -16.25),   # Madeira
    (36.75, 39.75, -31.5, -24.75),  # Azores
]
FIELDS = ("temp", "rain", "hum", "cloud", "cloudLow", "cloudMid", "cloudHigh")


def _key(lat, lon):
    return f"g{lat:+.2f}{lon:+.2f}"


def _coords():
    seen = set()
    for la0, la1, lo0, lo1 in BOXES:
        for i in range(int(round((la1 - la0) / RES)) + 1):
            for j in range(int(round((lo1 - lo0) / RES)) + 1):
                c = (round(la0 + i * RES, 2), round(lo0 + j * RES, 2))
                if c not in seen:  # los recuadros se solapan: cada punto una sola vez
                    seen.add(c)
                    yield c


def points():
    """Los puntos de la rejilla, como «ciudades» sin altura (la temperatura queda a la altura del modelo)."""
    return [City(id=_key(lat, lon), name="", lat=lat, lon=lon, tz="UTC", elev=None) for lat, lon in _coords()]


# Teselas de 1° (esquina suroeste) que se publican: las que tocan algún punto de la rejilla.
TILES = sorted({(math.floor(lat), math.floor(lon)) for lat, lon in _coords()})


def is_grid(pid):
    return pid.startswith("g+") or pid.startswith("g-")


# ---------------- Caché por modelo ----------------
def save_cache(model_id, run, series):
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    body = json.dumps({"run": run, "points": series}, separators=(",", ":")).encode()
    (CACHE_DIR / f"{model_id}.json.gz").write_bytes(gzip.compress(body, 6))


def load_cache(model_id):
    p = CACHE_DIR / f"{model_id}.json.gz"
    if not p.exists():
        return None
    try:
        return json.loads(gzip.decompress(p.read_bytes()))
    except Exception:
        return None


# ---------------- Mezcla de modelos ----------------
def _t(s):
    return datetime.strptime(s, "%Y-%m-%dT%H:%MZ").replace(tzinfo=timezone.utc).timestamp() / 3600.0


def _interp(src_t, vals, dst_t, max_gap=6.0):
    """Valores en dst_t interpolando entre las muestras de alrededor (si están a menos de max_gap horas)."""
    v = np.array([np.nan if x is None else x for x in vals], dtype=float)
    ok = ~np.isnan(v)
    if ok.sum() < 2:
        return np.full(len(dst_t), np.nan)
    t, v = src_t[ok], v[ok]
    # Todo a la vez con numpy (con miles de puntos, el bucle en Python tardaba minutos)
    out = np.interp(dst_t, t, v, left=np.nan, right=np.nan)
    i = np.clip(np.searchsorted(t, dst_t), 1, len(t) - 1)
    exact = np.isin(dst_t, t)
    out[(t[i] - t[i - 1] > max_gap) & ~exact] = np.nan
    return out


def _rain(src_t, vals, dst_t):
    """Lluvia (mm) en cada intervalo (t − 3 h, t]: acumulada desde el inicio, interpolada y restada."""
    v = np.array([0.0 if x is None else x for x in vals], dtype=float)
    has = np.array([x is not None for x in vals])
    if has.sum() < 2:
        return np.full(len(dst_t), np.nan)
    cum = np.cumsum(v)
    c = np.interp(dst_t, src_t, cum, left=np.nan, right=np.nan)
    c0 = np.interp(dst_t - STEP_H, src_t, cum, left=np.nan, right=np.nan)
    return np.maximum(c - c0, 0.0)


def compose(per_model, now=None):
    """De {modelo: {punto: serie}} a {punto: {campo: array}} con la media de los modelos, cada 3 h."""
    now = now or datetime.now(timezone.utc)
    t0 = math.floor(now.timestamp() / 3600 / STEP_H) * STEP_H
    dst = np.arange(t0, t0 + HOURS + STEP_H, STEP_H, dtype=float)
    acc = {}
    for model_id, pts in per_model.items():
        for pid, s in pts.items():
            if not s.get("times"):
                continue
            src = np.array([_t(x) for x in s["times"]])
            a = acc.setdefault(pid, {"elev": [], "models": []})
            m = {f: _interp(src, s[f], dst) for f in FIELDS if f != "rain" and s.get(f)}
            m["rain"] = _rain(src, s.get("rain") or [], dst)
            if s.get("wind") and s.get("windDir"):
                w = np.array([np.nan if x is None else x for x in s["wind"]], dtype=float)
                d = np.radians(np.array([np.nan if x is None else x for x in s["windDir"]], dtype=float))
                # El viento se mezcla por componentes (no se puede promediar 350° y 10°)
                m["u"] = _interp(src, list(-w * np.sin(d)), dst)
                m["v"] = _interp(src, list(-w * np.cos(d)), dst)
            m["elev"] = s.get("gridElev")
            a["models"].append(m)
            if s.get("gridElev") is not None:
                a["elev"].append(float(s["gridElev"]))
    out = {}
    for pid, a in acc.items():
        ref = float(np.mean(a["elev"])) if a["elev"] else None
        res = {"elev": None if ref is None else round(ref)}

        def stack(f, fix_temp=False):
            arrs = []
            for m in a["models"]:
                if f not in m:
                    continue
                x = m[f]
                # Cada modelo a la misma altura antes de mezclar
                if fix_temp and ref is not None and m["elev"] is not None:
                    x = x + LAPSE_RATE * (float(m["elev"]) - ref)
                arrs.append(x)
            if not arrs:
                return None
            with np.errstate(all="ignore"):
                return np.nanmean(np.vstack(arrs), axis=0)

        temp = stack("temp", True)
        if temp is None or np.all(np.isnan(temp)):
            continue
        res["temp"] = temp
        for f in ("rain", "hum", "cloud", "cloudLow", "cloudMid", "cloudHigh"):
            res[f] = stack(f)
        u, v = stack("u"), stack("v")
        if u is not None and v is not None:
            res["wind"] = np.hypot(u, v)
            res["windDir"] = (np.degrees(np.arctan2(-u, -v)) + 360) % 360
        res["n"] = len(a["models"])
        out[pid] = res
    return dst, out


def _r(arr, nd=0):
    if arr is None:
        return None
    return [None if (x is None or np.isnan(x)) else (round(float(x), nd) if nd else int(round(float(x)))) for x in arr]


def tiles(dst, composed, generated, models):
    """Las teselas listas para publicar: {ruta: documento}."""
    t0 = datetime.fromtimestamp(dst[0] * 3600, tz=timezone.utc).strftime("%Y-%m-%dT%H:%MZ")
    # Cada punto, a su tesela (y a la vecina si cae en el borde): así no se recorren todos por tesela
    buckets = {}
    for pid, r in composed.items():
        lat, lon = float(pid[1:7]), float(pid[7:])
        for la in {math.floor(lat), math.ceil(lat) - 1} if lat == math.floor(lat) else {math.floor(lat)}:
            for lo in {math.floor(lon), math.ceil(lon) - 1} if lon == math.floor(lon) else {math.floor(lon)}:
                buckets.setdefault((la, lo), []).append(((lat, lon), r))
    docs, index = {}, []
    for la, lo in TILES:
        pts = []
        for (lat, lon), r in buckets.get((la, lo), []):
            if la <= lat <= la + 1 and lo <= lon <= lo + 1:
                pts.append({"lat": lat, "lon": lon, "elev": r["elev"], "n": r["n"],
                            "temp": _r(r["temp"], 1), "rain": _r(r.get("rain"), 1), "hum": _r(r.get("hum")),
                            "cloud": _r(r.get("cloud")), "lo": _r(r.get("cloudLow")), "mid": _r(r.get("cloudMid")),
                            "hi": _r(r.get("cloudHigh")), "wind": _r(r.get("wind")), "dir": _r(r.get("windDir"))})
        if not pts:
            continue
        pts.sort(key=lambda p: (p["lat"], p["lon"]))
        name = f"{la}_{lo}"
        docs[f"grid/tiles/{name}.json"] = {"v": 1, "generated": generated, "models": models, "t0": t0, "stepHours": STEP_H,
                                          "res": RES, "lat0": la, "lon0": lo, "points": pts}
        index.append(name)
    docs["grid/index.json"] = {"v": 1, "generated": generated, "models": models, "t0": t0, "stepHours": STEP_H,
                               "res": RES, "tiles": index}
    return docs
