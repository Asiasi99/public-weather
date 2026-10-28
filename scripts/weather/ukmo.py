"""Modelo global de la Met Office (Reino Unido), 10 km, desde su cubo abierto en AWS.
Un NetCDF por variable y paso para todo el planeta, troceado en bloques de 128×128 puntos: con lecturas por
rangos (RangeFile) h5py solo baja los bloques que cubren España, no el fichero entero.
Licencia: CC BY-SA 4.0 (Crown copyright), que pide compartir los derivados con la misma licencia."""

import io
import math
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

import h5py
import numpy as np

from .common import HORIZON, GridPoints, build_series, choose_point, http_get, to_standard

BASE = "https://met-office-atmospheric-model-data.s3.eu-west-2.amazonaws.com/global-deterministic-10km"
# Variable del nombre del fichero → nombre común.
FIELDS = {
    "temperature_at_screen_level": "2t",
    "pressure_at_mean_sea_level": "msl",
    "cloud_amount_of_total_cloud": "tcc",
    "wind_speed_at_10m": "wind",
    "wind_direction_at_10m": "wdir",
}


class RangeFile(io.RawIOBase):
    """Fichero remoto de solo lectura que pide por HTTP solo los trozos que se leen, en bloques de 256 KB."""

    BLOCK = 256 * 1024

    def __init__(self, url):
        self.url, self.pos, self.cache = url, 0, {}
        head = http_get(url, method="HEAD")
        head.raise_for_status()
        self.size = int(head.headers["Content-Length"])

    def readable(self):
        return True

    def seekable(self):
        return True

    def seek(self, offset, whence=0):
        self.pos = [offset, self.pos + offset, self.size + offset][whence]
        return self.pos

    def tell(self):
        return self.pos

    def _block(self, n):
        if n not in self.cache:
            start = n * self.BLOCK
            end = min(start + self.BLOCK, self.size) - 1
            r = http_get(self.url, headers={"Range": f"bytes={start}-{end}"})
            r.raise_for_status()
            self.cache[n] = r.content
        return self.cache[n]

    def readinto(self, buffer):
        want = min(len(buffer), self.size - self.pos)
        if want <= 0:
            return 0
        out, pos = bytearray(), self.pos
        while len(out) < want:
            n, off = divmod(pos + len(out), self.BLOCK)
            out += self._block(n)[off:off + want - len(out)]
        buffer[:want] = out
        self.pos += want
        return want


def _km(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(a))


class Ukmo:
    id, name, resolution = "ukmo", "Met Office (Reino Unido)", "0,09° × 0,14° (~10 km)"

    def steps(self):
        # Como el IFS: de 3 en 3 h hasta 144 h y de 6 en 6 h hasta 168 h.
        return [s for s in range(0, 145, 3) if s <= HORIZON] + [s for s in range(150, 169, 6) if s <= HORIZON]

    def rain_buckets(self):
        """Los ficheros de lluvia: cubetas de 1 h hasta 54 h, de 3 h hasta 144 h y de 6 h después."""
        out = [(s, 1) for s in range(1, 55)] + [(s, 3) for s in range(57, 145, 3)] + [(s, 6) for s in range(150, 169, 6)]
        return [(s, b) for s, b in out if s <= self.steps()[-1]]

    def url(self, run, step, var):
        valid = run + timedelta(hours=step)
        return f"{BASE}/{run:%Y%m%dT%H%MZ}/{valid:%Y%m%dT%H%MZ}-PT{step:04d}H00M-{var}.nc"

    def latest(self):
        now = datetime.now(timezone.utc)
        run = now.replace(hour=now.hour - now.hour % 6, minute=0, second=0, microsecond=0)
        # Solo las pasadas de 00 y 12 UTC llegan a 7 días: se exige el último paso.
        for _ in range(8):
            if http_get(self.url(run, self.steps()[-1], "temperature_at_screen_level"), method="HEAD").ok:
                return run
            run -= timedelta(hours=6)
        raise RuntimeError("No hay ninguna pasada completa de la Met Office en las últimas 48 h")

    def _read(self, url, box):
        """Lee del NetCDF remoto solo el recuadro de España (filas y columnas) de su única variable 2D."""
        (r0, r1), (c0, c1) = box
        with h5py.File(RangeFile(url), "r") as h:
            ds = next(v for v in h.values() if getattr(v, "ndim", 0) == 2)
            units = ds.attrs.get("units", b"")
            return ds[r0:r1, c0:c1].astype(float), units.decode() if isinstance(units, bytes) else str(units)

    def fetch(self, run, cities):
        # La rejilla y el relieve, del paso 0: de ahí salen el punto de cada ciudad y su altura.
        with h5py.File(RangeFile(self.url(run, 0, "height_of_orography")), "r") as h:
            lat, lon = h["latitude"][:], h["longitude"][:]
            dlat, dlon = float(lat[1] - lat[0]), float(lon[1] - lon[0])
            rows = [int((c.lat - lat[0]) // dlat) for c in cities]
            cols = [int((c.lon - lon[0]) // dlon) for c in cities]
            box = ((min(rows), max(rows) + 2), (min(cols), max(cols) + 2))
            orog = h["surface_altitude"][box[0][0]:box[0][1], box[1][0]:box[1][1]].astype(float)

        # Para cada ciudad, sus 4 puntos vecinos (en coordenadas del recuadro) y el mejor de ellos.
        land = (orog > 0).astype(float)
        flat_elev, flat_land, width = orog.ravel(), land.ravel(), orog.shape[1]
        picks, dists = [], []
        for c, r, k in zip(cities, rows, cols):
            cands = []
            for dr in (0, 1):
                for dk in (0, 1):
                    rr, kk = r + dr, k + dk
                    idx = (rr - box[0][0]) * width + (kk - box[1][0])
                    cands.append((idx, _km(c.lat, c.lon, float(lat[rr]), float(lon[kk]))))
            idx, km = choose_point(cands, c, flat_land, flat_elev)
            picks.append(idx)
            dists.append(km)
        picks = np.array(picks)
        points = GridPoints(np.array(dists), flat_elev[picks])

        jobs = [(step, f, name) for step in self.steps() for f, name in FIELDS.items()]
        jobs += [(step, f"precipitation_accumulation-PT{b:02d}H", "tp") for step, b in self.rain_buckets()]

        def get(job):
            step, f, name = job
            try:
                values, units = self._read(self.url(run, step, f), box)
            except Exception:
                # Algún campo que falte en un paso (la lluvia del paso 0, por ejemplo) no tumba el modelo.
                return job, None, None
            return job, values.ravel()[picks], units

        data, raw = {}, {}
        with ThreadPoolExecutor(8) as pool:
            for (step, f, name), values, units in pool.map(get, jobs):
                if values is None:
                    continue
                if name in ("wind", "wdir"):
                    raw.setdefault(step, {})[name] = values
                    continue
                start = step - int(f[-3:-1]) if name == "tp" else step
                data.setdefault(name, {})[step] = (start, to_standard(name, units, values))

        # Viento: de velocidad y dirección de procedencia a las componentes u y v que usa build_series.
        for step, w in raw.items():
            if "wind" in w and "wdir" in w:
                rad = np.radians(w["wdir"])
                data.setdefault("10u", {})[step] = (step, -w["wind"] * np.sin(rad))
                data.setdefault("10v", {})[step] = (step, -w["wind"] * np.cos(rad))
        return build_series(data, points, cities, self.steps(), run)
