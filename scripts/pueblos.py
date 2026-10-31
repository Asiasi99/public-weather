"""Lista de pueblos y ciudades de España con su altitud, para buscar y para corregir la temperatura por altura.

Fuente: GeoNames (https://www.geonames.org, CC BY 4.0, uso comercial permitido citando la fuente).
Publica en el cubo:
    places/es.json      España entera: {"v":1, "source":…, "prov":[provincias], "p":[[nombre, provincia, lat×1000, lon×1000, altitud], …]}
    places/europa.json  El resto de países con datos (lugares de 1.000 habitantes o más, de cities1000):
                        {"v":2, "source":…, "reg":[[región, país]], "tz":[zonas horarias],
                         "p":[[nombre, región, lat×1000, lon×1000, altitud, zona horaria], …]}

Uso: python scripts/pueblos.py   (lo lanza .github/workflows/pueblos.yml una vez al mes)
"""

import io
import json
import sys
import unicodedata
import zipfile
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
from weather.store import Store  # noqa: E402

BASE = "https://download.geonames.org/export/dump"
# Lugares poblados: capital, cabeceras administrativas y pueblos. Fuera: barrios (PPLX), históricos, abandonados…
KEEP = {"PPLC", "PPLA", "PPLA2", "PPLA3", "PPLA4", "PPL", "PPLS", "PPLF", "PPLL"}


def norm(s):
    return unicodedata.normalize("NFD", s).encode("ascii", "ignore").decode().lower()


# Países fuera de España que ya tienen rejilla (scripts/weather/grid.py). Se amplía al abrir más Europa.
PAISES = ["PT", "FR", "AD", "MC", "GI"]


def europa(http):
    """Lugares de 1.000 habitantes o más de los países de PAISES, con su región y su zona horaria."""
    z = zipfile.ZipFile(io.BytesIO(http.get(f"{BASE}/cities1000.zip", timeout=300).content))
    rows = z.read("cities1000.txt").decode("utf-8").splitlines()
    admin1 = {}
    for line in http.get(f"{BASE}/admin1CodesASCII.txt", timeout=60).text.splitlines():
        code, name = line.split("\t")[:2]
        admin1[code] = name
    regs, reg_idx, tzs, tz_idx, places, seen = [], {}, [], {}, [], set()
    for line in rows:
        f = line.split("\t")
        if len(f) < 19 or f[8] not in PAISES or f[6] != "P" or f[7] not in KEEP:
            continue
        name, lat, lon, pop, tz = f[1], float(f[4]), float(f[5]), int(f[14] or 0), f[17]
        elev = f[15] or f[16]
        try:
            elev = int(float(elev))
        except ValueError:
            elev = None
        if elev is not None and elev < -100:
            elev = None
        reg = (admin1.get(f"{f[8]}.{f[10]}", ""), f[8])
        if reg not in reg_idx:
            reg_idx[reg] = len(regs)
            regs.append(list(reg))
        if tz not in tz_idx:
            tz_idx[tz] = len(tzs)
            tzs.append(tz)
        key = (norm(name), reg_idx[reg])
        if key in seen:
            continue
        seen.add(key)
        places.append([name, reg_idx[reg], round(lat * 1000), round(lon * 1000), elev, tz_idx[tz], pop])
    places.sort(key=lambda p: -p[6])
    doc = {"v": 2, "source": "GeoNames (CC BY 4.0) — geonames.org", "paises": PAISES, "reg": regs, "tz": tzs,
           "p": [p[:6] for p in places]}
    size = len(json.dumps(doc, ensure_ascii=False, separators=(",", ":")).encode())
    print(f"Europa: {len(places)} lugares en {len(PAISES)} países, {size / 1024:.0f} KB")
    return doc


def main():
    http = requests.Session()
    z = zipfile.ZipFile(io.BytesIO(http.get(f"{BASE}/ES.zip", timeout=120).content))
    rows = z.read("ES.txt").decode("utf-8").splitlines()
    admin2 = {}
    for line in http.get(f"{BASE}/admin2Codes.txt", timeout=60).text.splitlines():
        code, name = line.split("\t")[:2]
        if code.startswith("ES."):
            admin2[code] = name
    provs, prov_idx, places, seen = [], {}, [], set()
    for line in rows:
        f = line.split("\t")
        if len(f) < 19 or f[6] != "P" or f[7] not in KEEP:
            continue
        name, lat, lon = f[1], float(f[4]), float(f[5])
        pop = int(f[14] or 0)
        elev = f[15] or f[16]
        try:
            elev = int(float(elev))
        except ValueError:
            elev = None
        if elev is not None and elev < -100:
            elev = None  # «sin dato» en el relieve de GeoNames (-9999)
        # Un pueblo de 0 habitantes según GeoNames suele ser un caserío: se queda solo si es cabecera de municipio
        if f[7] == "PPL" and pop == 0:
            continue
        prov = admin2.get(f"ES.{f[10]}.{f[11]}", "")
        if prov not in prov_idx:
            prov_idx[prov] = len(provs)
            provs.append(prov)
        key = (norm(name), prov_idx[prov])
        if key in seen:
            continue
        seen.add(key)
        places.append([name, prov_idx[prov], round(lat * 1000), round(lon * 1000), elev, pop])
    # Los más poblados primero: el buscador los enseña antes
    places.sort(key=lambda p: -p[5])
    doc = {"v": 1, "source": "GeoNames (CC BY 4.0) — geonames.org", "prov": provs, "p": [p[:5] for p in places]}
    size = len(json.dumps(doc, ensure_ascii=False, separators=(",", ":")).encode())
    print(f"{len(places)} lugares, {len(provs)} provincias, {size / 1024:.0f} KB")
    store = Store()
    store.put("places/es.json", doc, max_age=86400)
    store.put("places/europa.json", europa(http), max_age=86400)


if __name__ == "__main__":
    main()
