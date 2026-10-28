#!/usr/bin/env python3
"""
Tu propio archivo: una copia comprimida de TODAS las previsiones y de lo observado, cada 6 horas.
Ocupa ~300 KB por copia (~100 MB al año), en archive/AAAA-MM-DDTHH.tar.gz del mismo cubo.

¿Para qué? Ahora la IA aprende con previsiones archivadas por Open-Meteo, que se parecen a las
tuyas pero no son idénticas (tú eliges el punto de rejilla y corriges por altitud). Con unos meses
de este archivo se podrá entrenar con TUS previsiones y TUS observaciones, y dejar Open-Meteo.

forecast.yml lo ejecuta cada hora tras run.py, pero solo guarda a las 00, 06, 12 y 18 UTC
(con --force, siempre).
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

EVERY_HOURS = 6


def main():
    now = datetime.now(timezone.utc)
    if now.hour % EVERY_HOURS and "--force" not in sys.argv:
        print(f"archivo: solo a las {', '.join(f'{h:02d}' for h in range(0, 24, EVERY_HOURS))} UTC")
        return
    store = Store()
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
    name = f"archive/{now:%Y-%m-%dT%H}.tar.gz"
    # Un archivo no cambia: que la caché lo guarde un día.
    store.put_bytes(name, body, "application/gzip", max_age=86400)
    print(f"archivo: {name} con {n} ficheros ({len(body) // 1024} KB)")


if __name__ == "__main__":
    main()
