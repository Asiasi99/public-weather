#!/usr/bin/env python3
"""
Paso 3 del nivel 2: aplicar la IA a la previsión de hoy.

Lee cities/<id>.json (lo que acaba de escribir run.py), calcula cada 3 h de las próximas
72 h la temperatura corregida y su rango 10-90 %, y la añade al mismo JSON como «ml»:

  "ml": {
    "times": ["2026-10-20T00:00Z", ...],
    "temp":  [12.4, ...],     ← la previsión de la IA
    "p10":   [11.1, ...],     ← 1 de cada 10 veces hará menos que esto
    "p90":   [13.9, ...],     ← 1 de cada 10 veces hará más que esto
    "trained": "...", "mae_ia": 1.1, "mae_media": 1.4
  }

Lo llama run.py justo antes de publicar cada ciudad (cargar() + add_ml()), así se escribe
una sola vez y nunca se lee una copia vieja de la caché de Supabase. Si no hay IA entrenada
o no aprobó su examen (metricas.json → "usar": false), no toca nada.
"""
import json
import os
import sys
from datetime import datetime, timezone

import joblib
import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(__file__))
from comun import LEAD_DAYS, MODEL_IDS, STEP_HOURS, Store, build_X, load_cities  # noqa: E402
from entrenar import predict  # noqa: E402

HERE = os.path.dirname(__file__)
STEP = STEP_HOURS * 3600


def parse_t(s):
    return int(datetime.strptime(s.rstrip("Z"), "%Y-%m-%dT%H:%M").replace(tzinfo=timezone.utc).timestamp())


def iso(t):
    return datetime.fromtimestamp(t, tz=timezone.utc).strftime("%Y-%m-%dT%H:%MZ")


def rows_for(doc, now, max_lead=3):
    """Una fila por instante (cada 3 h, hasta max_lead días vista) con lo que da cada modelo justo a esa hora."""
    series = {}
    for m in doc["models"]:
        if m["id"] not in MODEL_IDS:
            continue
        series[m["id"]] = ({parse_t(t): v for t, v in zip(m["times"], m["temp"]) if v is not None},
                           parse_t(m["run"]))
    start = -(-now // STEP) * STEP          # el siguiente múltiplo de 3 h
    rows = []
    for t in range(start, now + 24 * max_lead * 3600 + 1, STEP):
        values, leads = {}, []
        for mid, (by_t, run) in series.items():
            if t in by_t:
                values[f"f_{mid}"] = by_t[t]
                leads.append((t - run) / 3600)
        if len(values) < 2:
            continue
        # Antelación en días, como en el entrenamiento (1, 2 o 3). Lo de hoy cuenta como 1.
        lead = int(min(max(round(float(np.median(leads)) / 24), 1), max_lead))
        rows.append({"city": doc["city"]["id"], "t": t, "lead": lead, **values})
    return pd.DataFrame(rows, columns=["city", "t", "lead"] + [f"f_{m}" for m in MODEL_IDS])


def add_ml(doc, bundle, metrics, now):
    # Hasta donde la IA ganó a la media en su examen (los modelos antiguos, sin el dato, a 3 días).
    df = rows_for(doc, now, int(bundle.get("lead_days") or 3))
    if df.empty:
        return False
    c = doc["city"]
    X, mean = build_X(df, {c["id"]: {"lat": c["lat"], "lon": c["lon"], "elev": c.get("elev") or 0}})
    ok = mean.notna()
    pr = predict(bundle["models"], X[ok], mean[ok])
    doc["ml"] = {
        "times": [iso(t) for t in df.loc[ok, "t"]],
        "temp": [round(float(v), 1) for v in pr["p50"]],
        "p10": [round(float(v), 1) for v in pr["p10"]],
        "p90": [round(float(v), 1) for v in pr["p90"]],
        "trained": bundle["trained"],
        "mae_ia": metrics.get("mae_ia"),
        "mae_media": metrics.get("mae_media"),
    }
    return True


def cargar():
    """La IA entrenada y su examen, o None si no hay o si no aprobó. Lo usa run.py antes de publicar."""
    metrics_path, model_path = os.path.join(HERE, "metricas.json"), os.path.join(HERE, "modelo.joblib")
    if not (os.path.exists(metrics_path) and os.path.exists(model_path)):
        print("ml: aún no hay IA entrenada (lanza el workflow «entrenar-ia»)")
        return None
    with open(metrics_path) as f:
        metrics = json.load(f)
    if not metrics.get("usar"):
        print("ml: la IA no mejoró a la media en su examen; no se aplica")
        return None
    return joblib.load(model_path), metrics


def main():
    """A mano: añade «ml» a lo ya publicado. Normalmente no hace falta: run.py la añade al publicar."""
    loaded = cargar()
    if not loaded:
        return
    bundle, metrics = loaded
    store = Store()
    now = int(datetime.now(timezone.utc).timestamp())
    done = 0
    for city in load_cities():
        try:
            doc = store.get(f"cities/{city.id}.json")
            if doc and add_ml(doc, bundle, metrics, now):
                store.put(f"cities/{city.id}.json", doc)
                done += 1
        except Exception as e:
            print(f"! {city.id}: {e}", file=sys.stderr)
    print(f"Serie «ml» añadida a {done} ciudades")


if __name__ == "__main__":
    main()
