"""
Piezas compartidas por la IA de lluvia diaria (descargar_lluvia.py, entrenar_lluvia.py y predecir_lluvia.py).

El «día de lluvia» es el de AEMET: de las 07:00 UTC de un día a las 07:00 UTC del siguiente
(las 9:00 en horario de verano peninsular). Es como AEMET suma la precipitación diaria en sus
estaciones, así que las previsiones de los modelos se suman en esa misma ventana.

La regla de oro: las variables de entrada se calculan EXACTAMENTE igual al entrenar que al predecir.
"""
from datetime import datetime, timedelta, timezone

import numpy as np

from comun import MODEL_IDS

DAY_START_UTC = 7        # el día pluviométrico empieza a las 07:00 UTC
WET_MM = 1.0             # «llueve» = al menos 1 mm en el día (por debajo es poco más que rocío o chispeo)
LEAD_DAYS = (1, 2, 3)

RAIN_FEATURES = (
    [f"f_{m}" for m in MODEL_IDS]
    + ["mean", "std", "min", "max", "n_models", "wet_share", "lead",
       "doy_sin", "doy_cos", "lat", "lon", "elev"]
)


def window(day):
    """Inicio y fin (segundos Unix) del día pluviométrico que empieza el día `day` (date)."""
    start = datetime(day.year, day.month, day.day, DAY_START_UTC, tzinfo=timezone.utc)
    return int(start.timestamp()), int((start + timedelta(days=1)).timestamp())


def total_in_window(times, amounts, start, end):
    """
    Lluvia (mm) que cae entre start y end según una serie de acumulados por paso:
    amounts[i] es lo que cae entre times[i-1] y times[i]. Un paso que cruza el borde del día
    se reparte en proporción al tiempo que queda dentro. None si la serie no cubre la ventana entera.
    """
    if len(times) < 2 or times[0] > start or times[-1] < end:
        return None
    total = 0.0
    for i in range(1, len(times)):
        t0, t1 = times[i - 1], times[i]
        if t1 <= start or t0 >= end:
            continue
        a = amounts[i]
        if a is None or (isinstance(a, float) and np.isnan(a)):
            return None
        overlap = min(t1, end) - max(t0, start)
        total += float(a) * overlap / (t1 - t0)
    return total


def build_X_rain(df, metas):
    """
    df: una fila por ciudad, día y antelación, con columnas city, day (AAAA-MM-DD), lead (1-3)
        y f_<modelo> (mm previstos ese día o NaN).
    metas: {ciudad: {"lat", "lon", "elev"}}.
    Devuelve (X con RAIN_FEATURES, media de los modelos). Media NaN si hay menos de 2 modelos.
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
    # Qué parte de los modelos da un día de lluvia: lo que hoy ve la web como «confianza».
    X["wet_share"] = (f >= WET_MM).sum(axis=1) / n.where(n > 0)
    X["lead"] = df["lead"].astype(float)
    doy = pd.to_datetime(df["day"]).dt.dayofyear.astype(float)
    X["doy_sin"] = np.sin(2 * np.pi * doy / 365.25)
    X["doy_cos"] = np.cos(2 * np.pi * doy / 365.25)
    X["lat"] = df["city"].map(lambda c: metas[c]["lat"]).astype(float)
    X["lon"] = df["city"].map(lambda c: metas[c]["lon"]).astype(float)
    X["elev"] = df["city"].map(lambda c: metas[c].get("elev") or 0).astype(float)
    return X[list(RAIN_FEATURES)], X["mean"]
