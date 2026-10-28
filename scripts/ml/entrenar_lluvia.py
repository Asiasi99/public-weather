#!/usr/bin/env python3
"""
IA de lluvia, paso 2: aprender de los fallos de los modelos con la lluvia de cada día.

Entrena dos cosas con los mismos datos:
  - la PROBABILIDAD de que llueva al menos 1 mm ese día (un clasificador), y
  - CUÁNTO lloverá, en mm (un regresor de tipo Poisson: nunca da negativos y entiende
    que casi todos los días son 0 y unos pocos llueve mucho).

Examen: se reservan los últimos meses (que no ve al aprender) y se compara con lo que hoy
usaría cualquiera mirando los modelos:
  - probabilidad «de los modelos» = qué parte de los modelos da al menos 1 mm;
  - cantidad «de los modelos» = la media de lo que dan.
La probabilidad se puntúa con el índice de Brier (el error al cuadrado entre la probabilidad
y lo que pasó, 1 si llovió y 0 si no: 0 es perfecto, más bajo es mejor).
Solo se usa si gana en las dos cosas.

Entrada: ml/datos/lluvia/historial.csv.gz y ciudades.json (de descargar_lluvia.py).
Salida:  ml/modelo_lluvia.joblib y ml/metricas_lluvia.json.
"""
import json
import os
import sys
from datetime import datetime, timezone

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier, HistGradientBoostingRegressor

sys.path.insert(0, os.path.dirname(__file__))
from lluvia_comun import LEAD_DAYS, RAIN_FEATURES, WET_MM, build_X_rain  # noqa: E402

HERE = os.path.dirname(__file__)
DATA = os.path.join(HERE, "datos", "lluvia", "historial.csv.gz")
METAS = os.path.join(HERE, "datos", "lluvia", "ciudades.json")
MODEL_OUT = os.path.join(HERE, "modelo_lluvia.joblib")
METRICS_OUT = os.path.join(HERE, "metricas_lluvia.json")

TEST_SHARE = 0.2
MIN_ROWS = 10_000
COMMON = dict(learning_rate=0.05, max_iter=500, max_leaf_nodes=31, min_samples_leaf=100,
              l2_regularization=1.0, early_stopping=True, validation_fraction=0.1,
              n_iter_no_change=30, random_state=0)


def fit(X, obs):
    wet = (obs >= WET_MM).astype(int)
    return {
        "prob": HistGradientBoostingClassifier(**COMMON).fit(X, wet),
        "mm": HistGradientBoostingRegressor(loss="poisson", **COMMON).fit(X, obs),
    }


def predict(models, X):
    return {
        "prob": models["prob"].predict_proba(X)[:, 1],
        "mm": np.clip(models["mm"].predict(X), 0, None),
    }


def load():
    df = pd.read_csv(DATA)
    with open(METAS) as f:
        metas = json.load(f)
    df = df[df["city"].isin(metas)]
    X, mean = build_X_rain(df, metas)
    ok = mean.notna() & df["obs"].notna()
    return df[ok].reset_index(drop=True), X[ok].reset_index(drop=True), mean[ok].reset_index(drop=True)


def brier(p, y):
    return float(np.mean((p - y) ** 2))


def evaluate(df, X, mean):
    days = pd.to_datetime(df["day"])
    cutoff = days.quantile(1 - TEST_SHARE)
    train, test = days < cutoff, days >= cutoff
    models = fit(X[train], df.loc[train, "obs"])
    pr = predict(models, X[test])

    obs = df.loc[test, "obs"].to_numpy()
    wet = (obs >= WET_MM).astype(float)
    base_prob = X.loc[test, "wet_share"].to_numpy()
    base_mm = mean[test].to_numpy()
    lead = df.loc[test, "lead"].to_numpy()
    city = df.loc[test, "city"].to_numpy()

    def scores(mask):
        return {
            "brier_ia": round(brier(pr["prob"][mask], wet[mask]), 3),
            "brier_modelos": round(brier(base_prob[mask], wet[mask]), 3),
            "mae_ia": round(float(np.abs(pr["mm"][mask] - obs[mask]).mean()), 2),
            "mae_modelos": round(float(np.abs(base_mm[mask] - obs[mask]).mean()), 2),
            # Acierto «¿llueve sí o no?» si se dice «sí» a partir del 50 %.
            "acierto_ia_pct": round(100 * float(((pr["prob"][mask] >= 0.5) == (wet[mask] == 1)).mean()), 1),
            "acierto_modelos_pct": round(100 * float(((base_prob[mask] >= 0.5) == (wet[mask] == 1)).mean()), 1),
            "n": int(mask.sum()),
        }

    all_mask = np.ones(len(obs), bool)
    m = scores(all_mask)
    # Calibración: de los días en que la IA dijo ~70 %, ¿llovió de verdad en ~7 de cada 10?
    bins = np.clip((pr["prob"] * 10).astype(int), 0, 9)
    calib = {f"{b * 10}-{b * 10 + 10}%": round(100 * float(wet[bins == b].mean()), 1)
             for b in range(10) if (bins == b).sum() >= 30}
    return {
        "examen_desde": cutoff.strftime("%Y-%m-%d"),
        "filas_entreno": int(train.sum()),
        "filas_examen": int(test.sum()),
        "dias_lluvia_pct": round(100 * float(wet.mean()), 1),
        **m,
        "llovio_de_verdad_segun_prob_ia": calib,
        "por_antelacion": {str(n): scores(lead == n) for n in LEAD_DAYS if (lead == n).any()},
        "por_ciudad": {c: scores(city == c) for c in sorted(set(city))},
        "usar": m["brier_ia"] < m["brier_modelos"] and m["mae_ia"] < m["mae_modelos"],
    }


def main():
    df, X, mean = load()
    print(f"{len(df)} filas de {df['city'].nunique()} ciudades")
    if len(df) < MIN_ROWS:
        sys.exit(f"Solo hay {len(df)} filas; hacen falta al menos {MIN_ROWS}.")

    metrics = evaluate(df, X, mean)
    print(f"Examen (desde {metrics['examen_desde']}, llueve {metrics['dias_lluvia_pct']} % de los días):")
    print(f"  probabilidad: Brier IA {metrics['brier_ia']} vs modelos {metrics['brier_modelos']}"
          f" · acierto sí/no IA {metrics['acierto_ia_pct']} % vs modelos {metrics['acierto_modelos_pct']} %")
    print(f"  cantidad: error IA {metrics['mae_ia']} mm vs media de modelos {metrics['mae_modelos']} mm")
    for n, s in metrics["por_antelacion"].items():
        print(f"  a {n} día(s): Brier IA {s['brier_ia']} vs {s['brier_modelos']} · mm IA {s['mae_ia']} vs {s['mae_modelos']}")

    models = fit(X, df["obs"])
    trained = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ")
    metrics["entrenado"] = trained
    joblib.dump({"models": models, "features": list(RAIN_FEATURES), "trained": trained}, MODEL_OUT, compress=3)
    with open(METRICS_OUT, "w") as f:
        json.dump(metrics, f, ensure_ascii=False, indent=1)
    print("✔ La IA de lluvia mejora a los modelos: se usará." if metrics["usar"]
          else "✘ La IA de lluvia no mejora a los modelos: no se aplicará.")


if __name__ == "__main__":
    main()
