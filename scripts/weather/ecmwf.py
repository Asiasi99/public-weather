"""IFS y AIFS del ECMWF. La misma pasada está en cuatro servidores; se baja solo el trozo de cada campo
que hace falta (con el .index de cada paso) y, si un servidor frena o falla, se pasa al siguiente.
No se usa el paquete ecmwf-opendata: ante un «503 Slow Down» espera 120 s por reintento y no cambia de servidor."""

import json
import os
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

import requests

from .common import HORIZON, OUT_DIR, build_series, read_points

SERVERS = {
    "ecmwf": "https://data.ecmwf.int/forecasts",
    "google": "https://storage.googleapis.com/ecmwf-open-data",
    "aws": "https://ecmwf-forecasts.s3.eu-central-1.amazonaws.com",
    "azure": "https://ai4edataeuwest.blob.core.windows.net/ecmwf",
}
# Orden de preferencia; ECMWF_SOURCE pone uno delante.
ORDER = list(dict.fromkeys([os.environ.get("ECMWF_SOURCE", "ecmwf"), "ecmwf", "google", "aws", "azure"]))
PARAMS = {"2t", "2d", "tp", "10u", "10v", "msl", "tcc"}
# Campos fijos que el IFS publica en el paso 0: máscara de tierra y geopotencial del relieve.
STATIC = {"lsm", "z"}
http = requests.Session()


def _demote(name):
    """Un servidor que ha fallado pasa al final de la cola para todos los trozos siguientes."""
    if ORDER[0] == name and len(ORDER) > 1:
        ORDER.append(ORDER.pop(0))


def _get(path, headers=None):
    """Prueba los servidores en orden. Un error de conexión pasa al siguiente en el acto; uno de carga
    («503 Slow Down») reintenta dos veces con esperas cortas antes de pasar."""
    errors = []
    for name in list(ORDER):
        for attempt in range(3):
            try:
                r = http.get(f"{SERVERS[name]}/{path}", headers=headers, timeout=60)
            except requests.RequestException as e:
                errors.append(f"{name} {type(e).__name__}")
                break
            if r.ok:
                return r
            errors.append(f"{name} {r.status_code}")
            if r.status_code < 500 and r.status_code != 429:
                break
            time.sleep(2 * (attempt + 1))
        _demote(name)
    raise RuntimeError(f"No se pudo descargar {path}: {', '.join(errors)}")


def _exists(path):
    for name in ORDER:
        try:
            if http.head(f"{SERVERS[name]}/{path}", timeout=20).ok:
                return True
        except requests.RequestException:
            pass
    return False


class _Ecmwf:
    id = name = model = resolution = ""

    def steps(self):
        raise NotImplementedError

    def path(self, run, step, ext):
        return f"{run:%Y%m%d}/{run:%H}z/{self.model}/0p25/oper/{run:%Y%m%d%H}0000-{step}h-oper-fc.{ext}"

    def latest(self):
        # Que exista el último paso descarta las pasadas que no llegan tan lejos (las de 06 y 18 del IFS).
        now = datetime.now(timezone.utc)
        run = now.replace(hour=now.hour - now.hour % 6, minute=0, second=0, microsecond=0)
        for _ in range(8):
            if _exists(self.path(run, self.steps()[-1], "index")):
                return run
            run -= timedelta(hours=6)
        raise RuntimeError(f"No hay ninguna pasada completa de {self.name} en las últimas 48 h")

    def _download(self, run, step, params=PARAMS, model=None, name=None):
        path_of = lambda ext: self.path(run, step, ext).replace(f"/{self.model}/", f"/{model or self.model}/")
        index = [json.loads(line) for line in _get(path_of("index")).text.splitlines() if line.strip()]
        fields = [f for f in index if f.get("param") in params and f.get("levtype") == "sfc"]
        chunks = [_get(path_of("grib2"), {"Range": f"bytes={f['_offset']}-{f['_offset'] + f['_length'] - 1}"}).content
                  for f in fields]
        path = OUT_DIR / self.id / (name or f"{step:03d}.grib2")
        path.write_bytes(b"".join(chunks))
        return path

    def _static(self, run):
        """Máscara de tierra y relieve del IFS (paso 0). AIFS usa la misma rejilla y no los publica."""
        try:
            return [self._download(run, 0, STATIC, model="ifs", name="static.grib2")]
        except RuntimeError as e:
            print(f"{self.id}: sin máscara ni relieve ({e})")
            return []

    def fetch(self, run, cities):
        (OUT_DIR / self.id).mkdir(parents=True, exist_ok=True)
        with ThreadPoolExecutor(6) as pool:
            paths = list(pool.map(lambda s: self._download(run, s), self.steps()))
        data, distance = read_points(self._static(run) + paths, cities)
        return build_series(data, distance, cities, self.steps(), run)


class Ifs(_Ecmwf):
    id, name, model, resolution = "ifs", "ECMWF IFS", "ifs", "0,25° (~28 km)"

    def steps(self):
        # De 3 en 3 h hasta 144 h y de 6 en 6 h después.
        return [s for s in range(0, 145, 3) if s <= HORIZON] + [s for s in range(150, 241, 6) if s <= HORIZON]


class Aifs(_Ecmwf):
    id, name, model, resolution = "aifs", "ECMWF AIFS (IA)", "aifs-single", "0,25° (~28 km)"

    def steps(self):
        return list(range(0, HORIZON + 1, 6))
