"""
Piezas compartidas por descargar_historial.py, entrenar.py y predecir.py.

La regla de oro del aprendizaje automático: las variables de entrada se calculan
EXACTAMENTE igual al entrenar que al predecir. Por eso viven aquí, en un solo sitio.
"""
import os
import sys
import time
import urllib.error
import urllib.request

import numpy as np

# Para usar las piezas de scripts/weather (ciudades y Supabase) igual que run.py.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from weather.common import load_cities  # noqa: E402,F401
from weather.store import Store  # noqa: E402,F401

# Tus 8 modelos y su nombre en Open-Meteo (solo para el historial con el que se entrena).
MODELS = {
    "ifs": "ecmwf_ifs025",
    "aifs": "ecmwf_aifs025_single",
    "gfs": "gfs_global",
    "icon-eu": "icon_eu",
    "arpege": "meteofrance_arpege_europe",
    "arome": "meteofrance_arome_france",
    "ukmo": "ukmo_global_deterministic_10km",
    "gem": "gem_global",
}
MODEL_IDS = list(MODELS)
LEAD_DAYS = (1, 2, 3, 4, 5, 6, 7)   # la IA aprende de 1 a 7 días vista; solo se usa hasta donde gana a la media
STEP_HOURS = 3          # se entrena y se predice cada 3 h, como tus series

FEATURES = (
    [f"f_{m}" for m in MODEL_IDS]
    + ["mean", "std", "min", "max", "n_models", "lead",
       "hour_sin", "hour_cos", "doy_sin", "doy_cos", "lat", "lon", "elev"]
)


def build_X(df, metas):
    """
    df: una fila por ciudad, instante y antelación, con columnas
        city, t (segundos Unix, UTC), lead (1-3) y f_<modelo> (temperatura o NaN).
    metas: {ciudad: {"lat", "lon", "elev"}}.
    Devuelve (X con las columnas FEATURES, media de los modelos). Las filas con menos
    de 2 modelos quedan con media NaN: quien llama decide descartarlas.
    """
    import pandas as pd

    f = df[[f"f_{m}" for m in MODEL_IDS]].astype(float)
    X = pd.DataFrame(index=df.index)
    for m in MODEL_IDS:
        X[f"f_{m}"] = f[f"f_{m}"]
    n = f.notna().sum(axis=1)
    X["mean"] = f.mean(axis=1).where(n >= 2)
    X["std"] = f.std(axis=1, ddof=0)
    X["min"] = f.min(axis=1)
    X["max"] = f.max(axis=1)
    X["n_models"] = n.astype(float)
    X["lead"] = df["lead"].astype(float)
    # Hora y día del año como ángulos: así las 23 h quedan junto a las 0 h y el 31-dic junto al 1-ene.
    t = df["t"].astype(float)
    hour = (t % 86400) / 3600
    doy = (t / 86400) % 365.25
    X["hour_sin"] = np.sin(2 * np.pi * hour / 24)
    X["hour_cos"] = np.cos(2 * np.pi * hour / 24)
    X["doy_sin"] = np.sin(2 * np.pi * doy / 365.25)
    X["doy_cos"] = np.cos(2 * np.pi * doy / 365.25)
    X["lat"] = df["city"].map(lambda c: metas[c]["lat"]).astype(float)
    X["lon"] = df["city"].map(lambda c: metas[c]["lon"]).astype(float)
    X["elev"] = df["city"].map(lambda c: metas[c].get("elev") or 0).astype(float)
    return X[FEATURES], X["mean"]


# --- Red --------------------------------------------------------------------------------

def metas_of(cities):
    """{ciudad: {"lat", "lon", "elev"}} a partir de cities.json: también son variables de entrada."""
    return {c.id: {"lat": c.lat, "lon": c.lon, "elev": c.elev or 0} for c in cities}


def get(url, tries=4, timeout=120):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "web-tiempo-ml/1.0"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if i == tries - 1:
                raise
            time.sleep(60 if e.code == 429 else 5 * (i + 1))
        except Exception:
            if i == tries - 1:
                raise
            time.sleep(5 * (i + 1))
