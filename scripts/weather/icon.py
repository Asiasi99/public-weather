"""ICON-EU del DWD (servicio meteorológico alemán). Un fichero .bz2 por variable y paso, en rejilla regular.
No cubre Canarias: su borde sur está en 29,5° N, y esas ciudades se quedan sin ICON (MAX_DISTANCE_KM)."""

import bz2
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

from .common import HORIZON, OUT_DIR, build_series, http_get, read_points

BASE = "https://opendata.dwd.de/weather/nwp/icon-eu/grib"
VARS = ["t_2m", "td_2m", "tot_prec", "u_10m", "v_10m", "pmsl", "clct"]


class IconEu:
    id, name, resolution = "icon-eu", "DWD ICON-EU", "0,0625° (~7 km)"

    def steps(self):
        # Las pasadas de 00, 06, 12 y 18 llegan a 120 h; cada hora hasta 78 h, se cogen de 3 en 3.
        return list(range(0, min(HORIZON, 120) + 1, 3))

    def url(self, run, var, step):
        return (f"{BASE}/{run:%H}/{var}/icon-eu_europe_regular-lat-lon_single-level_"
                f"{run:%Y%m%d%H}_{step:03d}_{var.upper()}.grib2.bz2")

    def latest(self):
        now = datetime.now(timezone.utc)
        run = now.replace(hour=now.hour - now.hour % 6, minute=0, second=0, microsecond=0)
        # El DWD solo guarda las últimas 24 h.
        for _ in range(4):
            if http_get(self.url(run, "clct", self.steps()[-1]), method="HEAD").ok:
                return run
            run -= timedelta(hours=6)
        raise RuntimeError("No hay ninguna pasada completa de ICON-EU en las últimas 24 h")

    def _download(self, run, var, step):
        r = http_get(self.url(run, var, step))
        r.raise_for_status()
        path = OUT_DIR / "icon" / f"{var}_{step:03d}.grib2"
        path.write_bytes(bz2.decompress(r.content))
        return path

    def _static(self, run):
        """Relieve (HSURF) y fracción de tierra (FR_LAND): van en ficheros aparte, «time-invariant»."""
        paths = []
        for var in ("hsurf", "fr_land"):
            url = (f"{BASE}/{run:%H}/{var}/icon-eu_europe_regular-lat-lon_time-invariant_"
                   f"{run:%Y%m%d%H}_{var.upper()}.grib2.bz2")
            try:
                r = http_get(url)
                r.raise_for_status()
                path = OUT_DIR / "icon" / f"{var}.grib2"
                path.write_bytes(bz2.decompress(r.content))
                paths.append(path)
            except Exception as e:
                print(f"icon-eu: sin {var} ({e})")
        return paths

    def fetch(self, run, cities):
        (OUT_DIR / "icon").mkdir(parents=True, exist_ok=True)
        jobs = [(v, s) for s in self.steps() for v in VARS]
        with ThreadPoolExecutor(8) as pool:
            paths = list(pool.map(lambda j: self._download(run, *j), jobs))
        data, distance = read_points(self._static(run) + paths, cities)
        return build_series(data, distance, cities, self.steps(), run)
