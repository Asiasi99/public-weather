#!/usr/bin/env python3
"""
Paso 2 del nivel 2: la IA aprende de los fallos de los modelos.

No predice la temperatura desde cero: aprende la CORRECCIÓN que hay que aplicar a la media
de tus 8 modelos («en Bilbao, de noche y con viento sur, la media se queda 1,2° corta»).
Así nunca se aleja mucho de los modelos y no inventa extremos que ninguno da.

Entrena tres versiones: la mediana (la previsión) y los percentiles 10 y 90, que dan un
rango donde la temperatura real cae 8 de cada 10 veces.

Antes de guardar nada, se examina a sí misma con los últimos meses, que NO ha visto al
entrenar, y compara su error con el de la media normal. Si no mejora, lo deja escrito
en metricas.json («usar»: false) y predecir.py no la aplica.

Entrada: ml/datos/historial.csv.gz y ml/datos/ciudades.json (de descargar_historial.py).
Salida:  ml/modelo.joblib y ml/metricas.json.
"""
import json
import os
import sys
from datetime import datetime, timezone

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor

sys.path.insert(0, os.path.dirname(__file__))
from comun import FEATURES, LEAD_DAYS  # noqa: E402
from comun import build_X  # noqa: E402

HERE = os.path.dirname(__file__)
DATA = os.path.join(HERE, "datos", "historial.csv.gz")
METAS = os.path.join(HERE, "datos", "ciudades.json")
MODEL_OUT = os.path.join(HERE, "modelo.joblib")
METRICS_OUT = os.path.join(HERE, "metricas.json")

QUANTILES = {"p10": 0.1, "p50": 0.5, "p90": 0.9}
TEST_SHARE = 0.2          # el último 20 % del tiempo se reserva para el examen
MIN_ROWS = 20_000         # con menos, la IA aún no tiene de dónde aprender


def make_model(q):
    return HistGradientBoostingRegressor(
        loss="quantile", quantile=q,
        learning_rate=0.05, max_iter=500, max_leaf_nodes=31,
        min_samples_leaf=200,       # cada regla debe apoyarse en al menos 200 casos
        l2_regularization=1.0,
        early_stopping=True, validation_fraction=0.1, n_iter_no_change=30,
        random_state=0,
    )


def fit(X, y):
    return {name: make_model(q).fit(X, y) for name, q in QUANTILES.items()}


def predict(models, X, mean):
    """Temperatura corregida: media + corrección aprendida. Percentiles ordenados siempre."""
    p = np.column_stack([models[k].predict(X) for k in ("p10", "p50", "p90")])
    p.sort(axis=1)   # que p10 ≤ p50 ≤ p90 aunque los tres modelos discrepen un poco
    m = np.asarray(mean)[:, None]
    return {"p10": m[:, 0] + p[:, 0], "p50": m[:, 0] + p[:, 1], "p90": m[:, 0] + p[:, 2]}


def load():
    df = pd.read_csv(DATA)
    with open(METAS) as f:
        metas = json.load(f)
    df = df[df["city"].isin(metas)]
    X, mean = build_X(df, metas)
    ok = mean.notna() & df["obs"].notna()
    return df[ok].reset_index(drop=True), X[ok].reset_index(drop=True), mean[ok].reset_index(drop=True)


def evaluate(df, X, mean):
    cutoff = df["t"].quantile(1 - TEST_SHARE)
    train, test = df["t"] < cutoff, df["t"] >= cutoff
    y = df["obs"] - mean
    models = fit(X[train], y[train])
    pr = predict(models, X[test], mean[test])

    obs = df.loc[test, "obs"].to_numpy()
    base = mean[test].to_numpy()
    err_ml = np.abs(pr["p50"] - obs)
    err_mean = np.abs(base - obs)
    inside = (obs >= pr["p10"]) & (obs <= pr["p90"])
    lead = df.loc[test, "lead"].to_numpy()
    city = df.loc[test, "city"].to_numpy()

    by_lead = {
        str(n): {"mae_ia": round(float(err_ml[lead == n].mean()), 2),
                 "mae_media": round(float(err_mean[lead == n].mean()), 2),
                 "n": int((lead == n).sum())}
        for n in LEAD_DAYS if (lead == n).any()
    }
    by_city = {
        c: {"mae_ia": round(float(err_ml[city == c].mean()), 2),
            "mae_media": round(float(err_mean[city == c].mean()), 2)}
        for c in sorted(set(city))
    }
    mae_ml, mae_mean = float(err_ml.mean()), float(err_mean.mean())
    # Hasta qué día vista se usa: mientras gane a la media en TODOS los días anteriores (1, 2, 3…).
    dias = 0
    for n in LEAD_DAYS:
        m = by_lead.get(str(n))
        if not m or m["mae_ia"] >= m["mae_media"]:
            break
        dias = n
    return {
        "examen_desde": datetime.fromtimestamp(cutoff, tz=timezone.utc).strftime("%Y-%m-%d"),
        "filas_entreno": int(train.sum()),
        "filas_examen": int(test.sum()),
        "mae_ia": round(mae_ml, 2),
        "mae_media": round(mae_mean, 2),
        "mejora_pct": round(100 * (1 - mae_ml / mae_mean), 1),
        # Si el rango 10-90 está bien calibrado, debería acertar cerca del 80 %.
        "rango_10_90_acierta_pct": round(100 * float(inside.mean()), 1),
        "por_antelacion": by_lead,
        "por_ciudad": by_city,
        "dias_ia": dias,
        "usar": mae_ml < mae_mean and dias > 0,
    }


def main():
    df, X, mean = load()
    print(f"{len(df)} filas de {df['city'].nunique()} ciudades")
    if len(df) < MIN_ROWS:
        sys.exit(f"Solo hay {len(df)} filas; hacen falta al menos {MIN_ROWS}.")

    metrics = evaluate(df, X, mean)
    print(f"Examen (desde {metrics['examen_desde']}): "
          f"IA {metrics['mae_ia']}° vs media {metrics['mae_media']}° "
          f"({metrics['mejora_pct']:+} %), rango 10-90 acierta {metrics['rango_10_90_acierta_pct']} %")
    for n, m in metrics["por_antelacion"].items():
        print(f"  a {n} día(s): IA {m['mae_ia']}° vs media {m['mae_media']}°")

    # Aprobada o no, se reentrena con TODO el historial para la versión final.
    models = fit(X, df["obs"] - mean)
    trained = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ")
    metrics["entrenado"] = trained
    joblib.dump({"models": models, "features": FEATURES, "trained": trained, "lead_days": metrics["dias_ia"]},
                MODEL_OUT, compress=3)
    with open(METRICS_OUT, "w") as f:
        json.dump(metrics, f, ensure_ascii=False, indent=1)
    print((f"✔ La IA mejora a la media hasta {metrics['dias_ia']} días vista: se usará." if metrics["usar"]
           else "✘ La IA no mejora a la media: predecir.py no la aplicará."))


if __name__ == "__main__":
    main()
