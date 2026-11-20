# Tiempo · datos (public-weather) — retirado

Aquí estaba el sistema antiguo que preparaba los datos de la app del tiempo: los 8 modelos de Open-Meteo en 52
capitales, lo medido por AEMET y una IA que corregía la temperatura y la lluvia, publicado como JSON en Supabase.

Se retiró en noviembre de 2026: la app (Airoo) hace la media de los 8 modelos en tu punto exacto y lo demás lo preparan
las funciones de Supabase del repositorio `airoo`. Las tareas programadas y el código se han quitado; si alguna vez hace
falta, sigue en el historial de git.
