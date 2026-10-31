"""Dónde se publican los JSON: Supabase Storage si hay claves; si no, solo la carpeta out/."""

import json
import os
import time

import requests

from .common import OUT_DIR


class Store:
    def __init__(self):
        self.base = os.environ.get("SUPABASE_URL", "").strip().rstrip("/")
        self.key = os.environ.get("SUPABASE_SERVICE_KEY", "").strip()
        self.bucket = os.environ.get("SUPABASE_BUCKET", "weather")
        self.http = requests.Session()
        # En GitHub Actions, sin claves no se publica nada: mejor fallar (en rojo) que «terminar bien» sin subir.
        if os.environ.get("GITHUB_ACTIONS") == "true" and not (self.base and self.key):
            raise RuntimeError("Faltan SUPABASE_URL o SUPABASE_SERVICE_KEY en los secrets del repositorio: no se puede publicar.")

    @property
    def remote(self):
        return bool(self.base and self.key)

    def public_url(self, path):
        return f"{self.base}/storage/v1/object/public/{self.bucket}/{path}"

    def get(self, path):
        """Lo ya publicado, o None si no existe."""
        if self.remote:
            try:
                r = self.http.get(self.public_url(path), timeout=30)
                return r.json() if r.ok else None
            except (requests.RequestException, ValueError):
                return None
        local = OUT_DIR / "public" / path
        return json.loads(local.read_text(encoding="utf-8")) if local.exists() else None

    def get_bytes(self, path):
        """Un fichero tal cual (p. ej. una copia .tar.gz del archivo), o None si no existe."""
        if self.remote:
            try:
                r = self.http.get(self.public_url(path), timeout=60)
                return r.content if r.ok else None
            except requests.RequestException:
                return None
        local = OUT_DIR / "public" / path
        return local.read_bytes() if local.exists() else None

    def put(self, path, doc, max_age=600):
        body = json.dumps(doc, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.put_bytes(path, body, "application/json; charset=utf-8", max_age)

    def put_bytes(self, path, body, content_type, max_age=600):
        """Cualquier fichero (p. ej. las copias .tar.gz del archivo de previsiones)."""
        local = OUT_DIR / "public" / path
        local.parent.mkdir(parents=True, exist_ok=True)
        local.write_bytes(body)
        if not self.remote:
            return
        headers = {"apikey": self.key, "Content-Type": content_type,
                   "x-upsert": "true", "cache-control": f"max-age={max_age}"}
        # Las claves antiguas (JWT, «eyJ…») van también en Authorization; las nuevas (sb_secret_…) solo en apikey.
        if self.key.startswith("eyJ"):
            headers["Authorization"] = f"Bearer {self.key}"
        url = f"{self.base}/storage/v1/object/{self.bucket}/{path}"
        # Supabase a veces no contesta a tiempo (19-oct: una subida de 60 s perdió el modelo entero): se reintenta.
        for attempt in range(3):
            try:
                r = self.http.post(url, headers=headers, data=body, timeout=60)
                if r.status_code < 500:
                    break
            except requests.RequestException:
                if attempt == 2:
                    raise
            time.sleep(5 * (attempt + 1))
        if not r.ok:
            raise RuntimeError(f"Supabase rechazó {path} ({r.status_code}): {r.text}")
