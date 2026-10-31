import { addPropertyControls, ControlType } from "framer"
import {
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
    city: { id: string; name: string; tz: string }
    attribution: string
    models: ModelSeries[]
    accuracy?: Accuracy
}
type Step = {
    t: number
    temp: number
    rain: number
    cloud: N
    wind: N
    windDir: N
    pressure: N
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
                wind: mean(nums((s) => s.wind)),
                windDir: list[0].s.windDir,
                pressure: mean(nums((s) => s.pressure)),
            }
        })
}

const num = (v: number, digits = 0) =>
    v.toLocaleString("es-ES", { maximumFractionDigits: digits })
const mm = (v: number) => `${num(v, 1)} mm`
const COMPASS = ["N", "NE", "E", "SE", "S", "SO", "O", "NO"]
const compass = (deg: number) => COMPASS[Math.round(deg / 45) % 8]

// Curva suave que pasa por todos los puntos sin pasarse de ellos (cúbica monótona, Fritsch-Carlson):
// así una curva redondeada nunca dibuja una máxima o una mínima que el modelo no ha dado.
function smoothPath(p: [number, number][]): string {
    const n = p.length
    if (!n) return ""
    const f = (v: number) => v.toFixed(1)
    if (n === 1) return `M${f(p[0][0])},${f(p[0][1])}`
    const dx: number[] = [], m: number[] = []
    for (let i = 0; i < n - 1; i++) {
        dx.push(p[i + 1][0] - p[i][0])
        m.push((p[i + 1][1] - p[i][1]) / (dx[i] || 1))
    }
    const t: number[] = [m[0]]
    for (let i = 1; i < n - 1; i++) {
        if (m[i - 1] * m[i] <= 0) t.push(0)
        else {
            const w1 = 2 * dx[i] + dx[i - 1], w2 = dx[i] + 2 * dx[i - 1]
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
            "https://fonts.googleapis.com/css2?family=Outfit:wght@200;300;400;500;600;700&display=swap"
        document.head.appendChild(link)
    }
    if (typeof document.fonts !== "undefined") {
        void document.fonts.load("400 13px Outfit")
        void document.fonts.load("600 24px Outfit")
        void document.fonts.load("200 84px Outfit")
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

type Kind = "clear-day" | "clear-night" | "partly-day" | "partly-night" | "cloudy" | "overcast" | "drizzle" | "rain" | "unknown"

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
    if (kind === "rain" || kind === "drizzle") return "linear-gradient(160deg, #3d4f66 0%, #5f7690 55%, #8aa0b6 100%)"
    if (isNight(hour)) return "linear-gradient(160deg, #0b1630 0%, #1b2d55 55%, #34497a 100%)"
    if (kind === "overcast" || kind === "cloudy") return "linear-gradient(160deg, #50708f 0%, #7d9ab5 55%, #b4c6d6 100%)"
    if (hour < 9 || hour >= 18) return "linear-gradient(160deg, #4c4aa8 0%, #9a6bc4 50%, #f2a48a 100%)"
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
function Icon({ kind, size = 24, onSky = false }: { kind: Kind; size?: number; onSky?: boolean }) {
    const cloudFill = onSky ? "rgba(255,255,255,0.96)" : "#e8eef5"
    const cloudStroke = onSky ? "rgba(255,255,255,0.0)" : "#9fb0c3"
    const sun = "#fbbf24"
    const rays = (cx: number, cy: number, r1: number, r2: number) =>
        [0, 45, 90, 135, 180, 225, 270, 315].map((a) => {
            const rad = (a * Math.PI) / 180
            return (
                <line key={a} x1={cx + Math.cos(rad) * r1} y1={cy + Math.sin(rad) * r1} x2={cx + Math.cos(rad) * r2} y2={cy + Math.sin(rad) * r2}
                    stroke={sun} strokeWidth={1.8} strokeLinecap="round" />
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
        <path transform={`translate(${dx} ${dy}) scale(${s})`} d="M15.5 4.5a7.5 7.5 0 1 0 4 13.4A6.5 6.5 0 0 1 15.5 4.5z"
            fill={onSky ? "#f1f5f9" : "#c7d2fe"} />
    )
    const drops = (n: number) =>
        Array.from({ length: n }, (_, i) => (
            <line key={i} x1={9 + i * 3.5} y1={20.5} x2={8 + i * 3.5} y2={23} stroke="#60a5fa" strokeWidth={1.8} strokeLinecap="round" />
        ))
    let body
    switch (kind) {
        case "clear-day":
            body = <>{rays(12, 12, 7, 9.6)}<circle cx={12} cy={12} r={4.8} fill={sun} /></>
            break
        case "clear-night":
            body = moon()
            break
        case "partly-day":
            body = <>{rays(9, 8.5, 4.6, 6.4)}<circle cx={9} cy={8.5} r={3.3} fill={sun} />{cloud(2.5, 1.5, 0.85)}</>
            break
        case "partly-night":
            body = <>{moon(-3, -2, 0.75)}{cloud(2.5, 1.5, 0.85)}</>
            break
        case "cloudy":
            body = <>{cloud(3.5, -3.5, 0.75)}{cloud(-0.5, 0.5)}</>
            break
        case "overcast":
            body = <>{cloud(3.5, -4, 0.75)}<g opacity={onSky ? 0.85 : 1}>{cloud(-0.5, 0.5)}</g></>
            break
        case "drizzle":
            body = <>{cloud(0, -2.5)}{drops(2)}</>
            break
        case "rain":
            body = <>{cloud(0, -2.5)}{drops(3)}</>
            break
        default:
            body = (
                <>
                    <rect x={10} y={3} width={4} height={13} rx={2} fill="none" stroke={onSky ? "#fff" : "#9fb0c3"} strokeWidth={1.6} />
                    <circle cx={12} cy={18} r={3.5} fill="#f97316" />
                    <line x1={12} y1={9} x2={12} y2={16} stroke="#f97316" strokeWidth={1.8} strokeLinecap="round" />
                </>
            )
    }
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" style={{ display: "block", flex: "none", overflow: "visible" }} aria-label={KIND_LABEL[kind]} role="img">
            {body}
        </svg>
    )
}

function Drop({ size = 10 }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 12 12" style={{ display: "inline-block", verticalAlign: "-1px" }} aria-hidden>
            <path d="M6 1.2C6 1.2 2.4 5.4 2.4 7.6a3.6 3.6 0 0 0 7.2 0C9.6 5.4 6 1.2 6 1.2z" fill="#60a5fa" />
        </svg>
    )
}

interface Props {
    baseUrl: string
    cityId: string
    model: string
    chartDays: number
    chartHeight: number
    showModels: boolean
    hours: number
    days: number
    colorIfs: string
    colorAifs: string
    colorGfs: string
    colorIcon: string
    colorArpege: string
    colorArome: string
    colorUkmo: string
    colorGem: string
    dynamicSky: boolean
    background: string
    textColor: string
    mutedColor: string
    accent: string
    gridColor: string
    radius: number
    borderColor: string
    borderWidth: number
    borderOpacity: number
    shadow: string
    effectIntensity: number
    motionSpeed: number
    titleFont: FontValue
    bodyFont: FontValue
    style?: CSSProperties
}

/**
 * El tiempo de una ciudad en una sola tarjeta: ahora, la gráfica de temperatura con todos los modelos
 * (la línea gruesa es la media o el modelo elegido), las próximas horas y los próximos días.
 *
 * @framerSupportedLayoutWidth any
 * @framerSupportedLayoutHeight auto
 */
export default function WeatherCard(props: Props) {
    const {
        baseUrl = "",
        cityId = "madrid",
        model = "media",
        chartDays = 3,
        chartHeight = 230,
        showModels = true,
        hours = 10,
        days = 7,
        dynamicSky = true,
        background = "#f4f7fb",
        textColor = "#0f172a",
        mutedColor = "#64748b",
        accent = "#2563eb",
        gridColor = "transparent",
        radius = 28,
        borderColor = "rgba(255,255,255,0.6)",
        borderWidth = 1,
        borderOpacity = 0.5,
        shadow = "0 24px 60px rgba(15,23,42,0.16)",
        effectIntensity = 0.5,
        motionSpeed = 0.6,
        titleFont = { fontSize: "15px", lineHeight: "1.2em", letterSpacing: "0.02em", fontWeight: 500 },
        bodyFont = { fontSize: "13px", lineHeight: "1.35em", letterSpacing: "-0.01em", fontWeight: 500 },
        colorIfs = "#2a78d6",
        colorAifs = "#eb6834",
        colorGfs = "#1baf7a",
        colorIcon = "#eda100",
        colorArpege = "#e87ba4",
        colorArome = "#e34948",
        colorUkmo = "#008300",
        colorGem = "#6250d6",
        style,
    } = props
    const color: Record<string, string> = {
        ifs: colorIfs,
        aifs: colorAifs,
        gfs: colorGfs,
        "icon-eu": colorIcon,
        arpege: colorArpege,
        arome: colorArome,
        ukmo: colorUkmo,
        gem: colorGem,
    }
    const safeTitleFont = useMemo(() => ({ ...titleFont, fontFamily: OUTFIT_STACK }), [titleFont])
    const safeBodyFont = useMemo(() => ({ ...bodyFont, fontFamily: OUTFIT_STACK }), [bodyFont])
    const uid = useId().replace(/:/g, "")
    useEffect(() => {
        if (typeof window !== "undefined") ensureOutfitFont()
    }, [])

    const url = baseUrl ? `${baseUrl.replace(/\/$/, "")}/cities/${cityId}.json` : ""
    const [data, setData] = useState<CityDoc | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [hover, setHover] = useState<number | null>(null)
    const [focus, setFocus] = useState<string | null>(null)
    const [hidden, setHidden] = useState<string[]>([])
    const [chartRef, chartWidth] = useWidth()

    useEffect(() => {
        if (!url) return
        let alive = true
        startTransition(() => setError(null))
        load(url)
            .then((d) => alive && startTransition(() => setData(d)))
            .catch((e) => alive && startTransition(() => setError(String(e.message ?? e))))
        return () => {
            alive = false
        }
    }, [url])

    const view = useMemo(() => {
        if (!data || !data.models.length) return null
        const best = mostAccurate(data.accuracy, data.models.map((m) => m.id))
        const chosen = data.models.find((m) => m.id === (model === "mejor" ? best?.id : model))
        const steps = chosen ? stepsOf(chosen) : average(data.models)
        if (!steps.length) return null
        const bestScore = best && `±${num(best.mae, 1)}° a 24 h`
        const source = !chosen
            ? `Media de ${data.models.length} modelos`
            : model === "mejor"
              ? `${chosen.name}, el más preciso ${best!.where} (${bestScore})`
              : chosen.name
        const allSteps = data.models.map(stepsOf)

        const tz = data.city.tz
        const fmt = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("es-ES", { timeZone: tz, ...o })
        const dayKey = new Intl.DateTimeFormat("en-CA", { timeZone: tz })
        const hourOf = (t: number) => Number(fmt({ hour: "numeric", hourCycle: "h23" }).format(new Date(t)))

        // El paso más cercano a ahora; si la pasada es antigua, el último que haya.
        const now = Date.now()
        let current = 0
        for (let i = 0; i < steps.length; i++)
            if (Math.abs(steps[i].t - now) < Math.abs(steps[current].t - now)) current = i

        const next = steps.slice(current, current + hours).map((s) => ({
            t: s.t,
            label: fmt({ hour: "2-digit", minute: "2-digit" }).format(new Date(s.t)),
            kind: kindOf(s.rain, s.cloud, isNight(hourOf(s.t))),
            temp: Math.round(s.temp),
            rain: Math.round(s.rain * 10) / 10,
        }))

        // Los días enteros desde hoy: «Hoy» cuenta también las horas que ya han pasado, para su máxima y mínima.
        const todayKey = dayKey.format(new Date(steps[current].t))
        const byDay = new Map<string, Step[]>()
        for (const s of steps.filter((s) => dayKey.format(new Date(s.t)) >= todayKey)) {
            const k = dayKey.format(new Date(s.t))
            if (!byDay.has(k)) byDay.set(k, [])
            byDay.get(k)!.push(s)
        }
        const daily = [...byDay.entries()].slice(0, days).map(([key, list], i) => {
            const daytime = list.filter((s) => hourOf(s.t) >= 9 && hourOf(s.t) <= 18)
            const ref = daytime.length ? daytime : list
            const rain = list.reduce((a, s) => a + s.rain, 0)
            // Cada modelo que llegue hasta el final del día: su máxima y si da lluvia, en las mismas horas.
            const first = list[0].t, last = list[list.length - 1].t
            const others = allSteps.flatMap((ms) => {
                if (!ms.length || ms[ms.length - 1].t < last - 3 * HOUR) return []
                const inDay = ms.filter((s) => s.t >= first && s.t <= last)
                return inDay.length
                    ? [{ max: Math.max(...inDay.map((s) => s.temp)), rain: inDay.reduce((a, s) => a + s.rain, 0) }]
                    : []
            })
            const clouds = ref.flatMap((s) => (s.cloud == null ? [] : [s.cloud]))
            const cloud = clouds.length ? clouds.reduce((a, b) => a + b, 0) / clouds.length : null
            const dayRain = Math.round(rain * 10) / 10
            return {
                key,
                label: i === 0 ? "Hoy" : fmt({ weekday: "short", day: "numeric" }).format(new Date(list[0].t)),
                kind: kindOf(rain >= 5 ? 2 : rain >= 1 ? 0.3 : 0, cloud, false),
                min: Math.round(Math.min(...list.map((s) => s.temp))),
                max: Math.round(Math.max(...list.map((s) => s.temp))),
                rain: dayRain,
                conf: confidence(others.map((o) => o.max), others.filter((o) => o.rain >= 1).length),
            }
        })

        // Gráfica: desde 3 h antes de ahora hasta la medianoche local tras chartDays días.
        const start = Math.floor((now - 3 * HOUR) / HOUR) * HOUR
        let end = start + chartDays * 24 * HOUR
        while (hourOf(end) !== 0) end += HOUR
        const inWindow = (s: Step) => s.t >= start && s.t <= end
        const main = steps.filter(inWindow)
        const lines = MODELS.flatMap(([id, short]) => {
            const m = data.models.find((x) => x.id === id)
            if (!m) return []
            const pts = stepsOf(m).filter(inWindow)
            return pts.length ? [{ id, short, name: m.name, resolution: m.resolution, run: Date.parse(m.run), pts }] : []
        })
        const midnights: number[] = []
        for (let t = start + HOUR; t < end; t += HOUR) if (hourOf(t) === 0) midnights.push(t)

        const c = steps[current]
        const hourNow = hourOf(c.t)
        const kindNow = kindOf(c.rain, c.cloud, isNight(hourNow))
        return {
            name: data.city.name,
            source,
            mainId: chosen?.id ?? null,
            mainLabel: chosen ? chosen.name : "Media",
            now: { ...c, kind: kindNow, hour: hourNow },
            next,
            daily,
            best: best && model !== "mejor"
                ? `Más preciso ${best.where}: ${data.models.find((m) => m.id === best.id)?.name} (${bestScore})`
                : null,
            attribution: data.attribution,
            chart: { start, end, main, lines, midnights, nowT: now },
            fmtDay: fmt({ weekday: "short", day: "numeric" }),
            fmtTime: fmt({ weekday: "long", hour: "2-digit", minute: "2-digit" }),
            fmtRun: fmt({ day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }),
        }
    }, [data, model, hours, days, chartDays])

    const safeGrid = isTransparentColor(gridColor) ? "rgba(15, 23, 42, 0.06)" : gridColor
    const glassBorder = `1px solid rgba(255, 255, 255, ${Math.min(1, borderOpacity + 0.2)})`
    const box: CSSProperties = {
        width: "100%",
        minWidth: 0,
        boxSizing: "border-box",
        padding: 16,
        borderRadius: radius,
        background,
        color: textColor,
        display: "flex",
        flexDirection: "column",
        gap: 12,
        position: "relative",
        border: `${borderWidth}px solid ${borderColor}`,
        boxShadow: shadow,
        overflow: "hidden",
        ...style,
        fontFamily: OUTFIT_STACK,
    }
    const muted: CSSProperties = { ...fontStyle(safeBodyFont), color: mutedColor, fontSize: 12 }
    const card: CSSProperties = {
        position: "relative",
        zIndex: 1,
        borderRadius: Math.max(radius - 8, 12),
        border: glassBorder,
        background: "rgba(255,255,255,0.82)",
        backdropFilter: "blur(18px) saturate(1.4)",
        WebkitBackdropFilter: "blur(18px) saturate(1.4)",
        boxShadow: "0 1px 0 rgba(255,255,255,0.8) inset, 0 8px 24px rgba(15,23,42,0.06)",
    }
    const sectionTitle: CSSProperties = { ...muted, fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase" }
    const dot = (c: string, size = 8): CSSProperties => ({ width: size, height: size, borderRadius: size / 2, background: c, flex: "none" })

    if (!baseUrl) return <div style={box}>Pon la URL del cubo de Supabase en el panel de la derecha.</div>
    if (error) return <div style={box}>No se pudo cargar el pronóstico ({error}).</div>
    if (!view) return <div style={box}><span style={muted}>Cargando…</span></div>

    // --- Gráfica ---
    const { chart } = view
    const visible = showModels ? chart.lines.filter((l) => !hidden.includes(l.id) && l.id !== view.mainId) : []
    const temps = [...chart.main.map((s) => s.temp), ...visible.flatMap((l) => l.pts.map((s) => s.temp))]
    const lo = Math.min(...temps), hi = Math.max(...temps)
    const tickStep = hi - lo <= 8 ? 2 : hi - lo <= 20 ? 5 : 10
    const yMin = Math.floor((lo - 0.5) / tickStep) * tickStep
    const yMax = Math.max(Math.ceil((hi + 0.5) / tickStep) * tickStep, yMin + tickStep)
    const ticks: number[] = []
    for (let v = yMin; v <= yMax; v += tickStep) ticks.push(v)

    const rainBand = 30
    const ml = 30, mr = 8, mt = 30, mb = 24 + rainBand
    const w = Math.max(chartWidth, 240)
    const h = chartHeight + rainBand
    const x = (t: number) => ml + ((t - chart.start) / (chart.end - chart.start)) * (w - ml - mr)
    const y = (v: number) => mt + ((yMax - v) / (yMax - yMin)) * (h - mt - mb)
    const pts = (s: Step[]) => s.map((p) => [x(p.t), y(p.temp)] as [number, number])
    const mainPath = smoothPath(pts(chart.main))
    const base = h - mb
    const areaPath = chart.main.length > 1
        ? `${mainPath}L${x(chart.main[chart.main.length - 1].t).toFixed(1)},${base}L${x(chart.main[0].t).toFixed(1)},${base}Z`
        : ""
    const dayWidth = ((24 * HOUR) / (chart.end - chart.start)) * (w - ml - mr)
    const labelEvery = Math.max(1, Math.ceil(52 / dayWidth))
    const nowInside = chart.nowT >= chart.start && chart.nowT <= chart.end
    // Máxima y mínima de lo que se ve, rotuladas sobre la curva.
    const peak = chart.main.length ? chart.main.reduce((a, b) => (b.temp > a.temp ? b : a)) : null
    const trough = chart.main.length ? chart.main.reduce((a, b) => (b.temp < a.temp ? b : a)) : null
    // Lluvia: una barra por paso de la línea principal, en la franja de abajo.
    const gap = chart.main.length > 1 ? Math.min(...chart.main.slice(1).map((s, i) => x(s.t) - x(chart.main[i].t))) : 10
    const barW = Math.max(2, Math.min(gap * 0.55, 10))
    const rainMax = Math.max(4, ...chart.main.map((s) => s.rain))
    const rainTop = h - 22 - rainBand + 6

    const nearest = (s: Step[], t: number) =>
        s.length ? s.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a)) : null
    const hovered = hover === null || !chart.main.length ? null : (() => {
        const m = nearest(chart.main, hover)!
        const rows = visible
            .flatMap((l) => {
                const p = nearest(l.pts, m.t)
                return p && Math.abs(p.t - m.t) <= 90 * 60_000 ? [{ id: l.id, short: l.short, p }] : []
            })
            .sort((a, b) => b.p.temp - a.p.temp)
        return { m, rows }
    })()
    const onMove = (e: PointerEvent<SVGRectElement>) => {
        const r = e.currentTarget.getBoundingClientRect()
        const t = chart.start + ((e.clientX - r.left) / r.width) * (chart.end - chart.start)
        startTransition(() => setHover(t))
    }
    const toggle = (id: string) => setHidden((hd) => (hd.includes(id) ? hd.filter((v) => v !== id) : [...hd, id]))
    const lineOpacity = (id: string) => (focus === null ? 0.42 : focus === id ? 1 : 0.1)

    // --- Cabecera ---
    const today = view.daily[0]
    const heroText = dynamicSky ? "#ffffff" : textColor
    const heroMuted = dynamicSky ? "rgba(255,255,255,0.78)" : mutedColor
    const wind = view.now.wind == null ? null
        : `${Math.round(view.now.wind)} km/h${view.now.windDir == null ? "" : " " + compass(view.now.windDir)}`
    const pressure = view.now.pressure == null ? null : `${Math.round(view.now.pressure)} hPa`
    const speed = Math.max(motionSpeed, 0.05)
    const stats = [
        wind && { label: "Viento", value: wind },
        pressure && { label: "Presión", value: pressure },
        today && { label: "Lluvia hoy", value: today.rain >= 0.1 ? mm(today.rain) : "0 mm" },
    ].filter(Boolean) as { label: string; value: string }[]

    // --- Días ---
    const weekLo = Math.min(...view.daily.map((d) => d.min))
    const weekHi = Math.max(...view.daily.map((d) => d.max))
    const span = Math.max(weekHi - weekLo, 1)

    return (
        <div style={box}>
            <style>{`
                @keyframes wc-drift-${uid} { 0% { transform: translate(-10%, -6%) scale(1); } 50% { transform: translate(8%, 6%) scale(1.15); } 100% { transform: translate(-10%, -6%) scale(1); } }
                @media (prefers-reduced-motion: reduce) { .wc-aurora-${uid} { animation: none !important; } }
                .wc-scroll-${uid}::-webkit-scrollbar { display: none; }
            `}</style>

            {/* Cabecera: el cielo de ahora */}
            <div
                style={{
                    position: "relative",
                    overflow: "hidden",
                    borderRadius: Math.max(radius - 8, 12),
                    padding: "22px 22px 18px",
                    background: dynamicSky ? skyGradient(view.now.kind, view.now.hour) : "transparent",
                    color: heroText,
                }}
            >
                {dynamicSky && effectIntensity > 0 && (
                    <div
                        className={`wc-aurora-${uid}`}
                        aria-hidden
                        style={{
                            position: "absolute",
                            inset: "-40%",
                            background: "radial-gradient(40% 40% at 30% 30%, rgba(255,255,255,0.55), rgba(255,255,255,0) 70%), radial-gradient(35% 35% at 75% 60%, rgba(255,255,255,0.35), rgba(255,255,255,0) 70%)",
                            opacity: Math.min(effectIntensity, 1) * 0.6,
                            animation: `wc-drift-${uid} ${Math.round(24 / speed)}s ease-in-out infinite`,
                            pointerEvents: "none",
                        }}
                    />
                )}
                <div style={{ position: "relative", display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
                    <div style={{ minWidth: 0 }}>
                        <div style={{ ...fontStyle(safeTitleFont), color: heroText, display: "flex", alignItems: "center", gap: 6 }}>
                            <svg width={12} height={12} viewBox="0 0 12 12" aria-hidden>
                                <path d="M6 0.8a4 4 0 0 0-4 4c0 3 4 6.4 4 6.4s4-3.4 4-6.4a4 4 0 0 0-4-4zm0 5.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z" fill="currentColor" />
                            </svg>
                            {view.name}
                        </div>
                        <div style={{ fontFamily: OUTFIT_STACK, fontSize: 84, fontWeight: 200, lineHeight: "0.95em", letterSpacing: "-0.05em", marginTop: 10 }}>
                            {Math.round(view.now.temp)}°
                        </div>
                        <div style={{ fontSize: 16, fontWeight: 500, marginTop: 6 }}>{KIND_LABEL[view.now.kind]}</div>
                        {today && (
                            <div style={{ fontSize: 13, color: heroMuted, marginTop: 2 }}>
                                Máx. {today.max}° · Mín. {today.min}°
                            </div>
                        )}
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 12 }}>
                        <Icon kind={view.now.kind} size={88} onSky={dynamicSky} />
                        {today?.conf && (
                            <span
                                title="Cuánto coinciden los modelos hoy"
                                style={{
                                    display: "inline-flex",
                                    alignItems: "center",
                                    gap: 6,
                                    padding: "5px 10px",
                                    borderRadius: 999,
                                    fontSize: 12,
                                    fontWeight: 500,
                                    background: dynamicSky ? "rgba(255,255,255,0.18)" : "rgba(15,23,42,0.05)",
                                    border: dynamicSky ? "1px solid rgba(255,255,255,0.3)" : "1px solid rgba(15,23,42,0.08)",
                                    backdropFilter: "blur(8px)",
                                    WebkitBackdropFilter: "blur(8px)",
                                    whiteSpace: "nowrap",
                                }}
                            >
                                <span style={dot(LEVELS[today.conf.level].color, 7)} />
                                {LEVELS[today.conf.level].label}
                            </span>
                        )}
                    </div>
                </div>
                {stats.length > 0 && (
                    <div style={{ position: "relative", display: "flex", gap: 8, marginTop: 18, flexWrap: "wrap" }}>
                        {stats.map((s) => (
                            <div
                                key={s.label}
                                style={{
                                    flex: "1 1 90px",
                                    padding: "8px 12px",
                                    borderRadius: 14,
                                    background: dynamicSky ? "rgba(255,255,255,0.14)" : "rgba(15,23,42,0.04)",
                                    border: dynamicSky ? "1px solid rgba(255,255,255,0.22)" : "1px solid rgba(15,23,42,0.06)",
                                }}
                            >
                                <div style={{ fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: heroMuted }}>{s.label}</div>
                                <div style={{ fontSize: 14, fontWeight: 600, marginTop: 2 }}>{s.value}</div>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* Próximas horas */}
            {view.next.length > 0 && (
                <div style={{ ...card, padding: "12px 10px 10px" }}>
                    <div style={{ ...sectionTitle, padding: "0 6px 8px" }}>Próximas horas</div>
                    <div className={`wc-scroll-${uid}`} style={{ display: "flex", gap: 6, overflowX: "auto", scrollbarWidth: "none" }}>
                        {view.next.map((hr, i) => (
                            <div
                                key={hr.t}
                                style={{
                                    display: "flex",
                                    flexDirection: "column",
                                    alignItems: "center",
                                    gap: 6,
                                    minWidth: 56,
                                    flex: "1 0 56px",
                                    padding: "10px 4px",
                                    borderRadius: 16,
                                    background: i === 0 ? accent : "transparent",
                                    color: i === 0 ? "#fff" : textColor,
                                    boxShadow: i === 0 ? `0 8px 20px ${accent}40` : "none",
                                }}
                            >
                                <span style={{ fontSize: 12, fontWeight: i === 0 ? 600 : 500, opacity: i === 0 ? 1 : 0.65 }}>
                                    {i === 0 ? "Ahora" : hr.label}
                                </span>
                                <Icon kind={hr.kind} size={26} onSky={i === 0} />
                                <span style={{ fontSize: 16, fontWeight: 600 }}>{hr.temp}°</span>
                                <span style={{ fontSize: 10.5, fontWeight: 500, color: i === 0 ? "#dbeafe" : "#3b82f6", visibility: hr.rain >= 0.1 ? "visible" : "hidden" }}>
                                    {num(hr.rain, 1)} mm
                                </span>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Gráfica */}
            <div style={{ ...card, padding: "14px 14px 8px" }}>
                <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 4 }}>
                    <div style={sectionTitle}>Temperatura · {view.mainLabel}</div>
                    {showModels && (
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                            {chart.lines.filter((l) => l.id !== view.mainId).map((l) => {
                                const off = hidden.includes(l.id)
                                return (
                                    <button
                                        key={l.id}
                                        type="button"
                                        onClick={() => toggle(l.id)}
                                        onPointerEnter={() => !off && setFocus(l.id)}
                                        onPointerLeave={() => setFocus(null)}
                                        title={`${l.name} · ${l.resolution} · pasada ${view.fmtRun.format(new Date(l.run))}${off ? " · pulsa para mostrar" : " · pulsa para ocultar"}`}
                                        style={{
                                            fontFamily: OUTFIT_STACK,
                                            display: "inline-flex",
                                            alignItems: "center",
                                            gap: 5,
                                            padding: "4px 9px",
                                            borderRadius: 999,
                                            border: "none",
                                            background: off ? "rgba(15,23,42,0.03)" : "rgba(15,23,42,0.06)",
                                            color: off ? mutedColor : textColor,
                                            opacity: off ? 0.45 : 1,
                                            textDecoration: off ? "line-through" : "none",
                                            cursor: "pointer",
                                            fontSize: 11,
                                            fontWeight: 500,
                                        }}
                                    >
                                        <span style={dot(color[l.id], 7)} />
                                        {l.short}
                                    </button>
                                )
                            })}
                        </div>
                    )}
                </div>

                <div ref={chartRef} style={{ position: "relative" }}>
                    <svg width={w} height={h} style={{ display: "block", overflow: "visible", fontFamily: OUTFIT_STACK }}>
                        <defs>
                            {/* El trazo cambia de color con la temperatura: cada altura de la gráfica, su color. */}
                            <linearGradient id={`wc-stroke-${uid}`} gradientUnits="userSpaceOnUse" x1="0" y1={y(yMax)} x2="0" y2={y(yMin)}>
                                {[0, 0.25, 0.5, 0.75, 1].map((k) => (
                                    <stop key={k} offset={`${k * 100}%`} stopColor={tempColor(yMax - k * (yMax - yMin))} />
                                ))}
                            </linearGradient>
                            <linearGradient id={`wc-area-${uid}`} gradientUnits="userSpaceOnUse" x1="0" y1={y(yMax)} x2="0" y2={base}>
                                <stop offset="0%" stopColor={tempColor(hi)} stopOpacity={0.28} />
                                <stop offset="100%" stopColor={tempColor(lo)} stopOpacity={0.02} />
                            </linearGradient>
                            <filter id={`wc-glow-${uid}`} x="-10%" y="-30%" width="120%" height="160%">
                                <feGaussianBlur stdDeviation="4" />
                            </filter>
                        </defs>
                        {ticks.map((v) => (
                            <g key={v}>
                                <line x1={ml} x2={w - mr} y1={y(v)} y2={y(v)} stroke={safeGrid} strokeWidth={1} strokeDasharray="3 5" />
                                <text x={ml - 8} y={y(v)} dy="0.32em" textAnchor="end" fontSize={10} fill={mutedColor} opacity={0.8}>{v}°</text>
                            </g>
                        ))}
                        {chart.midnights.map((t, i) => (
                            <g key={t}>
                                <line x1={x(t)} x2={x(t)} y1={mt - 6} y2={h - 22} stroke={safeGrid} strokeWidth={1} />
                                {i % labelEvery === 0 && (
                                    <text x={x(t) + 6} y={h - 6} fontSize={11} fontWeight={500} fill={mutedColor} style={{ textTransform: "capitalize" }}>
                                        {view.fmtDay.format(new Date(t + HOUR))}
                                    </text>
                                )}
                            </g>
                        ))}
                        {/* Lluvia */}
                        {chart.main.map((s) =>
                            s.rain >= 0.1 ? (
                                <rect
                                    key={s.t}
                                    x={x(s.t) - barW / 2}
                                    y={rainTop + rainBand - 6 - Math.max(2, (s.rain / rainMax) * (rainBand - 8))}
                                    width={barW}
                                    height={Math.max(2, (s.rain / rainMax) * (rainBand - 8))}
                                    rx={Math.min(barW / 2, 3)}
                                    fill="#60a5fa"
                                    opacity={0.75}
                                />
                            ) : null
                        )}
                        {areaPath && <path d={areaPath} fill={`url(#wc-area-${uid})`} />}
                        {visible.map((l) => (
                            <path
                                key={l.id}
                                d={smoothPath(pts(l.pts))}
                                fill="none"
                                stroke={color[l.id]}
                                strokeWidth={focus === l.id ? 2.25 : 1.25}
                                strokeOpacity={lineOpacity(l.id)}
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                style={{ transition: "stroke-opacity 180ms ease, stroke-width 180ms ease" }}
                            />
                        ))}
                        <path d={mainPath} fill="none" stroke={`url(#wc-stroke-${uid})`} strokeWidth={6} strokeOpacity={0.35} filter={`url(#wc-glow-${uid})`} />
                        <path d={mainPath} fill="none" stroke={`url(#wc-stroke-${uid})`} strokeWidth={3.25} strokeLinecap="round" strokeLinejoin="round" />
                        {peak && trough && !hovered && (
                            <g fontSize={11} fontWeight={600} fill={textColor} textAnchor="middle">
                                <text x={Math.min(Math.max(x(peak.t), ml + 12), w - mr - 12)} y={y(peak.temp) - 10}>{Math.round(peak.temp)}°</text>
                                {trough !== peak && (
                                    <text x={Math.min(Math.max(x(trough.t), ml + 12), w - mr - 12)} y={y(trough.temp) + 18} fill={mutedColor}>{Math.round(trough.temp)}°</text>
                                )}
                            </g>
                        )}
                        {nowInside && (
                            <g>
                                <line x1={x(chart.nowT)} x2={x(chart.nowT)} y1={mt - 4} y2={base} stroke={accent} strokeWidth={1.25} strokeDasharray="2 4" />
                                <rect x={x(chart.nowT) - 22} y={mt - 24} width={44} height={18} rx={9} fill={accent} />
                                <text x={x(chart.nowT)} y={mt - 11.5} textAnchor="middle" fontSize={10} fontWeight={600} fill="#fff">Ahora</text>
                            </g>
                        )}
                        {hovered && (
                            <g pointerEvents="none">
                                <line x1={x(hovered.m.t)} x2={x(hovered.m.t)} y1={mt - 4} y2={base} stroke={textColor} strokeWidth={1} strokeOpacity={0.25} />
                                {hovered.rows.map(({ id, p }) => (
                                    <circle key={id} cx={x(p.t)} cy={y(p.temp)} r={3.5} fill={color[id]} stroke="#fff" strokeWidth={2} />
                                ))}
                                <circle cx={x(hovered.m.t)} cy={y(hovered.m.temp)} r={7} fill={tempColor(hovered.m.temp)} stroke="#fff" strokeWidth={3} />
                            </g>
                        )}
                        <rect
                            x={ml}
                            y={0}
                            width={Math.max(w - ml - mr, 0)}
                            height={h}
                            fill="transparent"
                            style={{ cursor: "crosshair" }}
                            onPointerMove={onMove}
                            onPointerDown={onMove}
                            onPointerLeave={() => startTransition(() => setHover(null))}
                        />
                    </svg>

                    {hovered && (
                        <div
                            style={{
                                position: "absolute",
                                top: 6,
                                ...(x(hovered.m.t) > w / 2 ? { right: w - x(hovered.m.t) + 14 } : { left: x(hovered.m.t) + 14 }),
                                background: "rgba(15,23,42,0.92)",
                                color: "#f8fafc",
                                borderRadius: 14,
                                padding: "10px 12px",
                                fontSize: 12,
                                pointerEvents: "none",
                                boxShadow: "0 16px 40px rgba(15,23,42,0.28)",
                                backdropFilter: "blur(8px)",
                                WebkitBackdropFilter: "blur(8px)",
                                whiteSpace: "nowrap",
                                minWidth: 132,
                            }}
                        >
                            <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 4, textTransform: "capitalize" }}>{view.fmtTime.format(new Date(hovered.m.t))}</div>
                            <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginBottom: hovered.rows.length ? 6 : 0 }}>
                                <span style={{ fontSize: 22, fontWeight: 300, letterSpacing: "-0.03em" }}>{num(hovered.m.temp, 1)}°</span>
                                <span style={{ color: "#94a3b8" }}>{view.mainLabel}</span>
                            </div>
                            {hovered.rows.map(({ id, short, p }) => (
                                <div key={id} style={{ display: "flex", alignItems: "center", gap: 6, lineHeight: "1.65em" }}>
                                    <span style={dot(color[id], 6)} />
                                    <span style={{ flex: 1, color: "#cbd5e1" }}>{short}</span>
                                    <span style={{ fontWeight: 500 }}>{num(p.temp, 1)}°</span>
                                </div>
                            ))}
                            {hovered.m.rain >= 0.1 && (
                                <div style={{ marginTop: 6, color: "#93c5fd" }}>
                                    <Drop /> {mm(hovered.m.rain)}
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </div>

            {/* Próximos días */}
            {view.daily.length > 0 && (
                <div style={{ ...card, padding: "12px 16px 6px" }}>
                    <div style={{ ...sectionTitle, paddingBottom: 4 }}>Próximos {view.daily.length} días</div>
                    {view.daily.map((d, i) => {
                        const left = ((d.min - weekLo) / span) * 100
                        const width = Math.max(((d.max - d.min) / span) * 100, 6)
                        const nowPos = i === 0 ? Math.min(Math.max(((view.now.temp - weekLo) / span) * 100, 0), 100) : null
                        return (
                            <div
                                key={d.key}
                                style={{
                                    display: "grid",
                                    gridTemplateColumns: "minmax(52px, 1fr) 26px 36px 26px minmax(40px, 2.2fr) 26px",
                                    alignItems: "center",
                                    gap: 8,
                                    padding: "10px 0",
                                    borderTop: i ? `1px solid ${safeGrid}` : "none",
                                }}
                            >
                                <span style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
                                    <span style={{ textTransform: "capitalize", fontWeight: i === 0 ? 600 : 500, fontSize: 14, whiteSpace: "nowrap" }}>{d.label}</span>
                                    {d.conf && (
                                        <span title={`${LEVELS[d.conf.level].label}: ${d.conf.spread}° de diferencia entre modelos`} style={dot(LEVELS[d.conf.level].color, 6)} />
                                    )}
                                </span>
                                <Icon kind={d.kind} size={26} />
                                <span style={{ fontSize: 11, fontWeight: 500, color: "#3b82f6", textAlign: "right", whiteSpace: "nowrap" }}>
                                    {d.rain >= 0.1 ? <><Drop size={9} /> {num(d.rain, 1)}</> : ""}
                                </span>
                                <span style={{ ...muted, fontSize: 14, textAlign: "right" }}>{d.min}°</span>
                                <span style={{ position: "relative", height: 6, borderRadius: 3, background: "rgba(15,23,42,0.07)" }}>
                                    <span
                                        style={{
                                            position: "absolute",
                                            left: `${left}%`,
                                            width: `${width}%`,
                                            top: 0,
                                            bottom: 0,
                                            borderRadius: 3,
                                            background: `linear-gradient(90deg, ${tempColor(d.min)}, ${tempColor(d.max)})`,
                                        }}
                                    />
                                    {nowPos !== null && (
                                        <span
                                            title={`Ahora ${Math.round(view.now.temp)}°`}
                                            style={{
                                                position: "absolute",
                                                left: `calc(${nowPos}% - 5px)`,
                                                top: -2,
                                                width: 10,
                                                height: 10,
                                                borderRadius: 5,
                                                background: "#fff",
                                                boxShadow: "0 0 0 2px rgba(15,23,42,0.75)",
                                            }}
                                        />
                                    )}
                                </span>
                                <b style={{ textAlign: "right", fontSize: 14, fontWeight: 600 }}>{d.max}°</b>
                            </div>
                        )
                    })}
                </div>
            )}

            <div style={{ ...muted, fontSize: 11, padding: "0 6px", position: "relative", zIndex: 1 }}>
                {view.best && <div style={{ marginBottom: 4, color: textColor, opacity: 0.75 }}>{view.best}</div>}
                {view.source} · {view.attribution}
            </div>
        </div>
    )
}

addPropertyControls(WeatherCard, {
    baseUrl: {
        type: ControlType.String,
        title: "URL del cubo",
        defaultValue: "",
        placeholder: "https://xxxx.supabase.co/storage/v1/object/public/weather",
    },
    cityId: {
        type: ControlType.Enum,
        title: "Ciudad",
        options: CITIES.map((c) => c[0]),
        optionTitles: CITIES.map((c) => c[1]),
        defaultValue: "madrid",
    },
    model: {
        type: ControlType.Enum,
        title: "Modelo",
        options: ["media", "mejor", "ifs", "aifs", "gfs", "icon-eu", "arpege", "arome", "ukmo", "gem"],
        optionTitles: [
            "Media de todos",
            "El más preciso aquí",
            "ECMWF IFS",
            "ECMWF AIFS",
            "NOAA GFS",
            "DWD ICON-EU",
            "Météo-France ARPEGE",
            "Météo-France AROME",
            "Met Office (Reino Unido)",
            "Canadá GEM",
        ],
        defaultValue: "media",
    },
    chartDays: { type: ControlType.Number, title: "Días gráfica", min: 1, max: 7, step: 1, defaultValue: 3 },
    chartHeight: { type: ControlType.Number, title: "Alto gráfica", min: 140, max: 480, step: 10, defaultValue: 230 },
    showModels: { type: ControlType.Boolean, title: "Otros modelos", defaultValue: true },
    hours: { type: ControlType.Number, title: "Pasos", min: 0, max: 16, step: 1, defaultValue: 10 },
    days: { type: ControlType.Number, title: "Días", min: 0, max: 7, step: 1, defaultValue: 7 },
    dynamicSky: { type: ControlType.Boolean, title: "Cielo dinámico", defaultValue: true },
    colorIfs: { type: ControlType.Color, title: "IFS", defaultValue: "#2a78d6" },
    colorAifs: { type: ControlType.Color, title: "AIFS", defaultValue: "#eb6834" },
    colorGfs: { type: ControlType.Color, title: "GFS", defaultValue: "#1baf7a" },
    colorIcon: { type: ControlType.Color, title: "ICON-EU", defaultValue: "#eda100" },
    colorArpege: { type: ControlType.Color, title: "ARPEGE", defaultValue: "#e87ba4" },
    colorArome: { type: ControlType.Color, title: "AROME", defaultValue: "#e34948" },
    colorUkmo: { type: ControlType.Color, title: "UKMO", defaultValue: "#008300" },
    colorGem: { type: ControlType.Color, title: "GEM", defaultValue: "#6250d6" },
    background: { type: ControlType.Color, title: "Fondo", defaultValue: "#f4f7fb" },
    textColor: { type: ControlType.Color, title: "Texto", defaultValue: "#0f172a" },
    mutedColor: { type: ControlType.Color, title: "Texto suave", defaultValue: "#64748b" },
    accent: { type: ControlType.Color, title: "Acento", defaultValue: "#2563eb" },
    gridColor: { type: ControlType.Color, title: "Rejilla", defaultValue: "transparent" },
    borderColor: { type: ControlType.Color, title: "Borde", defaultValue: "rgba(255,255,255,0.6)" },
    borderWidth: { type: ControlType.Number, title: "Borde px", min: 0, max: 3, step: 0.1, defaultValue: 1 },
    borderOpacity: { type: ControlType.Number, title: "Opac. cristal", min: 0, max: 1, step: 0.05, defaultValue: 0.5 },
    shadow: { type: ControlType.BoxShadow, title: "Sombra", defaultValue: "0 24px 60px rgba(15,23,42,0.16)" },
    effectIntensity: { type: ControlType.Number, title: "Brillo cielo", min: 0, max: 1, step: 0.05, defaultValue: 0.5 },
    motionSpeed: { type: ControlType.Number, title: "Movimiento", min: 0, max: 1.5, step: 0.05, defaultValue: 0.6 },
    radius: { type: ControlType.Number, title: "Esquinas", min: 0, max: 48, defaultValue: 28 },
    titleFont: {
        type: ControlType.Font,
        title: "Fuente ciudad",
        controls: "extended",
        defaultFontType: "sans-serif",
        defaultValue: { fontSize: "15px", lineHeight: "1.2em", letterSpacing: "0.02em", variant: "Medium" } as any,
    },
    bodyFont: {
        type: ControlType.Font,
        title: "Fuente texto",
        controls: "extended",
        defaultFontType: "sans-serif",
        defaultValue: { fontSize: "13px", lineHeight: "1.35em", letterSpacing: "-0.01em", variant: "Medium" } as any,
    },
})
