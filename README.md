# Tiempo · datos (public-weather)

El sistema que prepara los datos de la app del tiempo: pide a Open-Meteo los 8 modelos meteorológicos en las
52 capitales (y en las estaciones de los aeropuertos, para medir su acierto), añade lo medido por AEMET y la
corrección de una IA, y lo publica como JSON en Supabase. Los pueblos los pide la propia app a Open-Meteo en su
punto exacto.

- `scripts/run.py` — pronóstico de modelos (cada hora; solo pide los modelos con pasada nueva)
- `scripts/weather/openmeteo.py` — los 8 modelos desde Open-Meteo (plan gratis sin `OPEN_METEO_KEY`)
- `scripts/observado.py` — lo medido ahora por AEMET (cada hora)
- `scripts/ml/` — IA de temperatura y de lluvia (se reentrena cada mes)
- `scripts/pueblos.py` — pueblos de España (y de Portugal, Francia, Andorra, Mónaco y Gibraltar) con altitud (GeoNames)
- `scripts/ml/archivar.py` — una copia al día de todo, para entrenar la IA con tus propias previsiones

Las claves van en los *secrets* del repositorio (`SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `AEMET_API_KEY`), nunca en el código.

**Fuentes:** Open-Meteo.com (CC BY 4.0), con los modelos de ECMWF, NOAA GFS, DWD ICON-EU, Météo-France ARPEGE
y AROME, Met Office y ECCC GEM; AEMET OpenData; NOAA aviationweather.gov; GeoNames (CC BY 4.0).
