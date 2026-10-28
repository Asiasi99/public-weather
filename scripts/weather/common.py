"""Lo que comparten todos los modelos: leer un GRIB por puntos y convertirlo a una serie normalizada."""

import json
import os
from dataclasses import dataclass
from pathlib import Path

import time

import eccodes
import numpy as np
import requests

ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = ROOT / "out"
HORIZON = min(int(os.environ.get("FORECAST_HOURS", "168")), 240)
# Más lejos que esto, el punto de rejilla «más cercano» es el borde de un modelo regional: no vale.
MAX_DISTANCE_KM = 40.0
# sp (presión en superficie) solo sirve para deducir el relieve de los modelos que no lo publican.
VARIABLES = ("2t", "2d", "tp", "10u", "10v", "msl", "tcc", "lcc", "mcc", "hcc", "sp")
GRID_KEYS = ("gridType", "Ni", "Nj", "latitudeOfFirstGridPointInDegrees", "longitudeOfFirstGridPointInDegrees",
             "latitudeOfLastGridPointInDegrees", "longitudeOfLastGridPointInDegrees")
# Gradiente de temperatura con la altura en la atmósfera estándar: 6,5 °C por kilómetro.
LAPSE_RATE = 0.0065
# Campos fijos de cada modelo: máscara de tierra (0 mar, 1 tierra) y relieve. Sirven para elegir el punto
# de cada ciudad (tierra, no mar) y corregir la temperatura por la diferencia de altura.
LAND_MASK = {"lsm", "land", "fr_land"}
ELEVATION = {"z", "orog", "hsurf"}
# Nombres que usan GFS (prmsl) o el DWD (clct, tot_prec…) para lo mismo.
ALIASES = {"prmsl": "msl", "pmsl": "msl", "clct": "tcc", "tot_prec": "tp", "t_2m": "2t", "u_10m": "10u", "v_10m": "10v",
           "t2m": "2t", "u10": "10u", "v10": "10v", "td_2m": "2d", "d2m": "2d", "dpt": "2d"}


_http = requests.Session()


def http_get(url, method="GET", tries=4, **kwargs):
    """GET con reintentos ante cortes de conexión y errores de carga (5xx, 429). Un 404 se devuelve tal cual."""
    for attempt in range(tries):
        try:
            r = _http.request(method, url, timeout=kwargs.pop("timeout", 60), **kwargs)
            if r.status_code < 500 and r.status_code != 429:
                return r
        except requests.RequestException:
            if attempt == tries - 1:
                raise
        time.sleep(3 * (attempt + 1))
    return r


@dataclass
class City:
    id: str
    name: str
    lat: float
    lon: float
    tz: str
    elev: float | None = None
    # Estación METAR cercana, para medir la precisión real de los modelos (verify.py).
    metar: str | None = None


class GridPoints:
    """El punto de rejilla elegido para cada ciudad: distancia (km) y altura del modelo en él (m, o None)."""

    def __init__(self, distance, elev=None):
        self.distance = distance
        self.elev = elev


def barometric_height(sp_pa, msl_pa, t_kelvin):
    """Altura del terreno (m) a partir de la presión en superficie y a nivel del mar: h = (R·T/g)·ln(p_mar/p_sup).
    Para la temperatura media de la capa se suma a la de 2 m medio gradiente de la altura buscada (≈ +3 K)."""
    return 287.05 * (t_kelvin + 3.0) / 9.80665 * np.log(msl_pa / sp_pa)


def load_cities():
    return [City(**c) for c in json.loads((ROOT / "cities.json").read_text(encoding="utf-8"))]


# Para elegir punto: cada 100 m de diferencia de altura cuentan como 10 km de distancia, y un punto de mar,
# como 15 km más. Así gana el punto que más se parece a la ciudad, no solo el más cercano.
KM_PER_METRE = 0.1
SEA_PENALTY_KM = 15.0


def choose_point(candidates, city, land=None, elev=None):
    """De los puntos candidatos [(índice, km)], el que más se parece a la ciudad: cerca, a una altura
    parecida y en tierra (ver KM_PER_METRE y SEA_PENALTY_KM). Lo usan todos los modelos."""
    def score(c):
        index, km = c
        s = km
        if elev is not None and city.elev is not None:
            s += KM_PER_METRE * abs(float(elev[index]) - city.elev)
        if land is not None and land[index] < 0.5:
            s += SEA_PENALTY_KM
        return s

    return min(candidates, key=score)


def _nearest(gid, city, land=None, elev=None):
    """Índice y distancia (km) del punto elegido entre los 4 de la rejilla que rodean la ciudad.
    Fuera de la rejilla de un modelo regional (Canarias en ICON-EU) eccodes lanza un error: se da distancia
    infinita y build_series salta la ciudad."""
    try:
        near = eccodes.codes_grib_find_nearest(gid, city.lat, city.lon, npoints=4)
    except eccodes.GribInternalError:
        return 0, float("inf")
    return choose_point([(n["index"], n["distance"]) for n in near], city, land, elev)


def _grid_key(gid):
    return tuple(eccodes.codes_get(gid, k) for k in GRID_KEYS)


def _statics(paths):
    """Primera pasada: la máscara de tierra y el relieve (en metros) de cada rejilla, si el GRIB los trae."""
    land, elev = {}, {}
    for path in paths:
        with open(path, "rb") as f:
            while (gid := eccodes.codes_grib_new_from_file(f)) is not None:
                try:
                    name = eccodes.codes_get(gid, "shortName").lower()
                    if name in LAND_MASK:
                        land[_grid_key(gid)] = eccodes.codes_get_values(gid)
                    elif name in ELEVATION:
                        v = eccodes.codes_get_values(gid)
                        # El ECMWF da el geopotencial (m²/s²), no la altura.
                        elev[_grid_key(gid)] = v / 9.80665 if eccodes.codes_get(gid, "units") != "m" else v
                finally:
                    eccodes.codes_release(gid)
    return land, elev


def read_points(paths, cities, with_names=False, names_by_path=None):
    """Recorre los mensajes de uno o varios GRIB y guarda, por variable y paso, el valor en cada ciudad.

    Devuelve {variable: {paso_final: (paso_inicial, array por ciudad)}} y un GridPoints con la distancia de cada
    ciudad a su punto y la altura del modelo allí (y, con with_names, todos los nombres de variable que había,
    para diagnosticar un modelo nuevo). names_by_path da el nombre de las variables que eccodes no reconoce
    («unknown»), por el fichero del que vienen. Usa eccodes directamente: así da igual la rejilla (0–360 o −180–180)
    y si un modelo no cubre una ciudad.
    """
    land, elev = _statics(paths)
    data, points, names, grids = {}, None, set(), {}
    for path in paths:
        with open(path, "rb") as f:
            while (gid := eccodes.codes_grib_new_from_file(f)) is not None:
                try:
                    name = eccodes.codes_get(gid, "shortName")
                    names.add(name)
                    if name == "unknown" and names_by_path and str(path) in names_by_path:
                        name = names_by_path[str(path)]
                    name = ALIASES.get(name.lower(), name)
                    if name not in VARIABLES:
                        continue
                    units = eccodes.codes_get(gid, "units")
                    # El DWD guarda los pasos en minutos («0m»): se piden siempre en horas.
                    eccodes.codes_set(gid, "stepUnits", "h")
                    start = int(eccodes.codes_get(gid, "startStep", ktype=int))
                    end = int(eccodes.codes_get(gid, "endStep", ktype=int))
                    # El punto de cada ciudad se busca una vez por rejilla; después basta indexar el campo.
                    key = _grid_key(gid)
                    if key not in grids:
                        near = [_nearest(gid, c, land.get(key), elev.get(key)) for c in cities]
                        idx = np.array([n[0] for n in near])
                        grids[key] = (idx, GridPoints(np.array([n[1] for n in near]),
                                                      elev[key][idx] if key in elev else None))
                    idx, grid_points = grids[key]
                    values = _values(gid)[idx]
                    data.setdefault(name, {})[end] = (start, to_standard(name, units, values))
                    if points is None:
                        points = grid_points
                finally:
                    eccodes.codes_release(gid)
    return (data, points, names) if with_names else (data, points)


def _values(gid):
    """Los valores de un campo, con los puntos sin dato como NaN.

    Los modelos regionales (AROME, ICON-EU) rellenan con «missingValue» (9999) los puntos de su rectángulo
    que quedan fuera de su dominio real. Si no se quita, a la temperatura le resta 273,15 y sale 9724,6 °C:
    eso le pasaba a AROME en Murcia (LEMI) y disparaba su error medio de España a ~350°.
    """
    values = eccodes.codes_get_values(gid).astype(float)
    if eccodes.codes_get(gid, "bitmapPresent"):
        values[values == eccodes.codes_get(gid, "missingValue")] = np.nan
    return values


def to_standard(name, units, v):
    """K → °C, m → mm, 0–1 → %, Pa → hPa. Se mira la unidad del GRIB, no el modelo."""
    if name in ("2t", "2d") and units == "K":
        return v - 273.15
    if name == "tp" and units == "m":
        return v * 1000.0
    # Nubes de 0 a 1 salvo que el GRIB diga «%», o que no diga nada útil y los valores pasen de 1.
    if name in ("tcc", "lcc", "mcc", "hcc") and units != "%" and not (units in ("~", "unknown", "") and np.nanmax(v) > 1.0):
        return v * 100.0
    if name == "msl" and units == "Pa":
        return v / 100.0
    return v


def rain_per_step(tp, steps):
    """Lluvia de cada intervalo. Sirve para acumulada desde el inicio (IFS, ICON, GFS 0-N) y para cubetas."""
    # Primero, lo acumulado desde el inicio en cada paso; en el paso 0 no ha llovido nada.
    total = {0: 0.0}
    for s in sorted(tp):
        start, v = tp[s]
        if start in total:
            total[s] = total[start] + v
    # Después, la diferencia con el paso anterior. Si falta uno de los dos, no se sabe.
    rain, prev = [], 0
    for s in steps:
        cur, before = total.get(s), total.get(prev)
        rain.append(None if cur is None or before is None else np.maximum(cur - before, 0.0))
        prev = s
    return rain


def build_series(data, points, cities, steps, run):
    """Una serie columnar por ciudad: tiempos y una lista por variable (None donde falta).
    La temperatura se corrige por la diferencia de altura entre el punto del modelo y la ciudad."""
    from datetime import timedelta

    rain = rain_per_step(data.get("tp", {}), steps)
    out = {}
    for i, c in enumerate(cities):
        if points is None or points.distance[i] > MAX_DISTANCE_KM:
            continue
        # Si el punto del modelo está más alto que la ciudad, allí hace más frío: se suma la diferencia.
        model_elev = None if points.elev is None or np.isnan(points.elev[i]) else float(points.elev[i])
        adjust = 0.0 if model_elev is None or c.elev is None else LAPSE_RATE * (model_elev - c.elev)
        # Un campo que falta, o un punto sin dato (NaN), queda como None: el JSON no admite NaN.
        def get(name, s):
            field = data.get(name, {}).get(s, (None, None))[1]
            return None if field is None or np.isnan(field[i]) else field

        times, temp, rr, cloud, wind, wdir, pres = [], [], [], [], [], [], []
        # Nubes por pisos: bajas (< ~2 km), medias (2-6 km) y altas (> ~6 km), donde el modelo las da.
        layers = {"lcc": [], "mcc": [], "hcc": []}
        # Humedad relativa (%), a partir del punto de rocío a 2 m, donde el modelo lo da.
        hum = []
        for k, s in enumerate(steps):
            t, u, v, p, cc = get("2t", s), get("10u", s), get("10v", s), get("msl", s), get("tcc", s)
            if t is None:
                continue
            times.append((run + timedelta(hours=s)).strftime("%Y-%m-%dT%H:%MZ"))
            temp.append(round(float(t[i]) + adjust, 1))
            # En el paso 0 la lluvia es un 0 suelto, no un valor por ciudad.
            r = None if rain[k] is None else float(np.broadcast_to(rain[k], len(cities))[i])
            rr.append(None if r is None or np.isnan(r) else round(r, 1))
            cloud.append(None if cc is None else round(float(np.clip(cc[i], 0, 100))))
            td = get("2d", s)
            if td is None:
                hum.append(None)
            else:
                tt, dd = float(t[i]), float(td[i])
                hum.append(round(float(np.clip(100 * np.exp(17.625 * dd / (243.04 + dd)) / np.exp(17.625 * tt / (243.04 + tt)), 0, 100))))
            for name, lst in layers.items():
                f = get(name, s)
                lst.append(None if f is None else round(float(np.clip(f[i], 0, 100))))
            if u is None or v is None:
                wind.append(None)
                wdir.append(None)
            else:
                wind.append(round(float(np.hypot(u[i], v[i]) * 3.6)))
                # De dónde viene el viento, 0 = norte.
                wdir.append(round(float((np.degrees(np.arctan2(-u[i], -v[i])) + 360) % 360)))
            pres.append(None if p is None else round(float(p[i])))
        if times:
            out[c.id] = {"times": times, "temp": temp, "rain": rr, "cloud": cloud,
                         "wind": wind, "windDir": wdir, "pressure": pres,
                         "gridKm": round(float(points.distance[i]), 1),
                         "gridElev": None if model_elev is None else round(model_elev),
                         "tempAdjust": round(adjust, 1)}
            if any(v is not None for v in hum):
                out[c.id]["hum"] = hum
            for name, key in (("lcc", "cloudLow"), ("mcc", "cloudMid"), ("hcc", "cloudHigh")):
                if any(v is not None for v in layers[name]):
                    out[c.id][key] = layers[name]
    return out
