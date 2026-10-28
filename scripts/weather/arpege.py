"""ARPEGE y AROME de Météo-France, desde su cubo público.

ARPEGE: rejilla EURAT01 (0,1° sobre Europa y el norte de África, Canarias incluida), hasta 102 h.
AROME: 0,025° (~2,5 km), solo Francia y alrededores: en España llega hasta unos 37,5° N, así que salen las
capitales del norte y el centro, y las del sur, Canarias, Ceuta y Melilla se quedan sin él (eccodes da «fuera de
rejilla» y build_series las salta, como ICON-EU con Canarias). Hasta 48 h, cada hora.

Los ficheros son «paquetes»: SP1 trae los campos de superficie (2 m, 10 m, presión, nubes, lluvia) y viene
partido en tramos de horas (000H024H, 025H048H…) o en una hora por fichero. No hay índice para pedir solo un trozo,
así que se baja cada fichero entero, se leen los puntos y se borra antes del siguiente.
Las rutas no se dan por supuestas: se listan en el cubo, porque Météo-France ya ha cambiado de servidor alguna vez.
Ninguno publica el relieve en estos paquetes: se deduce de la presión en superficie (SP2) con la fórmula barométrica.
"""

import os
import re
import time
from datetime import datetime, timedelta, timezone

import numpy as np
import requests

from .common import HORIZON, OUT_DIR, GridPoints, barometric_height, build_series, http_get, read_points

BASE = os.environ.get("ARPEGE_BASE", "https://meteofrance-pnt.s3.rbx.io.cloud.ovh.net")
PACKAGE = "SP1"
# SP1 no trae nubes; SP2 trae las bajas, medias y altas, y la presión en superficie (para el relieve).
# Es opcional: sin él, sale sin nubosidad y sin corrección por altitud.
CLOUD_PACKAGE = "SP2"
CLOUDS = ("tcc", "lcc", "mcc", "hcc", "sp")
# Un tramo («000H024H») o una sola hora («012H») por fichero.
HOURS = re.compile(r"__(\d{2,3})H(?:(\d{2,3})H)?__")


class MeteoFrance:
    """Lo común a ARPEGE y AROME; cada uno pone su carpeta, rejillas, pasos y cada cuánto sale una pasada."""
    model, grids, every, step, last, cycle = "", [], 3, 3, 0, 6

    def steps(self):
        return list(range(0, min(HORIZON, self.last) + 1, self.step))

    def _list(self, prefix):
        keys, token = [], None
        while True:
            params = {"list-type": "2", "prefix": prefix, **({"continuation-token": token} if token else {})}
            r = http_get(BASE, params=params)
            r.raise_for_status()
            keys += re.findall(r"<Key>([^<]+)</Key>", r.text)
            # Con una hora por fichero pueden pasar de 1000, lo máximo que da una página.
            m = re.search(r"<NextContinuationToken>([^<]+)</NextContinuationToken>", r.text)
            if not m:
                return keys
            token = m.group(1)

    def _files(self, run, package=PACKAGE):
        """Los ficheros de un paquete de una pasada que hacen falta, en orden, o [] si aún no están todos."""
        wanted = set(self.steps())
        for grid in self.grids:
            folder = f"pnt/{run:%Y-%m-%dT%H:%M:%SZ}/{self.model}/{grid}/{package}/"
            keys = sorted(k for k in self._list(folder) if k.endswith(".grib2"))
            spans = {k: (int(m.group(1)), int(m.group(2) or m.group(1))) for k in keys if (m := HOURS.search(k))}
            if not spans or len(spans) < len(keys):
                continue
            # Completa si llega hasta el último paso que se pide; solo se bajan los que tienen alguno.
            if max(b for _, b in spans.values()) >= self.steps()[-1]:
                return [k for k, (a, b) in spans.items() if any(a <= s <= b for s in wanted)]
        return []

    def latest(self):
        now = datetime.now(timezone.utc)
        run = now.replace(hour=now.hour - now.hour % self.cycle, minute=0, second=0, microsecond=0)
        for _ in range(48 // self.cycle):
            if self._files(run):
                return run
            run -= timedelta(hours=self.cycle)
        raise RuntimeError(f"No hay ninguna pasada completa de {self.model} {self.grids} {PACKAGE} "
                           f"en las últimas 48 h en {BASE}")

    def _download(self, url, path, tries=3):
        """Tramos de cientos de MB: se escriben a disco por trozos y, si se corta, se empieza de nuevo."""
        for attempt in range(tries):
            try:
                with requests.get(url, stream=True, timeout=120) as r:
                    r.raise_for_status()
                    with open(path, "wb") as f:
                        for chunk in r.iter_content(1 << 20):
                            f.write(chunk)
                return
            except requests.RequestException:
                if attempt == tries - 1:
                    raise
                time.sleep(10 * (attempt + 1))

    def _read_package(self, run, cities, package, keep=None):
        """Baja los ficheros de un paquete uno a uno y junta sus puntos. keep limita las variables que se guardan."""
        folder = OUT_DIR / self.model
        folder.mkdir(parents=True, exist_ok=True)
        merged, points, seen = {}, None, set()
        for key in self._files(run, package):
            path = folder / "tramo.grib2"
            self._download(f"{BASE}/{key}", path)
            data, pts, names = read_points([path], cities, with_names=True)
            seen |= names
            for name, by_step in data.items():
                if keep is None or name in keep:
                    merged.setdefault(name, {}).update(by_step)
            points = pts if points is None else points
            path.unlink()
        return merged, points, seen

    def fetch(self, run, cities):
        merged, points, seen = self._read_package(run, cities, PACKAGE)
        if "2t" not in merged:
            raise RuntimeError(f"{self.model} {PACKAGE} sin temperatura a 2 m. Variables encontradas: {sorted(seen)}")
        try:
            clouds, _, seen2 = self._read_package(run, cities, CLOUD_PACKAGE, keep=CLOUDS)
            merged.update(clouds)
            if "tcc" not in merged:
                merged["tcc"] = _total_cloud(merged)
            print(f"{self.model}: de {CLOUD_PACKAGE}: {sorted(clouds)}" if clouds
                  else f"{self.model}: {CLOUD_PACKAGE} sin nubes; trae {sorted(seen2)}")
        except Exception as e:
            print(f"{self.model}: sin nubosidad ({CLOUD_PACKAGE}: {e})")
        if points is not None and points.elev is None:
            points = GridPoints(points.distance, _elevation(merged))
            if points.elev is None:
                print(f"{self.model}: sin relieve (hay {sorted(merged)})")
        return build_series(merged, points, cities, self.steps(), run)


class Arpege(MeteoFrance):
    id, name, resolution = "arpege", "Météo-France ARPEGE", "0,1° (~11 km)"
    # Cada hora hasta 48 h y cada 3 h hasta 102 h: se cogen de 3 en 3.
    model, grids, step, last, cycle = "arpege", [os.environ.get("ARPEGE_GRID", "01")], 3, 102, 6


class Arome(MeteoFrance):
    id, name, resolution = "arome", "Météo-France AROME", "0,025° (~2,5 km)"
    # Sale cada 3 h; las pasadas largas llegan a 51 h. Se cogen todas las horas hasta 48.
    model, grids, step, last, cycle = "arome", [os.environ.get("AROME_GRID", "0025")], 1, 48, 3


def _elevation(data):
    """Altura del punto de cada ciudad deducida de la presión: en el primer paso con sp, msl y 2t a la vez."""
    common = set(data.get("sp", {})) & set(data.get("msl", {})) & set(data.get("2t", {}))
    if not common:
        return None
    s = min(common)
    # msl ya está en hPa y 2t en °C (to_standard); sp sigue en Pa.
    return np.clip(barometric_height(data["sp"][s][1], data["msl"][s][1] * 100, data["2t"][s][1] + 273.15), -50, 5000)


def _total_cloud(data):
    """Nubosidad total a partir de las capas, con solapamiento aleatorio: 1 − (1−bajas)(1−medias)(1−altas).
    Aproximación: suele dar algo más de nubes que el cálculo interno del modelo."""
    layers = [data[k] for k in ("lcc", "mcc", "hcc") if k in data]
    if not layers:
        return {}
    total = {}
    for step in set.intersection(*(set(layer) for layer in layers)):
        clear = 1.0
        for layer in layers:
            clear = clear * (1 - np.clip(layer[step][1], 0, 100) / 100)
        total[step] = (0, (1 - clear) * 100)
    return total
