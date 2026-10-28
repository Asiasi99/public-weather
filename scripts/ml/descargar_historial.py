#!/usr/bin/env python3
"""
Paso 1 del nivel 2: el «libro de ejercicios resueltos» con el que aprende la IA.

Para cada ciudad junta, desde 2024:
  - lo que PREDIJO cada uno de tus 8 modelos 1, 2 y 3 días antes
    (Open-Meteo Previous Runs API, que archiva las previsiones pasadas), y
  - lo que luego se MIDIÓ de verdad en el aeropuerto de esa ciudad
    (METAR archivados del Iowa Environmental Mesonet, la misma estación que usa verify.py).

Resultado: ml/datos/historial.csv.gz, una fila por ciudad, instante y antelación.

Va ciudad a ciudad y guarda cada una en ml/datos/ciudades/<id>.csv.gz. Si se corta (límite de
la API o de tiempo), al volver a lanzarlo sigue donde lo dejó: el workflow guarda esa carpeta en
la caché de GitHub. Solo cuando están todas escribe el archivo DONE y se puede entrenar.

Límites de la API gratuita de Open-Meteo: 5.000 «llamadas» por hora y 10.000 por día, y una
petición grande cuenta como varias (cada 10 variables y cada 14 días cuentan como una más).
Por eso se espera entre peticiones para no pasar de RATE_PER_HOUR.

Licencia: la API gratuita de Open-Meteo es para uso no comercial. Aquí solo se usa para
entrenar; cuando tu propio archivo (archivar.py) tenga unos meses, se puede entrenar solo
con tus datos y dejar Open-Meteo.
"""
import csv
import gzip
import io
import json
import math
import os
import sys
import time
import urllib.error
from datetime import date, datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(__file__))
from comun import LEAD_DAYS, MODEL_IDS, MODELS, STEP_HOURS, get, load_cities, metas_of  # noqa: E402

START = date(2024, 1, 1)
CHUNK_DAYS = 92          # Open-Meteo: pedir de 3 en 3 meses para no hacer respuestas enormes
DATOS = os.path.join(os.path.dirname(__file__), "datos")
OUT = os.path.join(DATOS, "historial.csv.gz")
# «ciudades7»: con antelaciones de 1 a 7 días (la carpeta «ciudades» tenía solo de 1 a 3).
POR_CIUDAD = os.path.join(DATOS, "ciudades7")
DONE = os.path.join(DATOS, "DONE")
RATE_PER_HOUR = 4000     # por debajo de las 5.000/h de Open-Meteo, con margen
# Minutos máximos de descarga en esta ejecución (el workflow lo pone por debajo de su límite).
BUDGET_MIN = float(os.environ.get("ML_BUDGET_MIN", "0") or 0)
HEADER = ["city", "t", "lead"] + [f"f_{m}" for m in MODEL_IDS] + ["obs"]


class Parar(Exception):
    """Se acabó la cuota diaria de la API o el tiempo: guardar lo hecho y seguir otro día."""


def peso(d1, d2):
    """Cuántas «llamadas» cuenta Open-Meteo por una petición: 56 variables (8 modelos × 7 días) y ~92 días ≈ 37."""
    variables = len(LEAD_DAYS) * len(MODELS)
    dias = (d2 - d1).days + 1
    return max(1.0, variables / 10) * max(1.0, dias / 14)


def open_meteo(url):
    """Como get(), pero si la API dice «demasiadas peticiones» (429) espera de verdad:
    15 min por si es el límite por hora; si sigue, es el diario y hay que parar."""
    for intento in range(3):
        try:
            return get(url, tries=2)
        except urllib.error.HTTPError as e:
            if e.code != 429:
                raise
            print(f"  Open-Meteo: límite alcanzado (429), espero 15 min… ({intento + 1}/3)", flush=True)
            time.sleep(900)
    raise Parar("Open-Meteo sigue en 429: cuota diaria agotada")


def om_url(city, d1, d2):
    hourly = ",".join(f"temperature_2m_previous_day{n}" for n in LEAD_DAYS)
    return (
        "https://previous-runs-api.open-meteo.com/v1/forecast"
        f"?latitude={city.lat}&longitude={city.lon}&elevation={city.elev or 0}"
        f"&hourly={hourly}&models={','.join(MODELS.values())}"
        f"&start_date={d1.isoformat()}&end_date={d2.isoformat()}&timezone=GMT"
    )


def parse_open_meteo(doc):
    """
    {instante_unix: {antelación: {modelo: temp}}} solo en horas múltiplo de 3.
    Con varios modelos, Open-Meteo nombra las columnas «temperature_2m_previous_day1_gfs_global».
    """
    by_om = {v: k for k, v in MODELS.items()}
    hourly = doc.get("hourly", {})
    times = [int(datetime.strptime(t, "%Y-%m-%dT%H:%M").replace(tzinfo=timezone.utc).timestamp())
             for t in hourly.get("time", [])]
    out = {}
    for key, values in hourly.items():
        for n in LEAD_DAYS:
            prefix = f"temperature_2m_previous_day{n}_"
            if not key.startswith(prefix):
                continue
            model = by_om.get(key[len(prefix):])
            if not model:
                continue
            for t, v in zip(times, values):
                if v is None or (t // 3600) % STEP_HOURS:
                    continue
                out.setdefault(t, {}).setdefault(n, {})[model] = v
    return out


def iem_url(icao, d1, d2):
    return (
        "https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py"
        f"?station={icao}&data=tmpc&year1={d1.year}&month1={d1.month}&day1={d1.day}"
        f"&year2={d2.year}&month2={d2.month}&day2={d2.day}"
        "&tz=Etc/UTC&format=onlycomma&latlon=no&missing=M&trace=T&direct=no&report_type=3"
    )


def parse_iem(text):
    """{instante_unix_en_punto: temp}: solo lecturas a menos de 10 min de una hora múltiplo de 3."""
    out = {}
    for row in csv.DictReader(io.StringIO(text)):
        v = row.get("tmpc")
        if not v or v == "M":
            continue
        t = int(datetime.strptime(row["valid"], "%Y-%m-%d %H:%M").replace(tzinfo=timezone.utc).timestamp())
        hour = round(t / 3600) * 3600
        if abs(t - hour) > 600 or (hour // 3600) % STEP_HOURS:
            continue
        # Si hay dos lecturas para la misma hora, la más cercana a la hora en punto.
        if hour not in out or abs(t - hour) < out[hour][1]:
            out[hour] = (float(v), abs(t - hour))
    return {k: v for k, (v, _) in out.items()}


def rows_for_city(cid, forecasts, obs):
    for t in sorted(forecasts):
        if t not in obs:
            continue
        for n, by_model in forecasts[t].items():
            yield [cid, t, n] + [by_model.get(m, "") for m in MODEL_IDS] + [obs[t]]


def descargar_ciudad(city, end, t0):
    """Las filas de una ciudad, o Parar si se acaba la cuota o el tiempo."""
    obs = parse_iem(get(iem_url(city.metar, START, end), timeout=300).decode())
    forecasts = {}
    d1 = START
    while d1 <= end:
        if BUDGET_MIN and time.time() - t0 > BUDGET_MIN * 60:
            raise Parar(f"se acabaron los {BUDGET_MIN:.0f} min de esta ejecución")
        d2 = min(d1 + timedelta(days=CHUNK_DAYS - 1), end)
        try:
            part = parse_open_meteo(json.loads(open_meteo(om_url(city, d1, d2))))
            for t, by_lead in part.items():
                for n, by_model in by_lead.items():
                    forecasts.setdefault(t, {}).setdefault(n, {}).update(by_model)
        except Parar:
            raise
        except Exception as e:
            print(f"! {city.id} {d1}…{d2}: {e}", file=sys.stderr)
        # Ser educados con la API gratuita: no pasar de RATE_PER_HOUR llamadas por hora.
        time.sleep(math.ceil(peso(d1, d2) * 3600 / RATE_PER_HOUR))
        d1 = d2 + timedelta(days=1)
    return list(rows_for_city(city.id, forecasts, obs)), len(obs)


def juntar(cities):
    total = 0
    with gzip.open(OUT, "wt", newline="") as f:
        w = csv.writer(f)
        w.writerow(HEADER)
        for city in cities:
            path = os.path.join(POR_CIUDAD, f"{city.id}.csv.gz")
            if not os.path.exists(path):
                continue
            with gzip.open(path, "rt", newline="") as g:
                r = csv.reader(g)
                next(r, None)
                for row in r:
                    w.writerow(row)
                    total += 1
    with open(os.path.join(DATOS, "ciudades.json"), "w") as f:
        json.dump(metas_of(cities), f, ensure_ascii=False)
    return total


def main():
    t0 = time.time()
    end = date.today() - timedelta(days=1)
    os.makedirs(POR_CIUDAD, exist_ok=True)
    if os.path.exists(DONE):
        os.remove(DONE)
    cities = [c for c in load_cities() if c.metar]
    pendientes = [c for c in cities if not os.path.exists(os.path.join(POR_CIUDAD, f"{c.id}.csv.gz"))]
    print(f"{len(cities) - len(pendientes)}/{len(cities)} ciudades ya descargadas; faltan {len(pendientes)}")
    for i, city in enumerate(pendientes, 1):
        try:
            rows, n_obs = descargar_ciudad(city, end, t0)
        except Parar as e:
            print(f"■ Parada: {e}. Lo descargado se guarda y la próxima ejecución sigue desde {city.id}.")
            break
        except Exception as e:
            print(f"! {city.id}: no se pudo descargar ({e}); se reintentará la próxima vez", file=sys.stderr)
            continue
        path = os.path.join(POR_CIUDAD, f"{city.id}.csv.gz")
        with gzip.open(path + ".tmp", "wt", newline="") as f:
            w = csv.writer(f)
            w.writerow(HEADER)
            w.writerows(rows)
        os.replace(path + ".tmp", path)
        print(f"[{i}/{len(pendientes)}] {city.id}: {len(rows)} filas ({n_obs} medidas) · "
              f"{(time.time() - t0) / 60:.0f} min", flush=True)

    hechas = sum(os.path.exists(os.path.join(POR_CIUDAD, f"{c.id}.csv.gz")) for c in cities)
    total = juntar(cities)
    print(f"Total: {total} filas de {hechas}/{len(cities)} ciudades → {OUT}")
    if hechas == len(cities):
        open(DONE, "w").close()
        print("✔ Historial completo: se puede entrenar")
    else:
        print("… Historial incompleto: no se entrena todavía. Vuelve a lanzar «Entrenar IA» (mejor al día siguiente).")


if __name__ == "__main__":
    main()
