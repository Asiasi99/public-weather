# Airoo · web

Las páginas públicas de Airoo (las que piden las tiendas): soporte (`index.html`), política de privacidad
(`privacidad.html`, `privacy.html`) y condiciones de uso (`condiciones.html`, `terms.html`), en castellano e inglés. Se publican con GitHub Pages (Settings → Pages → `main` / `(root)`).

No se editan a mano: salen de `movil/src/legal.ts` del repositorio `airoo`, que es lo mismo que se lee dentro de la
app. Para rehacerlas: `cd movil && node scripts/legal-web.mjs <esta carpeta>`.

(Antes aquí estaba el sistema antiguo de datos del tiempo, con la IA; se retiró en noviembre de 2026 y sigue en el
historial de git.)
