# Tiempo · datos (public-weather)

El sistema que prepara los datos de la app y la web del tiempo: descarga los modelos meteorológicos,
los lee en las 52 capitales y en una rejilla de España cada 0,25°, los mezcla, añade lo medido por AEMET
y la corrección de una IA, y lo publica como JSON.

- `scripts/run.py` — pronóstico de modelos (cada hora)
- `scripts/weather/grid.py` — rejilla de España en teselas de 1°
- `scripts/observado.py` — lo medido ahora por AEMET (cada 30 min)
- `scripts/ml/` — IA de temperatura y de lluvia (se reentrena cada mes)
- `scripts/pueblos.py` — pueblos de España con altitud (GeoNames)

Las claves van en los *secrets* del repositorio (`SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `AEMET_API_KEY`), nunca en el código.

**Fuentes:** ECMWF Open Data (CC BY 4.0), NOAA GFS (dominio público), DWD ICON-EU (CC BY 4.0),
Météo-France ARPEGE y AROME (Licence Ouverte 2.0), Met Office (© Crown copyright, CC BY-SA 4.0),
ECCC GEM (Licencia del Gobierno Abierto de Canadá), AEMET OpenData, NOAA aviationweather.gov,
GeoNames (CC BY 4.0).

## Componentes de la web (Framer)

`framer/` tiene los componentes de código de la web de Framer (también se ven en la web publicada).
Framer los carga desde aquí: `https://raw.githubusercontent.com/Asiasi99/public-weather/main/framer/<archivo>.tsx`.
