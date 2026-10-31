// TiempoApp.tsx — la tarjeta del tiempo simplificada (pedido: «cómo mejorarías y simplificarías la app»).
import { addPropertyControls, ControlType } from "framer"
import {
    Fragment,
    startTransition,
    useCallback,
    useEffect,
    useId,
    useMemo,
    useRef,
    useState,
} from "react"
import type { CSSProperties, PointerEvent } from "react"

// Lo que escribe scripts/run.py en cities/<id>.json.
type N = number | null
type ModelSeries = {
    id: string
    name: string
    resolution: string
    run: string
    times: string[]
    temp: number[]
    rain: N[]
    cloud: N[]
    // Nubes por pisos (solo los modelos que las dan: ARPEGE y AROME)
    cloudLow?: N[]
    cloudMid?: N[]
    cloudHigh?: N[]
    hum?: N[]
    wind: N[]
    windDir: N[]
    pressure: N[]
}
// Error medio de cada modelo frente a lo medido, por días de antelación («1» = a 24 h). Lo escribe verify.py.
type Score = { mae: number; bias: number; n: number }
type Accuracy = {
    windowDays: number
    station: { id: string; name: string; km: number } | null
    local: Record<string, Record<string, Score>>
    spain: Record<string, Record<string, Score>>
}
type CityDoc = {
    city: {
        id: string
        name: string
        tz: string
        lat?: number
        lon?: number
        metar?: string
    }
    attribution: string
    models: ModelSeries[]
    accuracy?: Accuracy
    // La previsión corregida por la IA (scripts/ml): cada 3 h hasta 72 h, con su rango 10-90 %.
    ml?: MlSeries
    // La IA de lluvia diaria: probabilidad de ≥1 mm y mm esperados; cada día va de 07 a 07 UTC (AEMET).
    ml_rain?: { days: string[]; prob: number[]; mm: number[] }
}
type MlSeries = {
    times: string[]
    temp: number[]
    p10: number[]
    p90: number[]
    trained?: string
    mae_ia?: number
    mae_media?: number
}
// Lo que escribe scripts/observado.py en observed.json: lo medido ahora en cada ciudad.
type Obs = {
    source: "AEMET" | "METAR"
    station: string
    stationId?: string
    km?: N
    time: string
    temp?: N
    hum?: N
    wind?: N // km/h
    gust?: N // km/h
    windDir?: N
    pressure?: N // hPa, a nivel del mar
    rain1h?: N // mm en la última hora
    vis?: N // km
    cloud?: string | null
    wx?: string | null
    raw?: string | null
}
type ObservedDoc = { generated: string; attribution?: string; cities: Record<string, Obs> }
type Step = {
    t: number
    temp: number
    rain: number
    cloud: N
    cloudLow?: N
    cloudMid?: N
    cloudHigh?: N
    hum?: N
    wind: N
    windDir: N
    pressure: N
}

// Observación real: el último METAR del aeropuerto de la ciudad (aviationweather.gov, NOAA).
// Es la misma estación con la que verify.py mide el acierto de los modelos.
type Metar = {
    icaoId: string
    obsTime: number // segundos Unix
    temp?: number | null
    dewp?: number | null
    wdir?: number | string | null // «VRB» si es variable
    wspd?: number | null // nudos
    wgst?: number | null // nudos
    altim?: number | null // hPa
    visib?: number | string | null // millas; «6+» = 10 km o más
    wxString?: string | null
    clouds?: { cover: string; base: number | null }[]
    rawOb?: string
    name?: string
    lat?: number
    lon?: number
}

// Las 52 capitales de provincia, igual que cities.json.
const CITIES: [string, string][] = [
    ["a-coruna", "A Coruña"],
    ["albacete", "Albacete"],
    ["alicante", "Alicante"],
    ["almeria", "Almería"],
    ["avila", "Ávila"],
    ["badajoz", "Badajoz"],
    ["barcelona", "Barcelona"],
    ["bilbao", "Bilbao"],
    ["burgos", "Burgos"],
    ["caceres", "Cáceres"],
    ["cadiz", "Cádiz"],
    ["castellon", "Castellón de la Plana"],
    ["ceuta", "Ceuta"],
    ["ciudad-real", "Ciudad Real"],
    ["cordoba", "Córdoba"],
    ["cuenca", "Cuenca"],
    ["girona", "Girona"],
    ["granada", "Granada"],
    ["guadalajara", "Guadalajara"],
    ["huelva", "Huelva"],
    ["huesca", "Huesca"],
    ["jaen", "Jaén"],
    ["las-palmas", "Las Palmas de Gran Canaria"],
    ["leon", "León"],
    ["lleida", "Lleida"],
    ["logrono", "Logroño"],
    ["lugo", "Lugo"],
    ["madrid", "Madrid"],
    ["malaga", "Málaga"],
    ["melilla", "Melilla"],
    ["murcia", "Murcia"],
    ["ourense", "Ourense"],
    ["oviedo", "Oviedo"],
    ["palencia", "Palencia"],
    ["palma", "Palma"],
    ["pamplona", "Pamplona"],
    ["pontevedra", "Pontevedra"],
    ["salamanca", "Salamanca"],
    ["san-sebastian", "San Sebastián"],
    ["santa-cruz", "Santa Cruz de Tenerife"],
    ["santander", "Santander"],
    ["segovia", "Segovia"],
    ["sevilla", "Sevilla"],
    ["soria", "Soria"],
    ["tarragona", "Tarragona"],
    ["teruel", "Teruel"],
    ["toledo", "Toledo"],
    ["valencia", "Valencia"],
    ["valladolid", "Valladolid"],
    ["vitoria", "Vitoria-Gasteiz"],
    ["zamora", "Zamora"],
    ["zaragoza", "Zaragoza"],
]

// Orden y nombre corto fijos: el color va con el modelo, nunca con su posición en la lista.
const MODELS: [string, string][] = [
    ["ifs", "IFS"],
    ["aifs", "AIFS"],
    ["gfs", "GFS"],
    ["icon-eu", "ICON-EU"],
    ["arpege", "ARPEGE"],
    ["arome", "AROME"],
    ["ukmo", "UKMO"],
    ["gem", "GEM"],
]
const HOUR = 3600_000
// Con menos comparaciones, el error medio aún no dice nada.
const MIN_SCORES = 8

// Confianza de un día: cuánto se separan las máximas de los modelos y si discrepan en si llueve.
const LEVELS = [
    { label: "Confianza alta", color: "#1baf7a" },
    { label: "Confianza media", color: "#eda100" },
    { label: "Confianza baja", color: "#e34948" },
]
function confidence(maxes: number[], rainy: number) {
    if (maxes.length < 2) return null
    const spread = Math.max(...maxes) - Math.min(...maxes)
    let level = spread <= 2 ? 0 : spread <= 4 ? 1 : 2
    // Si entre una cuarta parte y tres cuartas partes de los modelos dan lluvia, no está claro si lloverá.
    const share = rainy / maxes.length
    if (share > 0.25 && share < 0.75) level = Math.min(2, level + 1)
    return { level, spread: Math.round(spread) }
}

// El modelo con menos error a 24 h: en la estación de la ciudad si ya hay datos; si no, en toda España.
function mostAccurate(acc: Accuracy | undefined, available: string[]) {
    if (!acc) return null
    for (const [where, by] of [
        ["aquí", acc.local],
        ["en España", acc.spain],
    ] as const) {
        const ranked = available
            .flatMap((id) =>
                by[id]?.["1"] && by[id]["1"].n >= MIN_SCORES
                    ? [{ id, mae: by[id]["1"].mae }]
                    : []
            )
            .sort((a, b) => a.mae - b.mae)
        if (ranked.length) return { ...ranked[0], where }
    }
    return null
}

const cache = new Map<string, Promise<CityDoc>>()
function load(url: string): Promise<CityDoc> {
    if (!cache.has(url)) {
        const p = fetch(url).then((r) => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`)
            return r.json()
        })
        p.catch(() => cache.delete(url))
        cache.set(url, p)
    }
    return cache.get(url)!
}

// El METAR más reciente de las últimas 3 h. Se guarda 10 minutos para no pedirlo en cada render.
const metarCache = new Map<string, Promise<Metar | null>>()
function loadMetar(icao: string): Promise<Metar | null> {
    const key = `${icao}-${Math.floor(Date.now() / 600_000)}`
    if (!metarCache.has(key)) {
        const p = fetch(
            `https://aviationweather.gov/api/data/metar?ids=${encodeURIComponent(icao)}&format=json&hours=3`
        )
            .then((r) => {
                if (!r.ok) throw new Error(`HTTP ${r.status}`)
                return r.json()
            })
            .then((list: Metar[]) =>
                Array.isArray(list) && list.length
                    ? [...list].sort((a, b) => b.obsTime - a.obsTime)[0]
                    : null
            )
        p.catch(() => metarCache.delete(key))
        metarCache.set(key, p)
    }
    return metarCache.get(key)!
}

// observed.json, lo medido ahora (AEMET o METAR). Se pide de nuevo cada 5 minutos.
const observedCache = new Map<string, Promise<ObservedDoc>>()
function loadObserved(url: string): Promise<ObservedDoc> {
    const key = `${url}#${Math.floor(Date.now() / 300_000)}`
    if (!observedCache.has(key)) {
        const p = fetch(`${url}?v=${Math.floor(Date.now() / 300_000)}`).then((r) => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`)
            return r.json()
        })
        p.catch(() => observedCache.delete(key))
        observedCache.set(key, p)
    }
    return observedCache.get(key)!
}

// Ref de función: mide el contenedor también si aparece después (al terminar de cargar).
function useWidth() {
    const [width, setWidth] = useState(0)
    const observer = useRef<ResizeObserver | null>(null)
    useEffect(() => {
        return () => observer.current?.disconnect()
    }, [])
    const ref = useCallback((el: HTMLDivElement | null) => {
        observer.current?.disconnect()
        if (!el) return
        observer.current = new ResizeObserver(([e]) =>
            startTransition(() => setWidth(e.contentRect.width))
        )
        observer.current.observe(el)
    }, [])
    return [ref, width] as const
}

function stepsOf(m: ModelSeries): Step[] {
    return m.times.map((t, i) => ({
        t: Date.parse(t),
        temp: m.temp[i],
        rain: m.rain[i] ?? 0,
        cloud: m.cloud?.[i] ?? null,
        cloudLow: m.cloudLow?.[i] ?? null,
        cloudMid: m.cloudMid?.[i] ?? null,
        cloudHigh: m.cloudHigh?.[i] ?? null,
        hum: m.hum?.[i] ?? null,
        wind: m.wind?.[i] ?? null,
        windDir: m.windDir?.[i] ?? null,
        pressure: m.pressure?.[i] ?? null,
    }))
}

const mean = (xs: number[]) =>
    xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null

// La media de los modelos en cada instante que tengan al menos dos (AROME va cada hora y los demás
// cada 3 h: una hora con solo AROME no es una media). La lluvia, solo de los que van de 3 en 3 h,
// para no mezclar la de 6 h de AIFS ni la de 1 h de AROME con la de 3 h de los demás.
function average(models: ModelSeries[]): Step[] {
    const byTime = new Map<number, { s: Step; interval: number }[]>()
    for (const m of models) {
        const steps = stepsOf(m)
        steps.forEach((s, i) => {
            const interval = i ? s.t - steps[i - 1].t : 0
            if (!byTime.has(s.t)) byTime.set(s.t, [])
            byTime.get(s.t)!.push({ s, interval })
        })
    }
    const minModels = Math.min(2, models.length)
    return [...byTime.entries()]
        .filter(([, list]) => list.length >= minModels)
        .sort((a, b) => a[0] - b[0])
        .map(([t, list]) => {
            const nums = (f: (s: Step) => N) =>
                list.flatMap(({ s }) => (f(s) == null ? [] : [f(s)!]))
            return {
                t,
                temp: mean(list.map(({ s }) => s.temp))!,
                rain:
                    mean(
                        list
                            .filter((x) => x.interval === 3 * HOUR)
                            .map(({ s }) => s.rain)
                    ) ?? 0,
                cloud: mean(nums((s) => s.cloud)),
                cloudLow: mean(nums((s) => s.cloudLow ?? null)),
                cloudMid: mean(nums((s) => s.cloudMid ?? null)),
                cloudHigh: mean(nums((s) => s.cloudHigh ?? null)),
                hum: mean(nums((s) => s.hum ?? null)),
                wind: mean(nums((s) => s.wind)),
                windDir: meanDir(list.map(({ s }) => s)),
                pressure: mean(nums((s) => s.pressure)),
            }
        })
}

// Dirección media del viento: se suman los vectores (no los grados: la media de 350° y 10° es 0°, no 180°).
function meanDir(steps: Step[]): N {
    let u = 0,
        v = 0,
        n = 0
    for (const s of steps) {
        if (s.windDir == null) continue
        const ws = s.wind ?? 1
        const r = (s.windDir * Math.PI) / 180
        u += ws * Math.sin(r)
        v += ws * Math.cos(r)
        n++
    }
    if (!n || (u === 0 && v === 0)) return null
    return ((Math.atan2(u, v) * 180) / Math.PI + 360) % 360
}

const num = (v: number, digits = 0) =>
    v.toLocaleString("es-ES", { maximumFractionDigits: digits })
const mm = (v: number) => `${num(v, 1)} mm`
const COMPASS = ["N", "NE", "E", "SE", "S", "SO", "O", "NO"]
const compass = (deg: number) => COMPASS[Math.round(deg / 45) % 8]

// --- Lectura del METAR -------------------------------------------------------------------------

const KT = 1.852 // nudos → km/h
// Humedad relativa a partir de temperatura y punto de rocío (fórmula de Magnus).
function humidity(t: number, td: number) {
    const a = 17.625,
        b = 243.04
    return Math.round(
        100 * Math.exp((a * td) / (b + td) - (a * t) / (b + t))
    )
}
// Distancia en km entre dos puntos (haversine).
function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number) {
    const r = Math.PI / 180
    const dLat = (lat2 - lat1) * r,
        dLon = (lon2 - lon1) * r
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2
    return 12742 * Math.asin(Math.sqrt(a))
}
const COVER: Record<string, [number, string]> = {
    SKC: [0, "Despejado"],
    CLR: [0, "Despejado"],
    NSC: [0, "Sin nubes bajas"],
    NCD: [0, "Despejado"],
    CAVOK: [0, "Despejado"],
    FEW: [1, "Poco nuboso"],
    SCT: [2, "Nubes dispersas"],
    BKN: [3, "Nuboso"],
    OVC: [4, "Cubierto"],
    OVX: [4, "Cielo oculto"],
}
function cloudText(m: Metar): string | null {
    const layers = (m.clouds ?? []).filter((c) => COVER[c.cover])
    if (!layers.length) return null
    const top = layers.reduce((a, b) =>
        COVER[b.cover][0] > COVER[a.cover][0] ? b : a
    )
    const label = COVER[top.cover][1]
    return top.base != null && COVER[top.cover][0] > 0
        ? `${label} · base ${num(Math.round((top.base * 0.3048) / 10) * 10)} m`
        : label
}
const WX: [string, string][] = [
    ["TS", "Tormenta"],
    ["GR", "Granizo"],
    ["SN", "Nieve"],
    ["SHRA", "Chubascos"],
    ["RA", "Lluvia"],
    ["DZ", "Llovizna"],
    ["FG", "Niebla"],
    ["BR", "Neblina"],
    ["HZ", "Calima"],
    ["DU", "Polvo"],
]
function wxText(s?: string | null): string | null {
    if (!s) return null
    const tok = s.trim().split(/\s+/)[0]
    const found = WX.find(([k]) => tok.includes(k))
    if (!found) return null
    const intensity = tok.startsWith("-")
        ? " débil"
        : tok.startsWith("+")
          ? " fuerte"
          : ""
    return found[1] + intensity
}
function metarToObs(m: Metar, city: CityDoc["city"]): Obs {
    const wdir = typeof m.wdir === "number" ? m.wdir : null
    const visKm = (() => {
        const v = m.visib
        if (v == null) return null
        if (typeof v === "string") return v.includes("+") ? 10 : parseFloat(v) * 1.609
        return v >= 6 ? 10 : v * 1.609
    })()
    return {
        source: "METAR",
        station: m.name?.replace(/,.*$/, "") ?? m.icaoId,
        stationId: m.icaoId,
        km:
            city.lat != null && city.lon != null && m.lat != null && m.lon != null
                ? distanceKm(city.lat, city.lon, m.lat, m.lon)
                : null,
        time: new Date(m.obsTime * 1000).toISOString(),
        temp: m.temp ?? null,
        hum: m.temp != null && m.dewp != null ? humidity(m.temp, m.dewp) : null,
        wind: m.wspd != null ? Math.round(m.wspd * KT) : null,
        gust: m.wgst ? Math.round(m.wgst * KT) : null,
        windDir: wdir,
        pressure: m.altim ?? null,
        vis: visKm,
        cloud: cloudText(m),
        wx: wxText(m.wxString),
        raw: m.rawOb ?? null,
    }
}

function ago(ms: number) {
    const min = Math.max(0, Math.round(ms / 60_000))
    if (min < 60) return `hace ${min} min`
    const h = Math.floor(min / 60)
    return `hace ${h} h ${min % 60} min`
}

// Curva suave que pasa por todos los puntos sin pasarse de ellos (cúbica monótona, Fritsch-Carlson):
// así una curva redondeada nunca dibuja una máxima o una mínima que el modelo no ha dado.
function smoothPath(p: [number, number][]): string {
    const n = p.length
    if (!n) return ""
    const f = (v: number) => v.toFixed(1)
    if (n === 1) return `M${f(p[0][0])},${f(p[0][1])}`
    const dx: number[] = [],
        m: number[] = []
    for (let i = 0; i < n - 1; i++) {
        dx.push(p[i + 1][0] - p[i][0])
        m.push((p[i + 1][1] - p[i][1]) / (dx[i] || 1))
    }
    const t: number[] = [m[0]]
    for (let i = 1; i < n - 1; i++) {
        if (m[i - 1] * m[i] <= 0) t.push(0)
        else {
            const w1 = 2 * dx[i] + dx[i - 1],
                w2 = dx[i] + 2 * dx[i - 1]
            t.push((w1 + w2) / (w1 / m[i - 1] + w2 / m[i]))
        }
    }
    t.push(m[n - 2])
    let d = `M${f(p[0][0])},${f(p[0][1])}`
    for (let i = 0; i < n - 1; i++) {
        const h = dx[i] / 3
        d += `C${f(p[i][0] + h)},${f(p[i][1] + h * t[i])} ${f(p[i + 1][0] - h)},${f(p[i + 1][1] - h * t[i + 1])} ${f(p[i + 1][0])},${f(p[i + 1][1])}`
    }
    return d
}

type FontValue = {
    fontFamily?: string
    fontSize?: string | number
    lineHeight?: string | number
    letterSpacing?: string | number
    fontWeight?: string | number
    fontStyle?: string
    textAlign?: "left" | "center" | "right"
}

const FONT_STYLESHEET_ID = "outfit-font-stylesheet-v1"
const OUTFIT_STACK = "Outfit, sans-serif"
function ensureOutfitFont() {
    if (typeof document === "undefined") return
    if (!document.getElementById(FONT_STYLESHEET_ID)) {
        const link = document.createElement("link")
        link.id = FONT_STYLESHEET_ID
        link.rel = "stylesheet"
        link.href =
            "https://fonts.googleapis.com/css2?family=Outfit:wght@200;300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&family=Doto:wght@800&display=swap"
        document.head.appendChild(link)
    }
    if (typeof document.fonts !== "undefined") {
        void document.fonts.load("400 13px Outfit")
        void document.fonts.load("600 24px Outfit")
        void document.fonts.load("200 84px Outfit")
        void document.fonts.load("800 120px Outfit")
        void document.fonts.load("500 11px 'JetBrains Mono'")
    }
}

function fontStyle(font?: FontValue): CSSProperties {
    const safeFont = font ?? {}
    return {
        fontFamily: OUTFIT_STACK,
        fontSize: safeFont.fontSize,
        lineHeight: safeFont.lineHeight,
        letterSpacing: safeFont.letterSpacing,
        fontWeight: safeFont.fontWeight,
        fontStyle: safeFont.fontStyle as CSSProperties["fontStyle"],
        textAlign: safeFont.textAlign,
    }
}

function isTransparentColor(value: string): boolean {
    const v = value.trim().toLowerCase()
    return (
        v === "transparent" ||
        v === "rgba(0,0,0,0)" ||
        v === "rgba(0, 0, 0, 0)" ||
        /rgba\([^)]*,\s*0\s*\)$/.test(v) ||
        /hsla\([^)]*,\s*0\s*\)$/.test(v)
    )
}

// --- Aspecto ---------------------------------------------------------------------------------

type Kind =
    | "clear-day"
    | "clear-night"
    | "partly-day"
    | "partly-night"
    | "cloudy"
    | "overcast"
    | "drizzle"
    | "rain"
    | "unknown"

function kindOf(rain: number, cloud: N, night: boolean): Kind {
    if (rain >= 2) return "rain"
    if (rain >= 0.3) return "drizzle"
    // Sin dato de nubes (ARPEGE sin SP2, GFS en su primera hora) no se puede saber si hace sol.
    if (cloud == null) return "unknown"
    if (cloud < 25) return night ? "clear-night" : "clear-day"
    if (cloud < 60) return night ? "partly-night" : "partly-day"
    if (cloud < 85) return "cloudy"
    return "overcast"
}
const isNight = (hour: number) => hour < 7 || hour >= 20

const KIND_LABEL: Record<Kind, string> = {
    "clear-day": "Despejado",
    "clear-night": "Despejado",
    "partly-day": "Poco nuboso",
    "partly-night": "Poco nuboso",
    cloudy: "Nuboso",
    overcast: "Cubierto",
    drizzle: "Lluvia débil",
    rain: "Lluvia",
    unknown: "Sin datos de nubes",
}

// El cielo de la cabecera según el tiempo de ahora y la hora local.
function skyGradient(kind: Kind, hour: number): string {
    if (kind === "rain" || kind === "drizzle")
        return "linear-gradient(160deg, #3d4f66 0%, #5f7690 55%, #8aa0b6 100%)"
    if (isNight(hour))
        return "linear-gradient(160deg, #0b1630 0%, #1b2d55 55%, #34497a 100%)"
    if (kind === "overcast" || kind === "cloudy")
        return "linear-gradient(160deg, #50708f 0%, #7d9ab5 55%, #b4c6d6 100%)"
    if (hour < 9 || hour >= 18)
        return "linear-gradient(160deg, #4c4aa8 0%, #9a6bc4 50%, #f2a48a 100%)"
    return "linear-gradient(160deg, #1f6fe0 0%, #3d94f0 50%, #8cc9fb 100%)"
}

// Escala de color por temperatura: azul el frío, verde lo templado, naranja y rojo el calor.
const RAMP: [number, [number, number, number]][] = [
    [-5, [99, 102, 241]],
    [5, [56, 189, 248]],
    [12, [52, 211, 153]],
    [18, [251, 191, 36]],
    [25, [249, 115, 22]],
    [33, [239, 68, 68]],
]
function tempColor(t: number): string {
    if (t <= RAMP[0][0]) return `rgb(${RAMP[0][1].join(",")})`
    for (let i = 1; i < RAMP.length; i++) {
        const [t1, c1] = RAMP[i]
        if (t <= t1) {
            const [t0, c0] = RAMP[i - 1]
            const k = (t - t0) / (t1 - t0)
            return `rgb(${c0.map((v, j) => Math.round(v + (c1[j] - v) * k)).join(",")})`
        }
    }
    return `rgb(${RAMP[RAMP.length - 1][1].join(",")})`
}

// Iconos dibujados (24×24): en la cabecera, sobre el cielo, las nubes van blancas; en las tarjetas, grises.
function Icon({
    kind,
    size = 24,
    onSky = false,
}: {
    kind: Kind
    size?: number
    onSky?: boolean
}) {
    const cloudFill = onSky ? "rgba(255,255,255,0.96)" : "#e8eef5"
    const cloudStroke = onSky ? "rgba(255,255,255,0.0)" : "#9fb0c3"
    const sun = "#fbbf24"
    const rays = (cx: number, cy: number, r1: number, r2: number) =>
        [0, 45, 90, 135, 180, 225, 270, 315].map((a) => {
            const rad = (a * Math.PI) / 180
            return (
                <line
                    key={a}
                    x1={cx + Math.cos(rad) * r1}
                    y1={cy + Math.sin(rad) * r1}
                    x2={cx + Math.cos(rad) * r2}
                    y2={cy + Math.sin(rad) * r2}
                    stroke={sun}
                    strokeWidth={1.8}
                    strokeLinecap="round"
                />
            )
        })
    const cloud = (dx = 0, dy = 0, s = 1) => (
        <path
            transform={`translate(${dx} ${dy}) scale(${s})`}
            d="M7.5 19h9.25a4.25 4.25 0 0 0 .6-8.46A5.75 5.75 0 0 0 6.4 11.1 4 4 0 0 0 7.5 19z"
            fill={cloudFill}
            stroke={cloudStroke}
            strokeWidth={1.1}
            strokeLinejoin="round"
        />
    )
    const moon = (dx = 0, dy = 0, s = 1) => (
        <path
            transform={`translate(${dx} ${dy}) scale(${s})`}
            d="M15.5 4.5a7.5 7.5 0 1 0 4 13.4A6.5 6.5 0 0 1 15.5 4.5z"
            fill={onSky ? "#f1f5f9" : "#c7d2fe"}
        />
    )
    const drops = (n: number) =>
        Array.from({ length: n }, (_, i) => (
            <line
                key={i}
                x1={9 + i * 3.5}
                y1={20.5}
                x2={8 + i * 3.5}
                y2={23}
                stroke="#60a5fa"
                strokeWidth={1.8}
                strokeLinecap="round"
            />
        ))
    let body
    switch (kind) {
        case "clear-day":
            body = (
                <>
                    {rays(12, 12, 7, 9.6)}
                    <circle cx={12} cy={12} r={4.8} fill={sun} />
                </>
            )
            break
        case "clear-night":
            body = moon()
            break
        case "partly-day":
            body = (
                <>
                    {rays(9, 8.5, 4.6, 6.4)}
                    <circle cx={9} cy={8.5} r={3.3} fill={sun} />
                    {cloud(2.5, 1.5, 0.85)}
                </>
            )
            break
        case "partly-night":
            body = (
                <>
                    {moon(-3, -2, 0.75)}
                    {cloud(2.5, 1.5, 0.85)}
                </>
            )
            break
        case "cloudy":
            body = (
                <>
                    {cloud(3.5, -3.5, 0.75)}
                    {cloud(-0.5, 0.5)}
                </>
            )
            break
        case "overcast":
            body = (
                <>
                    {cloud(3.5, -4, 0.75)}
                    <g opacity={onSky ? 0.85 : 1}>{cloud(-0.5, 0.5)}</g>
                </>
            )
            break
        case "drizzle":
            body = (
                <>
                    {cloud(0, -2.5)}
                    {drops(2)}
                </>
            )
            break
        case "rain":
            body = (
                <>
                    {cloud(0, -2.5)}
                    {drops(3)}
                </>
            )
            break
        default:
            body = (
                <>
                    <rect
                        x={10}
                        y={3}
                        width={4}
                        height={13}
                        rx={2}
                        fill="none"
                        stroke={onSky ? "#fff" : "#9fb0c3"}
                        strokeWidth={1.6}
                    />
                    <circle cx={12} cy={18} r={3.5} fill="#f97316" />
                    <line
                        x1={12}
                        y1={9}
                        x2={12}
                        y2={16}
                        stroke="#f97316"
                        strokeWidth={1.8}
                        strokeLinecap="round"
                    />
                </>
            )
    }
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            style={{ display: "block", flex: "none", overflow: "visible" }}
            aria-label={KIND_LABEL[kind]}
            role="img"
        >
            {body}
        </svg>
    )
}

function Drop({ size = 10 }: { size?: number }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 12 12"
            style={{ display: "inline-block", verticalAlign: "-1px" }}
            aria-hidden
        >
            <path
                d="M6 1.2C6 1.2 2.4 5.4 2.4 7.6a3.6 3.6 0 0 0 7.2 0C9.6 5.4 6 1.2 6 1.2z"
                fill="#60a5fa"
            />
        </svg>
    )
}


// ------------------------------------------------------------------------------------------------
// TiempoApp: la versión sencilla. Una pregunta por tarjeta:
//   Ahora (¿qué tiempo hace?) · Próximas horas (¿cómo evoluciona?) · Lluvia y nubes (¿paraguas?)
//   · 7 días (¿y la semana?) · ¿Me puedo fiar? (los aciertos de la IA).
// La IA es la previsión principal; los 8 modelos quedan detrás del botón «Ver modelos».
// ------------------------------------------------------------------------------------------------

type Acierto = {
    station: { id: string; name: string; km: number }
    days: {
        day: string
        rain?: { prob: number; mm: number; mod_prob: N; mod_mm: N }
        temp?: { max: number; min: number; mod_max: N; mod_min: N }
        obs: { mm: N; tmax: N; tmin: N } | null
    }[]
}
type AppDoc = CityDoc & { acierto?: Acierto }
type Pt = { t: number; v: number; lo?: number; hi?: number; ai: boolean }

const WET_MM = 1
// Paleta: tinta neutra para el texto, un solo color para la IA y una escala divergente para la temperatura
// (azul el frío, gris neutro hacia 16°, rojo el calor), nunca un arcoíris.
const INK2 = "#52514e"
const RAIN = "#2a78d6"
const CLOUD = "#d9d7cf"
const EMPTY = "#efeee9"
const HEAT: [number, string][] = [
    [-5, "#0d366b"],
    [0, "#1c5cab"],
    [5, "#3987e5"],
    [10, "#86b6ef"],
    [13, "#cde2fb"],
    [16, "#f0efec"],
    [19, "#f8d4c4"],
    [23, "#f0a283"],
    [27, "#e2684a"],
    [32, "#c03a2b"],
    [38, "#8a1f17"],
]
const rgbOf = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
function heat(t: number): string {
    if (t <= HEAT[0][0]) return HEAT[0][1]
    for (let i = 1; i < HEAT.length; i++) {
        const [t1, c1] = HEAT[i]
        if (t <= t1) {
            const [t0, c0] = HEAT[i - 1]
            const k = (t - t0) / (t1 - t0)
            const a = rgbOf(c0),
                b = rgbOf(c1)
            return `rgb(${a.map((v, j) => Math.round(v + (b[j] - v) * k)).join(",")})`
        }
    }
    return HEAT[HEAT.length - 1][1]
}
// Lluvia: un solo azul, de claro (poca) a oscuro (mucha). Sin lluvia, la casilla muestra las nubes en gris.
const RAIN_STEPS: [number, string][] = [
    [0.1, "#cde2fb"],
    [0.5, "#9ec5f4"],
    [1, "#6da7ec"],
    [2, "#3987e5"],
    [4, "#256abf"],
    [8, "#184f95"],
    [15, "#0d366b"],
]
function rainColor(mm: number): string {
    let c = RAIN_STEPS[0][1]
    for (const [v, col] of RAIN_STEPS) if (mm >= v) c = col
    return c
}
const rainDark = (mm: number) => mm >= 2
function cloudColor(c: N): string {
    if (c == null) return EMPTY
    const a = rgbOf("#fcfcfb"),
        b = rgbOf("#cfccc2")
    const k = Math.max(0, Math.min(1, c / 100))
    return `rgb(${a.map((v, j) => Math.round(v + (b[j] - v) * k)).join(",")})`
}
const mmText = (v: number) => (v < 10 ? v.toLocaleString("es-ES", { maximumFractionDigits: 1 }) : String(Math.round(v)))

// Texto encima de una casilla: blanco si el fondo es oscuro, tinta si es claro.
function inkOn(t: number): string {
    const m = heat(t).match(/\d+/g)
    const [r, g, b] = m ? m.map(Number) : rgbOf(heat(t))
    return 0.299 * r + 0.587 * g + 0.114 * b < 150 ? "#ffffff" : "#0b0b0b"
}
const TEMP_OK = 2
const OK = "#1baf7a"
const BAD = "#e34948"

function Mark({ hit }: { hit: boolean | null }) {
    if (hit == null) return null
    return (
        <span
            aria-label={hit ? "Acertó" : "Falló"}
            style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: 16,
                height: 16,
                borderRadius: 8,
                background: hit ? OK : BAD,
                color: "#fff",
                fontSize: 10,
                fontWeight: 700,
                lineHeight: 1,
            }}
        >
            {hit ? "✓" : "✗"}
        </span>
    )
}

interface AppProps {
    baseUrl: string
    cityId: string
    section: "todo" | "ahora" | "temperatura" | "curva" | "viento" | "sensacion" | "lluvia" | "acierto"
    showTempChart: boolean
    container: boolean
    tile: boolean
    textScale: number
    tempLine: boolean
    tileSoft: number
    days: number
    colorAi: string
    dynamicSky: boolean
    background: string
    textColor: string
    mutedColor: string
    radius: number
    shadow: string
    // Personalización de la vista
    bgColor: string
    inkColor: string
    softColor: string
    fontFamily: string
    padding: number
    palette: "vivo" | "clasico" | "mono" | "propia"
    showNow: boolean
    showTempBand: boolean
    showWindBand: boolean
    showRainChart: boolean
    tempColor1: string
    tempColor2: string
    tempColor3: string
    tempColor4: string
    tempColor5: string
    windColor1: string
    windColor2: string
    windColor3: string
    windColor4: string
    cloudColor: string
    feelsColor1: string
    feelsColor2: string
    feelsColor3: string
    feelsColor4: string
    showFeelsBand: boolean
    showAi: boolean
    feelsBandHeight: number
    showClouds: boolean
    showRain: boolean
    showArrows: boolean
    tempSize: number
    tempWeight: number
    bandHeight: number
    bandBlur: number
    cloudOpacity: number
    windBandHeight: number
    windMax: number
    arrowEvery: number
    arrowSize: number
    chartHeight: number
    chartBlur: number
    showChartWind: boolean
    chartWindOpacity: number
    chartWindDensity: number
    rainColor1: string
    rainColor2: string
    rainColor3: string
    aurora: boolean
    auroraStrength: number
    grain: boolean
    animations: boolean
    style?: CSSProperties
}

/**
 * El tiempo de una ciudad, versión sencilla: la IA como previsión principal y una pregunta por tarjeta.
 *
 * @framerSupportedLayoutWidth any
 * @framerSupportedLayoutHeight auto
 */
// --- Dibujitos a mano para la tabla de la semana (como un jardín: cada casilla, un dibujo) ---
// El color dice la temperatura, en 6 tramos de frío a calor.
const GARDEN: [number, string][] = [
    [6, "#2b1fd0"],
    [10, "#2f7be0"],
    [14, "#13a19a"],
    [18, "#3d9e43"],
    [22, "#ef8a1f"],
    [99, "#e0402c"],
]
const garden = (t: number) => GARDEN.find(([lim]) => t < lim)![1]
const CLOUD_D = "M9.5 22.5h13.2c2.9 0 4.9-2.1 4.8-4.7-.1-2.5-2.2-4.4-4.7-4.3-.7-3.6-3.6-6-7.1-5.9-3.2.1-5.8 2.4-6.4 5.4-2.5.2-4.4 2.3-4.3 4.8.1 2.6 2 4.7 4.5 4.7z"
function Doodle({ kind, color, size = 26 }: { kind: Kind; color: string; size?: number }) {
    const sun = (cx: number, cy: number, r: number, ray: number) => (
        <>
            <circle cx={cx} cy={cy} r={r} />
            {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => {
                const k = (a * Math.PI) / 180
                return <line key={a} x1={cx + Math.cos(k) * (r + 2.2)} y1={cy + Math.sin(k) * (r + 2.2)} x2={cx + Math.cos(k) * (r + 2.2 + ray)} y2={cy + Math.sin(k) * (r + 2.2 + ray)} />
            })}
        </>
    )
    const moon = (dx: number, dy: number, s: number) => (
        <path transform={`translate(${dx} ${dy}) scale(${s})`} d="M19 6.5c-5 .4-8.6 4.9-8 9.9.6 4.7 4.9 8 9.6 7.6 1.8-.2 3.4-.9 4.7-2-4.4-.2-7.8-3.9-7.6-8.3.1-2.8 1.5-5.3 3.8-6.8-.8-.3-1.6-.4-2.5-.4z" />
    )
    let body: any
    switch (kind) {
        case "clear-day":
            body = sun(16, 16, 5.2, 3.6)
            break
        case "clear-night":
            body = moon(0, 0, 1)
            break
        case "partly-day":
            body = (
                <>
                    {sun(11, 10.5, 3.6, 2.4)}
                    <path transform="translate(3 3) scale(.85)" d={CLOUD_D} fill="#fff" />
                </>
            )
            break
        case "partly-night":
            body = (
                <>
                    {moon(-5, -4, 0.75)}
                    <path transform="translate(3 3) scale(.85)" d={CLOUD_D} fill="#fff" />
                </>
            )
            break
        case "cloudy":
            body = <path d={CLOUD_D} />
            break
        case "overcast":
            body = (
                <>
                    <path transform="translate(5 -5) scale(.75)" d={CLOUD_D} />
                    <path transform="translate(-1 1)" d={CLOUD_D} fill="#fff" />
                </>
            )
            break
        case "drizzle":
            body = (
                <>
                    <path transform="translate(0 -5)" d={CLOUD_D} />
                    <line x1={12} y1={21.5} x2={11} y2={24.5} />
                    <line x1={19} y1={21.5} x2={18} y2={24.5} />
                </>
            )
            break
        case "rain":
            body = (
                <>
                    <path transform="translate(0 -5)" d={CLOUD_D} />
                    <line x1={10.5} y1={21.5} x2={8.5} y2={27} />
                    <line x1={16} y1={21.5} x2={14} y2={27} />
                    <line x1={21.5} y1={21.5} x2={19.5} y2={27} />
                </>
            )
            break
        default:
            body = <circle cx={16} cy={16} r={1.6} fill={color} />
    }
    return (
        <svg width={size} height={size} viewBox="0 0 32 32" fill="none" stroke={color} strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ display: "block", overflow: "visible" }}>
            {body}
        </svg>
    )
}

// --- El cartel de arriba (ideas de carteles del tiempo: un color entero, un número enorme) ---
const MONO_STACK = "'JetBrains Mono', ui-monospace, Menlo, monospace"
// Grano de papel: ruido SVG muy suave encima del color.
const GRAIN =
    "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 .9 0'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>\")"
type Poster = { bg: string; ink: string; soft: string; rule: string; shape: string; tint: string; drops?: boolean }
const SUN: Poster = { bg: "#f2c230", ink: "#1b1606", soft: "rgba(27,22,6,0.62)", rule: "rgba(27,22,6,0.22)", shape: "#f8d867", tint: "#fbefc6" }
const NIGHT: Poster = { bg: "#1e2747", ink: "#f2efe6", soft: "rgba(242,239,230,0.66)", rule: "rgba(242,239,230,0.2)", shape: "#2b3660", tint: "#e3e6f2" }
const GREY: Poster = { bg: "#d4d4cd", ink: "#16171a", soft: "rgba(22,23,26,0.6)", rule: "rgba(22,23,26,0.18)", shape: "#e4e3dd", tint: "#e9e8e1" }
const WET: Poster = { bg: "#2f56d0", ink: "#f4f6ff", soft: "rgba(244,246,255,0.72)", rule: "rgba(244,246,255,0.24)", shape: "#3d65dc", drops: true, tint: "#dde6fb" }
const POSTER: Record<Kind, Poster> = {
    "clear-day": SUN,
    "partly-day": SUN,
    "clear-night": NIGHT,
    "partly-night": NIGHT,
    cloudy: GREY,
    overcast: GREY,
    unknown: GREY,
    drizzle: WET,
    rain: WET,
}
// Cada tarjeta, su color suave (como una serie de carteles): la de las horas sigue al cielo de ahora.
const TINT = { week: "#e8e7ef", rain: "#dfe8f4", acierto: "#ebe6f8" }

// El fondo de toda la app: un degradado y tres luces suaves para cada cielo.
type Aura = { base: string; blobs: [string, string, string] }
const AURA_SUN: Aura = { base: "linear-gradient(165deg, #ffe08a 0%, #f7b955 55%, #f08f63 100%)", blobs: ["#fff6c7", "#ff9a6a", "#ffc8d9"] }
const AURA_NIGHT: Aura = { base: "linear-gradient(170deg, #0b1130 0%, #1b2258 55%, #3b2f70 100%)", blobs: ["#3f53d4", "#7a4fb8", "#147ea8"] }
const AURA_GREY: Aura = { base: "linear-gradient(170deg, #e2e3e6 0%, #c9cdd4 55%, #e9e4da 100%)", blobs: ["#ffffff", "#aeb6c4", "#f1e7d6"] }
const AURA_WET: Aura = { base: "linear-gradient(170deg, #2747c4 0%, #3a69de 55%, #6d90e6 100%)", blobs: ["#8db6ff", "#1b2c94", "#a4e3ff"] }
const AURA: Record<Kind, Aura> = {
    "clear-day": AURA_SUN,
    "partly-day": AURA_SUN,
    "clear-night": AURA_NIGHT,
    "partly-night": AURA_NIGHT,
    cloudy: AURA_GREY,
    overcast: AURA_GREY,
    unknown: AURA_GREY,
    drizzle: AURA_WET,
    rain: AURA_WET,
}

// Una frase con carácter para cada cielo.
const WITTY: Record<Kind, string> = {
    "clear-day": "Es hora de sol.",
    "partly-day": "Sol, con alguna nube de paso.",
    "clear-night": "Noche clara. Mira arriba.",
    "partly-night": "Noche tranquila.",
    cloudy: "Gris, pero seco.",
    overcast: "Cielo de techo bajo.",
    drizzle: "Chispea. Paraguas pequeño.",
    rain: "Sí. Está lloviendo.",
    unknown: "Cielo por confirmar.",
}

// --- Ciudad «global»: la comparten todas las piezas del tiempo de la página (componentes y overrides) ---
type CityBus = { city: string; place?: { name: string } | null; subs: Set<() => void> }
function cityBus(): CityBus {
    const g = globalThis as unknown as { __tiempoCiudad?: CityBus }
    if (!g.__tiempoCiudad) g.__tiempoCiudad = { city: "madrid", place: null, subs: new Set() }
    return g.__tiempoCiudad
}
function useGlobalCity(): [string, string | null] {
    const [city, setCity] = useState(() => cityBus().city)
    const [place, setPlace] = useState<string | null>(() => cityBus().place?.name ?? null)
    useEffect(() => {
        const bus = cityBus()
        const on = () => {
            setCity(bus.city)
            setPlace(bus.place?.name ?? null)
        }
        bus.subs.add(on)
        on()
        return () => {
            bus.subs.delete(on)
        }
    }, [])
    return [city, place]
}

// Partículas de viento en un lienzo (canvas): cientos de líneas con estela que viajan con el viento, como en Windy.
// Un solo dibujo que se repinta, así va fluido aunque haya muchas.
// field: 120 muestras de izquierda a derecha con { dir (de dónde viene, en grados), q (fuerza 0–1) }
function WindParticles({ field, color, opacity, density, animate }: { field: ({ dir: number; q: number } | null)[]; color: string; opacity: number; density: number; animate: boolean }) {
    const ref = useRef<HTMLCanvasElement>(null)
    const key = field.map((f) => (f ? `${Math.round(f.dir)}:${f.q.toFixed(2)}` : "-")).join(",")
    useEffect(() => {
        const cv = ref.current
        if (!cv) return
        const ctx = cv.getContext("2d")
        if (!ctx) return
        const [r, g, b] = hexRgb(color)
        let W = 0,
            H = 0,
            raf = 0
        let parts: { x: number; y: number; life: number }[] = []
        const sample = (x: number) => field[Math.min(field.length - 1, Math.max(0, Math.floor((x / Math.max(W, 1)) * field.length)))]
        const resize = () => {
            const dpr = Math.min(2, window.devicePixelRatio || 1)
            W = cv.clientWidth
            H = cv.clientHeight
            cv.width = Math.round(W * dpr)
            cv.height = Math.round(H * dpr)
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
            const n = Math.round(((W * H) / 260) * density)
            parts = Array.from({ length: n }, () => ({ x: Math.random() * W, y: Math.random() * H, life: Math.random() }))
        }
        // Un paso: cada partícula avanza un poco con el viento y pinta el trocito recorrido.
        // Lo pintado antes se va borrando poco a poco, así queda una estela (los «fideos» de Windy).
        const step = () => {
            ctx.globalCompositeOperation = "destination-out"
            ctx.fillStyle = "rgba(0,0,0,0.07)"
            ctx.fillRect(0, 0, W, H)
            ctx.globalCompositeOperation = "source-over"
            ctx.lineWidth = 1.1
            ctx.lineCap = "round"
            for (const p of parts) {
                const f = sample(p.x)
                if (!f) continue
                // un pelín de ondulación para que las líneas no sean rectas del todo
                const wob = Math.sin(p.y * 0.07 + p.x * 0.02) * 0.35
                const a = ((f.dir + 180) * Math.PI) / 180 + wob
                const sp = 0.35 + f.q * 1.4
                const nx = p.x + Math.sin(a) * sp,
                    ny = p.y - Math.cos(a) * sp
                p.life += 0.004 + f.q * 0.004
                const fade = Math.sin(Math.PI * Math.min(1, p.life))
                const al = opacity * (0.5 + 0.5 * f.q) * fade
                if (al > 0.02) {
                    ctx.strokeStyle = `rgba(${r},${g},${b},${al.toFixed(3)})`
                    ctx.beginPath()
                    ctx.moveTo(p.x, p.y)
                    ctx.lineTo(nx, ny)
                    ctx.stroke()
                }
                p.x = nx
                p.y = ny
                if (p.life > 1 || p.x < -4 || p.x > W + 4 || p.y < -4 || p.y > H + 4) {
                    p.x = Math.random() * W
                    p.y = Math.random() * H
                    p.life = 0
                }
            }
        }
        // Sin animación (o al empezar): se adelantan unos pasos para que ya se vean las estelas
        const draw = (_move: boolean) => {
            ctx.clearRect(0, 0, W, H)
            for (let k = 0; k < 45; k++) step()
        }
        resize()
        draw(false) // primer dibujo al momento, antes de que empiece a moverse
        const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => { resize(); draw(false) }) : null
        ro?.observe(cv)
        const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
        if (animate && !reduce) {
            const loop = () => {
                step()
                raf = requestAnimationFrame(loop)
            }
            raf = requestAnimationFrame(loop)
        } else draw(false)
        return () => {
            cancelAnimationFrame(raf)
            ro?.disconnect()
        }
    }, [key, color, opacity, density, animate])
    return <canvas ref={ref} aria-hidden style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }} />
}

export default function TiempoApp(props: AppProps) {
    const {
        baseUrl = "https://tmnnidlzmwxgpxufqkgm.supabase.co/storage/v1/object/public/weather",
        cityId: cityProp = "global",
        section = "todo",
        container = true,
        tile = false,
        textScale = 1.3,
        tempLine = false,
        tileSoft = 0.55,
        days = 7,
        colorAi = "#8f7bff",
        dynamicSky = false,
        background = "#f4f4f1",
        textColor = "#0b0b0b",
        mutedColor = "#6b6a65",
        radius = 28,
        shadow = "0 1px 2px rgba(11,11,11,0.04)",
        bgColor = "#f4f4f2",
        inkColor = "#141414",
        softColor = "#5f5f5a",
        fontFamily = "",
        padding = 22,
        palette = "vivo",
        showNow = true,
        showTempBand = true,
        showWindBand = true,
        showRainChart = true,
        showTempChart = true,
        tempColor1 = "#3b2bd1",
        tempColor2 = "#1fa2c9",
        tempColor3 = "#3fbf9a",
        tempColor4 = "#f6c341",
        tempColor5 = "#e2452f",
        windColor1 = "#dcebf8",
        windColor2 = "#a8d6ee",
        windColor3 = "#6aa8e8",
        windColor4 = "#4b55d6",
        cloudColor = "#ebeef5",
        feelsColor1 = "#3fbf8a",
        feelsColor2 = "#e6c84a",
        feelsColor3 = "#ef8a3a",
        feelsColor4 = "#e0405a",
        showFeelsBand = true,
        showAi = true,
        feelsBandHeight = 44,
        showClouds = true,
        showRain = true,
        showArrows = true,
        tempSize = 144,
        tempWeight = 200,
        bandHeight = 84,
        bandBlur = 0,
        cloudOpacity = 1,
        windBandHeight = 80,
        windMax = 60,
        arrowEvery = 2,
        arrowSize = 12,
        chartHeight = 160,
        chartBlur = 4,
        showChartWind = true,
        chartWindOpacity = 0.35,
        chartWindDensity = 1,
        rainColor1 = "#8f7bff",
        rainColor2 = "#4d6bff",
        rainColor3 = "#59e0c8",
        aurora = false,
        auroraStrength = 0.5,
        grain = false,
        animations = true,
        style,
    } = props
    const uid = useId().replace(/:/g, "")
    const [globalCity, globalPlace] = useGlobalCity()
    const cityId = cityProp === "global" ? globalCity : cityProp
    const placeName = cityProp === "global" ? globalPlace : null
    // Una sola sección (para colocar cada pieza por separado en el lienzo) o todas
    const only = section !== "todo"
    const sNow = only ? section === "ahora" : showNow
    const sTemp = only ? section === "temperatura" : showTempBand
    const sWind = only ? section === "viento" : showWindBand
    const sFeels = only ? section === "sensacion" : showFeelsBand
    const sRain = only ? section === "lluvia" : showRainChart
    const sCurve = only ? section === "curva" : showTempChart
    const sAi = only ? section === "acierto" : showAi
    const mt = (v: number) => (only ? 0 : v)
    // Tamaño de los textos pequeños (etiquetas, días, leyendas): «Tamaño textos» en el panel
    const fs = (n: number) => Math.round(n * textScale * 10) / 10
    // «Banda como tarjeta»: la pieza entera es el degradado (el fondo es la propia banda)
    const tileMode = tile && (section === "temperatura" || section === "viento" || section === "sensacion")
    const TILE_PAD = 18
    useEffect(() => {
        if (typeof window !== "undefined") ensureOutfitFont()
    }, [])

    const root = baseUrl.replace(/\/$/, "")
    const url = baseUrl ? `${root}/cities/${cityId}.json` : ""
    const observedUrl = baseUrl ? `${root}/observed.json` : ""
    const [data, setData] = useState<AppDoc | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [obs, setObs] = useState<Obs | null>(null)
    const [range, setRange] = useState<"day" | "week">("day")
    const [showModels, setShowModels] = useState(false)
    const [hover, setHover] = useState<number | null>(null)
    const [windHover, setWindHover] = useState<number | null>(null)
    const [feelsHover, setFeelsHover] = useState<number | null>(null)
    const [openAcierto, setOpenAcierto] = useState(false)
    const [cell, setCell] = useState<string | null>(null)
    // La temperatura grande «cuenta» hasta su valor (900 ms, frenando al final) cuando cambia.
    const [shownTemp, setShownTemp] = useState<number | null>(null)
    const animFrom = useRef<number | null>(null)
    const [chartRef, chartWidth] = useWidth()

    useEffect(() => {
        if (!url) return
        let alive = true
        startTransition(() => setError(null))
        load(url)
            .then((d) => alive && startTransition(() => setData(d as AppDoc)))
            .catch((e) => alive && startTransition(() => setError(String(e.message ?? e))))
        return () => {
            alive = false
        }
    }, [url])

    // Lo medido: AEMET si tiene menos de 3 h; si no, el METAR del aeropuerto si es más reciente.
    const icao = data?.city.metar ?? data?.accuracy?.station?.id ?? null
    useEffect(() => {
        if (!data || !observedUrl) return
        let alive = true
        const city = data.city
        const fromMetar = () =>
            icao ? loadMetar(icao).then((m) => (m ? metarToObs(m, city) : null)) : Promise.resolve(null)
        loadObserved(observedUrl)
            .then((doc) => {
                const o = doc?.cities?.[cityId] ?? null
                if (o && Date.now() - Date.parse(o.time) <= 3 * HOUR) return o
                return fromMetar()
                    .catch(() => null)
                    .then((m) => (m && (!o || Date.parse(m.time) > Date.parse(o.time)) ? m : o))
            })
            .catch(fromMetar)
            .then((o) => alive && startTransition(() => setObs(o)))
            .catch(() => undefined)
        return () => {
            alive = false
        }
    }, [data, icao, cityId, observedUrl])

    const view = useMemo(() => {
        if (!data || !data.models.length) return null
        const tz = data.city.tz
        const fmt = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("es-ES", { timeZone: tz, ...o })
        const dayKey = new Intl.DateTimeFormat("en-CA", { timeZone: tz })
        const hourOf = (t: number) => Number(fmt({ hour: "numeric", hourCycle: "h23" }).format(new Date(t)))
        const now = Date.now()

        const mean = average(data.models)
        // La IA, cada 3 h (hasta donde aprobó), con su rango del 10 al 90 %.
        const ai = (data.ml?.times ?? [])
            .map((tt, i) => ({ t: Date.parse(tt), v: data.ml!.temp[i], lo: data.ml!.p10[i], hi: data.ml!.p90[i] }))
            .filter((p) => p.v != null)
        const aiStart = ai.length ? ai[0].t : Infinity
        const aiEnd = ai.length ? ai[ai.length - 1].t : -Infinity
        // La línea principal: la IA donde la hay; antes y después, la media de los modelos.
        const line: Pt[] = [
            ...mean.filter((s) => s.t < aiStart).map((s) => ({ t: s.t, v: s.temp, ai: false })),
            ...ai.map((p) => ({ ...p, ai: true })),
            ...mean.filter((s) => s.t > aiEnd).map((s) => ({ t: s.t, v: s.temp, ai: false })),
        ]
        const nearest = <T extends { t: number }>(xs: T[], t: number) =>
            xs.length ? xs.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a)) : null
        const cur = nearest(mean, now)!
        const curLine = nearest(line, now)!

        // --- Días ---
        const byDay = new Map<string, Step[]>()
        const todayKey = dayKey.format(new Date(now))
        for (const s of mean) {
            const k = dayKey.format(new Date(s.t))
            if (k < todayKey) continue
            if (!byDay.has(k)) byDay.set(k, [])
            byDay.get(k)!.push(s)
        }
        const allSteps = data.models.map(stepsOf)
        const daily = [...byDay.entries()].slice(0, days).map(([key, list], i) => {
            const aiDay = ai.filter((p) => dayKey.format(new Date(p.t)) === key)
            const hasAi = aiDay.length >= 3
            const min = hasAi ? Math.min(...aiDay.map((p) => p.v)) : Math.min(...list.map((s) => s.temp))
            const max = hasAi ? Math.max(...aiDay.map((p) => p.v)) : Math.max(...list.map((s) => s.temp))
            // Lluvia: la de la IA para ese día (de 9:00 a 9:00); si no, qué parte de los modelos da ≥ 1 mm.
            const ri = data.ml_rain?.days.indexOf(key) ?? -1
            const first = list[0].t,
                last = list[list.length - 1].t
            const totals = allSteps.flatMap((ms) => {
                if (!ms.length || ms[ms.length - 1].t < last - 3 * HOUR) return []
                const inDay = ms.filter((s) => s.t > first && s.t <= last)
                return inDay.length ? [inDay.reduce((a, s) => a + s.rain, 0)] : []
            })
            const modProb = totals.length ? totals.filter((v) => v >= WET_MM).length / totals.length : null
            const rainProb = ri >= 0 ? data.ml_rain!.prob[ri] : modProb
            const rainMm =
                ri >= 0 ? data.ml_rain!.mm[ri] : totals.length ? totals.reduce((a, b) => a + b, 0) / totals.length : 0
            // Confianza: lo ancho que es el rango de la IA (o lo que discrepan los modelos).
            let conf: number | null = null
            if (hasAi) {
                const w = aiDay.reduce((a, p) => a + (p.hi - p.lo), 0) / aiDay.length
                conf = w <= 3.5 ? 0 : w <= 5.5 ? 1 : 2
            } else {
                const maxes = allSteps.flatMap((ms) => {
                    const inDay = ms.filter((s) => s.t >= first && s.t <= last)
                    return inDay.length ? [Math.max(...inDay.map((s) => s.temp))] : []
                })
                const c = confidence(maxes, totals.filter((v) => v >= WET_MM).length)
                conf = c ? c.level : null
            }
            const daytime = list.filter((s) => hourOf(s.t) >= 9 && hourOf(s.t) <= 18)
            const ref = daytime.length ? daytime : list
            const clouds = ref.flatMap((s) => (s.cloud == null ? [] : [s.cloud]))
            const cloud = clouds.length ? clouds.reduce((a, b) => a + b, 0) / clouds.length : null
            const kind = kindOf(
                (rainProb ?? 0) >= 0.5 ? (rainMm >= 5 ? 2 : 0.3) : 0,
                cloud,
                false
            )
            return {
                key,
                label: i === 0 ? "Hoy" : fmt({ weekday: "short", day: "numeric" }).format(new Date(list[0].t)),
                long: i === 0 ? "hoy" : i === 1 ? "mañana" : fmt({ weekday: "long" }).format(new Date(list[0].t)),
                min: Math.round(min),
                max: Math.round(max),
                hasAi,
                rainProb,
                rainMm,
                rainFromAi: ri >= 0,
                conf,
                kind,
            }
        })

        // Mapa de calor de la semana: cada día, 8 tramos de 3 h (hora local) con la temperatura
        // (la de la IA donde la hay) y la lluvia de ese tramo.
        const meanByT = new Map(mean.map((s) => [s.t, s]))
        const offsetH = hourOf(Math.ceil(now / (3 * HOUR)) * 3 * HOUR) % 3
        const cells = daily.map((d) => {
            const row: ({ t: number; v: number; ai: boolean; rain: number; cloud: N; past: boolean } | null)[] = Array(8).fill(null)
            for (const p of line) {
                if (p.t % (3 * HOUR) !== 0 || dayKey.format(new Date(p.t)) !== d.key) continue
                const m = meanByT.get(p.t)
                row[Math.floor(hourOf(p.t) / 3)] = { t: p.t, v: p.v, ai: p.ai, rain: m?.rain ?? 0, cloud: m?.cloud ?? null, past: p.t < now - 90 * 60_000 }
            }
            return row
        })
        const slotHours = Array.from({ length: 8 }, (_, i) => i * 3 + offsetH)

        // La frase de arriba: cuándo llueve.
        const wetNow = cur.rain >= 0.3
        const firstWet = daily.findIndex((d) => (d.rainProb ?? 0) >= 0.5)
        const frase = wetNow
            ? "Está lloviendo ahora"
            : firstWet === 0
              ? `Probable lluvia hoy (${Math.round(daily[0].rainProb! * 100)} %)`
              : firstWet > 0
                ? `Sin lluvia hasta el ${daily[firstWet].long}`
                : `Sin lluvia en los próximos ${daily.length} días`

        // --- Rango de las gráficas ---
        const start = Math.floor((now - 3 * HOUR) / HOUR) * HOUR
        let end = range === "day" ? start + 27 * HOUR : start + days * 24 * HOUR
        if (range === "week") while (hourOf(end) !== 0) end += HOUR
        const inWin = (t: number) => t >= start && t <= end
        const ticks: { t: number; label: string; strong: boolean }[] = []
        for (let t = start + HOUR; t < end; t += HOUR) {
            const h = hourOf(t)
            if (range === "day" && h % 3 === 0)
                ticks.push({ t, label: h === 0 ? fmt({ weekday: "short" }).format(new Date(t + HOUR)) : `${h} h`, strong: h === 0 })
            if (range === "week" && h === 0)
                ticks.push({ t, label: fmt({ weekday: "short", day: "numeric" }).format(new Date(t + HOUR)), strong: true })
        }
        const models = MODELS.flatMap(([id, short]) => {
            const m = data.models.find((x) => x.id === id)
            if (!m) return []
            const pts = stepsOf(m).filter((s) => inWin(s.t))
            return pts.length ? [{ id, short, pts }] : []
        })

        // Máxima y mínima de cada día que se ve en la gráfica (de la línea principal, hora local).
        const byChartDay = new Map<string, Pt[]>()
        for (const p of line.filter((p) => inWin(p.t))) {
            const k = dayKey.format(new Date(p.t))
            if (!byChartDay.has(k)) byChartDay.set(k, [])
            byChartDay.get(k)!.push(p)
        }
        const extremes = [...byChartDay.values()]
            .filter((l) => l.length >= 3)
            .map((l) => ({
                max: l.reduce((a, b) => (b.v > a.v ? b : a)),
                min: l.reduce((a, b) => (b.v < a.v ? b : a)),
            }))

        return {
            cells,
            slotHours,
            extremes,
            name: data.city.name,
            attribution: data.attribution,
            nowTemp: curLine.v,
            nowKind: kindOf(cur.rain, cur.cloud, isNight(hourOf(now))),
            hour: hourOf(now),
            wind: cur.wind,
            windDir: cur.windDir,
            frase,
            daily,
            start,
            end,
            now,
            ticks,
            line: line.filter((p) => inWin(p.t)),
            lineAll: line,
            meanAll: mean,
            mean: mean.filter((s) => inWin(s.t)),
            models,
            aiTrained: data.ml?.trained ?? null,
            fmtTime: fmt({ weekday: "long", hour: "2-digit", minute: "2-digit" }),
            fmtHour: fmt({ hour: "2-digit", minute: "2-digit" }),
            rainDays: (data.ml_rain?.days ?? []).map((d, i) => ({
                from: Date.parse(`${d}T07:00:00Z`),
                prob: data.ml_rain!.prob[i],
                mm: data.ml_rain!.mm[i],
            })),
        }
    }, [data, days, range])

    const targetTemp = (() => {
        if (!view) return null
        const age = obs ? Date.now() - Date.parse(obs.time) : Infinity
        return obs?.temp != null && age <= 3 * HOUR ? obs.temp : view.nowTemp
    })()
    useEffect(() => {
        if (targetTemp == null) return
        const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
        const from = animFrom.current ?? targetTemp - 12
        animFrom.current = targetTemp
        if (reduce || typeof requestAnimationFrame === "undefined") {
            setShownTemp(targetTemp)
            return
        }
        // La animación la hace <CountUp>, sin volver a pintar todo el componente en cada fotograma
        void from
        setShownTemp(targetTemp)
    }, [targetTemp])

    const box: CSSProperties = {
        width: "100%",
        minWidth: 0,
        boxSizing: "border-box",
        padding: 16,
        borderRadius: radius,
        background,
        color: textColor,
        display: "grid",
        gridTemplateColumns: "repeat(6, minmax(0, 1fr))",
        gap: 10,
        boxShadow: shadow,
        overflow: "hidden",
        fontFamily: OUTFIT_STACK,
        ...style,
    }
    const muted: CSSProperties = { color: mutedColor, fontSize: 12 }
    const card: CSSProperties = {
        borderRadius: Math.max(radius - 8, 12),
        background: "#fcfcfb",
        border: "none",
        padding: "14px 14px 10px",
    }
    const title: CSSProperties = {
        ...muted,
        fontFamily: MONO_STACK,
        fontSize: 10.5,
        fontWeight: 500,
        letterSpacing: "0.14em",
        textTransform: "uppercase",
    }
    // Bento: todas las cajas iguales (misma forma, mismo fondo, que sigue al cielo de ahora).
    const oldTileBg = view ? POSTER[view.nowKind].tint : "#fcfcfb"
    const tileBox: CSSProperties = { ...card, background: oldTileBg, borderRadius: Math.max(radius - 6, 14) }
    const pill = (on: boolean): CSSProperties => ({
        fontFamily: OUTFIT_STACK,
        border: "none",
        borderRadius: 999,
        padding: "4px 11px",
        fontSize: 11,
        fontWeight: 600,
        cursor: "pointer",
        background: on ? "#fff" : "transparent",
        color: on ? textColor : mutedColor,
        boxShadow: on ? "0 1px 3px rgba(15,23,42,0.15)" : "none",
    })

    if (!baseUrl) return <div style={{ ...box, display: "block" }}>Pon la URL del cubo de Supabase en el panel de la derecha.</div>
    if (error) return <div style={{ ...box, display: "block" }}>No se pudo cargar el pronóstico ({error}).</div>
    if (!view) return <div style={{ ...box, display: "block" }}><span style={muted}>Cargando…</span></div>

    // --- Ahora: lo medido si es reciente; si no, la previsión ---
    const obsAge = obs ? Date.now() - Date.parse(obs.time) : Infinity
    const useObs = obs?.temp != null && obsAge <= 3 * HOUR
    const nowTemp = useObs ? obs!.temp! : view.nowTemp
    const nowSource = useObs
        ? `Medido en ${obs!.source === "AEMET" ? "AEMET" : "el aeropuerto"} ${obs!.station} · ${ago(obsAge)}`
        : "Previsión de la IA para esta hora"
    const today = view.daily[0]
    const heroText = dynamicSky ? "#fff" : textColor
    const heroMuted = dynamicSky ? "rgba(255,255,255,0.8)" : mutedColor
    const windNow = useObs && obs!.wind != null ? obs!.wind : view.wind
    const dirNow = useObs && obs!.windDir != null ? obs!.windDir : view.windDir

    // --- Escala horizontal común a las dos gráficas ---
    const w = Math.max(chartWidth, 260)
    const ml = 30,
        mr = 8
    const x = (t: number) => ml + ((t - view.start) / (view.end - view.start)) * (w - ml - mr)
    const nowX = x(view.now)
    const onMove = (e: PointerEvent<SVGRectElement>) => {
        const r = e.currentTarget.getBoundingClientRect()
        const t = view.start + ((e.clientX - r.left) / r.width) * (view.end - view.start)
        startTransition(() => setHover(t))
    }
    const narrow = w < 420
    const nearestPt = <T extends { t: number }>(xs: T[], t: number) =>
        xs.length ? xs.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a)) : null

    // --- Gráfica de temperatura ---
    const TH = 200,
        TT = 34,
        TB = 26
    const temps = [
        ...view.line.flatMap((p) => [p.v, p.lo ?? p.v, p.hi ?? p.v]),
        ...(showModels ? view.models.flatMap((m) => m.pts.map((s) => s.temp)) : []),
    ]
    const tlo = Math.min(...temps),
        thi = Math.max(...temps)
    const tstep = thi - tlo <= 8 ? 2 : thi - tlo <= 20 ? 5 : 10
    const yMin = Math.floor((tlo - 0.5) / tstep) * tstep
    const yMax = Math.max(Math.ceil((thi + 0.5) / tstep) * tstep, yMin + tstep)
    const y = (v: number) => TT + ((yMax - v) / (yMax - yMin)) * (TH - TT - TB)
    const yTicks: number[] = []
    for (let v = yMin; v <= yMax; v += tstep) yTicks.push(v)
    // Columnas: un punto cada 3 h (los de la IA y, fuera de su alcance, los de la media de los modelos).
    const cols = view.line.filter((p) => p.t % (3 * HOUR) === 0 && p.t >= view.start && p.t <= view.end)
    const colGap = cols.length > 1 ? (w - ml - mr) / cols.length : 20
    const cw = Math.max(3, Math.min(colGap * 0.42, 14))
    const labelAll = range === "day"
    const band = view.line.filter((p) => p.ai && p.lo != null)
    const bandPath =
        band.length > 1
            ? `${smoothPath(band.map((p) => [x(p.t), y(p.hi!)] as [number, number]))}L${[...band]
                  .reverse()
                  .map((p) => `${x(p.t).toFixed(1)},${y(p.lo!).toFixed(1)}`)
                  .join("L")}Z`
            : ""
    const hot = hover == null ? null : nearestPt(cols, hover)
    const hotModels =
        hot && showModels
            ? view.models
                  .flatMap((m) => {
                      const p = nearestPt(m.pts, hot.t)
                      return p && Math.abs(p.t - hot.t) <= 90 * 60_000 ? [{ id: m.id, short: m.short, v: p.temp }] : []
                  })
                  .sort((a, b) => b.v - a.v)
            : []
    const hotMean = hot ? nearestPt(view.mean, hot.t) : null
    // Viento: una flecha cada 3 h (24 h) o cada 12 h (7 días), con su velocidad.
    const windEvery = range === "day" ? 3 : 12
    const windMarks = view.mean.filter(
        (s) => s.windDir != null && s.wind != null && s.t > view.start && Math.round(s.t / HOUR) % windEvery === 0
    )



    // --- ¿Me puedo fiar? ---
    const ac = data!.acierto
    const rows = (ac?.days ?? []).slice(-7).map((d) => {
        const o = d.obs
        const rained = o?.mm != null ? o.mm >= WET_MM : null
        return {
            ...d,
            rained,
            rainHit: d.rain && rained != null ? d.rain.prob >= 0.5 === rained : null,
            err: d.temp && o?.tmax != null ? d.temp.max - o.tmax : null,
        }
    })
    const checked = rows.filter((r) => r.rainHit != null)
    const hits = checked.filter((r) => r.rainHit).length
    const errs = rows.flatMap((r) => (r.err == null ? [] : [Math.abs(r.err)]))
    const mae = errs.length ? errs.reduce((a, b) => a + b, 0) / errs.length : null
    const fmtDay = new Intl.DateTimeFormat("es-ES", { timeZone: "UTC", weekday: "short", day: "numeric" })

    const Tooltip = ({ at, children }: { at: number; children?: any }) => (
        <div
            style={{
                position: "absolute",
                top: 0,
                zIndex: 2,
                ...(x(at) > w / 2 ? { right: w - x(at) + 12 } : { left: x(at) + 12 }),
                background: "rgba(15,23,42,0.92)",
                color: "#f8fafc",
                borderRadius: 12,
                padding: "8px 10px",
                fontSize: 12,
                pointerEvents: "none",
                whiteSpace: "nowrap",
                boxShadow: "0 12px 30px rgba(15,23,42,0.25)",
            }}
        >
            {children}
        </div>
    )
    const axis = (H: number, B: number) => (
        <>
            {view.ticks.map((k) => (
                <g key={k.t}>
                    {k.strong && <line x1={x(k.t)} x2={x(k.t)} y1={4} y2={H - B + 2} stroke="rgba(15,23,42,0.07)" />}
                    <text
                        x={x(k.t)}
                        y={H - 8}
                        textAnchor="middle"
                        fontSize={10.5}
                        fontWeight={k.strong ? 600 : 500}
                        fill={mutedColor}
                        style={{ textTransform: k.strong ? "capitalize" : "none" }}
                    >
                        {k.label}
                    </text>
                </g>
            ))}
            {view.now >= view.start && view.now <= view.end && (
                <line x1={nowX} x2={nowX} y1={4} y2={H - B} stroke={INK2} strokeOpacity={0.6} strokeWidth={1} strokeDasharray="2 3" />
            )}
        </>
    )

    const css = `
        @keyframes ta-rise-${uid} { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
        @keyframes ta-pop-${uid} { from { opacity: 0; transform: scale(.82); } to { opacity: 1; transform: none; } }
        @keyframes ta-grow-${uid} { from { transform: scaleY(0); opacity: 0; } to { transform: scaleY(1); opacity: 1; } }
        @keyframes ta-aura-${uid} { 0% { transform: translate(-6%, -4%) scale(1); } 50% { transform: translate(6%, 5%) scale(1.12); } 100% { transform: translate(-6%, -4%) scale(1); } }
        .ta-card-${uid} { animation: ta-rise-${uid} .6s cubic-bezier(.2,.8,.2,1) both; }
        .ta-cell-${uid} { animation: ta-pop-${uid} .45s cubic-bezier(.2,.9,.3,1.2) both; transition: transform .18s cubic-bezier(.2,.8,.2,1), box-shadow .18s; }
        .ta-cell-${uid}:hover { transform: scale(1.12); box-shadow: 0 6px 16px rgba(11,11,11,.18); z-index: 2; position: relative; }
        .ta-col-${uid} { transform-box: fill-box; transform-origin: center; animation: ta-grow-${uid} .7s cubic-bezier(.2,.8,.2,1) both; }
        .ta-dot-${uid} { animation: ta-pop-${uid} .5s cubic-bezier(.2,.9,.3,1.3) both; transform-box: fill-box; transform-origin: center; }
        .ta-aura-${uid} { animation: ta-aura-${uid} 16s ease-in-out infinite; }
        .ta-btn-${uid} { transition: background .2s, color .2s, transform .15s; }
        .ta-btn-${uid}:active { transform: scale(.96); }
        @media (prefers-reduced-motion: reduce) {
            .ta-card-${uid}, .ta-cell-${uid}, .ta-col-${uid}, .ta-dot-${uid}, .ta-aura-${uid} { animation: none !important; }
            .ta-cell-${uid}:hover { transform: none; }
        }
        @keyframes ta-shape-${uid} { from { transform: scale(.6); opacity: 0; } to { transform: none; opacity: 1; } }
        @keyframes ta-drop-${uid} { 0%,100% { transform: translateY(0); } 50% { transform: translateY(4px); } }
        .ta-shape-${uid} { animation: ta-shape-${uid} 1.1s cubic-bezier(.2,.8,.2,1) both; }
        .ta-drop-${uid} { animation: ta-drop-${uid} 2.4s ease-in-out infinite; }
        @keyframes ta-draw-${uid} { from { stroke-dashoffset: 1; } to { stroke-dashoffset: 0; } }
        @keyframes ta-fade-${uid} { from { opacity: 0; } to { opacity: 1; } }
        .ta-line-${uid} { stroke-dasharray: 1; animation: ta-draw-${uid} 1.2s cubic-bezier(.4,0,.2,1) .15s both; }
        .ta-area-${uid} { animation: ta-fade-${uid} 1s ease .5s both; }
        .ta-bento-${uid} > * { grid-column: span 6; min-width: 0; }
        .ta-bento-${uid} > .ta-sm-${uid} { grid-column: span 2; }
        .ta-row-${uid} { animation: ta-rise-${uid} .5s cubic-bezier(.2,.8,.2,1) both; }
        @media (prefers-reduced-motion: reduce) {
            .ta-shape-${uid}, .ta-drop-${uid}, .ta-row-${uid}, .ta-line-${uid}, .ta-area-${uid} { animation: none !important; stroke-dasharray: none; }
        }
    `
    const anim = `${cityId}-${range}`
    const shown = shownTemp ?? nowTemp
    const poster = POSTER[view.nowKind]
    const monoLabel: CSSProperties = { fontFamily: MONO_STACK, fontSize: 11, fontWeight: 500, letterSpacing: "0.14em", textTransform: "uppercase" }
    const dateLine = new Intl.DateTimeFormat("es-ES", { timeZone: data!.city.tz, weekday: "short", day: "numeric", month: "short" })
        .format(new Date(view.now))
        .replace(/\./g, "")
    // Las próximas 24 h, cada 3 h: temperatura (IA), cielo y cuántos modelos ven lluvia.
    const hours = cols
        .filter((p) => p.t >= view.now - 90 * 60_000)
        .slice(0, 9)
        .map((p) => {
            const m = nearestPt(view.mean, p.t)
            const wet = view.models.filter((md) => md.pts.filter((s) => s.t > p.t - 3 * HOUR && s.t <= p.t).reduce((a, s) => a + s.rain, 0) >= 0.2)
            const hh = new Date(p.t)
            return {
                t: p.t,
                v: p.v,
                label: view.fmtHour.format(hh),
                kind: m ? kindOf(m.rain, m.cloud, isNight(Number(view.fmtHour.format(hh).slice(0, 2)))) : ("unknown" as Kind),
                prob: view.models.length ? wet.length / view.models.length : 0,
            }
        })
    const hourLo = Math.round(Math.min(...hours.map((h) => h.v)))
    const hourHi = Math.round(Math.max(...hours.map((h) => h.v)))
    // La curva: cada punto en el centro de su columna; arriba deja sitio para la etiqueta.
    const HW = Math.max(chartWidth, 240),
        HC = narrow ? 86 : 104
    const hourPts = hours.map(
        (h, i) =>
            [((i + 0.5) / hours.length) * HW, 26 + (1 - (h.v - hourLo) / Math.max(hourHi - hourLo, 1)) * (HC - 38)] as [number, number]
    )
    // Un mismo diseño para todas las tarjetas: cabecera, textos pequeños y nota al pie.
    const sectionHead: CSSProperties = { display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, flexWrap: "wrap", marginBottom: 12 }
    const metaText: CSSProperties = { fontFamily: MONO_STACK, fontSize: 9.5, letterSpacing: "0.06em", color: mutedColor }
    const footNote: CSSProperties = { fontFamily: MONO_STACK, fontSize: 9.5, letterSpacing: "0.02em", color: mutedColor, marginTop: 10, paddingTop: 8, borderTop: "1px solid rgba(11,11,11,0.07)", lineHeight: 1.5 }

    // --- La tabla: cada día una fila de 24 cuadrados (uno por hora), solo color ---
    const tz = data!.city.tz
    const hourFmt = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "numeric", hourCycle: "h23" })
    const localHour = (t: number) => Number(hourFmt.format(new Date(t)))
    const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz })
    const lineAll = view.lineAll
    const meanAll = view.meanAll
    // Temperatura a cualquier hora: entre dos puntos conocidos, la recta que los une.
    const tempAt = (t: number): number | null => {
        let j = lineAll.findIndex((p) => p.t >= t)
        if (j < 0) return null
        if (lineAll[j].t === t || j === 0) return lineAll[j].t - t <= 3 * HOUR ? lineAll[j].v : null
        const a = lineAll[j - 1],
            b = lineAll[j]
        return a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t)
    }
    const nearestMean = (t: number) => {
        const p = nearestPt(meanAll, t)
        return p && Math.abs(p.t - t) <= 3 * HOUR ? p : null
    }
    // Lluvia de esa hora: la del tramo de 3 h que la contiene, repartida.
    const rainAt = (t: number) => {
        const end = Math.ceil(t / (3 * HOUR)) * 3 * HOUR
        const p = meanAll.find((s) => s.t === end)
        return p ? p.rain / 3 : 0
    }
    const grid = view.daily.map((d) => {
        const guess = Date.parse(`${d.key}T00:00:00Z`)
        const h0 = localHour(guess)
        const midnight = h0 < 12 ? guess - h0 * HOUR : guess + (24 - h0) * HOUR
        // Cada hora, en su casilla según la hora local (los días de cambio de hora tienen 23 o 25).
        const row: ({ t: number; h: number; v: number; cloud: N; lo: N; mi: N; hi: N; rain: number; past: boolean; night: boolean } | null)[] = Array(24).fill(null)
        const seen = Array(24).fill(false)
        for (let k = 0; k < 26; k++) {
            const t = midnight + k * HOUR
            if (dayFmt.format(new Date(t)) !== d.key) continue
            const h = localHour(t)
            if (seen[h]) continue
            seen[h] = true
            const v = tempAt(t)
            if (v == null) continue
            const m = nearestMean(t)
            row[h] = { t, h, v, cloud: m?.cloud ?? null, lo: m?.cloudLow ?? null, mi: m?.cloudMid ?? null, hi: m?.cloudHigh ?? null, rain: rainAt(t), past: t < view.now - 30 * 60_000, night: isNight(h) }
        }
        return row
    })
    const nowCloud = nearestMean(view.now)?.cloud ?? null
    const nowRain = useObs && obs!.rain1h != null ? obs!.rain1h! : rainAt(view.now)
    const nowHum = useObs && obs!.hum != null ? obs!.hum! : null
    const sel = cell ? (() => {
        const [i, h] = cell.split("-").map(Number)
        const c = grid[i]?.[h]
        return c ? { c, d: view.daily[i] } : null
    })() : null

    const fx = `
        @keyframes tg-in-${uid} { from { opacity: 0; transform: scale(.4); } to { opacity: 1; transform: none; } }
        @keyframes tg-rain-${uid} { from { background-position: 0 0; } to { background-position: -11px 24px; } }
        @keyframes tg-f0-${uid} { from { transform: translate(-8%, -6%) scale(1); } to { transform: translate(20%, 16%) scale(1.25); } }
        @keyframes tg-f1-${uid} { from { transform: translate(10%, 8%) scale(1.1); } to { transform: translate(-18%, -14%) scale(.9); } }
        @keyframes tg-up-${uid} { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
        .tg-sq-${uid} { animation: tg-in-${uid} .5s cubic-bezier(.2,.9,.3,1.2) both; transition: transform .2s; }
        .tg-sq-${uid}:hover, .tg-rain-${uid}:hover { filter: brightness(1.12); }
        .tg-rain-${uid} { animation: tg-in-${uid} .5s cubic-bezier(.2,.9,.3,1.2) both, tg-rain-${uid} 1.2s linear infinite; }
        .tg-up-${uid} { animation: tg-up-${uid} .7s cubic-bezier(.2,.8,.2,1) both; }
        @media (prefers-reduced-motion: reduce) {
            .tg-sq-${uid}, .tg-rain-${uid}, .tg-up-${uid} { animation: none !important; }
        }
    `
    // --- Estilo: noche de datos. Fondo casi negro, una aurora con los colores de hoy y una matriz de puntos ---
    // Etiquetas de color legibles: sobre fondo claro se oscurecen, sobre oscuro se aclaran
    const lightBg = hexRgb(bgColor).reduce((a, v) => a + v, 0) / 3 > 150
    const tone = (c: string) => (paleTile ? mix(c, inkColor, 0.55) : tileMode ? "#ffffff" : lightBg ? mix(c, inkColor, 0.45) : mix(c, "#ffffff", 0.22))
    // En la tarjeta de temperatura el degradado es pálido (sutil) y el texto oscuro; en las otras, blanco
    const paleTile = tileMode && section === "temperatura"
    const ink = tileMode && !paleTile ? "#ffffff" : inkColor,
        soft = tileMode && !paleTile ? "rgba(255,255,255,0.85)" : softColor,
        faint = mix(bgColor, inkColor, 0.14)
    const rainTxt = paleTile || (lightBg && !tileMode) ? "#2f5fd0" : "#9cc0ff"
    // Paleta de la temperatura: «vivo», «clásico» (azul-blanco-rojo) o «mono» (un solo tono)
    const ownTemp: [number, string][] = [
        [-5, tempColor1],
        [5, tempColor2],
        [15, tempColor3],
        [25, tempColor4],
        [35, tempColor5],
    ]
    const tcol = (t: number) =>
        palette === "propia"
            ? scaleColor(ownTemp, t)
            : palette === "clasico"
              ? heat(t)
              : palette === "mono"
                ? mix(mix(bgColor, inkColor, 0.18), inkColor, Math.max(0, Math.min(1, (t + 5) / 40)))
                : vivid(t)
    const tMin = today ? today.min : nowTemp - 5,
        tMax = today ? today.max : nowTemp + 5
    const auroraCols = [tcol(tMin), tcol(nowTemp), tcol(tMax)]
    const stat = (k: string, v: string, u: string) => (
        <div style={{ minWidth: 0 }}>
            <div style={{ fontFamily: MONO_STACK, fontSize: fs(8.5), letterSpacing: "0.06em", textTransform: "uppercase", color: soft }}>{k}</div>
            <div style={{ fontSize: narrow ? 17 : 20, fontWeight: 300, letterSpacing: "-0.02em", marginTop: 4, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
                {v}
                <span style={{ fontFamily: MONO_STACK, fontSize: fs(9), color: soft, marginLeft: 4, letterSpacing: 0 }}>{u}</span>
            </div>
        </div>
    )
    // --- La banda de temperatura: cada hora desde ahora hasta el final de la semana ---
    const bandPts = grid.flat().filter((c): c is NonNullable<typeof c> => c != null && c.t >= view.now - HOUR)
    const bT0 = bandPts.length ? bandPts[0].t : 0,
        bT1 = bandPts.length ? bandPts[bandPts.length - 1].t : 1
    const bx = (t: number) => ((t - bT0) / Math.max(bT1 - bT0, 1)) * 100
    const bMin = Math.round(Math.min(...bandPts.map((p) => p.v))),
        bMax = Math.round(Math.max(...bandPts.map((p) => p.v)))
    // Degradado suave: un color cada 2 h, sin cortes
    const bandGrad = `linear-gradient(90deg, ${bandPts
        .filter((_, k, arr) => k % 2 === 0 || k === arr.length - 1)
        .map((p) => `${p.night ? mix(tcol(p.v), bgColor, 0.18) : tcol(p.v)} ${bx(p.t).toFixed(2)}%`)
        .join(", ")})`
    const BAND_H = Math.round(bandHeight * (narrow ? 0.78 : 1)),
        CLOUD_H = narrow ? 6 : 8,
        CLOUD_GAP = narrow ? 4 : 5,
        BAND_TOP = showClouds ? 3 * ((narrow ? 6 : 8) + (narrow ? 4 : 5)) + 10 : 8,
        CLOUD_W = narrow ? 44 : 62
    // El cielo cada 3 h: nubes (media) y lluvia (suma) para dibujar encima de la banda
    const bandSky = bandPts
        .filter((p) => p.t % (3 * HOUR) === 0)
        .map((p, k) => {
            const win = bandPts.filter((q) => Math.abs(q.t - p.t) <= HOUR)
            const clouds = win.flatMap((q) => (q.cloud == null ? [] : [q.cloud]))
            const rain = win.reduce((a, q) => a + q.rain, 0)
            const avg = (f: (q: (typeof win)[number]) => N) => {
                const xs = win.flatMap((q) => (f(q) == null ? [] : [f(q)!]))
                return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null
            }
            const cloud = clouds.length ? clouds.reduce((a, b) => a + b, 0) / clouds.length : 0
            const lo = avg((q) => q.lo),
                mi = avg((q) => q.mi),
                hi = avg((q) => q.hi)
            // Sin pisos (modelos que solo dan el total): todo el total como nube media
            const layered = lo != null || mi != null || hi != null
            return { t: p.t, k, cloud, lo: layered ? lo ?? 0 : 0, mi: layered ? mi ?? 0 : cloud, hi: layered ? hi ?? 0 : 0, rain, k2: Math.min(1, Math.log1p(rain) / Math.log1p(6)) }
        })
    const bandDays = view.daily
        .map((d, i) => {
            const first = grid[i].find((c) => c != null && c.t >= bT0)
            return first ? { i, t: first.t, max: d.max, min: d.min, mm: d.rainMm ?? 0, label: i === 0 ? "Hoy" : d.label.slice(0, 3).replace(".", "") } : null
        })
        .filter((d): d is NonNullable<typeof d> => d != null)
    // --- La banda del viento: fuerza (color) y dirección (flechas), cada hora ---
    const windPts = bandPts.flatMap((p) => {
        const m = nearestMean(p.t)
        return m && m.wind != null ? [{ t: p.t, v: m.wind, dir: m.windDir }] : []
    })
    // El color del viento se reparte entre 0 y la escala elegida («Viento máx.»)
    const ownWind: [number, string][] = [
        [0, windColor1],
        [windMax / 3, windColor2],
        [(windMax * 2) / 3, windColor3],
        [windMax, windColor4],
    ]
    const wcol = (v: number) => scaleColor(ownWind, v)
    const arrowInk = tileMode && section !== "temperatura" ? "rgba(255,255,255,0.95)" : "rgba(20,32,60,0.6)"
    const windGrad = `linear-gradient(90deg, ${windPts
        .filter((_, k, arr) => k % 2 === 0 || k === arr.length - 1)
        .map((p) => `${wcol(p.v)} ${bx(p.t).toFixed(2)}%`)
        .join(", ")})`
    const WBAND_H = Math.round(windBandHeight * (narrow ? 0.78 : 1))
    // Un campo de flechas que llena la banda: columnas repartidas por todo el ancho y varias filas
    const arrowRows = Math.max(1, Math.floor((WBAND_H - 8) / (arrowSize * 2.1)))
    const arrowCols = Math.max(8, Math.round((narrow ? 330 : 520) / (arrowSize * 2.6)))
    const windArrows =
        windPts.length > 1
            ? Array.from({ length: arrowRows * arrowCols }, (_, n) => {
                  const r = Math.floor(n / arrowCols),
                      c = n % arrowCols
                  // filas alternas desplazadas medio hueco, como un tejido
                  // un poco de azar fijo (siempre el mismo) para que parezcan partículas y no una rejilla
                  const rx = Math.abs(Math.sin(n * 12.9898) * 43758.5453) % 1,
                      ry = Math.abs(Math.sin(n * 78.233) * 12345.678) % 1
                  const x = Math.min(99, Math.max(1, ((c + 0.3 + rx * 0.45) / arrowCols) * 100))
                  const p = nearestPt(windPts, bT0 + (x / 100) * (bT1 - bT0))!
                  return p.dir == null ? null : { n, x, y: ((r + 0.3 + ry * 0.4) / arrowRows) * 100, v: p.v, dir: p.dir }
              }).filter((a): a is { n: number; x: number; y: number; v: number; dir: number } => a != null)
            : []
    // --- Sensación térmica: con frío y viento, el viento enfría (wind chill); con calor y humedad, la humedad
    //     calienta (índice de calor de la NOAA). Si no hay humedad prevista, solo el viento. ---
    const feelsPts = bandPts.map((p) => {
        const m = nearestMean(p.t)
        const w = m?.wind ?? null
        const hum = m?.hum ?? null
        let f = p.v
        if (p.v <= 10 && w != null && w > 4.8) {
            const k = Math.pow(w, 0.16)
            f = 13.12 + 0.6215 * p.v - 11.37 * k + 0.3965 * p.v * k
        } else if (p.v >= 26 && hum != null) {
            const T = (p.v * 9) / 5 + 32,
                R = hum
            const hiF = -42.379 + 2.04901523 * T + 10.14333127 * R - 0.22475541 * T * R - 0.00683783 * T * T - 0.05481717 * R * R + 0.00122874 * T * T * R + 0.00085282 * T * R * R - 0.00000199 * T * T * R * R
            f = Math.max(p.v, ((hiF - 32) * 5) / 9)
        }
        // Nivel: 0 bien · 1 precaución · 2 mal · 3 peligro (por frío, por calor o por viento fuerte)
        let lvl = f < -10 ? 3 : f < 0 ? 2 : f < 6 ? 1 : f >= 40 ? 3 : f >= 32 ? 2 : f >= 27 ? 1 : 0
        if (w != null) lvl = Math.max(lvl, w >= 70 ? 3 : w >= 50 ? 2 : w >= 35 ? 1 : 0)
        return { t: p.t, v: p.v, f, hum, w, lvl }
    })
    const LEVELS = [
        ["Bien", feelsColor1],
        ["Precaución", feelsColor2],
        ["Mal", feelsColor3],
        ["Peligro", feelsColor4],
    ] as const
    // Tramos seguidos del mismo nivel, para escribir su nombre encima de la banda
    const feelsRuns: { a: number; b: number; lvl: number }[] = []
    for (const p of feelsPts) {
        const last = feelsRuns[feelsRuns.length - 1]
        if (last && last.lvl === p.lvl) last.b = p.t
        else feelsRuns.push({ a: p.t, b: p.t, lvl: p.lvl })
    }
    const feelsHasHum = feelsPts.some((p) => p.hum != null)
    const feelsGrad = `linear-gradient(90deg, ${feelsPts
        .filter((_, k, arr) => k % 2 === 0 || k === arr.length - 1)
        .map((p) => `${LEVELS[p.lvl][1]} ${bx(p.t).toFixed(2)}%`)
        .join(", ")})`
    const FBAND_H = Math.round(feelsBandHeight * (narrow ? 0.78 : 1))
    // El degradado de la tarjeta en píxeles, para que cada hora caiga justo encima de su etiqueta
    const every2 = <T,>(xs: T[]) => xs.filter((_, k) => k % 3 === 0 || k === xs.length - 1)
    const tileStops: [number, string][] =
        section === "temperatura"
            ? every2(bandPts).map((p) => [p.t, mix(tcol(p.v), "#ffffff", tileSoft)])
            : section === "viento"
              ? every2(windPts).map((p) => [p.t, wcol(p.v)])
              : every2(feelsPts).map((p) => [p.t, LEVELS[p.lvl][1]])
    const tileBg = tileMode && tileStops.length > 1 ? `linear-gradient(180deg, rgba(255,255,255,0.22), rgba(255,255,255,0) 45%, rgba(0,0,0,0.12)), linear-gradient(90deg, ${tileStops.map(([t, c]) => `${c} ${(TILE_PAD + (bx(t) / 100) * chartWidth).toFixed(1)}px`).join(", ")})` : undefined
    // --- Aprendizaje de la IA ---
    const mlAny = data!.ml as unknown as { trained?: string; mae_ia?: number; mae_media?: number } | undefined
    const mrAny = data!.ml_rain as unknown as { trained?: string; brier_ia?: number; brier_modelos?: number } | undefined
    const aiCompare = [
        mlAny?.mae_ia != null && mlAny?.mae_media != null
            ? { k: "Temperatura · error medio", ia: mlAny.mae_ia, mod: mlAny.mae_media, unit: "°", dec: 2 }
            : null,
        mrAny?.brier_ia != null && mrAny?.brier_modelos != null
            ? { k: "Lluvia · error de probabilidad (Brier)", ia: mrAny.brier_ia, mod: mrAny.brier_modelos, unit: "", dec: 3 }
            : null,
    ]
        .filter((c): c is { k: string; ia: number; mod: number; unit: string; dec: number } => c != null)
        .map((c) => ({ ...c, max: Math.max(c.ia, c.mod) * 1.05, gain: 1 - c.ia / c.mod }))
    const aiTrainedTxt = mlAny?.trained ? `entrenada el ${mlAny.trained.slice(8, 10)}/${mlAny.trained.slice(5, 7)} · aprende cada mes` : ""
    const colorAiSoft = mix(colorAi, "#ffffff", 0.45)
    // Bento del acierto: el día más reciente primero; cada valor de la IA frente a lo medido
    const okColor = "#3fbf8a",
        badColor = "#e0405a"
    const aiDays = [...rows].reverse().map((r) => {
        const o = r.obs
        const maxHit = r.temp && o?.tmax != null ? Math.abs(r.temp.max - o.tmax) <= TEMP_OK : null
        const minHit = r.temp && o?.tmin != null ? Math.abs(r.temp.min - o.tmin) <= TEMP_OK : null
        const checks = [r.rainHit, maxHit, minHit].filter((x): x is boolean => x != null)
        return {
            ...r,
            maxHit,
            minHit,
            ok: checks.length ? checks.every(Boolean) : null,
            label: fmtDay.format(new Date(`${r.day}T12:00:00Z`)).replace(".", ""),
        }
    })
    const fmtHourDay = new Intl.DateTimeFormat("es-ES", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit" })
    // Lluvia total de cada día (la de la IA si la hay; si no, la media de los modelos), en mm.
    const dayRain = view.daily.map((d) => d.rainMm ?? 0)
    // Lluvia acumulada: el total de cada día repartido por sus horas (según cuándo llueve), y sumado.
    const accPts: { t: number; acc: number }[] = []
    let accRun = 0
    grid.forEach((row, i) => {
        const cells = row.filter((c): c is NonNullable<typeof c> => c != null)
        const w = cells.reduce((a, c) => a + c.rain, 0)
        for (const c of cells) {
            accRun += dayRain[i] * (w > 0 ? c.rain / w : 1 / cells.length)
            accPts.push({ t: c.t, acc: accRun })
        }
    })
    const accTotal = accRun
    const CW = 600,
        CH = Math.round(chartHeight * (narrow ? 0.75 : 1))
    const aT0 = accPts.length ? accPts[0].t : 0,
        aT1 = accPts.length ? accPts[accPts.length - 1].t : 1
    const ax = (t: number) => ((t - aT0) / Math.max(aT1 - aT0, 1)) * CW
    // Escala: al menos 10 mm de alto, para que una semana seca se vea casi plana.
    const ay = (v: number) => CH - (v / Math.max(accTotal * 1.1, 10)) * CH * 0.9 - 2
    // Suavizado: media de ±8 h y un punto cada 3 h, para una curva sin escalones.
    const accSmooth = accPts
        .map((p, k) => {
            const win = accPts.slice(Math.max(0, k - 8), k + 9)
            return { t: p.t, acc: win.reduce((a, q) => a + q.acc, 0) / win.length }
        })
        .filter((_, k, arr) => k % 3 === 0 || k === arr.length - 1)
    const accXY = accSmooth.map((p) => [ax(p.t), ay(p.acc)] as [number, number])
    const accLine = smoothPath(accXY)
    const accTop = accXY.length ? Math.min(...accXY.map((p) => p[1])) : 0
    // --- Gráfica de temperatura (mismo estilo que la de lluvia) ---
    const TCH = Math.round(chartHeight * 0.85 * (narrow ? 1 : 1))
    // Suavizado como la de lluvia: media de ±3 h y un punto cada 2 h, para una curva sin picos
    const curvePts = bandPts
        .map((p, k) => {
            const win = bandPts.slice(Math.max(0, k - 3), k + 4)
            return { t: p.t, v: win.reduce((a, q) => a + q.v, 0) / win.length }
        })
        .filter((_, k, arr) => k % 2 === 0 || k === arr.length - 1)
    const cy = (v: number) => TCH - 4 - ((v - bMin) / Math.max(bMax - bMin, 1)) * (TCH * 0.8)
    const curveXY = curvePts.map((p) => [(bx(p.t) / 100) * CW, cy(p.v)] as [number, number])
    const curveLine = smoothPath(curveXY)
    const curveArea = curveXY.length ? `${curveLine}L${CW},${TCH}L0,${TCH}Z` : ""
    const curveTop = curveXY.length ? Math.min(...curveXY.map((p) => p[1])) : 0
    // Picos y valles: en cada día, dónde está la máxima y la mínima de la curva, con el valor real del día
    const curveMarks = bandDays.flatMap((d, k) => {
        const next = bandDays[k + 1]?.t ?? bT1
        if (bx(next) - bx(d.t) < 6) return []
        const pts = curvePts.filter((p) => p.t >= d.t && p.t < next)
        if (pts.length < 2) return []
        const hi = pts.reduce((a, p) => (p.v > a.v ? p : a)),
            lo = pts.reduce((a, p) => (p.v < a.v ? p : a))
        return [
            { key: `h${d.t}`, x: (bx(hi.t) / 100) * CW, y: cy(hi.v), v: d.max, hot: true },
            { key: `l${d.t}`, x: (bx(lo.t) / 100) * CW, y: cy(lo.v), v: d.min, hot: false },
        ]
    })
    // Viento de fondo en la gráfica: el viento a lo largo del eje del tiempo (120 muestras)
    const chartWindField =
        windPts.length > 1 && showChartWind
            ? Array.from({ length: 120 }, (_, k) => {
                  const p = nearestPt(windPts, bT0 + ((k + 0.5) / 120) * (bT1 - bT0))!
                  return p.dir == null ? null : { dir: p.dir, q: Math.min(1, p.v / Math.max(1, windMax)) }
              })
            : []
    // En fondo claro una nube blanca no se ve: se usa un gris azulado
    const chartCloud = lightBg && hexRgb(cloudColor).reduce((a, b) => a + b, 0) / 3 > 200 ? "#8e9ab3" : cloudColor
    const accArea = accXY.length ? `${accLine}L${CW},${CH}L0,${CH}Z` : ""
    const accDays = view.daily
        .map((d, i) => {
            const first = grid[i].find((c) => c != null)
            return first ? { t: first.t, mm: dayRain[i], label: i === 0 ? "Hoy" : d.label.slice(0, 3).replace(".", "") } : null
        })
        .filter((d): d is { t: number; mm: number; label: string } => d != null)
    const wettest = accDays.reduce((a, b) => (b.mm > a.mm ? b : a), accDays[0] ?? { t: 0, mm: 0, label: "—" })
    const fxDots = (animations ? "" : `[class*="td-"] { animation: none !important; }`) + `
        @keyframes td-draw-${uid} { from { stroke-dashoffset: 1; } to { stroke-dashoffset: 0; } }
        @keyframes td-glow-${uid} { 0%, 100% { opacity: .55; } 50% { opacity: .9; } }
        .td-line-${uid} { stroke-dasharray: 1; animation: td-draw-${uid} 2s cubic-bezier(.4,0,.2,1) .6s both; }
        .td-glow-${uid} { animation: td-glow-${uid} 6s ease-in-out infinite; }
        @keyframes td-a-${uid} { 0% { transform: translate(-12%, 0) scale(1, .8); } 100% { transform: translate(14%, 8%) scale(1.2, 1); } }
        @keyframes td-b-${uid} { 0% { transform: translate(10%, 6%) scale(1.1, .9); } 100% { transform: translate(-16%, -4%) scale(.9, 1.15); } }
        @keyframes td-c-${uid} { 0% { transform: translate(0, -6%) scale(.9); } 100% { transform: translate(-6%, 10%) scale(1.2); } }
        @keyframes td-in-${uid} { from { opacity: 0; transform: scale(.2); } to { opacity: 1; transform: none; } }
        @keyframes td-up-${uid} { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
        @keyframes td-rip-${uid} { 0% { transform: scale(.6); opacity: .9; } 100% { transform: scale(1.9); opacity: 0; } }
        @keyframes td-breath-${uid} { 0%, 100% { opacity: .75; } 50% { opacity: 1; } }
        .td-dot-${uid} { animation: td-in-${uid} .7s cubic-bezier(.2,.8,.2,1) both; transition: transform .25s cubic-bezier(.2,.8,.2,1); }
        .td-cell-${uid}:hover .td-dot-${uid} { transform: scale(1.6); }
        @keyframes td-rain-${uid} { from { background-position: 0 0; } to { background-position: -3px 12px; } }
        .td-rain-${uid} { animation: td-rain-${uid} .6s linear infinite; }
        @keyframes td-wipe-${uid} { from { clip-path: inset(0 100% 0 0); } to { clip-path: inset(0 0 0 0); } }
        @keyframes td-smoke-${uid} { from { background-position: 0 0; } to { background-position: 180px 0; } }
        @keyframes td-far-${uid} { from { transform: translate3d(0, 0, 0); } to { transform: translate3d(-3px, 22px, 0); } }
        @keyframes td-near-${uid} { from { transform: translate3d(0, 0, 0); } to { transform: translate3d(-5px, 34px, 0); } }
        @keyframes td-cloud-${uid} { 0%, 100% { transform: translateX(-6px) scale(1); } 50% { transform: translateX(6px) scale(1.08); } }
        @keyframes td-bandin-${uid} { from { clip-path: inset(0 100% 0 0); } to { clip-path: inset(0 0 0 0); } }
        @keyframes td-wind-${uid} { 0% { transform: translate3d(0, var(--tw), 0); opacity: 0; } 18% { opacity: var(--to); } 78% { opacity: var(--to); } 100% { transform: translate3d(0, calc(var(--tw) * -1), 0); opacity: 0; } }
        @keyframes td-arrow-${uid} { 0% { transform: translateY(5px); opacity: 0; } 30% { opacity: 1; } 70% { opacity: 1; } 100% { transform: translateY(-5px); opacity: 0; } }
        .td-arrow-${uid} { animation-name: td-arrow-${uid}; animation-timing-function: ease-in-out; animation-iteration-count: infinite; }
        .td-wind-${uid} { animation-name: td-wind-${uid}; animation-timing-function: linear; animation-iteration-count: infinite; opacity: var(--to); will-change: transform, opacity; }
        @keyframes td-bar-${uid} { from { transform: scaleX(0); } to { transform: none; } }
        .td-bar-${uid} { transform-origin: left; animation: td-bar-${uid} 1.2s cubic-bezier(.2,.8,.2,1) .8s both; }
        @keyframes td-tile-${uid} { from { opacity: 0; transform: translateY(8px) scale(.98); } to { opacity: 1; transform: none; } }
        .td-tile-${uid} { animation: td-tile-${uid} .6s cubic-bezier(.2,.8,.2,1) both; }
        @keyframes td-cap-${uid} { from { transform: scaleY(0.1); opacity: 0; } to { transform: none; opacity: 1; } }
        @keyframes td-capglow-${uid} { 0%, 100% { opacity: .4; } 50% { opacity: .65; } }
        .td-cap-${uid} { transform-origin: center; animation: td-cap-${uid} .9s cubic-bezier(.2,.8,.2,1) both; }
        .td-capglow-${uid} { animation: td-capglow-${uid} 5s ease-in-out infinite; }
        .td-cloud-${uid} { animation: td-cloud-${uid} 9s ease-in-out infinite; }
        .td-band-${uid} { animation: td-bandin-${uid} 1.4s cubic-bezier(.6,0,.2,1) .3s both; }
        .td-row-${uid} { animation: td-wipe-${uid} 1s cubic-bezier(.6,0,.2,1) both; }
        .td-smoke-${uid} { animation-name: td-smoke-${uid}; animation-timing-function: linear; animation-iteration-count: infinite; }
        .td-drops-far-${uid} { animation: td-far-${uid} 1.1s linear infinite; }
        .td-drops-near-${uid} { animation-name: td-near-${uid}; animation-duration: .6s; animation-timing-function: linear; animation-iteration-count: infinite; }

        .td-up-${uid} { animation: td-up-${uid} .9s cubic-bezier(.2,.8,.2,1) both; }
        .td-now-${uid} { animation: td-breath-${uid} 2.4s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) {
            .td-dot-${uid}, .td-arrow-${uid}, .td-wind-${uid}, .td-cloud-${uid}, .td-band-${uid}, .td-rain-${uid}, .td-row-${uid}, .td-smoke-${uid}, .td-drops-far-${uid}, .td-drops-near-${uid}, .td-line-${uid}, .td-glow-${uid}, .td-up-${uid}, .td-now-${uid}, .td-aur-${uid} { animation: none !important; }
        }
    `

    return (
        <div
            ref={chartRef}
            style={{
                ...box,
                display: "block",
                position: "relative",
                padding: tileMode ? TILE_PAD : container ? (narrow ? Math.round(padding * 0.72) : padding) : 0,
                background: tileMode ? tileBg ?? bgColor : container ? bgColor : "transparent",
                boxShadow: container && !tileMode ? box.boxShadow : "none",
                borderRadius: tileMode ? radius : container ? box.borderRadius : 0,
                textShadow: tileMode && !paleTile ? "0 1px 10px rgba(0,0,0,0.18)" : undefined,
                transition: "background 1s ease",
                color: ink,
                fontFamily: fontFamily ? `${fontFamily}, ${OUTFIT_STACK}` : OUTFIT_STACK,
            }}
        >
            <style>{fxDots}</style>
            {/* Aurora: tres luces con el color de la mínima, de ahora y de la máxima de hoy */}
            {container && aurora && auroraCols.map((c, k) => (
                <div
                    key={k}
                    aria-hidden
                    className={`td-aur-${uid}`}
                    style={{
                        position: "absolute",
                        top: narrow ? -110 : -150,
                        left: `${-15 + k * 30}%`,
                        width: "70%",
                        height: narrow ? 300 : 380,
                        borderRadius: "50%",
                        background: `radial-gradient(closest-side, ${c}, transparent)`,
                        opacity: auroraStrength,
                        willChange: "transform",
                        animation: `td-${"abc"[k]}-${uid} ${18 + k * 6}s ease-in-out infinite alternate`,
                        pointerEvents: "none",
                    }}
                />
            ))}
            {container && grain && <div aria-hidden style={{ position: "absolute", inset: 0, backgroundImage: GRAIN, opacity: 0.06, pointerEvents: "none" }} />}

            <div style={{ position: "relative" }}>
                {/* Ahora */}
                {sNow && (<>
                <div className={`td-up-${uid}`} style={{ display: "flex", justifyContent: "space-between", fontFamily: MONO_STACK, fontSize: fs(10), letterSpacing: "0.06em", textTransform: "uppercase", color: soft }}>
                    <span style={{ color: ink }}>{placeName ?? view.name}</span>
                    <span>{dateLine}</span>
                </div>
                <div
                    className={`td-up-${uid}`}
                    style={{
                        fontSize: Math.round(tempSize * (narrow ? 0.72 : 1)),
                        fontWeight: tempWeight,
                        lineHeight: 1,
                        letterSpacing: "-0.075em",
                        marginTop: narrow ? 22 : 30,
                        marginLeft: -4,
                        fontVariantNumeric: "tabular-nums",
                        // Texto sólido con un brillo del color de ahora (el degradado recortado al texto fallaba en algunos navegadores)
                        color: mix(ink, tcol(nowTemp), 0.18),
                        animationDelay: "80ms",
                    }}
                >
                    <CountUp value={shown} />°
                </div>
                <div className={`td-up-${uid}`} style={{ fontFamily: MONO_STACK, fontSize: fs(10), letterSpacing: "0.06em", textTransform: "uppercase", color: soft, marginTop: 6, animationDelay: "140ms" }}>
                    {KIND_LABEL[view.nowKind]} · {tMax}° / {tMin}°
                </div>
                <div className={`td-up-${uid}`} style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 10, marginTop: narrow ? 22 : 28, paddingTop: 14, borderTop: `1px solid ${faint}`, animationDelay: "200ms" }}>
                    {stat("Viento", windNow != null ? `${Math.round(windNow)}` : "—", `km/h${dirNow != null ? " " + compass(dirNow) : ""}`)}
                    {stat("Humedad", nowHum != null ? `${Math.round(nowHum)}` : "—", "%")}
                    {stat("Nubes", nowCloud != null ? `${Math.round(nowCloud)}` : "—", "%")}
                    {stat("Lluvia", nowRain >= 0.05 ? num(nowRain, 1) : "0", "mm/h")}
                </div>
                </>)}

                {/* La semana: una banda ancha, de izquierda (ahora) a derecha (dentro de 7 días).
                    El color es la temperatura; encima, nubes de humo y lluvia cuando toca. */}
                {sTemp && bandPts.length > 1 && (
                    <div className={`td-up-${uid}`} style={{ marginTop: mt(narrow ? 30 : 40), animationDelay: "300ms" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", fontFamily: MONO_STACK, fontSize: fs(9), letterSpacing: "0.06em", textTransform: "uppercase", color: soft, marginBottom: 10 }}>
                            <span>Temperatura · {days} días</span>
                            <span style={{ display: "inline-flex", alignItems: "center", gap: 6, letterSpacing: 0 }}>
                                {bMin}°
                                <span style={{ width: 60, height: 3, borderRadius: 2, background: `linear-gradient(90deg, ${[0, 1, 2, 3, 4].map((q) => tcol(bMin + (q / 4) * (bMax - bMin))).join(",")})` }} />
                                {bMax}°
                            </span>
                        </div>
                        <div
                            style={{ position: "relative", height: BAND_TOP + BAND_H + 10, touchAction: "none" }}
                            onPointerMove={(e: PointerEvent<HTMLDivElement>) => {
                                const r = e.currentTarget.getBoundingClientRect()
                                const t = bT0 + ((e.clientX - r.left) / r.width) * (bT1 - bT0)
                                setHover(Math.round(Math.max(bT0, Math.min(bT1, t)) / HOUR) * HOUR)
                            }}
                            onPointerLeave={() => setHover(null)}
                        >
                            {/* La banda: degradado suave de la temperatura, con los bordes difuminados */}
                            <div
                                className={`td-band-${uid}`}
                                style={{
                                    position: "absolute",
                                    left: 0,
                                    right: 0,
                                    top: BAND_TOP,
                                    height: BAND_H,
                                    background: tileMode ? "transparent" : bandGrad,
                                    filter: bandBlur > 0 ? `blur(${bandBlur}px)` : undefined,
                                    WebkitMaskImage: "linear-gradient(180deg, transparent 0%, #000 22%, #000 78%, transparent 100%), linear-gradient(90deg, transparent 0%, #000 3%, #000 97%, transparent 100%)",
                                    WebkitMaskComposite: "source-in",
                                    maskImage: "linear-gradient(180deg, transparent 0%, #000 22%, #000 78%, transparent 100%)",
                                    borderRadius: 18,
                                }}
                            />
                            {/* Una línea fina con la temperatura hora a hora (sube y baja con el día y la noche) */}
                            {tempLine && bandPts.length > 1 && (
                                <svg
                                    aria-hidden
                                    viewBox="0 0 1000 100"
                                    preserveAspectRatio="none"
                                    style={{ position: "absolute", left: 0, right: 0, top: BAND_TOP + BAND_H * 0.12, width: "100%", height: BAND_H * 0.76, overflow: "visible", pointerEvents: "none" }}
                                >
                                    <path
                                        d={smoothPath(bandPts.filter((_, k) => k % 2 === 0).map((p) => [bx(p.t) * 10, 100 - ((p.v - bMin) / Math.max(bMax - bMin, 1)) * 100] as [number, number]))}
                                        fill="none"
                                        stroke={ink}
                                        strokeOpacity={0.7}
                                        strokeWidth={1.4}
                                        vectorEffect="non-scaling-stroke"
                                        strokeLinecap="round"
                                    />
                                </svg>
                            )}
                            {/* Brillo por debajo, como una luz */}
                            
                            {/* Nubes: tres bandas finas e independientes (altas, medias, bajas); más blanca = más nube */}
                            {showClouds &&
                                ([
                                    ["hi", 0, "Altas"],
                                    ["mi", 1, "Medias"],
                                    ["lo", 2, "Bajas"],
                                ] as const).map(([key, row, label]) => {
                                    const stops = bandSky
                                        .map((b) => {
                                            const v = b[key]
                                            const al = Math.min(1, Math.max(0, (v - 10) / 90) * 0.9 * cloudOpacity)
                                            const c = (b.rain >= 0.1 && key !== "hi" ? hexRgb(mix(cloudColor, "#5a78c8", 0.4)) : hexRgb(cloudColor)).join(",")
                                            return `rgba(${c},${al.toFixed(2)}) ${bx(b.t).toFixed(2)}%`
                                        })
                                        .join(", ")
                                    const top = row * (CLOUD_H + CLOUD_GAP)
                                    return (
                                        <Fragment key={key}>
                                            <span aria-hidden style={{ position: "absolute", left: 0, right: 0, top, height: CLOUD_H, borderRadius: CLOUD_H, background: faint, opacity: 0.35, pointerEvents: "none" }} />
                                            <span aria-hidden style={{ position: "absolute", left: 0, right: 0, top, height: CLOUD_H, borderRadius: CLOUD_H, background: `linear-gradient(90deg, ${stops})`, pointerEvents: "none" }} />
                                            <span style={{ position: "absolute", left: 4, top: top + CLOUD_H / 2 - 5, lineHeight: "10px", mixBlendMode: "normal", fontFamily: MONO_STACK, fontSize: fs(7.5), letterSpacing: "0.05em", textTransform: "uppercase", color: soft, whiteSpace: "nowrap", pointerEvents: "none" }}>{label}</span>
                                        </Fragment>
                                    )
                                })}
                            {/* Lluvia: gotas que caen desde la nube atravesando la banda */}
                            {showRain && bandSky.map((b) =>
                                b.rain >= 0.1 ? (
                                    <span
                                        key={`r${b.t}`}
                                        aria-hidden
                                        style={{
                                            position: "absolute",
                                            left: `${bx(b.t - 1.5 * HOUR)}%`,
                                            width: `${bx(b.t + 1.5 * HOUR) - bx(b.t - 1.5 * HOUR)}%`,
                                            top: BAND_TOP - 6,
                                            height: BAND_H + 6,
                                            overflow: "hidden",
                                            WebkitMaskImage: "linear-gradient(180deg, transparent, #000 25%, #000 75%, transparent)",
                                            maskImage: "linear-gradient(180deg, transparent, #000 25%, #000 75%, transparent)",
                                            pointerEvents: "none",
                                        }}
                                    >
                                        <span className={`td-drops-far-${uid}`} style={{ position: "absolute", left: -6, right: -6, top: -34, bottom: 0, backgroundImage: DROPS, backgroundSize: "14px 22px", opacity: 0.35 + 0.4 * b.k2, willChange: "transform" }} />
                                        <span className={`td-drops-near-${uid}`} style={{ position: "absolute", left: -6, right: -6, top: -34, bottom: 0, backgroundImage: DROPS, backgroundSize: `${22 - 8 * b.k2}px 34px`, opacity: 0.55 + 0.45 * b.k2, animationDuration: `${0.75 - 0.3 * b.k2}s`, willChange: "transform" }} />
                                    </span>
                                ) : null
                            )}
                            {/* Ahora y el punto que señalas */}
                            {[...(hover != null ? [hover] : [])].map((t) => {
                                const p = nearestPt(bandPts, t)!
                                const left = bx(p.t)
                                return (
                                    <Fragment key="hv">
                                        <span style={{ position: "absolute", left: `${left}%`, top: BAND_TOP - 4, height: BAND_H + 8, width: 1, background: ink, pointerEvents: "none" }} />
                                        <span
                                            style={{
                                                position: "absolute",
                                                top: BAND_TOP + BAND_H + 2,
                                                ...(left > 60 ? { right: `${100 - left}%` } : { left: `${left}%` }),
                                                transform: "translateY(2px)",
                                                fontFamily: MONO_STACK,
                                                fontSize: fs(9.5),
                                                color: ink,
                                                whiteSpace: "nowrap",
                                                padding: "0 4px",
                                                pointerEvents: "none",
                                            }}
                                        >
                                            {fmtHourDay.format(new Date(p.t))} · {Math.round(p.v)}° · nubes {p.cloud != null ? Math.round(p.cloud) + "%" : "—"}
                                            {p.rain >= 0.05 ? ` · ${num(p.rain, 1)} mm` : ""}
                                        </span>
                                    </Fragment>
                                )
                            })}
                        </div>
                        {/* Días: nombre, máxima / mínima y lluvia */}
                        <div style={{ position: "relative", height: 40, marginTop: 4 }}>
                            {bandDays.map((d, k) => {
                                const next = bandDays[k + 1]?.t ?? bT1
                                const w = bx(next) - bx(d.t)
                                if (w < 6) return null
                                return (
                                    <span key={d.t} style={{ position: "absolute", left: `${bx(d.t)}%`, width: `${w}%`, paddingLeft: 5, boxSizing: "border-box", fontFamily: MONO_STACK, fontSize: fs(9), lineHeight: 1.5, color: soft, overflow: "hidden", whiteSpace: "nowrap" }}>
                                        <span style={{ display: "block", textTransform: "uppercase", letterSpacing: "0.04em", color: d.i === 0 ? ink : soft }}>{d.label}</span>
                                        <span style={{ display: "block" }}>
                                            <span style={{ color: tone(tcol(d.max)) }}>{d.max}°</span> <span>{d.min}°</span>
                                        </span>
                                        {d.mm >= 0.1 && <span style={{ display: "block", color: rainTxt }}>{num(d.mm, 1)} mm</span>}
                                    </span>
                                )
                            })}
                        </div>
                    </div>
                )}

                {/* Viento: la misma banda; el color es la fuerza y las flechas, hacia dónde sopla (se mueven) */}
                {sWind && windPts.length > 1 && (
                    <div className={`td-up-${uid}`} style={{ marginTop: mt(narrow ? 24 : 30), animationDelay: "400ms" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", fontFamily: MONO_STACK, fontSize: fs(9), letterSpacing: "0.06em", textTransform: "uppercase", color: soft, marginBottom: 10 }}>
                            <span>Viento · {days} días</span>
                            <span style={{ display: "inline-flex", alignItems: "center", gap: 6, letterSpacing: 0 }}>
                                0
                                <span style={{ width: 60, height: 3, borderRadius: 2, background: `linear-gradient(90deg, ${[0, 0.2, 0.4, 0.6, 0.8, 1].map((q) => wcol(q * windMax)).join(",")})` }} />
                                {windMax} km/h
                            </span>
                        </div>
                        <div
                            style={{ position: "relative", height: WBAND_H + 8, touchAction: "none" }}
                            onPointerMove={(e: PointerEvent<HTMLDivElement>) => {
                                const r = e.currentTarget.getBoundingClientRect()
                                setWindHover(Math.round((bT0 + ((e.clientX - r.left) / r.width) * (bT1 - bT0)) / HOUR) * HOUR)
                            }}
                            onPointerLeave={() => setWindHover(null)}
                        >
                            <div
                                className={`td-band-${uid}`}
                                style={{
                                    position: "absolute",
                                    left: 0,
                                    right: 0,
                                    top: 4,
                                    height: WBAND_H,
                                    background: tileMode ? "transparent" : windGrad,
                                    filter: bandBlur > 0 ? `blur(${bandBlur}px)` : undefined,
                                    WebkitMaskImage: "linear-gradient(180deg, transparent 0%, #000 22%, #000 78%, transparent 100%)",
                                    maskImage: "linear-gradient(180deg, transparent 0%, #000 22%, #000 78%, transparent 100%)",
                                    borderRadius: 18,
                                    animationDelay: ".5s",
                                }}
                            />
                            
                            {/* Flechas: una cada 6 h; apuntan hacia donde va el viento y avanzan más rápido cuanto más sopla */}
                            {showArrows && (
                                <div aria-hidden style={{ position: "absolute", left: 0, right: 0, top: 4, height: WBAND_H, pointerEvents: "none", overflow: "hidden", borderRadius: 18 }}>
                                    {windArrows.map((a) => (
                                        <span
                                            key={a.n}
                                            style={{
                                                position: "absolute",
                                                left: `${a.x}%`,
                                                top: `${a.y}%`,
                                                width: arrowSize,
                                                height: arrowSize,
                                                marginLeft: -arrowSize / 2,
                                                marginTop: -arrowSize / 2,
                                                transform: `rotate(${a.dir + 180}deg)`,
                                            }}
                                        >
                                            {/* Partícula: una flecha con estela que viaja hacia donde sopla el viento.
                                                Más viento → viaja más lejos, más rápido y se ve más. */}
                                            {(() => {
                                                const q = Math.min(1, a.v / Math.max(1, windMax))
                                                return (
                                                    <span
                                                        className={`td-wind-${uid}`}
                                                        style={{
                                                            position: "absolute",
                                                            inset: 0,
                                                            ["--tw" as any]: `${(arrowSize * (1 + q * 2.6)).toFixed(1)}px`,
                                                            ["--to" as any]: (0.35 + q * 0.6).toFixed(2),
                                                            animationDuration: `${Math.max(0.9, 3.4 - a.v / 16).toFixed(2)}s`,
                                                            animationDelay: `${-(((a.n * 0.618) % 1) * 3).toFixed(2)}s`,
                                                        }}
                                                    >
                                                        <span style={{ position: "absolute", left: "50%", top: "10%", height: `${((0.6 + q * 1.4) * 100).toFixed(0)}%`, width: 1.5, marginLeft: -0.75, borderRadius: 1, background: `linear-gradient(180deg, ${arrowInk}, transparent)` }} />
                                                        <span style={{ position: "absolute", left: "50%", top: "8%", width: "44%", height: "44%", marginLeft: "-22%", marginTop: "2%", borderLeft: `1.6px solid ${arrowInk}`, borderTop: `1.6px solid ${arrowInk}`, transform: "rotate(45deg)", boxSizing: "border-box" }} />
                                                    </span>
                                                )
                                            })()}
                                        </span>
                                    ))}
                                </div>
                            )}
                            {windHover != null &&
                                (() => {
                                    const p = nearestPt(windPts, windHover)!
                                    const left = bx(p.t)
                                    return (
                                        <>
                                            <span style={{ position: "absolute", left: `${left}%`, top: 0, height: WBAND_H + 8, width: 1, background: ink, pointerEvents: "none" }} />
                                            <span style={{ position: "absolute", top: -14, ...(left > 60 ? { right: `${100 - left}%` } : { left: `${left}%` }), padding: "0 4px", fontFamily: MONO_STACK, fontSize: fs(9.5), color: ink, whiteSpace: "nowrap", pointerEvents: "none" }}>
                                                {fmtHourDay.format(new Date(p.t))} · {Math.round(p.v)} km/h {p.dir != null ? compass(p.dir) : ""}
                                            </span>
                                        </>
                                    )
                                })()}
                        </div>
                        {/* Máximo de viento de cada día */}
                        <div style={{ position: "relative", height: 16, marginTop: 4 }}>
                            {bandDays.map((d, k) => {
                                const next = bandDays[k + 1]?.t ?? bT1
                                const w = bx(next) - bx(d.t)
                                if (w < 6) return null
                                const mx = Math.max(0, ...windPts.filter((p) => p.t >= d.t && p.t < next).map((p) => p.v))
                                return (
                                    <span key={d.t} style={{ position: "absolute", left: `${bx(d.t)}%`, width: `${w}%`, paddingLeft: 5, boxSizing: "border-box", fontFamily: MONO_STACK, fontSize: fs(9), color: soft, whiteSpace: "nowrap", overflow: "hidden" }}>
                                        <span style={{ color: tone(wcol(mx)) }}>{Math.round(mx)}</span>{narrow ? "" : " km/h"}
                                    </span>
                                )
                            })}
                        </div>
                    </div>
                )}

                {/* Sensación térmica: la misma banda, con lo que nota el cuerpo (viento en frío, humedad en calor) */}
                {sFeels && feelsPts.length > 1 && (
                    <div className={`td-up-${uid}`} style={{ marginTop: mt(narrow ? 24 : 30), animationDelay: "450ms" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", fontFamily: MONO_STACK, fontSize: fs(9), letterSpacing: "0.06em", textTransform: "uppercase", color: soft, marginBottom: 10 }}>
                            <span>Sensación térmica · {days} días</span>
                            <span style={{ display: "inline-flex", gap: 10, letterSpacing: 0, flexWrap: "wrap", justifyContent: "flex-end" }}>
                                {LEVELS.map(([name, col]) => (
                                    <span key={name} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                                        <span style={{ width: 7, height: 7, borderRadius: 2, background: col }} />
                                        {name}
                                    </span>
                                ))}
                            </span>
                        </div>
                        <div
                            style={{ position: "relative", height: FBAND_H + 8, touchAction: "none" }}
                            onPointerMove={(e: PointerEvent<HTMLDivElement>) => {
                                const r = e.currentTarget.getBoundingClientRect()
                                setFeelsHover(Math.round((bT0 + ((e.clientX - r.left) / r.width) * (bT1 - bT0)) / HOUR) * HOUR)
                            }}
                            onPointerLeave={() => setFeelsHover(null)}
                        >
                            <div
                                className={`td-band-${uid}`}
                                style={{
                                    position: "absolute",
                                    left: 0,
                                    right: 0,
                                    top: 4,
                                    height: FBAND_H,
                                    background: tileMode ? "transparent" : feelsGrad,
                                    filter: bandBlur > 0 ? `blur(${bandBlur}px)` : undefined,
                                    WebkitMaskImage: "linear-gradient(180deg, transparent 0%, #000 22%, #000 78%, transparent 100%)",
                                    maskImage: "linear-gradient(180deg, transparent 0%, #000 22%, #000 78%, transparent 100%)",
                                    borderRadius: 18,
                                    animationDelay: ".6s",
                                }}
                            />
                            {/* El nombre de cada tramo, encima de la banda */}
                            {feelsRuns
                                .filter((r) => bx(r.b) - bx(r.a) >= 9)
                                .map((r) => (
                                    <span key={r.a} style={{ position: "absolute", left: `${(bx(r.a) + bx(r.b)) / 2}%`, top: 4 + FBAND_H / 2 - 6, transform: "translateX(-50%)", fontFamily: MONO_STACK, fontSize: fs(8.5), letterSpacing: "0.04em", textTransform: "uppercase", color: "rgba(11,11,16,0.78)", whiteSpace: "nowrap", pointerEvents: "none" }}>
                                        {LEVELS[r.lvl][0]}
                                    </span>
                                ))}
                            {feelsHover != null &&
                                (() => {
                                    const p = nearestPt(feelsPts, feelsHover)!
                                    const left = bx(p.t)
                                    return (
                                        <>
                                            <span style={{ position: "absolute", left: `${left}%`, top: 0, height: FBAND_H + 8, width: 1, background: ink, pointerEvents: "none" }} />
                                            <span style={{ position: "absolute", top: -14, ...(left > 60 ? { right: `${100 - left}%` } : { left: `${left}%` }), padding: "0 4px", fontFamily: MONO_STACK, fontSize: fs(9.5), color: ink, whiteSpace: "nowrap", pointerEvents: "none" }}>
                                                {fmtHourDay.format(new Date(p.t))} · {LEVELS[p.lvl][0]} · se nota {Math.round(p.f)}° (marca {Math.round(p.v)}°){p.w != null ? ` · ${Math.round(p.w)} km/h` : ""}{p.hum != null ? ` · ${Math.round(p.hum)} %` : ""}
                                            </span>
                                        </>
                                    )
                                })()}
                        </div>
                        <div style={{ position: "relative", height: 30, marginTop: 4, lineHeight: 1.5 }}>
                            {bandDays.map((d, k) => {
                                const next = bandDays[k + 1]?.t ?? bT1
                                const w = bx(next) - bx(d.t)
                                if (w < 6) return null
                                const day = feelsPts.filter((p) => p.t >= d.t && p.t < next)
                                if (!day.length) return null
                                const worst = Math.max(...day.map((p) => p.lvl))
                                return (
                                    <span key={d.t} style={{ position: "absolute", left: `${bx(d.t)}%`, width: `${w}%`, paddingLeft: 5, boxSizing: "border-box", fontFamily: MONO_STACK, fontSize: fs(9), color: soft, whiteSpace: "nowrap", overflow: "hidden" }}>
                                        <span style={{ display: "block", color: tone(LEVELS[worst][1]) }}>{narrow ? ({ Precaución: "Prec.", Peligro: "Pelig." } as Record<string, string>)[LEVELS[worst][0]] ?? LEVELS[worst][0] : LEVELS[worst][0]}</span>
                                    </span>
                                )
                            })}
                        </div>
                    </div>
                )}

                {/* Gráfica de temperatura: como la de lluvia, una luz que sube y baja con el color de cada hora */}
                {sCurve && bandPts.length > 1 && (
                    <div className={`td-up-${uid}`} style={{ marginTop: mt(narrow ? 28 : 36), animationDelay: "350ms" }}>
                        <div style={{ fontFamily: MONO_STACK, fontSize: fs(9), letterSpacing: "0.06em", textTransform: "uppercase", color: soft, marginBottom: 8 }}>Temperatura · {days} días</div>
                        {/* Nubes por altura: tres bandas finas difuminadas (altas, medias, bajas); más blanca = más nube */}
                        {showClouds && (
                            <div style={{ position: "relative", height: 3 * 9 + 2 * 5, marginTop: 6, marginBottom: 4 }}>
                                {([
                                    ["hi", 0, "Altas"],
                                    ["mi", 1, "Medias"],
                                    ["lo", 2, "Bajas"],
                                ] as const).map(([key, row, label]) => {
                                    const stops = bandSky
                                        .map((b) => {
                                            const al = Math.min(1, Math.max(0, (b[key] - 10) / 90)) * cloudOpacity
                                            const c = b.rain >= 0.1 && key !== "hi" ? mix(chartCloud, "#4f6fd8", 0.45) : chartCloud
                                            return `rgba(${hexRgb(c).join(",")},${al.toFixed(2)}) ${bx(b.t).toFixed(2)}%`
                                        })
                                        .join(", ")
                                    const top = row * 14
                                    return (
                                        <Fragment key={key}>
                                            <span aria-hidden style={{ position: "absolute", left: 0, right: 0, top, height: 9, borderRadius: 9, background: `${soft}12` }} />
                                            <span aria-hidden style={{ position: "absolute", left: 0, right: 0, top: top - 2, height: 13, borderRadius: 9, background: `linear-gradient(90deg, ${stops})`, filter: "blur(3px)" }} />
                                            <span style={{ position: "absolute", left: 4, top: top - 0.5, lineHeight: "10px", fontFamily: MONO_STACK, fontSize: fs(7), letterSpacing: "0.05em", textTransform: "uppercase", color: soft, opacity: 0.8 }}>{label}</span>
                                        </Fragment>
                                    )
                                })}
                            </div>
                        )}
                        <div style={{ position: "relative" }}>
                        {/* Viento de fondo: partículas que viajan hacia donde sopla */}
                        {chartWindField.length > 0 && <WindParticles field={chartWindField} color={inkColor} opacity={chartWindOpacity} density={chartWindDensity} animate={animations} />}
                        <svg width="100%" height={TCH} viewBox={`0 0 ${CW} ${TCH}`} preserveAspectRatio="none" style={{ display: "block", overflow: "visible", position: "relative" }}>
                            <defs>
                                <filter id={`tcb-${uid}`} x="-5%" y="-30%" width="110%" height="160%">
                                    <feGaussianBlur stdDeviation={chartBlur} />
                                </filter>
                                <filter id={`tcb2-${uid}`} x="-5%" y="-40%" width="110%" height="180%">
                                    <feGaussianBlur stdDeviation={chartBlur * 3} />
                                </filter>
                                <linearGradient id={`tcg-${uid}`} gradientUnits="userSpaceOnUse" x1="0" x2={CW} y1="0" y2="0">
                                    {curvePts
                                        .filter((_, k, arr) => k % 2 === 0 || k === arr.length - 1)
                                        .map((p) => (
                                            <stop key={p.t} offset={(bx(p.t) / 100).toFixed(4)} stopColor={tcol(p.v)} />
                                        ))}
                                </linearGradient>
                                <linearGradient id={`tcf-${uid}`} gradientUnits="userSpaceOnUse" x1="0" x2="0" y1={curveTop} y2={TCH}>
                                    <stop offset="0" stopColor="#fff" stopOpacity={0} />
                                    <stop offset="0.3" stopColor="#fff" stopOpacity={0.6} />
                                    <stop offset="1" stopColor="#fff" stopOpacity={1} />
                                </linearGradient>
                                <mask id={`tcm-${uid}`}>
                                    <rect x={0} y={0} width={CW} height={TCH} fill={`url(#tcf-${uid})`} />
                                </mask>
                            </defs>
                            {/* Brillo muy difuminado debajo y, encima, el área algo difuminada */}
                            <path d={curveArea} fill={`url(#tcg-${uid})`} mask={`url(#tcm-${uid})`} opacity={0.55} filter={chartBlur > 0 ? `url(#tcb2-${uid})` : undefined} />
                            <path d={curveArea} fill={`url(#tcg-${uid})`} mask={`url(#tcm-${uid})`} opacity={0.85} filter={chartBlur > 0 ? `url(#tcb-${uid})` : undefined} />
                            {tempLine && <path d={curveLine} fill="none" stroke={ink} strokeOpacity={0.55} strokeWidth={1.3} vectorEffect="non-scaling-stroke" />}
                        </svg>
                        {/* Lluvia: partículas (gotas) que caen sobre la gráfica en las horas en que llueve */}
                        {showRain &&
                            bandSky.map((b) =>
                                b.rain >= 0.1 ? (
                                    <span
                                        key={`cr${b.t}`}
                                        aria-hidden
                                        style={{
                                            position: "absolute",
                                            left: `${bx(b.t - 1.5 * HOUR)}%`,
                                            width: `${bx(b.t + 1.5 * HOUR) - bx(b.t - 1.5 * HOUR)}%`,
                                            top: -18,
                                            bottom: 0,
                                            overflow: "hidden",
                                            WebkitMaskImage: "linear-gradient(180deg, transparent, #000 20%, #000 70%, transparent)",
                                            maskImage: "linear-gradient(180deg, transparent, #000 20%, #000 70%, transparent)",
                                            pointerEvents: "none",
                                        }}
                                    >
                                        <span className={`td-drops-far-${uid}`} style={{ position: "absolute", left: -6, right: -6, top: -34, bottom: 0, backgroundImage: DROPS_INK, backgroundSize: "14px 22px", opacity: 0.35 + 0.4 * b.k2, willChange: "transform" }} />
                                        <span className={`td-drops-near-${uid}`} style={{ position: "absolute", left: -6, right: -6, top: -34, bottom: 0, backgroundImage: DROPS_INK, backgroundSize: `${22 - 8 * b.k2}px 34px`, opacity: 0.55 + 0.45 * b.k2, animationDuration: `${0.75 - 0.3 * b.k2}s`, willChange: "transform" }} />
                                    </span>
                                ) : null
                            )}
                        {/* Máxima y mínima de cada día: un punto en el pico o el valle y su valor encima */}
                        {curveMarks.map((m) => {
                            const left = (m.x / CW) * 100
                            return (
                                <Fragment key={m.key}>
                                    <span
                                        style={{
                                            position: "absolute",
                                            left: `${Math.min(96, Math.max(4, left))}%`,
                                            top: m.y - (m.hot ? 18 : 15),
                                            transform: "translateX(-50%)",
                                            fontFamily: m.hot ? "Doto, " + MONO_STACK : MONO_STACK,
                                            fontWeight: m.hot ? 800 : 400,
                                            fontSize: fs(m.hot ? 12.5 : 9.5),
                                            color: m.hot ? ink : soft,
                                            whiteSpace: "nowrap",
                                            pointerEvents: "none",
                                        }}
                                    >
                                        {m.v}°
                                    </span>
                                </Fragment>
                            )
                        })}
                        </div>
                        <div style={{ position: "relative", height: 16, marginTop: 8 }}>
                            {bandDays.map((d, k) => {
                                const next = bandDays[k + 1]?.t ?? bT1
                                const w = bx(next) - bx(d.t)
                                if (w < 6) return null
                                return (
                                    <span key={d.t} style={{ position: "absolute", left: `${bx(d.t)}%`, width: `${w}%`, paddingLeft: 4, boxSizing: "border-box", fontFamily: MONO_STACK, fontSize: fs(8.5), letterSpacing: "0.04em", textTransform: "uppercase", color: soft, lineHeight: 1.4, overflow: "hidden", whiteSpace: "nowrap" }}>
                                        {d.label}
                                    </span>
                                )
                            })}
                        </div>
                    </div>
                )}

                {/* Al final: la lluvia acumulada en 7 días, como una luz azul-violeta que crece */}
                {sRain && accPts.length > 1 && (
                    <div className={`td-up-${uid}`} style={{ marginTop: mt(narrow ? 28 : 36), animationDelay: "500ms" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, fontFamily: MONO_STACK, fontSize: fs(9), letterSpacing: "0.06em", textTransform: "uppercase", color: soft }}>
                            <span>Lluvia acumulada · {days} días</span>
                            <span style={{ textAlign: "right" }}>
                                <span style={{ display: "block", fontFamily: OUTFIT_STACK, fontSize: narrow ? 26 : 32, fontWeight: 200, letterSpacing: "-0.04em", textTransform: "none", color: accTotal >= 0.1 ? "#cfe0ff" : ink }}>
                                    {num(accTotal, 1)}
                                    <span style={{ fontFamily: MONO_STACK, fontSize: fs(9), marginLeft: 4, color: soft }}>mm</span>
                                </span>
                            </span>
                        </div>
                        {/* Tres etiquetas de color, como en la referencia */}
                        <div style={{ display: "flex", gap: 22, fontFamily: MONO_STACK, fontSize: fs(9), marginTop: 6, marginBottom: 8 }}>
                            {[
                                ["Días con lluvia", `${view.daily.filter((_, i) => dayRain[i] >= 1).length}`, rainColor1],
                                ["Día más húmedo", accTotal >= 0.1 ? wettest.label : "—", rainColor2],
                                ["Máx. en un día", `${num(wettest.mm, 1)}`, rainColor3],
                            ].map(([k, v, c]) => (
                                <span key={k}>
                                    <span style={{ display: "block", color: c }}>{k}</span>
                                    <span style={{ display: "block", color: c, opacity: 0.8, textTransform: "capitalize" }}>{v}</span>
                                </span>
                            ))}
                        </div>
                        <svg width="100%" height={CH} viewBox={`0 0 ${CW} ${CH}`} preserveAspectRatio="none" style={{ display: "block", overflow: "visible" }}>
                            <defs>
                                <linearGradient id={`ac-${uid}`} x1="0" x2="1" y1="0" y2="0">
                                    <stop offset="0" stopColor={rainColor1} />
                                    <stop offset="0.5" stopColor={rainColor2} />
                                    <stop offset="1" stopColor={rainColor3} />
                                </linearGradient>
                                <linearGradient id={`af-${uid}`} gradientUnits="userSpaceOnUse" x1="0" x2="0" y1={accTop} y2={CH}>
                                    <stop offset="0" stopColor="#fff" stopOpacity={0} />
                                    <stop offset="0.35" stopColor="#fff" stopOpacity={0.55} />
                                    <stop offset="1" stopColor="#fff" stopOpacity={1} />
                                </linearGradient>
                                <mask id={`am-${uid}`}>
                                    <rect x={0} y={0} width={CW} height={CH} fill={`url(#af-${uid})`} />
                                </mask>
                                <filter id={`ab-${uid}`} x="-10%" y="-40%" width="120%" height="180%">
                                    <feGaussianBlur stdDeviation={16} />
                                </filter>
                                <filter id={`as-${uid}`} x="-5%" y="-20%" width="110%" height="140%">
                                    <feGaussianBlur stdDeviation={5} />
                                </filter>
                            </defs>
                            {/* La luz: el área desenfocada (brillo) y encima nítida, desvaneciéndose hacia arriba */}
                            <path d={accArea} fill={`url(#ac-${uid})`} mask={`url(#am-${uid})`} opacity={0.9} />
                        </svg>
                        <div style={{ position: "relative", height: 26, marginTop: 6 }}>
                            {accDays.map((d) => (
                                <span key={d.t} style={{ position: "absolute", left: `${(ax(d.t) / CW) * 100}%`, paddingLeft: 4, fontFamily: MONO_STACK, fontSize: fs(8.5), letterSpacing: "0.04em", textTransform: "uppercase", color: soft, lineHeight: 1.4 }}>
                                    {d.label}
                                    <span style={{ display: "block", color: d.mm >= 0.1 ? rainTxt : soft, opacity: d.mm >= 0.1 ? 1 : 0.5, letterSpacing: 0 }}>{num(d.mm, 1)}</span>
                                </span>
                            ))}
                        </div>
                    </div>
                )}

                {/* Al final: ¿acertó la IA? Un bento con cada día, lo que dijo frente a lo que pasó */}
                {sAi && ac && aiDays.length > 0 && (
                    <div className={`td-up-${uid}`} style={{ marginTop: mt(narrow ? 30 : 40), animationDelay: "600ms" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, flexWrap: "wrap", fontFamily: MONO_STACK, fontSize: fs(9), letterSpacing: "0.06em", textTransform: "uppercase", color: soft, marginBottom: 12 }}>
                            <span style={{ color: colorAi }}>¿Acertó la IA?</span>
                            <span style={{ letterSpacing: 0, textTransform: "none" }}>Dijo la víspera → midió AEMET {ac.station.name}</span>
                        </div>
                        <div style={{ display: "grid", gridTemplateColumns: `repeat(${narrow ? 2 : 4}, minmax(0, 1fr))`, gap: 8 }}>
                            {aiDays.map((d, k) => {
                                const tone = d.ok == null ? faint : d.ok ? okColor : badColor
                                const big = k === 0
                                const line = (label: string, said: string, real: string | null, hit: boolean | null) => (
                                    <div style={{ minWidth: 0, fontFamily: MONO_STACK }}>
                                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: fs(8.5), letterSpacing: "0.08em", textTransform: "uppercase", color: soft }}>
                                            <span>{label}</span>
                                            <span style={{ color: hit == null ? soft : hit ? okColor : badColor }}>{hit == null ? "" : hit ? "✓" : "✗"}</span>
                                        </div>
                                        <div style={{ fontSize: big ? 11 : 10, color: ink, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", marginTop: 2 }}>
                                            {said}
                                            <span style={{ color: soft }}> → </span>
                                            {real ?? <span style={{ color: soft }}>…</span>}
                                        </div>
                                    </div>
                                )
                                return (
                                    <div
                                        key={d.day}
                                        className={`td-tile-${uid}`}
                                        style={{
                                            gridColumn: big ? "span 2" : undefined,
                                            borderRadius: 14,
                                            padding: big ? 14 : 12,
                                            minWidth: 0,
                                            overflow: "hidden",
                                            background: `linear-gradient(160deg, ${mix(bgColor, tone, 0.22)}, ${mix(bgColor, tone, 0.08)})`,
                                            boxShadow: `inset 0 0 0 1px ${mix(bgColor, tone, 0.35)}`,
                                            display: "grid",
                                            gap: 8,
                                            alignContent: "start",
                                            animationDelay: `${650 + k * 60}ms`,
                                        }}
                                    >
                                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                            <span style={{ fontFamily: MONO_STACK, fontSize: fs(9.5), letterSpacing: "0.04em", textTransform: "uppercase", color: ink }}>{d.label}</span>
                                            <span style={{ fontSize: big ? 22 : 16, lineHeight: 1, color: d.ok == null ? soft : d.ok ? okColor : badColor }}>{d.ok == null ? "…" : d.ok ? "✓" : "✗"}</span>
                                        </div>
                                        {d.rain && line(`Lluvia ${Math.round(d.rain.prob * 100)}%`, num(d.rain.mm, 1), d.obs?.mm != null ? `${num(d.obs.mm, 1)} mm` : null, d.rainHit)}
                                        {d.temp && line("Máx.", `${num(d.temp.max, 1)}°`, d.obs?.tmax != null ? `${num(d.obs.tmax, 1)}°` : null, d.maxHit)}
                                        {d.temp && line("Mín.", `${num(d.temp.min, 1)}°`, d.obs?.tmin != null ? `${num(d.obs.tmin, 1)}°` : null, d.minHit)}
                                        {big && d.ok == null && <span style={{ fontFamily: MONO_STACK, fontSize: fs(9), color: soft }}>AEMET publica lo medido unos 4 días después</span>}
                                    </div>
                                )
                            })}
                        </div>
                    </div>
                )}
            </div>
        </div>
    )
}

// Un número que «cuenta» hasta su valor escribiendo directamente en su nodo (fluido: no re-renderiza nada más).
function CountUp({ value }: { value: number }) {
    const ref = useRef<HTMLSpanElement | null>(null)
    const last = useRef<number | null>(null)
    useEffect(() => {
        const el = ref.current
        if (!el) return
        const from = last.current ?? value - 12
        last.current = value
        const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
        if (reduce || typeof requestAnimationFrame === "undefined") {
            el.textContent = String(Math.round(value))
            return
        }
        let raf = 0
        const t0 = performance.now()
        const tick = (now: number) => {
            const k = Math.min(1, (now - t0) / 900)
            const e = 1 - Math.pow(1 - k, 4)
            el.textContent = String(Math.round(from + (value - from) * e))
            if (k < 1) raf = requestAnimationFrame(tick)
        }
        raf = requestAnimationFrame(tick)
        return () => cancelAnimationFrame(raf)
    }, [value])
    return <span ref={ref}>{Math.round(value)}</span>
}

// Color en una escala de puntos [valor, color], mezclando entre los dos vecinos.
function scaleColor(stops: [number, string][], v: number) {
    if (v <= stops[0][0]) return mix(stops[0][1], stops[0][1], 0)
    for (let i = 1; i < stops.length; i++) {
        const [v1, c1] = stops[i]
        const [v0, c0] = stops[i - 1]
        if (v <= v1) return mix(c0, c1, (v - v0) / Math.max(v1 - v0, 1e-6))
    }
    return mix(stops[stops.length - 1][1], stops[stops.length - 1][1], 0)
}

// Color del viento: de calma (azul petróleo) a fuerte (magenta, violeta), en km/h.
const WIND_STOPS: [number, string][] = [
    [0, "#1e4a5c"],
    [10, "#1f8f8c"],
    [20, "#3cc48a"],
    [30, "#d6d84c"],
    [45, "#f08a3a"],
    [60, "#e0407a"],
    [80, "#9b3bd6"],
]
function windColor(v: number) {
    if (v <= 0) return WIND_STOPS[0][1]
    for (let i = 1; i < WIND_STOPS.length; i++) {
        const [v1, c1] = WIND_STOPS[i]
        const [v0, c0] = WIND_STOPS[i - 1]
        if (v <= v1) return mix(c0, c1, (v - v0) / (v1 - v0))
    }
    return WIND_STOPS[WIND_STOPS.length - 1][1]
}

// Gotas: un azulejo SVG con trazos cortos inclinados, que se repite y se mueve hacia abajo.
// Las mismas gotas en azul, para fondos claros
const DROPS_INK =
    "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='18' height='28'><g stroke='%234f6fd8' stroke-width='1.2' stroke-linecap='round'><line x1='4' y1='1' x2='2.8' y2='7'/><line x1='13' y1='12' x2='11.8' y2='18'/><line x1='8.5' y1='21' x2='7.6' y2='25.5'/><line x1='16.5' y1='3' x2='15.8' y2='6.5'/></g></svg>\")"
const DROPS =
    "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='18' height='28'><g stroke='%23d4e4ff' stroke-width='1.1' stroke-linecap='round'><line x1='4' y1='1' x2='2.8' y2='7'/><line x1='13' y1='12' x2='11.8' y2='18'/><line x1='8.5' y1='21' x2='7.6' y2='25.5'/><line x1='16.5' y1='3' x2='15.8' y2='6.5'/></g></svg>\")"
// Humo: manchas blancas difusas que se repiten en horizontal.
const SMOKE =
    "radial-gradient(ellipse 45% 55% at 25% 45%, rgba(225,230,240,.85), rgba(225,230,240,0) 70%), radial-gradient(ellipse 40% 45% at 70% 60%, rgba(205,212,225,.75), rgba(205,212,225,0) 70%), radial-gradient(ellipse 30% 40% at 50% 25%, rgba(240,242,248,.6), rgba(240,242,248,0) 70%)"

// El color de un cuadrado: la temperatura pone el tono, las nubes lo apagan, la noche lo oscurece
// y la lluvia lo convierte en un degradado azul que se mueve (más oscuro cuanto más llueve).
const VIVID: [number, string][] = [
    [-5, "#3b2bd1"],
    [3, "#2f6fe0"],
    [9, "#1fa2c9"],
    [14, "#3fbf9a"],
    [18, "#b9d35a"],
    [22, "#f6c341"],
    [27, "#f28a3a"],
    [33, "#e2452f"],
    [40, "#a11d33"],
]
// Acepta cualquier color de Framer: «#rgb», «#rrggbb(aa)», «rgb(…)» o «rgba(…)». Si no lo entiende, gris.
function hexRgb(c: string): number[] {
    const v = (c || "").trim()
    if (v.startsWith("#")) {
        const h = v.length === 4 || v.length === 5 ? [...v.slice(1, 4)].map((x) => x + x).join("") : v.slice(1, 7)
        const out = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16))
        return out.some((n) => isNaN(n)) ? [128, 128, 128] : out
    }
    const m = v.match(/rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i)
    return m ? [m[1], m[2], m[3]].map((n) => Math.round(Number(n))) : [128, 128, 128]
}
const mix = (a: string, b: string, k: number) => {
    const A = hexRgb(a),
        B = hexRgb(b)
    return `#${A.map((v, i) => Math.round(v + (B[i] - v) * k).toString(16).padStart(2, "0")).join("")}`
}
function vivid(t: number) {
    if (t <= VIVID[0][0]) return VIVID[0][1]
    for (let i = 1; i < VIVID.length; i++) {
        const [t1, c1] = VIVID[i]
        const [t0, c0] = VIVID[i - 1]
        if (t <= t1) return mix(c0, c1, (t - t0) / (t1 - t0))
    }
    return VIVID[VIVID.length - 1][1]
}
function cellPaint(t: number, cloud: N, rain: number, night: boolean): { style: CSSProperties; rain: boolean; base: string } {
    let c = vivid(t)
    if (cloud != null) c = mix(c, "#b7bac2", (cloud / 100) * 0.6)
    if (night) c = mix(c, "#1b2140", 0.28)
    if (rain >= 0.1) {
        // Lluvia: rayas diagonales que caen por encima, sin tapar el color de la temperatura.
        const k = Math.min(1, Math.log1p(rain) / Math.log1p(4))
        const a = (0.35 + 0.45 * k).toFixed(2)
        const gap = Math.round(7 - 3 * k)
        return {
            style: {
                backgroundColor: c,
                backgroundImage: `repeating-linear-gradient(115deg, rgba(12,30,140,${a}) 0 1.5px, transparent 1.5px ${gap}px)`,
                backgroundSize: "24px 24px",
            },
            rain: true,
            base: c,
        }
    }
    return { style: { background: c }, rain: false, base: c }
}

// Cada control se ve solo en las secciones a las que afecta («Todo» los muestra según lo que esté encendido)
const only =
    (...secs: string[]) =>
    (p: any) =>
        p.section !== "todo" && !secs.includes(p.section)
const inTodo =
    (flag: string, ...secs: string[]) =>
    (p: any) =>
        p.section === "todo" ? !p[flag] : !secs.includes(p.section)

addPropertyControls(TiempoApp, {
    // Básico
    section: {
        type: ControlType.Enum,
        title: "Mostrar",
        options: ["todo", "ahora", "temperatura", "curva", "viento", "sensacion", "lluvia", "acierto"],
        optionTitles: ["Todo", "Ahora", "Banda temperatura", "Gráfica temperatura", "Banda viento", "Sensación térmica", "Lluvia acumulada", "¿Acertó la IA?"],
        defaultValue: "todo",
    },
    cityId: {
        type: ControlType.Enum,
        title: "Ciudad",
        options: ["global", ...CITIES.map((c) => c[0])],
        optionTitles: ["Global (la de la página)", ...CITIES.map((c) => c[1])],
        defaultValue: "global",
    },
    days: { type: ControlType.Number, title: "Días", min: 3, max: 7, step: 1, defaultValue: 7, hidden: only("temperatura", "curva", "viento", "sensacion", "lluvia") },
    textScale: { type: ControlType.Number, title: "Tamaño textos", min: 0.8, max: 2, step: 0.05, defaultValue: 1.3 },

    // Qué se ve (solo en «Todo»)
    showNow: { type: ControlType.Boolean, title: "Ahora", defaultValue: true, hidden: (p: any) => p.section !== "todo" },
    showTempBand: { type: ControlType.Boolean, title: "Banda temp.", defaultValue: true, hidden: (p: any) => p.section !== "todo" },
    showWindBand: { type: ControlType.Boolean, title: "Banda viento", defaultValue: true, hidden: (p: any) => p.section !== "todo" },
    showFeelsBand: { type: ControlType.Boolean, title: "Sensación térm.", defaultValue: true, hidden: (p: any) => p.section !== "todo" },
    showRainChart: { type: ControlType.Boolean, title: "Lluvia acum.", defaultValue: true, hidden: (p: any) => p.section !== "todo" },
    showAi: { type: ControlType.Boolean, title: "¿Acertó la IA?", defaultValue: true, hidden: (p: any) => p.section !== "todo" },

    // Caja
    container: { type: ControlType.Boolean, title: "Caja (fondo)", defaultValue: true },
    padding: { type: ControlType.Number, title: "Margen", min: 0, max: 64, defaultValue: 22, hidden: (p: any) => !p.container },
    radius: { type: ControlType.Number, title: "Esquinas", min: 0, max: 48, defaultValue: 28, hidden: (p: any) => !p.container },
    shadow: { type: ControlType.BoxShadow, title: "Sombra", defaultValue: "0 1px 2px rgba(11,11,11,0.04)", hidden: (p: any) => !p.container },
    tile: { type: ControlType.Boolean, title: "Banda como tarjeta", defaultValue: false, hidden: (p: any) => !["temperatura", "viento", "sensacion"].includes(p.section) },
    tileSoft: { type: ControlType.Number, title: "Suavidad tarjeta", min: 0, max: 0.9, step: 0.05, defaultValue: 0.55, hidden: (p: any) => !p.tile || p.section !== "temperatura" },

    // Colores generales
    bgColor: { type: ControlType.Color, title: "Fondo", defaultValue: "#f4f4f2" },
    inkColor: { type: ControlType.Color, title: "Texto", defaultValue: "#141414" },
    softColor: { type: ControlType.Color, title: "Texto suave", defaultValue: "#5f5f5a" },
    fontFamily: { type: ControlType.String, title: "Letra", defaultValue: "", placeholder: "Outfit" },
    palette: {
        type: ControlType.Enum,
        title: "Paleta temp.",
        options: ["vivo", "clasico", "mono", "propia"],
        optionTitles: ["Viva", "Clásica", "Mono", "Propia"],
        defaultValue: "vivo",
        hidden: only("ahora", "temperatura", "curva", "sensacion"),
    },
    tempColor1: { type: ControlType.Color, title: "Temp. −5°", defaultValue: "#3b2bd1", hidden: (p: any) => p.palette !== "propia" },
    tempColor2: { type: ControlType.Color, title: "Temp. 5°", defaultValue: "#1fa2c9", hidden: (p: any) => p.palette !== "propia" },
    tempColor3: { type: ControlType.Color, title: "Temp. 15°", defaultValue: "#3fbf9a", hidden: (p: any) => p.palette !== "propia" },
    tempColor4: { type: ControlType.Color, title: "Temp. 25°", defaultValue: "#f6c341", hidden: (p: any) => p.palette !== "propia" },
    tempColor5: { type: ControlType.Color, title: "Temp. 35°", defaultValue: "#e2452f", hidden: (p: any) => p.palette !== "propia" },

    // Ahora
    tempSize: { type: ControlType.Number, title: "Tamaño temp.", min: 48, max: 240, step: 4, defaultValue: 144, hidden: inTodo("showNow", "ahora") },
    tempWeight: { type: ControlType.Number, title: "Grosor temp.", min: 100, max: 900, step: 100, defaultValue: 200, hidden: inTodo("showNow", "ahora") },

    // Banda y gráfica de temperatura
    bandHeight: { type: ControlType.Number, title: "Alto banda", min: 24, max: 200, defaultValue: 84, hidden: inTodo("showTempBand", "temperatura") },
    bandBlur: { type: ControlType.Number, title: "Desenfoque banda", min: 0, max: 12, step: 0.5, defaultValue: 0, hidden: inTodo("showTempBand", "temperatura") },
    tempLine: { type: ControlType.Boolean, title: "Línea de temp.", defaultValue: false, hidden: only("temperatura", "curva") },
    chartHeight: { type: ControlType.Number, title: "Alto gráfica", min: 60, max: 300, defaultValue: 160, hidden: only("curva", "lluvia") },
    chartBlur: { type: ControlType.Number, title: "Difuminado", min: 0, max: 16, step: 1, defaultValue: 4, hidden: only("curva") },
    showChartWind: { type: ControlType.Boolean, title: "Viento de fondo", defaultValue: true, hidden: only("curva") },
    chartWindOpacity: { type: ControlType.Number, title: "Opacidad viento", min: 0.05, max: 1, step: 0.05, defaultValue: 0.35, hidden: (p: any) => !p.showChartWind || only("curva")(p) },
    chartWindDensity: { type: ControlType.Number, title: "Cantidad partículas", min: 0.2, max: 3, step: 0.1, defaultValue: 1, hidden: (p: any) => !p.showChartWind || only("curva")(p) },
    showClouds: { type: ControlType.Boolean, title: "Nubes", defaultValue: true, hidden: only("temperatura", "curva") },
    cloudColor: { type: ControlType.Color, title: "Color nubes", defaultValue: "#ebeef5", hidden: (p: any) => !p.showClouds || only("temperatura", "curva")(p) },
    cloudOpacity: { type: ControlType.Number, title: "Nubes (fuerza)", min: 0, max: 1.5, step: 0.05, defaultValue: 1, hidden: (p: any) => !p.showClouds || only("temperatura", "curva")(p) },
    showRain: { type: ControlType.Boolean, title: "Gotas de lluvia", defaultValue: true, hidden: only("temperatura", "curva") },

    // Viento
    windBandHeight: { type: ControlType.Number, title: "Alto viento", min: 20, max: 160, defaultValue: 80, hidden: inTodo("showWindBand", "viento") },
    showArrows: { type: ControlType.Boolean, title: "Partículas", defaultValue: true, hidden: inTodo("showWindBand", "viento") },
    arrowSize: { type: ControlType.Number, title: "Tamaño flecha", min: 5, max: 24, defaultValue: 12, hidden: (p: any) => !p.showArrows || inTodo("showWindBand", "viento")(p) },
    windMax: { type: ControlType.Number, title: "Escala viento", min: 20, max: 120, step: 5, unit: " km/h", defaultValue: 60, hidden: only("viento", "curva") },
    windColor1: { type: ControlType.Color, title: "Viento calma", defaultValue: "#dcebf8", hidden: inTodo("showWindBand", "viento") },
    windColor2: { type: ControlType.Color, title: "Viento flojo", defaultValue: "#a8d6ee", hidden: inTodo("showWindBand", "viento") },
    windColor3: { type: ControlType.Color, title: "Viento fuerte", defaultValue: "#6aa8e8", hidden: inTodo("showWindBand", "viento") },
    windColor4: { type: ControlType.Color, title: "Viento máx.", defaultValue: "#4b55d6", hidden: inTodo("showWindBand", "viento") },

    // Sensación térmica
    feelsBandHeight: { type: ControlType.Number, title: "Alto sensación", min: 20, max: 160, defaultValue: 44, hidden: inTodo("showFeelsBand", "sensacion") },
    feelsColor1: { type: ControlType.Color, title: "Sens. bien", defaultValue: "#3fbf8a", hidden: inTodo("showFeelsBand", "sensacion") },
    feelsColor2: { type: ControlType.Color, title: "Sens. precaución", defaultValue: "#e6c84a", hidden: inTodo("showFeelsBand", "sensacion") },
    feelsColor3: { type: ControlType.Color, title: "Sens. mal", defaultValue: "#ef8a3a", hidden: inTodo("showFeelsBand", "sensacion") },
    feelsColor4: { type: ControlType.Color, title: "Sens. peligro", defaultValue: "#e0405a", hidden: inTodo("showFeelsBand", "sensacion") },

    // Lluvia acumulada
    rainColor1: { type: ControlType.Color, title: "Lluvia 1", defaultValue: "#8f7bff", hidden: inTodo("showRainChart", "lluvia") },
    rainColor2: { type: ControlType.Color, title: "Lluvia 2", defaultValue: "#4d6bff", hidden: inTodo("showRainChart", "lluvia") },
    rainColor3: { type: ControlType.Color, title: "Lluvia 3", defaultValue: "#59e0c8", hidden: inTodo("showRainChart", "lluvia") },

    // ¿Acertó la IA?
    colorAi: { type: ControlType.Color, title: "Color IA", defaultValue: "#8f7bff", hidden: inTodo("showAi", "acierto") },

    // Efectos
    aurora: { type: ControlType.Boolean, title: "Aurora", defaultValue: false },
    auroraStrength: { type: ControlType.Number, title: "Fuerza aurora", min: 0, max: 1, step: 0.05, defaultValue: 0.5, hidden: (p: any) => !p.aurora },
    grain: { type: ControlType.Boolean, title: "Grano", defaultValue: false },
    animations: { type: ControlType.Boolean, title: "Animaciones", defaultValue: true },
    baseUrl: {
        type: ControlType.String,
        title: "URL de datos",
        defaultValue: "https://tmnnidlzmwxgpxufqkgm.supabase.co/storage/v1/object/public/weather",
    },
})
