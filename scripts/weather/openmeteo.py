"""Todos los modelos desde Open-Meteo (https://open-meteo.com): una petición por modelo y por tanda de puntos,
ya en JSON, sin descargar ni leer ficheros GRIB.

Devuelve lo mismo que devolvían los lectores de GRIB: {punto: serie en columnas} con times, temp, rain, cloud, hum,
wind, windDir, gust (rachas, km/h) y las nubes por pisos. Así run.py, la IA, la precisión y la app no cambian.

Coste (Open-Meteo cuenta llamadas por punto, por modelo y por cada 10 variables): se piden exactamente 10 variables
y 7 días, así que cada punto cuesta 1 llamada por modelo. Los modelos regionales solo se piden dentro de su zona.

Ahorro: cada modelo se pide solo si Open-Meteo tiene una pasada nueva (lo dice su meta.json, que no cuenta como
llamada), y run.py solo pide las estaciones a las 00 y 12 UTC.

Plan gratis (uso no comercial): 600 llamadas/min, 5.000/h, 10.000/día y 300.000/mes. Sin clave se va despacio
para no pasar del límite por minuto. Con OPEN_METEO_KEY (plan de pago) se usa el servidor de clientes y sin pausas.
"""

import os
import time
from datetime import datetime, timezone

from .common import http_get

API_GRATIS = "https://api.open-meteo.com/v1/forecast"
API_PAGO = "https://customer-api.open-meteo.com/v1/forecast"
# Exactamente 10: con 11 cada punto contaría como 2 llamadas. (La presión no la usaba nadie: en su lugar, las rachas)
VARIABLES = ("temperature_2m", "relative_humidity_2m", "precipitation", "wind_gusts_10m", "cloud_cover",
             "cloud_cover_low", "cloud_cover_mid", "cloud_cover_high", "wind_speed_10m", "wind_direction_10m")
DIAS = 7
TANDA = 50
# Plan gratis: 600 llamadas por minuto. Se va a 400 para dejar margen.
LLAMADAS_POR_MINUTO = 400
iso = lambda ts: datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%dT%H:%MZ")


class OpenMeteo:
    """Un modelo de Open-Meteo. caja = (lat_min, lat_max, lon_min, lon_max) para los regionales: fuera no se pide."""

    def __init__(self, id, name, resolution, model, meta, caja=None):
        self.id, self.name, self.resolution, self.model, self.meta, self.caja = id, name, resolution, model, meta, caja

    def latest(self):
        """La pasada que sirve Open-Meteo ahora. Si es la ya publicada, run.py no pide nada: 0 llamadas."""
        now = datetime.now(timezone.utc)
        try:
            r = http_get(f"https://api.open-meteo.com/data/{self.meta}/static/meta.json", timeout=30)
            run = datetime.fromtimestamp(int(r.json()["last_run_initialisation_time"]), timezone.utc)
            # Un meta.json viejo (le pasa al de GEM) no dice la verdad: entonces, como abajo
            if (now - run).total_seconds() < 36 * 3600:
                return run
        except Exception as e:
            print(f"{self.id}: sin meta.json de Open-Meteo ({e})")
        # Sin dato fiable, la última pasada sinóptica (00, 06, 12 o 18 UTC): como mucho una vez cada 6 h
        return now.replace(hour=now.hour - now.hour % 6, minute=0, second=0, microsecond=0)

    def _dentro(self, c):
        if not self.caja:
            return True
        la0, la1, lo0, lo1 = self.caja
        return la0 <= c.lat <= la1 and lo0 <= c.lon <= lo1

    def fetch(self, run, cities):
        puntos = [c for c in cities if self._dentro(c)]
        # La altura solo se manda si todos los de la tanda la tienen (Open-Meteo no admite huecos):
        # las ciudades y estaciones van con la suya; la rejilla, con la del relieve de Open-Meteo.
        con_altura = [c for c in puntos if c.elev is not None]
        sin_altura = [c for c in puntos if c.elev is None]
        out = {}
        for grupo, altura in ((con_altura, True), (sin_altura, False)):
            for i in range(0, len(grupo), TANDA):
                tanda = grupo[i:i + TANDA]
                for c, d in zip(tanda, self._pedir(tanda, altura)):
                    s = _serie(d, self.model, c.elev if altura else d.get("elevation"))
                    if s:
                        out[c.id] = s
        print(f"{self.id}: {len(out)} de {len(puntos)} puntos con datos ({len(puntos)} llamadas)")
        return out

    def _pedir(self, tanda, altura):
        params = {
            "latitude": ",".join(f"{c.lat:.4f}" for c in tanda),
            "longitude": ",".join(f"{c.lon:.4f}" for c in tanda),
            "hourly": ",".join(VARIABLES),
            "models": self.model,
            "forecast_days": DIAS,
            "timezone": "GMT",
            "timeformat": "unixtime",
        }
        if altura:
            # La temperatura sale ya a la altura de la ciudad (Open-Meteo la corrige con el relieve)
            params["elevation"] = ",".join(str(round(c.elev)) for c in tanda)
        clave = os.environ.get("OPEN_METEO_KEY", "").strip()
        if clave:
            params["apikey"] = clave
        for intento in range(4):
            r = http_get(API_PAGO if clave else API_GRATIS, params=params, timeout=120)
            if r.status_code == 429:
                motivo = _motivo(r)
                # Límite por minuto: basta esperar. Por hora, día o mes: no tiene arreglo ahora, se avisa.
                if "inute" in motivo and intento < 3:
                    print(f"{self.id}: límite por minuto, espero 65 s")
                    time.sleep(65)
                    continue
                raise RuntimeError(f"Open-Meteo: límite de llamadas ({motivo})")
            if not r.ok:
                raise RuntimeError(f"Open-Meteo {r.status_code}: {_motivo(r)}")
            break
        datos = r.json()
        if not clave:
            # Sin plan de pago, al ritmo del límite por minuto
            time.sleep(len(tanda) * 60 / LLAMADAS_POR_MINUTO)
        return datos if isinstance(datos, list) else [datos]


def _motivo(r):
    try:
        return str(r.json().get("reason", ""))[:200]
    except ValueError:
        return r.text[:200]


def _columna(h, var, model):
    # Con un solo modelo, Open-Meteo no añade el sufijo «_<modelo>» al nombre; con varios, sí
    return h.get(f"{var}_{model}", h.get(var))


def _r(x, nd=0):
    if x is None:
        return None
    return round(float(x), nd) if nd else int(round(float(x)))


def _serie(d, model, altura):
    """De la respuesta de un punto a la serie en columnas que usa el resto. None si el modelo no cubre el punto."""
    h = d.get("hourly") or {}
    temp = _columna(h, "temperature_2m", model)
    if not temp or all(t is None for t in temp):
        return None
    col = {v: _columna(h, v, model) or [None] * len(temp) for v in VARIABLES}
    s = {k: [] for k in ("times", "temp", "rain", "cloud", "wind", "windDir", "gust", "hum",
                         "cloudLow", "cloudMid", "cloudHigh")}
    for k, ts in enumerate(h["time"]):
        if temp[k] is None:
            continue
        s["times"].append(iso(ts))
        s["temp"].append(_r(temp[k], 1))
        s["rain"].append(_r(col["precipitation"][k], 1))
        s["cloud"].append(_r(col["cloud_cover"][k]))
        s["hum"].append(_r(col["relative_humidity_2m"][k]))
        s["wind"].append(_r(col["wind_speed_10m"][k]))
        s["windDir"].append(_r(col["wind_direction_10m"][k]))
        s["gust"].append(_r(col["wind_gusts_10m"][k]))
        s["cloudLow"].append(_r(col["cloud_cover_low"][k]))
        s["cloudMid"].append(_r(col["cloud_cover_mid"][k]))
        s["cloudHigh"].append(_r(col["cloud_cover_high"][k]))
    # Lo que no trae el modelo (p. ej. nubes por pisos) no se publica, como antes
    for k in ("hum", "gust", "cloudLow", "cloudMid", "cloudHigh"):
        if all(v is None for v in s[k]):
            del s[k]
    # Open-Meteo ya da la temperatura a la altura pedida: no hay punto de rejilla lejano ni corrección aparte
    s.update({"gridKm": 0.0, "gridElev": None if altura is None else round(float(altura)), "tempAdjust": 0.0})
    return s


# Los mismos id que antes: la IA, la precisión y la app los conocen por su id.
# Nombre en la API y nombre de su carpeta de datos (para el meta.json con la hora de la última pasada)
MODELS = [
    OpenMeteo("ifs", "ECMWF IFS", "0,25° (~28 km)", "ecmwf_ifs025", "ecmwf_ifs025"),
    OpenMeteo("aifs", "ECMWF AIFS (IA)", "0,25° (~28 km)", "ecmwf_aifs025_single", "ecmwf_aifs025_single"),
    OpenMeteo("gfs", "NOAA GFS", "0,25° (~28 km)", "gfs_global", "ncep_gfs025"),
    OpenMeteo("icon-eu", "DWD ICON-EU", "0,0625° (~7 km)", "icon_eu", "dwd_icon_eu", caja=(29.5, 70.5, -23.5, 62.5)),
    OpenMeteo("arpege", "Météo-France ARPEGE", "0,1° (~11 km)", "meteofrance_arpege_europe", "meteofrance_arpege_europe",
              caja=(20.0, 72.0, -32.0, 42.0)),
    OpenMeteo("arome", "Météo-France AROME", "0,025° (~2,5 km)", "meteofrance_arome_france", "meteofrance_arome_france0025",
              caja=(41.0, 51.5, -5.5, 10.0)),
    OpenMeteo("ukmo", "Met Office (Reino Unido)", "0,09° × 0,14° (~10 km)", "ukmo_global_deterministic_10km",
              "ukmo_global_deterministic_10km"),
    OpenMeteo("gem", "Canadá GEM", "0,15° (~15 km)", "gem_global", "cmc_gem_gdps"),
]
