#!/usr/bin/env python3
"""
IA de lluvia, paso 3: aplicarla a la previsión de hoy.

Con lo que acaba de descargar run.py (cities/<id>.json), suma la lluvia de cada modelo en los
próximos días pluviométricos (07 a 07 UTC, como AEMET) y añade al mismo JSON «ml_rain»:

  "ml_rain": {
    "days": ["2026-10-22", ...],   ← el día empieza ese día a las 07:00 UTC
    "prob": [0.72, ...],           ← probabilidad de al menos 1 mm
    "mm":   [4.1, ...],            ← lluvia esperada
    "trained": "...", "brier_ia": .., "brier_modelos": .., "mae_ia": .., "mae_modelos": ..
  }

Lo llama run.py antes de publicar cada ciudad. Si no hay IA de lluvia o no aprobó su examen
(metricas_lluvia.json → "usar": false), no toca nada.
"""
import json
import os
import sys
from datetime import datetime, timedelta, timezone

import joblib
import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(__file__))
from comun import MODEL_IDS  # noqa: E402
from lluvia_comun import LEAD_DAYS, build_X_rain, total_in_window, window  # noqa: E402

HERE = os.path.dirname(__file__)


def parse_t(s):
    return int(datetime.strptime(s.rstrip("Z"), "%Y-%m-%dT%H:%M").replace(tzinfo=timezone.utc).timestamp())


def rows_for(doc, now):
    """Una fila por día pluviométrico (hoy y los dos siguientes) con lo que suma cada modelo ese día."""
    series = {}
    for m in doc["models"]:
        if m["id"] in MODEL_IDS and m.get("rain"):
            series[m["id"]] = ([parse_t(t) for t in m["times"]], m["rain"], parse_t(m["run"]))
    today = datetime.fromtimestamp(now, tz=timezone.utc)
    # El día pluviométrico en curso es el que empezó hoy a las 07 UTC (o ayer, si aún no son las 07).
    first = (today - timedelta(hours=7)).date()
    rows = []
    for k in range(len(LEAD_DAYS)):
        day = first + timedelta(days=k)
        start, end = window(day)
        values, leads = {}, []
        for mid, (times, rain, run) in series.items():
            v = total_in_window(times, rain, start, end)
            if v is not None:
                values[f"f_{mid}"] = v
                leads.append(((start + end) / 2 - run) / 86400)
        if len(values) < 2:
            continue
        lead = int(min(max(round(float(np.median(leads))), 1), max(LEAD_DAYS)))
        rows.append({"city": doc["city"]["id"], "day": day.isoformat(), "lead": lead, **values})
    return pd.DataFrame(rows, columns=["city", "day", "lead"] + [f"f_{m}" for m in MODEL_IDS])


def add_ml_rain(doc, bundle, metrics, now):
    df = rows_for(doc, now)
    if df.empty:
        return False
    c = doc["city"]
    X, mean = build_X_rain(df, {c["id"]: {"lat": c["lat"], "lon": c["lon"], "elev": c.get("elev") or 0}})
    ok = mean.notna()
    if not ok.any():
        return False
    models = bundle["models"]
    prob = models["prob"].predict_proba(X[ok])[:, 1]
    amount = np.clip(models["mm"].predict(X[ok]), 0, None)
    doc["ml_rain"] = {
        "days": list(df.loc[ok, "day"]),
        "prob": [round(float(p), 2) for p in prob],
        "mm": [round(float(v), 1) for v in amount],
        "trained": bundle["trained"],
        **{k: metrics.get(k) for k in ("brier_ia", "brier_modelos", "mae_ia", "mae_modelos")},
    }
    return True


def cargar():
    """La IA de lluvia y su examen, o None si no hay o no aprobó. Lo usa run.py antes de publicar."""
    metrics_path = os.path.join(HERE, "metricas_lluvia.json")
    model_path = os.path.join(HERE, "modelo_lluvia.joblib")
    if not (os.path.exists(metrics_path) and os.path.exists(model_path)):
        print("ml_rain: aún no hay IA de lluvia entrenada")
        return None
    with open(metrics_path) as f:
        metrics = json.load(f)
    if not metrics.get("usar"):
        print("ml_rain: la IA de lluvia no mejoró a los modelos en su examen; no se aplica")
        return None
    return joblib.load(model_path), metrics
