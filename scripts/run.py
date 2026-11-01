"""Pide a Open-Meteo los modelos que tengan pasada nueva y publica un JSON por ciudad con todos ellos.

Uso:
    python scripts/run.py                     # todos los modelos
    python scripts/run.py --models ifs gfs    # solo esos
    python scripts/run.py --force             # aunque la pasada ya esté publicada

Publica en el cubo de Supabase (o en out/public/ sin claves):
    models/<modelo>.json   la última pasada de cada modelo, para todas las ciudades
    cities/<ciudad>.json   lo que lee la web: la ciudad con todos los modelos (y «ml» y «ml_rain», la IA de
                           temperatura y la de lluvia diaria, si están entrenadas y aprobaron su examen,
                           y «acierto», si acertaron los días pasados)
    index.json             ciudades y pasada de cada modelo

Los pueblos no salen de aquí: la app pide a Open-Meteo los modelos en su punto exacto y usa estas ciudades
para la IA, lo medido y como respaldo.

Los datos vienen de Open-Meteo (weather/openmeteo.py). Sin OPEN_METEO_KEY usa el plan gratis (no comercial).
"""

import argparse
import sys
import traceback
from dataclasses import asdict
from datetime import datetime, timezone

from weather.common import OUT_DIR, load_cities
from weather.openmeteo import MODELS
from weather.store import Store
from weather import verify

ATTRIBUTION = ("Datos meteorológicos: Open-Meteo.com (CC BY 4.0), con los modelos de ECMWF, NOAA GFS, DWD ICON-EU, "
               "Météo-France ARPEGE y AROME, Met Office y ECCC GEM. Observaciones: METAR de NOAA aviationweather.gov.")
iso = lambda d: d.strftime("%Y-%m-%dT%H:%MZ")
STALE_HOURS = 24   # una pasada más vieja que esto ya es un problema de verdad


def update_model(model, points, store, force, stations=()):
    """La última pasada de un modelo: la nueva si la hay, o la ya publicada.
    Las estaciones (solo sirven para medir el acierto) se piden solo en las pasadas de 00 y 12 UTC: ahorra llamadas."""
    published = store.get(f"models/{model.id}.json")
    try:
        run = model.latest()
        if published and published.get("run") == iso(run) and not force:
            print(f"{model.id}: {iso(run)} ya publicada")
            return published, True
        print(f"{model.id}: descargando {iso(run)}…", flush=True)
        with_stations = list(stations) if run.hour % 12 == 0 else []
        series = model.fetch(run, list(points) + with_stations)
        doc = {"id": model.id, "name": model.name, "resolution": model.resolution,
               "run": iso(run), "cities": series}
        store.put(f"models/{model.id}.json", doc)
        stations = sum(k.startswith("st-") for k in series)
        print(f"{model.id}: {len(series) - stations} ciudades y {stations} estaciones")
        return doc, True
    except Exception as e:
        # Un modelo que falla no tumba a los demás: se queda la última pasada publicada.
        print(f"{model.id}: ERROR, se mantiene la pasada anterior", file=sys.stderr)
        traceback.print_exc()
        # Aviso amarillo en GitHub (se ve en el resumen de la ejecución), sin ponerla en rojo.
        print(f"::warning title={model.name}::No se pudo descargar ({type(e).__name__}: {str(e)[:150]}); "
              f"se mantiene la pasada {published.get('run') if published else 'anterior'}")
        return published, False


def load_ml():
    """La corrección con IA (scripts/ml), si está entrenada y aprobó su examen: (add_ml, modelo, examen, ahora).
    Es opcional: si falta algo (librerías, modelo), se publica igual, sin la serie «ml»."""
    try:
        from ml.predecir import add_ml, cargar
        loaded = cargar()
    except Exception as e:
        print(f"ml: no disponible ({e})", file=sys.stderr)
        return None
    if not loaded:
        return None
    return add_ml, loaded[0], loaded[1], int(datetime.now(timezone.utc).timestamp())


def load_ml_rain():
    """La IA de lluvia diaria (scripts/ml/predecir_lluvia.py), si está entrenada y aprobó. Opcional, como load_ml."""
    try:
        from ml.predecir_lluvia import add_ml_rain, cargar
        loaded = cargar()
    except Exception as e:
        print(f"ml_rain: no disponible ({e})", file=sys.stderr)
        return None
    if not loaded:
        return None
    return add_ml_rain, loaded[0], loaded[1], int(datetime.now(timezone.utc).timestamp())


def load_acierto(store, cities):
    """El historial «¿acertó la IA?» (scripts/ml/acierto.py). Opcional: si falla, se publica sin él."""
    try:
        from ml import acierto
        now = int(datetime.now(timezone.utc).timestamp())
        return acierto, acierto.load(store, cities, now), now
    except Exception as e:
        print(f"acierto: no disponible ({e})", file=sys.stderr)
        return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--models", nargs="*", help="ids: " + ", ".join(m.id for m in MODELS))
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    OUT_DIR.mkdir(exist_ok=True)
    store = Store()
    cities = load_cities()
    chosen = [m for m in MODELS if not args.models or m.id in args.models]
    # Las estaciones METAR se extraen como una ciudad más, para comparar cada modelo con lo medido.
    metars = verify.fetch_metars(sorted({c.metar for c in cities if c.metar}))
    stations = verify.stations(cities, store, metars)
    # Los que no se piden se componen con lo ya publicado.
    results = [update_model(m, cities, store, args.force, stations) if m in chosen
               else (store.get(f"models/{m.id}.json"), True) for m in MODELS]
    docs = [d for d, _ in results if d]
    if not docs:
        sys.exit("Ningún modelo disponible")

    # La precisión real no debe impedir publicar el pronóstico.
    try:
        scores = verify.update(store, docs, metars)
    except Exception:
        print("verify: ERROR, se publica sin precisión nueva", file=sys.stderr)
        traceback.print_exc()
        scores = (store.get("verify/state.json") or {}).get("scores", {})
    spain = verify.summary(scores)
    by_icao = {s.id[3:]: s for s in stations}

    generated = iso(datetime.now(timezone.utc))
    meta = [{k: d[k] for k in ("id", "name", "resolution", "run")} for d in docs]
    ml = load_ml()
    ml_rain = load_ml_rain()
    hist = load_acierto(store, cities)
    for c in cities:
        doc = {
            "city": asdict(c), "generated": generated, "attribution": ATTRIBUTION,
            "models": [{**m, **d["cities"][c.id]} for m, d in zip(meta, docs) if c.id in d["cities"]],
            "accuracy": verify.for_city(c, by_icao, scores, spain),
        }
        if ml:
            try:
                ml[0](doc, *ml[1:])
            except Exception as e:
                print(f"ml: {c.id} sin serie de la IA ({e})", file=sys.stderr)
        if ml_rain:
            try:
                ml_rain[0](doc, *ml_rain[1:])
            except Exception as e:
                print(f"ml_rain: {c.id} sin lluvia de la IA ({e})", file=sys.stderr)
        if hist:
            try:
                hist[0].record(hist[1], doc, hist[2])
                h = hist[0].history(hist[1], c.id, c.tz, hist[2])
                if h:
                    doc["acierto"] = h
            except Exception as e:
                print(f"acierto: {c.id} sin historial ({e})", file=sys.stderr)
        store.put(f"cities/{c.id}.json", doc)
    if hist:
        try:
            hist[0].save(store, hist[1], hist[2])
        except Exception as e:
            print(f"acierto: no se pudo guardar el estado ({e})", file=sys.stderr)
    store.put("index.json", {"generated": generated, "attribution": ATTRIBUTION, "models": meta, "accuracy": spain,
                             "cities": [asdict(c) for c in cities]})
    print(f"Publicadas {len(cities)} ciudades con {len(docs)} modelos" + ("" if store.remote else " en out/public/"))
    # Un fallo suelto (un servidor que tarda, un archivo que aún no está) se arregla solo en la
    # siguiente hora: queda como aviso amarillo. En rojo (y con email) solo si un modelo lleva
    # más de STALE_HOURS sin pasada nueva, porque entonces sí hay algo que mirar.
    now = datetime.now(timezone.utc)
    stale = [d["id"] for d in docs
             if (now - datetime.strptime(d["run"], "%Y-%m-%dT%H:%MZ").replace(tzinfo=timezone.utc)).total_seconds()
             > STALE_HOURS * 3600]
    missing = [m.id for m, (d, _) in zip(MODELS, results) if not d]
    if stale or missing:
        sys.exit(f"Modelos sin pasada reciente (más de {STALE_HOURS} h): {', '.join(stale + missing)}")


if __name__ == "__main__":
    main()
