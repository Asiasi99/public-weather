"""Lo que comparten las piezas del pronóstico: rutas, peticiones HTTP con reintentos y las ciudades."""

import json
import time
from dataclasses import dataclass
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = ROOT / "out"
# Gradiente de temperatura con la altura en la atmósfera estándar: 6,5 °C por kilómetro.
LAPSE_RATE = 0.0065


_http = requests.Session()


def http_get(url, method="GET", tries=4, **kwargs):
    """GET con reintentos ante cortes de conexión y errores de carga (5xx, 429). Un 404 se devuelve tal cual."""
    timeout = kwargs.pop("timeout", 60)
    for attempt in range(tries):
        try:
            r = _http.request(method, url, timeout=timeout, **kwargs)
            if r.status_code < 500 and r.status_code != 429:
                return r
        except requests.RequestException:
            if attempt == tries - 1:
                raise
        time.sleep(3 * (attempt + 1))
    return r


@dataclass
class City:
    id: str
    name: str
    lat: float
    lon: float
    tz: str
    elev: float | None = None
    # Estación METAR cercana, para medir la precisión real de los modelos (verify.py).
    metar: str | None = None


def load_cities():
    return [City(**c) for c in json.loads((ROOT / "cities.json").read_text(encoding="utf-8"))]
