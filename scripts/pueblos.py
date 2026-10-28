"""Lista de pueblos y ciudades de España con su altitud, para buscar y para corregir la temperatura por altura.

Fuente: GeoNames (https://www.geonames.org, CC BY 4.0, uso comercial permitido citando la fuente).
Publica en el cubo:
    places/es.json   {"v":1, "source":…, "prov":[provincias], "p":[[nombre, provincia, lat×1000, lon×1000, altitud], …]}

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
    Store().put("places/es.json", doc, max_age=86400)


if __name__ == "__main__":
    main()
