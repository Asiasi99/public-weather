"""GFS de NOAA desde su copia oficial en AWS. Cada fichero trae cientos de campos: se baja solo el trozo
de cada uno que hace falta, con las posiciones que da su .idx."""

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

from .common import HORIZON, OUT_DIR, build_series, http_get, read_points

BASE = "https://noaa-gfs-bdp-pds.s3.amazonaws.com"


def _wanted(step):
    # Las líneas del .idx que interesan. La lluvia, la acumulada desde el inicio (la otra es por cubetas de 6 h).
    lines = [":TMP:2 m above ground:", ":DPT:2 m above ground:", ":UGRD:10 m above ground:", ":VGRD:10 m above ground:",
             ":PRMSL:mean sea level:", f":TCDC:entire atmosphere:{step} hour fcst:"]
    if step == 0:
        # Campos fijos: relieve y máscara de tierra, para elegir el punto y corregir por altura.
        lines += [":HGT:surface:anl:", ":LAND:surface:anl:"]
    if step > 0:
        lines.append(f":APCP:surface:0-{step} hour acc fcst:")
        # En los días enteros NOAA escribe «0-1 day acc», no «0-24 hour acc».
        if step % 24 == 0:
            lines.append(f":APCP:surface:0-{step // 24} day acc fcst:")
    return lines


class Gfs:
    id, name, resolution = "gfs", "NOAA GFS", "0,25° (~28 km)"

    def steps(self):
        return list(range(0, HORIZON + 1, 3))

    def url(self, run, step):
        return f"{BASE}/gfs.{run:%Y%m%d}/{run:%H}/atmos/gfs.t{run:%H}z.pgrb2.0p25.f{step:03d}"

    def latest(self):
        now = datetime.now(timezone.utc)
        run = now.replace(hour=now.hour - now.hour % 6, minute=0, second=0, microsecond=0)
        for _ in range(8):
            if self._complete(run):
                return run
            run -= timedelta(hours=6)
        raise RuntimeError("No hay ninguna pasada completa de GFS en las últimas 48 h")

    def _complete(self, run):
        # NOAA sube los pasos en desorden: el último puede estar y faltar uno intermedio (21-oct: f165). Se miran todos.
        if not http_get(self.url(run, self.steps()[-1]) + ".idx", method="HEAD").ok:
            return False
        with ThreadPoolExecutor(8) as pool:
            return all(pool.map(lambda s: http_get(self.url(run, s) + ".idx", method="HEAD").ok, self.steps()))

    def _download(self, run, step):
        url = self.url(run, step)
        idx = http_get(url + ".idx")
        idx.raise_for_status()
        rows = [line.split(":", 2) for line in idx.text.strip().splitlines()]
        offsets = [int(r[1]) for r in rows]
        chunks = []
        for i, r in enumerate(rows):
            line = ":" + r[2]
            if any(w in line for w in _wanted(step)):
                end = offsets[i + 1] - 1 if i + 1 < len(rows) else ""
                part = http_get(url, headers={"Range": f"bytes={offsets[i]}-{end}"})
                part.raise_for_status()
                chunks.append(part.content)
        path = OUT_DIR / "gfs" / f"f{step:03d}.grib2"
        path.write_bytes(b"".join(chunks))
        return path

    def fetch(self, run, cities):
        (OUT_DIR / "gfs").mkdir(parents=True, exist_ok=True)
        with ThreadPoolExecutor(8) as pool:
            paths = list(pool.map(lambda s: self._download(run, s), self.steps()))
        data, distance = read_points(paths, cities)
        return build_series(data, distance, cities, self.steps(), run)
