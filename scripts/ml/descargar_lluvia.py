#!/usr/bin/env python3
"""
IA de lluvia, paso 1: los «exámenes resueltos» de lluvia diaria.

Para cada una de las 52 ciudades junta, desde 2024:
  - lo que PREDIJO cada uno de tus 8 modelos para cada día, 1, 2 y 3 días antes
    (Open-Meteo Previous Runs API, sumando la lluvia hora a hora de 07 a 07 UTC), y
  - lo que LLOVIÓ de verdad ese día en la estación de AEMET más parecida a la ciudad
    (valores climatológicos diarios de AEMET OpenData, también de 07 a 07 UTC).

Resultado: ml/datos/lluvia/historial.csv.gz, una fila por ciudad, día y antelación.

Como descargar_historial.py, guarda cada ciudad en su propio archivo (prev/ y obs/) y, si se corta
(límite de la API o de tiempo), la siguiente ejecución sigue donde lo dejó. Solo cuando están
todas escribe DONE y se puede entrenar.

Variables de entorno: AEMET_API_KEY (obligatoria) y ML_BUDGET_MIN (minutos máximos de descarga).
"""
import csv
import gzip
import json
import math
import os
import sys
import time
import urllib.error
from datetime import date, datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(__file__))
from comun import MODEL_IDS, MODELS, get, load_cities, metas_of  # noqa: E402
from descargar_historial import CHUNK_DAYS, RATE_PER_HOUR, START, Parar, open_meteo, peso  # noqa: E402
from lluvia_comun import LEAD_DAYS, window  # noqa: E402  (la lluvia sigue a 1-3 días)

AEMET_KEY = os.environ.get("AEMET_API_KEY", "").strip()
BUDGET_MIN = float(os.environ.get("ML_BUDGET_MIN", "0") or 0)

DATOS = os.path.join(os.path.dirname(__file__), "datos", "lluvia")
PREV = os.path.join(DATOS, "prev")
OBS = os.path.join(DATOS, "obs")
OUT = os.path.join(DATOS, "historial.csv.gz")
STATIONS = os.path.join(DATOS, "estaciones.json")
DONE = os.path.join(DATOS, "DONE")

MAX_KM = 25                  # más lejos ya no es «la lluvia de tu ciudad»
ALT_PENALTY_M = 50           # cada 50 m de desnivel cuentan como 1 km más (como observado.py)
AEMET_CHUNK_DAYS = 150       # AEMET no da más de unos 6 meses por petición
AEMET_PAUSE_S = 2            # unas 30 peticiones por minuto, por debajo de su límite
PREV_HEADER = ["day", "lead"] + [f"f_{m}" for m in MODEL_IDS]
HEADER = ["city", "day", "lead"] + [f"f_{m}" for m in MODEL_IDS] + ["obs"]


# --- AEMET ----------------------------------------------------------------------------------

def aemet(path):
    """Las peticiones de AEMET van en dos pasos: primero te da una URL, luego los datos (en latin-1)."""
    for intento in range(4):
        try:
            meta = json.loads(get(f"https://opendata.aemet.es/opendata/api/{path}?api_key={AEMET_KEY}", tries=2))
        except urllib.error.HTTPError as e:
            if e.code == 429:
                time.sleep(60)
                continue
            raise
        estado = meta.get("estado")
        if estado == 404:          # «No hay datos que satisfagan esos criterios»
            return []
        if estado == 429:
            time.sleep(60)
            continue
        if estado != 200:
            raise RuntimeError(f"AEMET {estado}: {meta.get('descripcion')}")
        time.sleep(AEMET_PAUSE_S)
        rows = json.loads(get(meta["datos"]).decode("latin-1"))
        time.sleep(AEMET_PAUSE_S)
        return rows
    raise RuntimeError("AEMET sigue respondiendo 429")


def dms(s):
    """«394924N» → 39,823 (grados, minutos y segundos; oeste y sur en negativo)."""
    s = s.strip()
    sign = -1 if s[-1] in "WS" else 1
    d = s[:-1].rjust(6, "0")
    return sign * (int(d[:2]) + int(d[2:4]) / 60 + int(d[4:6]) / 3600)


def km(lat1, lon1, lat2, lon2):
    r = math.pi / 180
    a = (math.sin((lat2 - lat1) * r / 2) ** 2
         + math.cos(lat1 * r) * math.cos(lat2 * r) * math.sin((lon2 - lon1) * r / 2) ** 2)
    return 12742 * math.asin(math.sqrt(a))


def pick_stations(cities):
    """La estación climatológica de AEMET más parecida a cada ciudad (cerca y a una altura parecida)."""
    if os.path.exists(STATIONS):
        with open(STATIONS) as f:
            return json.load(f)
    inv = aemet("valores/climatologicos/inventarioestaciones/todasestaciones")
    out = {}
    for c in cities:
        best = None
        for s in inv:
            try:
                lat, lon, alt = dms(s["latitud"]), dms(s["longitud"]), float(s.get("altitud") or 0)
            except (KeyError, ValueError):
                continue
            d = km(c.lat, c.lon, lat, lon)
            if d > MAX_KM:
                continue
            score = d + abs(alt - (c.elev or 0)) / ALT_PENALTY_M
            if best is None or score < best[0]:
                best = (score, {"id": s["indicativo"], "name": s.get("nombre", "").title(), "km": round(d, 1)})
        out[c.id] = best[1] if best else None
        print(f"  {c.id}: {out[c.id]['name'] + ' (' + str(out[c.id]['km']) + ' km)' if best else 'sin estación cercana'}")
    with open(STATIONS, "w") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    return out


def mm(v):
    """«12,4» → 12.4; «Ip» (inapreciable) → 0; «Acum» o vacío → None (día sin dato limpio)."""
    if v is None:
        return None
    v = str(v).strip().replace(",", ".")
    if v == "Ip":
        return 0.0
    try:
        return float(v)
    except ValueError:
        return None


def obs_for(station_id, end):
    """{día: mm} de la estación, desde START hasta end."""
    out = {}
    d1 = START
    while d1 <= end:
        d2 = min(d1 + timedelta(days=AEMET_CHUNK_DAYS - 1), end)
        rows = aemet(f"valores/climatologicos/diarios/datos/fechaini/{d1}T00:00:00UTC"
                     f"/fechafin/{d2}T23:59:59UTC/estacion/{station_id}")
        for r in rows:
            v = mm(r.get("prec"))
            if v is not None and r.get("fecha"):
                out[r["fecha"]] = v
        d1 = d2 + timedelta(days=1)
    return out


# --- Modelos (Open-Meteo) ---------------------------------------------------------------------

def om_url(city, d1, d2):
    hourly = ",".join(f"precipitation_previous_day{n}" for n in LEAD_DAYS)
    return (
        "https://previous-runs-api.open-meteo.com/v1/forecast"
        f"?latitude={city.lat}&longitude={city.lon}&elevation={city.elev or 0}"
        f"&hourly={hourly}&models={','.join(MODELS.values())}"
        f"&start_date={d1.isoformat()}&end_date={d2.isoformat()}&timezone=GMT"
    )


def hourly_of(doc):
    """{antelación: {modelo: {instante_unix: mm en la hora que termina ahí}}}"""
    by_om = {v: k for k, v in MODELS.items()}
    hourly = doc.get("hourly", {})
    times = [int(datetime.strptime(t, "%Y-%m-%dT%H:%M").replace(tzinfo=timezone.utc).timestamp())
             for t in hourly.get("time", [])]
    out = {}
    for key, values in hourly.items():
        for n in LEAD_DAYS:
            prefix = f"precipitation_previous_day{n}_"
            if key.startswith(prefix) and key[len(prefix):] in by_om:
                series = out.setdefault(n, {}).setdefault(by_om[key[len(prefix):]], {})
                for t, v in zip(times, values):
                    if v is not None:
                        series[t] = v
    return out


def daily_rows(hourly, first, last):
    """Una fila por día y antelación: lo que suma cada modelo de 07 a 07 UTC (las 24 horas, o nada)."""
    rows = []
    day = first
    while day <= last:
        start, end = window(day)
        hours = range(start + 3600, end + 1, 3600)      # cada valor es la hora que TERMINA en t
        for n in LEAD_DAYS:
            row = [day.isoformat(), n]
            for m in MODEL_IDS:
                s = hourly.get(n, {}).get(m, {})
                vals = [s.get(t) for t in hours]
                row.append(round(sum(vals), 2) if all(v is not None for v in vals) else "")
            if any(v != "" for v in row[2:]):
                rows.append(row)
        day += timedelta(days=1)
    return rows


def prev_for(city, end, t0):
    hourly = {}
    d1 = START
    while d1 <= end:
        if BUDGET_MIN and time.time() - t0 > BUDGET_MIN * 60:
            raise Parar(f"se acabaron los {BUDGET_MIN:.0f} min de esta ejecución")
        # Un día más al final: el día pluviométrico termina a las 07:00 UTC del siguiente.
        d2 = min(d1 + timedelta(days=CHUNK_DAYS - 1), end + timedelta(days=1))
        try:
            part = hourly_of(json.loads(open_meteo(om_url(city, d1, d2))))
            for n, by_model in part.items():
                for m, series in by_model.items():
                    hourly.setdefault(n, {}).setdefault(m, {}).update(series)
        except Parar:
            raise
        except Exception as e:
            print(f"! {city.id} {d1}…{d2}: {e}", file=sys.stderr)
        time.sleep(math.ceil(peso(d1, d2) * 3600 / RATE_PER_HOUR))
        d1 = d2 + timedelta(days=1)
    return daily_rows(hourly, START, end)


# --- Todo junto ------------------------------------------------------------------------------

def write_csv(path, header, rows):
    with gzip.open(path + ".tmp", "wt", newline="") as f:
        w = csv.writer(f)
        w.writerow(header)
        w.writerows(rows)
    os.replace(path + ".tmp", path)


def read_csv(path):
    with gzip.open(path, "rt", newline="") as f:
        return list(csv.DictReader(f))


def juntar(cities):
    total = 0
    with gzip.open(OUT, "wt", newline="") as f:
        w = csv.writer(f)
        w.writerow(HEADER)
        for c in cities:
            p, o = os.path.join(PREV, f"{c.id}.csv.gz"), os.path.join(OBS, f"{c.id}.csv.gz")
            if not (os.path.exists(p) and os.path.exists(o)):
                continue
            obs = {r["day"]: r["mm"] for r in read_csv(o)}
            for r in read_csv(p):
                if r["day"] in obs:
                    w.writerow([c.id, r["day"], r["lead"]] + [r[f"f_{m}"] for m in MODEL_IDS] + [obs[r["day"]]])
                    total += 1
    with open(os.path.join(DATOS, "ciudades.json"), "w") as f:
        json.dump(metas_of(cities), f, ensure_ascii=False)
    return total


def main():
    if not AEMET_KEY:
        sys.exit("Falta AEMET_API_KEY: sin ella no hay lluvia medida con la que aprender.")
    t0 = time.time()
    end = date.today() - timedelta(days=2)    # AEMET tarda un par de días en publicar el dato diario
    for d in (PREV, OBS):
        os.makedirs(d, exist_ok=True)
    if os.path.exists(DONE):
        os.remove(DONE)
    cities = load_cities()
    stations = pick_stations(cities)
    usable = [c for c in cities if stations.get(c.id)]
    print(f"{len(usable)}/{len(cities)} ciudades con estación AEMET a menos de {MAX_KM} km")

    # 1) Lo medido: rápido (AEMET), así se ve pronto si la clave funciona.
    for c in usable:
        path = os.path.join(OBS, f"{c.id}.csv.gz")
        if os.path.exists(path):
            continue
        try:
            obs = obs_for(stations[c.id]["id"], end)
        except Exception as e:
            print(f"! {c.id}: lluvia medida no disponible ({e}); se reintentará", file=sys.stderr)
            continue
        write_csv(path, ["day", "mm"], sorted(obs.items()))
        print(f"{c.id}: {len(obs)} días medidos en {stations[c.id]['name']}", flush=True)

    # 2) Lo previsto: lento (Open-Meteo, con su límite por hora y por día).
    pendientes = [c for c in usable if not os.path.exists(os.path.join(PREV, f"{c.id}.csv.gz"))]
    print(f"Previsiones: faltan {len(pendientes)} ciudades")
    for i, c in enumerate(pendientes, 1):
        try:
            rows = prev_for(c, end, t0)
        except Parar as e:
            print(f"■ Parada: {e}. Lo descargado se guarda y la próxima ejecución sigue desde {c.id}.")
            break
        except Exception as e:
            print(f"! {c.id}: no se pudo descargar ({e}); se reintentará", file=sys.stderr)
            continue
        write_csv(os.path.join(PREV, f"{c.id}.csv.gz"), PREV_HEADER, rows)
        print(f"[{i}/{len(pendientes)}] {c.id}: {len(rows)} filas · {(time.time() - t0) / 60:.0f} min", flush=True)

    hechas = sum(os.path.exists(os.path.join(PREV, f"{c.id}.csv.gz")) and os.path.exists(os.path.join(OBS, f"{c.id}.csv.gz"))
                 for c in usable)
    total = juntar(usable)
    print(f"Total: {total} filas de {hechas}/{len(usable)} ciudades → {OUT}")
    if hechas == len(usable):
        open(DONE, "w").close()
        print("✔ Historial de lluvia completo: se puede entrenar")
    else:
        print("… Historial incompleto: no se entrena todavía. Vuelve a lanzar «Entrenar IA lluvia» (mejor al día siguiente).")


if __name__ == "__main__":
    main()
