"""Lista todo lo que hay en el cubo de Supabase y borra las carpetas que ya no usa nadie.

Uso: python scripts/limpiar.py                  # solo lista
     python scripts/limpiar.py grid mapa framer # lista y borra esas carpetas (con todo lo de dentro)
"""
import os
import sys
from collections import Counter

import requests

BASE = os.environ["SUPABASE_URL"].strip().rstrip("/")
KEY = os.environ["SUPABASE_SERVICE_KEY"].strip()
BUCKET = os.environ.get("SUPABASE_BUCKET", "weather")
H = {"apikey": KEY, "Content-Type": "application/json"}
if KEY.startswith("eyJ"):
    H["Authorization"] = f"Bearer {KEY}"


def listar(prefijo=""):
    """Todos los ficheros bajo un prefijo, entrando en las carpetas."""
    out, offset = [], 0
    while True:
        r = requests.post(f"{BASE}/storage/v1/object/list/{BUCKET}", headers=H, timeout=60,
                          json={"prefix": prefijo, "limit": 1000, "offset": offset, "sortBy": {"column": "name", "order": "asc"}})
        r.raise_for_status()
        filas = r.json()
        for f in filas:
            ruta = f"{prefijo}/{f['name']}" if prefijo else f["name"]
            if f.get("id") is None:  # carpeta
                out += listar(ruta)
            else:
                out.append((ruta, (f.get("metadata") or {}).get("size", 0)))
        if len(filas) < 1000:
            return out
        offset += 1000


todo = listar()
por_carpeta = Counter(r.split("/")[0] if "/" in r else "(raíz)" for r, _ in todo)
tam = Counter()
for r, t in todo:
    tam[r.split("/")[0] if "/" in r else "(raíz)"] += t or 0
print(f"{len(todo)} ficheros en el cubo «{BUCKET}»:")
for c, n in sorted(por_carpeta.items()):
    print(f"  {c:12} {n:6} ficheros  {tam[c] / 1048576:8.1f} MB")
print("En la raíz:", ", ".join(r for r, _ in todo if "/" not in r))

borrar = [r for r, _ in todo if r.split("/")[0] in sys.argv[1:]]
for i in range(0, len(borrar), 500):
    r = requests.delete(f"{BASE}/storage/v1/object/{BUCKET}", headers=H, json={"prefixes": borrar[i:i + 500]}, timeout=120)
    r.raise_for_status()
if sys.argv[1:]:
    print(f"Borrados {len(borrar)} ficheros de: {', '.join(sys.argv[1:])}")
