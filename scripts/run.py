"""Descarga los modelos que tengan pasada nueva y publica un JSON por ciudad con todos ellos.

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
    grid/…                 la rejilla de España (weather/grid.py): el tiempo en cualquier punto, en teselas de 1°
"""

import argparse
import shutil
import sys
import traceback
from dataclasses import asdict
from datetime import datetime, timezone

from weather.arpege import Arome, Arpege
from weather.common import OUT_DIR, load_cities
from weather.ecmwf import Aifs, Ifs
from weather.gem import Gem
from weather.gfs import Gfs
from weather import grid
from weather.icon import IconEu
from weather.store import Store
from weather.ukmo import Ukmo
from weather import verify

MODELS = [Ifs(), Aifs(), Gfs(), IconEu(), Arpege(), Arome(), Ukmo(), Gem()]
ATTRIBUTION = ("Datos: ECMWF Open Data (CC BY 4.0), NOAA GFS (dominio público), DWD ICON-EU (CC BY 4.0), "
               "Météo-France ARPEGE y AROME (Licence Ouverte 2.0), Met Office (© Crown copyright, CC BY-SA 4.0) "
               "y ECCC GEM (Licencia del Gobierno Abierto de Canadá). Observaciones: METAR de NOAA aviationweather.gov. "
               "Modificados: punto de rejilla elegido, corrección por altitud y unidades.")
iso = lambda d: d.strftime("%Y-%m-%dT%H:%MZ")
STALE_HOURS = 24   # una pasada más vieja que esto ya es un problema de verdad


def update_model(model, points, store, force, grid_points=()):
    """La última pasada de un modelo: la nueva si la hay, o la ya publicada.
    Con grid_points, lee también la rejilla de España y la guarda en la caché (no en models/<id>.json)."""
    published = store.get(f"models/{model.id}.json")
    try:
        run = model.latest()
        if published and published.get("run") == iso(run) and not force:
            print(f"{model.id}: {iso(run)} ya publicada")
            return published, True
        print(f"{model.id}: descargando {iso(run)}…", flush=True)
        series = model.fetch(run, list(points) + list(grid_points))
        cells = {k: v for k, v in series.items() if grid.is_grid(k)}
        series = {k: v for k, v in series.items() if not grid.is_grid(k)}
        if cells:
            try:
                grid.save_cache(model.id, iso(run), cells)
                print(f"{model.id}: {len(cells)} puntos de la rejilla")
            except Exception as e:
                print(f"{model.id}: rejilla sin guardar ({e})", file=sys.stderr)
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
    finally:
        shutil.rmtree(OUT_DIR / model.id.split("-")[0], ignore_errors=True)
        (OUT_DIR / f"{model.id}.grib2").unlink(missing_ok=True)


def publish_grid(store, docs, generated):
    """La rejilla de España: mezcla lo que hay en la caché de cada modelo (de su última pasada) y sube las teselas.
    Si algo falla, las ciudades ya están publicadas: solo se avisa."""
    try:
        runs = {d["id"]: d["run"] for d in docs}
        per_model, used = {}, []
        for model_id, run in runs.items():
            c = grid.load_cache(model_id)
            # Solo si la caché es de una pasada reciente (como mucho 36 h): mejor sin ese modelo que con datos viejos
            if not c or not c.get("points"):
                continue
            age = (datetime.now(timezone.utc) - datetime.strptime(c["run"], "%Y-%m-%dT%H:%MZ").replace(tzinfo=timezone.utc)).total_seconds() / 3600
            if age > 36:
                continue
            per_model[model_id] = c["points"]
            used.append(model_id)
        if not per_model:
            print("rejilla: sin modelos en la caché todavía")
            return
        dst, composed = grid.compose(per_model)
        out = grid.tiles(dst, composed, generated, used)
        for path, doc in out.items():
            store.put(path, doc, max_age=900)
        print(f"rejilla: {len(out) - 1} teselas con {len(composed)} puntos y {len(used)} modelos ({', '.join(used)})")
        # El mapa de la app: un fichero por cada paso de 3 h (si falla, las teselas ya están)
        try:
            m = grid.mapa(dst, composed, generated, used)
            for path, doc in m.items():
                store.put(path, doc, max_age=900)
            print(f"mapa: {len(m) - 1} pasos")
        except Exception as e:
            print(f"::warning title=Mapa::No se pudo publicar el mapa ({type(e).__name__}: {str(e)[:150]})")
    except Exception as e:
        print(f"::warning title=Rejilla::No se pudo publicar la rejilla ({type(e).__name__}: {str(e)[:150]})")
        traceback.print_exc()


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
    grid_points = grid.points()
    results = [update_model(m, cities + stations, store, args.force, grid_points) if m in chosen
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
    publish_grid(store, docs, generated)
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
