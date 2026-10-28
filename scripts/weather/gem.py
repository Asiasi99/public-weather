"""GEM global (GDPS) del servicio meteorológico de Canadá (ECCC), 0,15° (~15 km), desde su Datamart.
Un GRIB2 por variable y paso. Los nombres de los ficheros han cambiado de formato con los años, así que no se
dan por supuestos: se lee el listado de la carpeta de cada paso y se bajan los que encajan con las variables
que hacen falta; después eccodes reconoce cada campo por su contenido (2t, 10u, prmsl, tp…), no por el nombre.
Licencia: Licencia del Gobierno Abierto de Canadá (atribución)."""

import re
from concurrent.futures import ThreadPoolExecutor

import eccodes
import numpy as np
from datetime import datetime, timedelta, timezone

from .common import HORIZON, OUT_DIR, barometric_height, build_series, http_get, read_points

BASE = "https://dd.weather.gc.ca"
# Las organizaciones conocidas del Datamart. «today/» solo tiene las pasadas del día UTC en curso: pasada la
# medianoche, la de las 12 de ayer solo está en la carpeta con fecha. Por eso esa va primero.
LAYOUTS = [
    ("{date}/WXO-DD/model_gdps/15km/{HH}/{hhh}/", "{date}T{HH}Z_MSC_GDPS_"),
    ("today/model_gdps/15km/{HH}/{hhh}/", "{date}T{HH}Z_MSC_GDPS_"),
    ("model_gem_global/15km/grib2/lat_lon/{HH}/{hhh}/", "CMC_glb_"),
]
# Trozos del nombre de cada variable que interesa, en los dos formatos.
# La lluvia, solo la acumulada desde el inicio (Precip-Accum_Sfc): ni la convectiva ni las cubetas de 1 y 3 h.
WANTED = re.compile(
    r"(AirTemp_AGL-2m|TMP_TGL_2_|WindU_AGL-10m|WindV_AGL-10m|UGRD_TGL_10_|VGRD_TGL_10_|"
    r"Pressure_MSL|MSLP|PRMSL_MSL|(?<![A-Za-z])Precip-Accum_Sfc|APCP_SFC|TotalCloudCover|TCDC_SFC|"
    r"ModelTopography|HGT_SFC|LandWater|LandSea|LAND_SFC|Pressure_Sfc|PRES_SFC)", re.IGNORECASE)
# Solo hacen falta en el paso 0: máscara de tierra, relieve y presión en superficie (para deducir el relieve).
STATIC = re.compile(r"(Topography|HGT_SFC|LandWater|LandSea|LAND_SFC|Pressure_Sfc|PRES_SFC)", re.IGNORECASE)
# Variables que eccodes no reconoce en los GRIB de ECCC («unknown»): se nombran por el fichero.
BY_FILE = {"Precip-Accum_Sfc": "tp", "TotalCloudCover": "tcc"}


class Gem:
    id, name, resolution = "gem", "Canadá GEM", "0,15° (~15 km)"
    _layout = None

    def steps(self):
        return list(range(0, HORIZON + 1, 3))

    def _listing(self, run, step, layout):
        folder, prefix = layout
        url = f"{BASE}/" + folder.format(date=f"{run:%Y%m%d}", HH=f"{run:%H}", hhh=f"{step:03d}")
        r = http_get(url)
        if not r.ok:
            return url, []
        names = re.findall(r'href="([^"?/][^"]*\.grib2)"', r.text)
        start = prefix.format(date=f"{run:%Y%m%d}", HH=f"{run:%H}")
        # Solo los de esta pasada: en el formato antiguo la fecha va al final del nombre.
        names = [n for n in names if n.startswith(start) and (start != "CMC_glb_" or f"{run:%Y%m%d%H}" in n)]
        return url, names

    def latest(self):
        now = datetime.now(timezone.utc)
        run = now.replace(hour=now.hour - now.hour % 12, minute=0, second=0, microsecond=0)
        for _ in range(4):
            for layout in LAYOUTS:
                _, names = self._listing(run, self.steps()[-1], layout)
                if any(WANTED.search(n) for n in names):
                    self._layout = layout
                    return run
            run -= timedelta(hours=12)
        raise RuntimeError("No hay ninguna pasada completa de GEM en las últimas 48 h")

    def _download(self, run, step):
        url, names = self._listing(run, step, self._layout)
        wanted = [n for n in names if WANTED.search(n) and (step == 0 or not STATIC.search(n))]
        if step == self.steps()[-1] and not wanted:
            raise RuntimeError(f"GEM: nada reconocible en {url}; hay {names[:40]}")
        paths = []
        for n in wanted:
            r = http_get(url + n)
            r.raise_for_status()
            path = OUT_DIR / "gem" / f"{step:03d}_{n}"
            path.write_bytes(r.content)
            paths.append(path)
        return paths

    def _elevation(self, step0):
        """GEM no publica el relieve. Se deduce de la presión en superficie y a nivel del mar con la fórmula
        barométrica y se guarda como un campo «orog» para el resto del código."""
        fields = {}
        for path in step0:
            with open(path, "rb") as f:
                while (gid := eccodes.codes_grib_new_from_file(f)) is not None:
                    name = eccodes.codes_get(gid, "shortName")
                    if name in ("sp", "prmsl", "2t") and name not in fields:
                        fields[name] = (eccodes.codes_get_values(gid), eccodes.codes_clone(gid))
                    eccodes.codes_release(gid)
        if not {"sp", "prmsl", "2t"} <= fields.keys():
            print(f"gem: sin relieve (hay {sorted(fields)})")
            return None
        sp, msl, t = (fields[k][0] for k in ("sp", "prmsl", "2t"))
        h = barometric_height(sp, msl, t)
        gid = fields["sp"][1]
        eccodes.codes_set(gid, "paramId", 228002)  # orografía, en metros
        eccodes.codes_set_values(gid, np.clip(h, -50, 5000))
        path = step0[0].parent / "000_orog.grib2"
        with open(path, "wb") as out:
            eccodes.codes_write(gid, out)
        for _, g in fields.values():
            eccodes.codes_release(g)
        return path

    def fetch(self, run, cities):
        if self._layout is None:
            self.latest()
        (OUT_DIR / "gem").mkdir(parents=True, exist_ok=True)
        with ThreadPoolExecutor(8) as pool:
            paths = [p for ps in pool.map(lambda s: self._download(run, s), self.steps()) for p in ps]
        by_path = {str(p): name for p in paths for key, name in BY_FILE.items() if key in p.name}
        orog = self._elevation([p for p in paths if p.name.startswith("000_")])
        data, points, names = read_points(([orog] if orog else []) + paths, cities, with_names=True,
                                          names_by_path=by_path)
        missing = {"2t", "tp", "10u", "10v", "msl", "tcc"} - data.keys()
        if missing:
            print(f"gem: faltan {sorted(missing)}; los GRIB traen {sorted(names)}")
            # Para afinar WANTED: las variables que ofrece un paso, sin fecha ni rejilla.
            _, listing = self._listing(run, 3, self._layout)
            kinds = sorted({re.sub(r"^.*?_MSC_GDPS_|^CMC_glb_|_LatLon.*$|_latlon.*$", "", n) for n in listing})
            print(f"gem: el paso 3 ofrece {kinds}")
        if "2t" not in data:
            raise RuntimeError("GEM sin temperatura a 2 m")
        return build_series(data, points, cities, self.steps(), run)
