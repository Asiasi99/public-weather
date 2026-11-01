#!/usr/bin/env python3
"""
Tu propio archivo: una copia comprimida de TODAS las previsiones y de lo observado, una vez al día.
Ocupa ~180 KB por copia (~65 MB al año), en archive/AAAA-MM-DDTHH.tar.gz del mismo cubo (HH: 00, 06, 12 o 18,
la franja de 6 h en que se guardó; acierto.py los busca con ese nombre).

¿Para qué? Ahora la IA aprende con previsiones archivadas por Open-Meteo, que se parecen a las
tuyas pero no son idénticas (tú eliges el punto de rejilla y corriges por altitud). Con unos meses
de este archivo se podrá entrenar con TUS previsiones y TUS observaciones, y dejar Open-Meteo.

forecast.yml lo ejecuta tras cada run.py (4 veces al día): la primera del día UTC guarda la copia y las demás
ven que ya existe y no hacen nada (con --force, guarda siempre). Así no depende de a qué hora llegue el cron.

Cada copia lleva, por ciudad, la última pasada de cada modelo con su hora («run»): con eso y lo medido después
(METAR del IEM, como ahora) se arman los ejemplos de 1 a 7 días vista para entrenar.
"""
import io
import json
import os
import sys
import tarfile
import time
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(__file__))
from comun import Store, load_cities  # noqa: E402

FRANJA_HORAS = 6


def main():
    now = datetime.now(timezone.utc)
    store = Store()
    hoy = [f"archive/{now:%Y-%m-%d}T{h:02d}.tar.gz" for h in range(0, now.hour + 1, FRANJA_HORAS)]
    hecha = next((n for n in hoy if store.get_bytes(n)), None)
    if hecha and "--force" not in sys.argv:
        print(f"archivo: la copia de hoy ya está ({hecha})")
        return
    buf = io.BytesIO()
    n = 0
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for path in [f"cities/{c.id}.json" for c in load_cities()] + ["observed.json"]:
            doc = store.get(path)
            if doc is None:
                print(f"archivo: falta {path}", file=sys.stderr)
                continue
            data = json.dumps(doc, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            info = tarfile.TarInfo(path)
            info.size, info.mtime = len(data), int(time.time())
            tar.addfile(info, io.BytesIO(data))
            n += 1
    body = buf.getvalue()
    name = f"archive/{now:%Y-%m-%d}T{now.hour - now.hour % FRANJA_HORAS:02d}.tar.gz"
    # Un archivo no cambia: que la caché lo guarde un día.
    store.put_bytes(name, body, "application/gzip", max_age=86400)
    print(f"archivo: {name} con {n} ficheros ({len(body) // 1024} KB)")


if __name__ == "__main__":
    main()
