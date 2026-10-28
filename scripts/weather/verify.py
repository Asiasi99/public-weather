"""Precisión real de cada modelo: lo que pronosticó frente a lo que midió la estación METAR del aeropuerto.

Cada estación se trata como una ciudad más: los modelos la extraen en su punto y con su altura, así que se compara
cada modelo exactamente donde está el termómetro. Se apunta lo que dice cada pasada para las horas que vienen y,
cuando llega la observación, se suma el error a un resumen diario por modelo, estación y día de antelación.

Solo se miden las 00, 06, 12 y 18 UTC, que tienen todos los modelos (AIFS va de 6 en 6 h): así nadie sale mejor
por medirse más veces. El estado vive en verify/state.json del cubo y se recorta a los últimos WINDOW_DAYS días.
Observaciones: aviationweather.gov (NOAA), sin clave.
"""

import math
from datetime import datetime, timedelta, timezone

from .common import City, http_get

API = "https://aviationweather.gov/api/data/metar"
HOURS = (0, 6, 12, 18)
WINDOW_DAYS = 30
MAX_DAY = 5
# Más lejos, la estación ya no habla del tiempo de la ciudad: cuenta para España, no para la ciudad.
STATION_MAX_KM = 40
# Una observación vale para una hora en punto si está a menos de esto (en España se da a :00 y :30).
OBS_TOLERANCE = timedelta(minutes=20)
# Si a las tantas horas no ha llegado la observación, el pronóstico se olvida.
FORGET_AFTER = timedelta(hours=30)

# Una temperatura fuera de esto no es un pronóstico, es un dato roto (p. ej. el 9724,6° de AROME en LEMI).
PLAUSIBLE = (-60.0, 60.0)

iso = lambda d: d.strftime("%Y-%m-%dT%H:%MZ")


def _purge_impossible(forecasts, scores):
    """Quita del estado guardado lo que entró antes de filtrar datos rotos: pronósticos fuera de PLAUSIBLE y
    resúmenes diarios con un error medio imposible (más de 30°). Así el error de España se recupera ya,
    sin esperar a que esos días salgan de la ventana de WINDOW_DAYS."""
    for by_station in forecasts.values():
        for by_time in by_station.values():
            for t in list(by_time):
                by_time[t] = {d: v for d, v in by_time[t].items()
                              if v is not None and PLAUSIBLE[0] <= v <= PLAUSIBLE[1]}
                if not by_time[t]:
                    del by_time[t]
    for by_station in scores.values():
        for by_day in by_station.values():
            for by_date in by_day.values():
                for date in [d for d, (a, _, n) in by_date.items() if n and a / n > 30]:
                    del by_date[date]
parse = lambda s: datetime.strptime(s, "%Y-%m-%dT%H:%MZ").replace(tzinfo=timezone.utc)


def station_key(icao):
    return f"st-{icao}"


# El API corta la respuesta (unos 400 partes): con 36 estaciones y un parte cada media hora, solo llegaban
# las últimas ~11 h. Se pide de pocas en pocas para tener las 26 h enteras.
METAR_BATCH = 6


def fetch_metars(icaos, hours=26):
    """Los METAR de las últimas horas, como lista de dicts del API. Lo que falle se salta."""
    out = []
    for i in range(0, len(icaos), METAR_BATCH):
        batch = icaos[i:i + METAR_BATCH]
        try:
            r = http_get(API, params={"ids": ",".join(batch), "format": "json", "hours": str(hours)})
            if r.ok and r.text.strip():
                out += r.json()
        except Exception as e:
            print(f"verify: sin METAR de {batch} ({e})")
    return out


def stations(cities, store, metars):
    """Las estaciones como City (para extraerlas igual que una ciudad). Coordenadas y altura salen del propio
    METAR y se guardan en el cubo, por si otro día el servicio no responde."""
    meta = store.get("verify/stations.json") or {}
    for o in metars:
        icao = o.get("icaoId")
        if icao and o.get("lat") is not None and o.get("lon") is not None:
            meta[icao] = {"name": o.get("name") or icao, "lat": o["lat"], "lon": o["lon"], "elev": o.get("elev")}
    wanted = sorted({c.metar for c in cities if c.metar})
    missing = [i for i in wanted if i not in meta]
    if missing:
        print(f"verify: sin datos de las estaciones {missing}")
    if metars:
        store.put("verify/stations.json", meta)
    return [City(id=station_key(i), name=meta[i]["name"], lat=meta[i]["lat"], lon=meta[i]["lon"], tz="UTC",
                 elev=meta[i]["elev"]) for i in wanted if i in meta]


def _observed(metars):
    """{icao: {hora en punto: °C}} a las horas que se miden, con la observación más cercana a cada hora."""
    best = {}
    for o in metars:
        temp, t = o.get("temp"), o.get("obsTime")
        if temp is None or t is None:
            continue
        t = datetime.fromtimestamp(int(t), timezone.utc)
        hour = (t + timedelta(minutes=30)).replace(minute=0, second=0, microsecond=0)
        gap = abs(t - hour)
        if hour.hour not in HOURS or gap > OBS_TOLERANCE:
            continue
        key = (o["icaoId"], iso(hour))
        if key not in best or gap < best[key][0]:
            best[key] = (gap, float(temp))
    out = {}
    for (icao, hour), (_, temp) in best.items():
        out.setdefault(icao, {})[hour] = temp
    return out


def update(store, docs, metars, now=None):
    """Apunta los pronósticos nuevos, puntúa los que ya tienen observación y guarda el estado. Devuelve los
    resúmenes diarios {modelo: {icao: {día: {fecha: [Σ|error|, Σerror, n]}}}}."""
    now = now or datetime.now(timezone.utc)
    state = store.get("verify/state.json") or {}
    forecasts, scores = state.get("forecasts", {}), state.get("scores", {})
    _purge_impossible(forecasts, scores)

    # 1. Lo que dice cada pasada para las horas que aún no han llegado. Solo el futuro: lo pasado ya se puntuó
    # (o se está esperando su observación) y apuntarlo otra vez lo contaría dos veces.
    for doc in docs:
        run = parse(doc["run"])
        for key, s in doc["cities"].items():
            if not key.startswith("st-"):
                continue
            by_time = forecasts.setdefault(doc["id"], {}).setdefault(key[3:], {})
            for t, temp in zip(s["times"], s["temp"]):
                if temp is None or not PLAUSIBLE[0] <= temp <= PLAUSIBLE[1]:
                    continue
                valid = parse(t)
                lead = (valid - run).total_seconds() / 3600
                day = math.ceil(lead / 24)
                if valid.hour not in HOURS or valid <= now or lead <= 0 or day > MAX_DAY:
                    continue
                # La pasada más reciente de cada día de antelación pisa a la anterior.
                by_time.setdefault(t, {})[str(day)] = temp

    # 2. Los que ya tienen observación: su error, al resumen de ese día.
    observed = _observed(metars)
    scored = 0
    for model, by_station in forecasts.items():
        for icao, by_time in by_station.items():
            for t in list(by_time):
                obs = observed.get(icao, {}).get(t)
                if obs is not None:
                    for day, value in by_time.pop(t).items():
                        cell = (scores.setdefault(model, {}).setdefault(icao, {}).setdefault(day, {})
                                .setdefault(t[:10], [0.0, 0.0, 0]))
                        err = value - obs
                        cell[0] = round(cell[0] + abs(err), 2)
                        cell[1] = round(cell[1] + err, 2)
                        cell[2] += 1
                        scored += 1
                elif parse(t) < now - FORGET_AFTER:
                    del by_time[t]

    # 3. Solo los últimos WINDOW_DAYS días.
    oldest = (now - timedelta(days=WINDOW_DAYS)).strftime("%Y-%m-%d")
    for by_station in scores.values():
        for by_day in by_station.values():
            for by_date in by_day.values():
                for date in [d for d in by_date if d < oldest]:
                    del by_date[date]

    store.put("verify/state.json", {"updated": iso(now), "forecasts": forecasts, "scores": scores})
    print(f"verify: {scored} pronósticos puntuados con {sum(len(v) for v in observed.values())} observaciones")
    return scores


def summary(scores, icaos=None):
    """Error medio absoluto (°C) y sesgo de cada modelo por día de antelación, en esas estaciones (o en todas)."""
    out = {}
    for model, by_station in scores.items():
        totals = {}
        for icao, by_day in by_station.items():
            if icaos is not None and icao not in icaos:
                continue
            for day, by_date in by_day.items():
                t = totals.setdefault(day, [0.0, 0.0, 0])
                for a, b, n in by_date.values():
                    t[0] += a
                    t[1] += b
                    t[2] += n
        days = {d: {"mae": round(a / n, 2), "bias": round(b / n, 2), "n": n} for d, (a, b, n) in totals.items() if n}
        if days:
            out[model] = dict(sorted(days.items()))
    return out


def distance_km(a, b):
    """Distancia entre dos puntos (lat, lon) en km."""
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(h))


def for_city(city, stations_by_icao, scores, spain):
    """El bloque «accuracy» del JSON de una ciudad: la estación cercana (si la hay) y el resumen de España."""
    st = stations_by_icao.get(city.metar) if city.metar else None
    km = None if st is None else distance_km((city.lat, city.lon), (st.lat, st.lon))
    local = st is not None and km <= STATION_MAX_KM
    return {
        "windowDays": WINDOW_DAYS,
        "station": {"id": city.metar, "name": st.name, "km": round(km, 1)} if local else None,
        "local": summary(scores, {city.metar}) if local else {},
        "spain": spain,
    }
