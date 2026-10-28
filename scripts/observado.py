#!/usr/bin/env python3
"""
Lo que está pasando AHORA en cada ciudad, medido de verdad (no previsto).

1. Descarga de AEMET OpenData la última observación de todas sus estaciones.
2. Para cada ciudad elige la estación más cercana con datos recientes
   (penalizando si está mucho más alta o más baja que la ciudad).
3. Si no hay ninguna estación AEMET válida, usa el METAR del aeropuerto (NOAA).
4. Guarda todo en un único observed.json y lo sube al cubo de Supabase (con weather.store, como
   run.py), junto a cities/<id>.json, para que la tarjeta de Framer lo lea.

Uso:  python scripts/observado.py

Variables de entorno (los mismos secretos de GitHub que forecast.yml, más uno):
  AEMET_API_KEY          clave gratuita de opendata.aemet.es (sin ella, solo METAR)
  SUPABASE_URL, SUPABASE_SERVICE_KEY   como en run.py (sin ellas, escribe en out/public/)
"""
import json
import math
import sys
import time
import os
import urllib.error
import urllib.request
from dataclasses import asdict
from datetime import datetime, timedelta, timezone

from weather.common import load_cities
from weather.store import Store

AEMET_KEY = os.environ.get("AEMET_API_KEY", "").strip()

MAX_KM = 25                      # más lejos ya no es «tu ciudad»
MAX_AGE = timedelta(hours=3)     # un dato más viejo no es «ahora»
ALT_PENALTY_M = 50               # cada 50 m de desnivel cuenta como 1 km más
KT = 1.852                       # nudos → km/h


# --- Red ----------------------------------------------------------------------------------

def get(url, tries=4):
    """Descarga con reintentos: AEMET limita peticiones por minuto y a veces corta."""
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "web-tiempo/1.0"})
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if i == tries - 1:
                raise
            time.sleep(30 if e.code == 429 else 5 * (i + 1))
        except Exception:
            if i == tries - 1:
                raise
            time.sleep(5 * (i + 1))


def km(lat1, lon1, lat2, lon2):
    r = math.pi / 180
    a = (math.sin((lat2 - lat1) * r / 2) ** 2
         + math.cos(lat1 * r) * math.cos(lat2 * r) * math.sin((lon2 - lon1) * r / 2) ** 2)
    return 12742 * math.asin(math.sqrt(a))


def utc(s):
    """«2026-10-19T18:00:00+0000» o «2026-10-19T18:00:00» → datetime en UTC."""
    return datetime.strptime(s[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)


def iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%MZ")


def rnd(v, d=1):
    if v is None:
        return None
    return round(float(v)) if d == 0 else round(float(v), d)


# --- AEMET --------------------------------------------------------------------------------

def aemet_stations():
    """Última observación de cada estación AEMET (la API devuelve unas 12-24 h de todas)."""
    meta = json.loads(get(
        f"https://opendata.aemet.es/opendata/api/observacion/convencional/todas?api_key={AEMET_KEY}"))
    if meta.get("estado") != 200:
        raise RuntimeError(f"AEMET: {meta.get('estado')} {meta.get('descripcion')}")
    # AEMET sirve los datos en ISO-8859-15, no en UTF-8.
    rows = json.loads(get(meta["datos"]).decode("latin-1"))
    latest = {}
    for r in rows:
        if r.get("ta") is None or r.get("lat") is None:
            continue
        prev = latest.get(r["idema"])
        if prev is None or r["fint"] > prev["fint"]:
            latest[r["idema"]] = r
    return list(latest.values())


def sea_level_pressure(s):
    """Presión a nivel del mar (hPa), la que se compara entre ciudades y la que dan los modelos.

    AEMET la da como «pres_nmar»; si falta, se calcula desde la presión de la estación («pres»)
    con la fórmula barométrica. Sin reducir, una estación a 1.000 m marca ~110 hPa menos
    (Soria daba 893 hPa en vez de unos 1.016).
    """
    if s.get("pres_nmar") is not None:
        return s["pres_nmar"]
    p, h, t = s.get("pres"), s.get("alt"), s.get("ta")
    if p is None or h is None:
        return None
    t = 15.0 if t is None else t
    return p * (1 - 0.0065 * h / (t + 0.0065 * h + 273.15)) ** -5.257


def from_aemet(s, dist, t):
    wind = s.get("vv")      # m/s
    gust = s.get("vmax")    # m/s
    return {
        "source": "AEMET",
        "station": (s.get("ubi") or s["idema"]).title(),
        "stationId": s["idema"],
        "km": round(dist, 1),
        "alt": s.get("alt"),
        "time": iso(t),
        "temp": rnd(s.get("ta")),
        "hum": rnd(s.get("hr"), 0),
        "wind": rnd(wind * 3.6 if wind is not None else None, 0),
        "gust": rnd(gust * 3.6 if gust is not None else None, 0),
        "windDir": rnd(s.get("dv"), 0),
        "pressure": rnd(sea_level_pressure(s), 0),
        "rain1h": rnd(s.get("prec")),
        "vis": rnd(s.get("vis")),
    }


def pick_aemet(city, stations, now):
    best = None
    for s in stations:
        try:
            t = utc(s["fint"])
        except Exception:
            continue
        if now - t > MAX_AGE:
            continue
        d = km(city["lat"], city["lon"], s["lat"], s["lon"])
        if d > MAX_KM:
            continue
        score = d + abs((s.get("alt") or 0) - city["elev"]) / ALT_PENALTY_M
        if best is None or score < best[0]:
            best = (score, d, s, t)
    return from_aemet(best[2], best[1], best[3]) if best else None


# --- METAR (respaldo) ---------------------------------------------------------------------

COVER = {"SKC": (0, "Despejado"), "CLR": (0, "Despejado"), "NSC": (0, "Sin nubes bajas"),
         "NCD": (0, "Despejado"), "CAVOK": (0, "Despejado"), "FEW": (1, "Poco nuboso"),
         "SCT": (2, "Nubes dispersas"), "BKN": (3, "Nuboso"), "OVC": (4, "Cubierto"),
         "OVX": (4, "Cielo oculto")}
WX = [("TS", "Tormenta"), ("GR", "Granizo"), ("SN", "Nieve"), ("SHRA", "Chubascos"),
      ("RA", "Lluvia"), ("DZ", "Llovizna"), ("FG", "Niebla"), ("BR", "Neblina"),
      ("HZ", "Calima"), ("DU", "Polvo")]


def metar_cloud(m):
    layers = [c for c in (m.get("clouds") or []) if c.get("cover") in COVER]
    if not layers:
        return None
    top = max(layers, key=lambda c: COVER[c["cover"]][0])
    label = COVER[top["cover"]][1]
    if top.get("base") is not None and COVER[top["cover"]][0] > 0:
        return f"{label} · base {round(top['base'] * 0.3048 / 10) * 10} m"
    return label


def metar_wx(s):
    if not s:
        return None
    tok = s.split()[0]
    for k, label in WX:
        if k in tok:
            return label + (" débil" if tok.startswith("-") else " fuerte" if tok.startswith("+") else "")
    return None


def metar_vis(v):
    if v is None:
        return None
    if isinstance(v, str):
        if "+" in v:
            return 10.0
        try:
            v = float(v)
        except ValueError:
            return None
    return 10.0 if v >= 6 else round(v * 1.609, 1)


def metars(icaos):
    if not icaos:
        return {}
    data = json.loads(get(
        "https://aviationweather.gov/api/data/metar?format=json&hours=3&ids=" + ",".join(sorted(icaos))))
    latest = {}
    for m in data:
        if m["icaoId"] not in latest or m["obsTime"] > latest[m["icaoId"]]["obsTime"]:
            latest[m["icaoId"]] = m
    return latest


def from_metar(city, m):
    t = datetime.fromtimestamp(m["obsTime"], tz=timezone.utc)
    temp, dew = m.get("temp"), m.get("dewp")
    hum = None
    if temp is not None and dew is not None:
        a, b = 17.625, 243.04
        hum = round(100 * math.exp(a * dew / (b + dew) - a * temp / (b + temp)))
    wdir = m.get("wdir")
    return {
        "source": "METAR",
        "station": (m.get("name") or m["icaoId"]).split(",")[0],
        "stationId": m["icaoId"],
        "km": round(km(city["lat"], city["lon"], m["lat"], m["lon"]), 1) if m.get("lat") else None,
        "alt": m.get("elev"),
        "time": iso(t),
        "temp": rnd(temp),
        "hum": hum,
        "wind": rnd(m["wspd"] * KT, 0) if m.get("wspd") is not None else None,
        "gust": rnd(m["wgst"] * KT, 0) if m.get("wgst") else None,
        "windDir": wdir if isinstance(wdir, (int, float)) else None,
        "pressure": rnd(m.get("altim"), 0),
        "vis": metar_vis(m.get("visib")),
        "cloud": metar_cloud(m),
        "wx": metar_wx(m.get("wxString")),
        "raw": m.get("rawOb"),
    }


# --- Todo junto ---------------------------------------------------------------------------

def build(cities, stations, metar_by_icao, now):
    out = {}
    for c in cities:
        obs = pick_aemet(c, stations, now) if stations else None
        m = metar_by_icao.get(c["metar"]) if c.get("metar") else None
        if obs is None and m and now - datetime.fromtimestamp(m["obsTime"], tz=timezone.utc) <= MAX_AGE:
            obs = from_metar(c, m)
        if obs is None:
            print(f"  - {c['id']}: sin observación reciente", file=sys.stderr)
            continue
        # Del METAR se aprovechan nubes y tiempo presente aunque gane AEMET (AEMET no los da).
        if obs["source"] == "AEMET" and m:
            mc = from_metar(c, m)
            obs["cloud"], obs["wx"] = mc["cloud"], mc["wx"]
        out[c["id"]] = obs
    return out


def main():
    now = datetime.now(timezone.utc)
    # Las mismas ciudades que run.py, de cities.json (con su altitud y su estación METAR).
    cities = [{**asdict(c), "elev": c.elev or 0} for c in load_cities()]

    stations = []
    if AEMET_KEY:
        try:
            stations = aemet_stations()
            print(f"AEMET: {len(stations)} estaciones")
        except Exception as e:
            print(f"! AEMET no disponible ({e}); se usará solo METAR", file=sys.stderr)
    else:
        print("! Falta AEMET_API_KEY; se usará solo METAR", file=sys.stderr)

    try:
        by_icao = metars({c["metar"] for c in cities if c.get("metar")})
    except Exception as e:
        print(f"! METAR no disponible ({e})", file=sys.stderr)
        by_icao = {}

    result = build(cities, stations, by_icao, now)
    n_aemet = sum(1 for o in result.values() if o["source"] == "AEMET")
    print(f"{len(result)}/{len(cities)} ciudades con dato: {n_aemet} AEMET, {len(result) - n_aemet} METAR")

    doc = {
        "generated": iso(now),
        "attribution": "Observaciones: © AEMET (OpenData) y METAR de NOAA aviationweather.gov.",
        "cities": result,
    }
    store = Store()
    # Cinco minutos de caché: el dato cambia cada media hora.
    store.put("observed.json", doc, max_age=300)
    print("Subido a Supabase" if store.remote else "Sin claves de Supabase: escrito en out/public/observed.json")


if __name__ == "__main__":
    main()
