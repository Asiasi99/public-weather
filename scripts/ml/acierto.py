"""
¿Acertó la IA? El historial de los días pasados, ciudad a ciudad.

Funciona como apuntar en una libreta lo que dijo el hombre del tiempo y, días después, tachar o
marcar según lo que pasó:

  1. LO QUE DIJO: en cada publicación (run.py) se apunta, para cada día que aún no ha empezado,
     lo que da la IA (lluvia: probabilidad y mm; temperatura: máxima y mínima) y lo que dan los
     modelos. Cuando el día empieza, la última apuntada se queda fija: es «lo que dijo la víspera».
     Los días ya pasados nunca se reescriben, así que no hay trampa posible.
  2. LO QUE PASÓ: cada 6 h se piden a AEMET los valores diarios de los últimos 10 días
     (lluvia de 07 a 07 UTC, máxima y mínima) de la misma estación con la que aprendió la IA.
     AEMET tarda de 1 a 4 días en publicarlos: hasta entonces el día sale «pendiente».

Todo se guarda en acierto/estado.json (en el cubo) y cada ciudad publica en su JSON:

  "acierto": {
    "station": {"id", "name", "km"},
    "days": [
      {"day": "2026-10-22",
       "rain": {"prob": 0.7, "mm": 4.1, "mod_prob": 0.5, "mod_mm": 3.2},   ← lo que dijeron
       "temp": {"max": 21.3, "min": 11.0, "mod_max": 22.1, "mod_min": 10.2},
       "obs":  {"mm": 5.2, "tmax": 21.8, "tmin": 10.6}}                     ← lo que pasó (o null)
    ]
  }

La primera vez, además, rellena con las copias de archive/ (archivar.py), que también son lo
que se publicó de verdad en su momento.
"""
import io
import json
import os
import sys
import tarfile
from collections import defaultdict
from datetime import date, datetime, time as dtime, timedelta, timezone
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.dirname(__file__))
from lluvia_comun import WET_MM, total_in_window, window  # noqa: E402

STATE = "acierto/estado.json"
OBS_EVERY_H = 6        # cada cuánto se pregunta a AEMET
OBS_DAYS = 10          # cuántos días hacia atrás se le piden (AEMET no da más de 15 de todas las estaciones)
KEEP_DAYS = 45         # lo que se guarda en el estado
SHOW_DAYS = 10         # lo que se publica en cada ciudad
ARCHIVE_FROM = datetime(2026, 10, 21, tzinfo=timezone.utc)   # la primera IA publicada


def parse_t(s):
    return int(datetime.strptime(s.rstrip("Z"), "%Y-%m-%dT%H:%M").replace(tzinfo=timezone.utc).timestamp())


def iso(t):
    return datetime.fromtimestamp(t, tz=timezone.utc).strftime("%Y-%m-%dT%H:%MZ")


def num(v):
    """«21,4» → 21.4 (AEMET usa coma decimal); lo que no sea número → None."""
    if v is None:
        return None
    try:
        return float(str(v).strip().replace(",", "."))
    except ValueError:
        return None


# --- 1. Lo que dijo ---------------------------------------------------------------------------

def record(state, doc, now):
    """Apunta lo que dice esta publicación para cada día que aún no ha empezado."""
    cid = doc["city"]["id"]
    tz = ZoneInfo(doc["city"].get("tz") or "Europe/Madrid")
    preds = state.setdefault("pred", {}).setdefault(cid, {})
    issued = iso(now)

    # Lluvia: el día va de 07 a 07 UTC (como en AEMET y en el entrenamiento).
    r = doc.get("ml_rain")
    if r:
        series = [([parse_t(t) for t in m["times"]], m["rain"]) for m in doc["models"] if m.get("rain")]
        for day, prob, amount in zip(r["days"], r["prob"], r["mm"]):
            start, end = window(date.fromisoformat(day))
            if start <= now:
                continue
            totals = [v for v in (total_in_window(ts, rr, start, end) for ts, rr in series) if v is not None]
            preds.setdefault(day, {})["rain"] = {
                "prob": prob,
                "mm": amount,
                # Lo que verías sin IA: qué parte de los modelos da ≥1 mm y cuánto dan de media.
                "mod_prob": round(sum(v >= WET_MM for v in totals) / len(totals), 2) if totals else None,
                "mod_mm": round(sum(totals) / len(totals), 1) if totals else None,
                "issued": issued,
            }

    # Temperatura: el día es el de la ciudad (de medianoche a medianoche, hora local).
    ml = doc.get("ml")
    if ml:
        local = lambda t: datetime.fromtimestamp(t, tz=tz).date().isoformat()  # noqa: E731
        ai = defaultdict(list)
        for t, v in zip(ml["times"], ml["temp"]):
            if v is not None:
                ai[local(parse_t(t))].append(v)
        # La media de los modelos cada 3 h (donde haya al menos 2), como la línea gruesa de la web.
        by_t = defaultdict(list)
        for m in doc["models"]:
            for t, v in zip(m["times"], m["temp"]):
                tt = parse_t(t)
                if v is not None and tt % 10800 == 0:
                    by_t[tt].append(v)
        mod = defaultdict(list)
        for tt, vals in by_t.items():
            if len(vals) >= 2:
                mod[local(tt)].append(sum(vals) / len(vals))
        for day, vals in ai.items():
            midnight = datetime.combine(date.fromisoformat(day), dtime(0), tz).timestamp()
            # Solo días enteros (8 puntos cada 3 h) que aún no han empezado.
            if midnight <= now or len(vals) < 8:
                continue
            m = mod.get(day, [])
            preds.setdefault(day, {})["temp"] = {
                "max": round(max(vals), 1),
                "min": round(min(vals), 1),
                "mod_max": round(max(m), 1) if len(m) >= 8 else None,
                "mod_min": round(min(m), 1) if len(m) >= 8 else None,
                "issued": issued,
            }


def backfill(state, store):
    """La primera vez: lo que se publicó desde el primer día de la IA, sacado de archive/ (cada 6 h)."""
    if state.get("backfill") or not hasattr(store, "get_bytes"):
        return
    t = ARCHIVE_FROM
    now = datetime.now(timezone.utc)
    n = 0
    while t <= now:
        body = store.get_bytes(f"archive/{t:%Y-%m-%dT%H}.tar.gz")
        if body:
            with tarfile.open(fileobj=io.BytesIO(body), mode="r:gz") as tar:
                for member in tar.getmembers():
                    if member.name.startswith("cities/") and member.isfile():
                        record(state, json.load(tar.extractfile(member)), int(t.timestamp()))
            n += 1
        t += timedelta(hours=6)
    state["backfill"] = True
    print(f"acierto: rellenado con {n} copias del archivo")


# --- 2. Lo que pasó --------------------------------------------------------------------------

def stations(state, cities):
    """La estación AEMET de cada ciudad: la misma que eligió descargar_lluvia.py para entrenar."""
    if "stations" not in state:
        import descargar_lluvia as dl
        os.makedirs(dl.DATOS, exist_ok=True)
        state["stations"] = dl.pick_stations(cities)
    return state["stations"]


def refresh_obs(state, now):
    """Pide a AEMET los valores diarios de los últimos días (una sola petición, todas las estaciones)."""
    last = state.get("obs_checked")
    if last and now - parse_t(last) < OBS_EVERY_H * 3600:
        return
    import descargar_lluvia as dl
    if not dl.AEMET_KEY:
        print("acierto: sin AEMET_API_KEY no se puede leer lo medido")
        return
    end = datetime.fromtimestamp(now, tz=timezone.utc).date() - timedelta(days=1)
    start = end - timedelta(days=OBS_DAYS - 1)
    rows = dl.aemet(f"valores/climatologicos/diarios/datos/fechaini/{start}T00:00:00UTC"
                    f"/fechafin/{end}T23:59:59UTC/todasestaciones")
    by_station = defaultdict(list)
    for cid, s in state.get("stations", {}).items():
        if s:
            by_station[s["id"]].append(cid)
    obs = state.setdefault("obs", {})
    n = 0
    for r in rows:
        day = r.get("fecha")
        for cid in by_station.get(r.get("indicativo"), []):
            o = {"mm": dl.mm(r.get("prec")), "tmax": num(r.get("tmax")), "tmin": num(r.get("tmin"))}
            if day and any(v is not None for v in o.values()):
                obs.setdefault(cid, {})[day] = o
                n += 1
    state["obs_checked"] = iso(now)
    print(f"acierto: {n} días medidos de AEMET ({start} a {end})")


# --- 3. Publicar -----------------------------------------------------------------------------

def history(state, city_id, tz, now):
    """Hoy y los últimos días de esta ciudad: lo que dijo y lo que pasó (o None si aún no se sabe)."""
    st = state.get("stations", {}).get(city_id)
    if not st:
        return None
    today = datetime.fromtimestamp(now, tz=ZoneInfo(tz or "Europe/Madrid")).date().isoformat()
    preds = state.get("pred", {}).get(city_id, {})
    obs = state.get("obs", {}).get(city_id, {})
    # Hoy también (aún «pendiente»): así se ve desde el primer día lo que dijo la IA la víspera.
    days = sorted(d for d in preds if d <= today)[-SHOW_DAYS:]
    strip = lambda p: {k: v for k, v in p.items() if k != "issued"}  # noqa: E731
    return {
        "station": st,
        "days": [{"day": d, **{k: strip(v) for k, v in preds[d].items()}, "obs": obs.get(d)} for d in days],
    }


def prune(state, now):
    cut = (datetime.fromtimestamp(now, tz=timezone.utc).date() - timedelta(days=KEEP_DAYS)).isoformat()
    for key in ("pred", "obs"):
        for cid, by_day in state.get(key, {}).items():
            for d in [d for d in by_day if d < cut]:
                del by_day[d]


def load(store, cities, now):
    """El estado, con lo medido al día. Lo llama run.py; si algo falla, se publica sin historial."""
    state = store.get(STATE) or {}
    stations(state, cities)
    backfill(state, store)
    try:
        refresh_obs(state, now)
    except Exception as e:
        print(f"acierto: AEMET no disponible ahora ({e}); se usa lo ya guardado", file=sys.stderr)
    return state


def save(store, state, now):
    prune(state, now)
    store.put(STATE, state, max_age=60)
