// Pedido: "crea un gráfico para nubosidad y otro para presión y otro para precipitación",
// después "en la lluvia pon todos los modelos" y "las líneas de precipitación smooth".
// Un solo componente con tres modos (Variable). Usa los mismos datos que WeatherCard
// (cities/<id>.json en Supabase, varios modelos): lo grueso es la media de los modelos
// o el modelo elegido; las líneas finas, cada modelo por separado.
// La lluvia se dibuja en mm/h: cada modelo acumula en pasos distintos (1, 3 o 6 h), así que
// dividir cada acumulado entre las horas de su paso es lo que permite compararlos.
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

type N = number | null
type ModelSeries = {
    id: string
    name: string
    times: string[]
    rain: N[]
    cloud: N[]
    pressure: N[]
}
type CityDoc = {
    city: { id: string; name: string; tz: string }
    attribution: string
    models: ModelSeries[]
    // IA de lluvia diaria (scripts/ml/predecir_lluvia.py): cada día va de 07:00 a 07:00 UTC, como en AEMET.
    ml_rain?: { days: string[]; prob: number[]; mm: number[] }
}
type Variable = "cloud" | "pressure" | "rain"
// dt: en la lluvia, lo que dura el paso que termina en t.
type Pt = { t: number; v: number; dt: number }

const HOUR = 3600_000
const DEFAULT_URL =
    "https://tmnnidlzmwxgpxufqkgm.supabase.co/storage/v1/object/public/weather"

const VARS: Record<Variable, { title: string; unit: string; digits: number }> = {
    cloud: { title: "Nubosidad", unit: "%", digits: 0 },
    pressure: { title: "Presión", unit: "hPa", digits: 0 },
    rain: { title: "Precipitación", unit: "mm/h", digits: 1 },
}

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

// Mismo orden y colores que en WeatherCard.
const MODELS: [string, string, string][] = [
    ["ifs", "IFS", "#2a78d6"],
    ["aifs", "AIFS", "#eb6834"],
    ["gfs", "GFS", "#1baf7a"],
    ["icon-eu", "ICON-EU", "#eda100"],
    ["arpege", "ARPEGE", "#e87ba4"],
    ["arome", "AROME", "#e34948"],
    ["ukmo", "UKMO", "#008300"],
    ["gem", "GEM", "#6250d6"],
]

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

function useWidth() {
    const [width, setWidth] = useState(0)
    const observer = useRef<ResizeObserver | null>(null)
    useEffect(() => () => observer.current?.disconnect(), [])
    const ref = useCallback((el: HTMLDivElement | null) => {
        observer.current?.disconnect()
        if (!el || typeof ResizeObserver === "undefined") return
        observer.current = new ResizeObserver(([e]) =>
            startTransition(() => setWidth(e.contentRect.width))
        )
        observer.current.observe(el)
    }, [])
    return [ref, width] as const
}

const OUTFIT_STACK = "Outfit, sans-serif"
function ensureOutfitFont() {
    if (typeof document === "undefined") return
    const id = "outfit-font-stylesheet-v1"
    if (!document.getElementById(id)) {
        const link = document.createElement("link")
        link.id = id
        link.rel = "stylesheet"
        link.href =
            "https://fonts.googleapis.com/css2?family=Outfit:wght@200;300;400;500;600;700&display=swap"
        document.head.appendChild(link)
    }
}

// Curva suave que no se pasa de los puntos (cúbica monótona), como en WeatherCard:
// nunca dibuja un pico que el modelo no ha dado ni baja de 0 mm/h.
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

// Dónde se dibuja cada punto: la lluvia, en el centro de su paso; lo demás, en su instante.
const midT = (p: Pt) => p.t - p.dt / 2

function seriesOf(m: ModelSeries, variable: Variable): Pt[] {
    const arr = m[variable] ?? []
    const times = m.times.map((t) => Date.parse(t))
    const out: Pt[] = []
    times.forEach((t, i) => {
        const v = arr[i]
        if (v == null) return
        if (variable === "rain") {
            // El acumulado de cada paso, pasado a mm/h.
            const dt = i ? t - times[i - 1] : 0
            if (dt <= 0) return
            out.push({ t, v: v / (dt / HOUR), dt })
        } else out.push({ t, v, dt: 0 })
    })
    return out
}

// Media de los modelos en cada instante que tengan al menos dos (AROME va cada hora y casi todos
// los demás cada 3 h: una hora con solo AROME no es una media).
function averageOf(models: ModelSeries[], variable: Variable): Pt[] {
    const byTime = new Map<number, number[]>()
    for (const m of models)
        for (const p of seriesOf(m, variable)) {
            if (!byTime.has(p.t)) byTime.set(p.t, [])
            byTime.get(p.t)!.push(p.v)
        }
    const minModels = Math.min(2, models.length)
    const list = [...byTime.entries()]
        .filter(([, l]) => l.length >= minModels)
        .sort((a, b) => a[0] - b[0])
    return list.map(([t, l], i) => ({
        t,
        v: l.reduce((a, b) => a + b, 0) / l.length,
        dt: variable === "rain" ? (i ? t - list[i - 1][0] : 3 * HOUR) : 0,
    }))
}

// Lluvia total que da un modelo entre dos instantes, en mm, con sus acumulados tal cual.
function rainTotal(m: ModelSeries, from: number, to: number): number | null {
    const times = m.times.map((t) => Date.parse(t))
    if (!times.length || times[times.length - 1] < to - 3 * HOUR) return null
    let sum = 0
    times.forEach((t, i) => {
        if (i && t > from && t <= to) sum += m.rain?.[i] ?? 0
    })
    return sum
}

const num = (v: number, digits = 0) =>
    v.toLocaleString("es-ES", { maximumFractionDigits: digits })

function cloudLabel(v: number) {
    if (v < 25) return "Despejado"
    if (v < 60) return "Poco nuboso"
    if (v < 85) return "Nuboso"
    return "Cubierto"
}

type FontValue = {
    fontSize?: string | number
    lineHeight?: string | number
    letterSpacing?: string | number
    fontWeight?: string | number
}

interface Props {
    variable: Variable
    baseUrl: string
    cityId: string
    model: string
    chartDays: number
    chartHeight: number
    showModels: boolean
    showAI: boolean
    colorAi: string
    color: string
    background: string
    textColor: string
    mutedColor: string
    accent: string
    radius: number
    shadow: string
    titleFont: FontValue
    style?: CSSProperties
}

/**
 * Gráfica del tiempo: nubosidad, presión o precipitación.
 *
 * @framerSupportedLayoutWidth any
 * @framerSupportedLayoutHeight auto
 */
export default function WeatherChart(props: Props) {
    const {
        variable = "cloud",
        baseUrl = DEFAULT_URL,
        cityId = "madrid",
        model = "media",
        chartDays = 3,
        chartHeight = 200,
        showModels = true,
        showAI = true,
        colorAi = "#c026d3",
        color = "#3b82f6",
        background = "#ffffff",
        textColor = "#0f172a",
        mutedColor = "#64748b",
        accent = "#2563eb",
        radius = 17,
        shadow = "0 24px 60px rgba(15,23,42,0.16)",
        titleFont = { fontSize: "15px", lineHeight: "1.2em", letterSpacing: "0.02em", fontWeight: 500 },
        style,
    } = props
    const meta = VARS[variable] ?? VARS.cloud
    const isRain = variable === "rain"
    const uid = useId().replace(/:/g, "")
    useEffect(() => ensureOutfitFont(), [])

    const url = baseUrl
        ? `${baseUrl.replace(/\/$/, "")}/cities/${cityId}.json`
        : ""
    const [data, setData] = useState<CityDoc | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [hover, setHover] = useState<number | null>(null)
    const [chartRef, chartWidth] = useWidth()

    useEffect(() => {
        if (!url) return
        let alive = true
        startTransition(() => setError(null))
        load(url)
            .then((d) => alive && startTransition(() => setData(d)))
            .catch(
                (e) =>
                    alive &&
                    startTransition(() => setError(String(e.message ?? e)))
            )
        return () => {
            alive = false
        }
    }, [url])

    const view = useMemo(() => {
        if (!data || !data.models.length) return null
        const chosen = data.models.find((m) => m.id === model)
        const all = chosen ? seriesOf(chosen, variable) : averageOf(data.models, variable)

        const tz = data.city.tz
        const fmt = (o: Intl.DateTimeFormatOptions) =>
            new Intl.DateTimeFormat("es-ES", { timeZone: tz, ...o })
        const hourOf = (t: number) =>
            Number(fmt({ hour: "numeric", hourCycle: "h23" }).format(new Date(t)))

        // Desde 3 h antes de ahora hasta la medianoche local tras chartDays días.
        const now = Date.now()
        const start = Math.floor((now - 3 * HOUR) / HOUR) * HOUR
        let end = start + chartDays * 24 * HOUR
        for (let k = 0; k < 24 && hourOf(end) !== 0; k++) end += HOUR
        const inWindow = (p: Pt) => p.t - p.dt >= start && p.t <= end
        const main = all.filter(inWindow)

        const lines = MODELS.flatMap(([id, short, c]) => {
            const m = data.models.find((x) => x.id === id)
            if (!m || m.id === chosen?.id) return []
            const pts = seriesOf(m, variable).filter(inWindow)
            return pts.length ? [{ id, short, color: c, pts }] : []
        })

        // Lluvia de aquí al final de la gráfica: la media de lo que acumula cada modelo que llegue hasta ahí.
        let total: number | null = null
        if (variable === "rain") {
            const totals = (chosen ? [chosen] : data.models).flatMap((m) => {
                const s = rainTotal(m, now, end)
                return s == null ? [] : [s]
            })
            total = totals.length ? totals.reduce((a, b) => a + b, 0) / totals.length : null
        }

        const midnights: number[] = []
        for (let t = start + HOUR; t < end; t += HOUR)
            if (hourOf(t) === 0) midnights.push(t)

        // IA de lluvia: un tramo por día pluviométrico (07 a 07 UTC) que se vea, aunque sea en parte.
        const aiRain =
            variable === "rain" && data.ml_rain
                ? data.ml_rain.days.flatMap((d, i) => {
                      const from = Date.parse(`${d}T07:00:00Z`)
                      const to = from + 24 * HOUR
                      const a = Math.max(from, start),
                          b = Math.min(to, end)
                      return b - a >= 6 * HOUR
                          ? [{ day: d, from: a, to: b, prob: data.ml_rain!.prob[i], mm: data.ml_rain!.mm[i] }]
                          : []
                  })
                : []

        return {
            name: data.city.name,
            mainLabel: chosen ? chosen.name : "Media de modelos",
            attribution: data.attribution,
            main,
            all,
            lines,
            total,
            start,
            end,
            now,
            midnights,
            aiRain,
            fmtDay: fmt({ weekday: "short", day: "numeric" }),
            fmtTime: fmt({ weekday: "long", hour: "2-digit", minute: "2-digit" }),
            fmtHour: fmt({ hour: "2-digit", minute: "2-digit" }),
        }
    }, [data, model, variable, chartDays])

    const box: CSSProperties = {
        width: "100%",
        minWidth: 0,
        boxSizing: "border-box",
        position: "relative",
        padding: 18,
        borderRadius: radius,
        background,
        color: textColor,
        boxShadow: shadow,
        display: "flex",
        flexDirection: "column",
        gap: 10,
        fontFamily: OUTFIT_STACK,
        overflow: "hidden",
        ...style,
    }
    const muted: CSSProperties = { color: mutedColor, fontSize: 12 }

    // La gráfica de presión se quitó de la web: si alguna instancia la tiene elegida, no dibuja nada.
    if (variable === "pressure") return null
    if (!baseUrl)
        return <div style={box}>Pon la URL del cubo de Supabase en el panel de la derecha.</div>
    if (error)
        return <div style={box}>No se pudo cargar el pronóstico ({error}).</div>
    if (!view)
        return (
            <div style={box}>
                <span style={muted}>Cargando…</span>
            </div>
        )
    if (!view.main.length)
        return (
            <div style={box}>
                <span style={muted}>
                    No hay datos de {meta.title.toLowerCase()} para esta ciudad.
                </span>
            </div>
        )

    const visible = showModels ? view.lines : []
    const nearest = (pts: Pt[], t: number) =>
        pts.length
            ? pts.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a))
            : null
    // En la lluvia, el paso que contiene ese instante; en lo demás, el punto más cercano.
    const pointAt = (pts: Pt[], t: number) =>
        isRain ? pts.find((p) => t > p.t - p.dt && t <= p.t) ?? null : nearest(pts, t)

    // --- Escala vertical ---
    let yMin: number, yMax: number, step: number
    const vals = [
        ...view.main.map((p) => p.v),
        ...visible.flatMap((l) => l.pts.map((p) => p.v)),
    ]
    if (variable === "cloud") {
        yMin = 0
        yMax = 100
        step = 25
    } else if (isRain) {
        const hi = Math.max(0.5, ...vals)
        step = hi <= 1 ? 0.25 : hi <= 2 ? 0.5 : hi <= 5 ? 1 : hi <= 10 ? 2 : 5
        yMin = 0
        yMax = Math.ceil(hi / step) * step
    } else {
        const lo = Math.min(...vals),
            hi = Math.max(...vals)
        step = hi - lo <= 8 ? 2 : hi - lo <= 20 ? 5 : 10
        yMin = Math.floor((lo - 0.5) / step) * step
        yMax = Math.max(Math.ceil((hi + 0.5) / step) * step, yMin + step)
    }
    const ticks: number[] = []
    for (let v = yMin; v <= yMax + 1e-9; v += step) ticks.push(Math.round(v * 100) / 100)

    // --- Geometría ---
    const ml = 40,
        mr = 8,
        mt = 26,
        mb = 24
    const w = Math.max(chartWidth, 240)
    const h = chartHeight
    const aiOn = isRain && showAI && view.aiRain.length > 0
    const AI_BAND = aiOn ? 30 : 0 // debajo de los días, la previsión de la IA para cada día
    const x = (t: number) => ml + ((t - view.start) / (view.end - view.start)) * (w - ml - mr)
    const y = (v: number) => mt + ((yMax - v) / (yMax - yMin)) * (h - mt - mb)
    const base = y(yMin)
    const linePath = (pts: Pt[]) =>
        smoothPath(pts.map((p) => [x(midT(p)), y(p.v)] as [number, number]))
    const mainPath = isRain ? "" : linePath(view.main)
    const last = view.main[view.main.length - 1]
    const areaPath =
        !isRain && view.main.length > 1
            ? `${mainPath}L${x(last.t).toFixed(1)},${base}L${x(view.main[0].t).toFixed(1)},${base}Z`
            : ""
    const dayWidth = ((24 * HOUR) / (view.end - view.start)) * (w - ml - mr)
    const labelEvery = Math.max(1, Math.ceil(52 / dayWidth))
    const nowInside = view.now >= view.start && view.now <= view.end

    // --- Resumen de la cabecera ---
    const current = pointAt(view.main, view.now) ?? nearest(view.main, view.now)!
    let summary: string
    let detail: string
    if (variable === "cloud") {
        summary = `${num(current.v)} %`
        detail = cloudLabel(current.v)
    } else {
        const total = view.total ?? 0
        summary = `${num(total, 1)} mm`
        detail =
            total < 0.1
                ? `Sin lluvia en ${chartDays} días`
                : `Acumulado en ${chartDays} días`
    }

    // --- Interacción ---
    const hovered =
        hover === null
            ? null
            : (() => {
                  const m = pointAt(view.main, hover) ?? nearest(view.main, hover)!
                  const tRef = isRain ? hover : m.t
                  const rows = visible
                      .flatMap((l) => {
                          const p = pointAt(l.pts, tRef)
                          return p && (isRain || Math.abs(p.t - m.t) <= 90 * 60_000)
                              ? [{ id: l.id, short: l.short, color: l.color, p }]
                              : []
                      })
                      .sort((a, b) => b.p.v - a.p.v)
                  return { m, rows }
              })()
    const onMove = (e: PointerEvent<SVGRectElement>) => {
        const r = e.currentTarget.getBoundingClientRect()
        const t = view.start + ((e.clientX - r.left) / r.width) * (view.end - view.start)
        startTransition(() => setHover(t))
    }
    const hoverX = hovered ? (isRain ? x(hover!) : x(hovered.m.t)) : 0

    return (
        <div style={box}>
            <div
                style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "flex-end",
                    gap: 12,
                }}
            >
                <div style={{ minWidth: 0 }}>
                    <div
                        style={{
                            ...titleFont,
                            fontFamily: OUTFIT_STACK,
                            color: mutedColor,
                            textTransform: "uppercase",
                            fontSize: 11,
                            fontWeight: 600,
                            letterSpacing: "0.08em",
                        }}
                    >
                        {meta.title} · {view.name}
                    </div>
                    <div
                        style={{
                            fontSize: 34,
                            fontWeight: 300,
                            letterSpacing: "-0.03em",
                            lineHeight: "1.1em",
                            marginTop: 6,
                            color: textColor,
                        }}
                    >
                        {summary}
                    </div>
                    <div style={{ ...muted, fontSize: 13, marginTop: 2 }}>{detail}</div>
                </div>
                {isRain && <span style={{ ...muted, fontSize: 11 }}>mm/h</span>}
            </div>

            <div ref={chartRef} style={{ position: "relative" }}>
                <svg
                    width={w}
                    height={h + AI_BAND}
                    style={{ display: "block", overflow: "visible", fontFamily: OUTFIT_STACK }}
                    role="img"
                    aria-label={`${meta.title} en ${view.name}`}
                >
                    <defs>
                        <linearGradient id={`wch-area-${uid}`} x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor={color} stopOpacity={0.3} />
                            <stop offset="100%" stopColor={color} stopOpacity={0.02} />
                        </linearGradient>
                    </defs>

                    {ticks.map((v) => (
                        <g key={v}>
                            <line
                                x1={ml}
                                x2={w - mr}
                                y1={y(v)}
                                y2={y(v)}
                                stroke="rgba(15,23,42,0.07)"
                                strokeDasharray="3 5"
                            />
                            <text
                                x={ml - 8}
                                y={y(v)}
                                dy="0.32em"
                                textAnchor="end"
                                fontSize={10}
                                fill={mutedColor}
                            >
                                {num(v, 2)}
                            </text>
                        </g>
                    ))}

                    {view.midnights.map((t, i) => (
                        <g key={t}>
                            <line
                                x1={x(t)}
                                x2={x(t)}
                                y1={mt - 6}
                                y2={h - mb + 4}
                                stroke="rgba(15,23,42,0.07)"
                            />
                            {i % labelEvery === 0 && (
                                <text
                                    x={x(t) + 6}
                                    y={h - 6}
                                    fontSize={11}
                                    fontWeight={500}
                                    fill={mutedColor}
                                    style={{ textTransform: "capitalize" }}
                                >
                                    {view.fmtDay.format(new Date(t + HOUR))}
                                </text>
                            )}
                        </g>
                    ))}

                    {/* Lluvia: barras de la media (o del modelo elegido), cada una del ancho de su paso */}
                    {isRain &&
                        view.main.map((p) => {
                            if (p.v < 0.02) return null
                            const x0 = x(p.t - p.dt) + 1,
                                x1 = x(p.t) - 1
                            return (
                                <rect
                                    key={p.t}
                                    x={x0}
                                    y={Math.min(y(p.v), base - 2)}
                                    width={Math.max(1, x1 - x0)}
                                    height={Math.max(2, base - y(p.v))}
                                    rx={Math.min((x1 - x0) / 2, 3)}
                                    fill={color}
                                    opacity={hovered && hovered.m.t === p.t ? 0.75 : 0.45}
                                />
                            )
                        })}

                    {areaPath && variable === "cloud" && (
                        <path d={areaPath} fill={`url(#wch-area-${uid})`} />
                    )}

                    {visible.map((l) => (
                        <path
                            key={l.id}
                            d={linePath(l.pts)}
                            fill="none"
                            stroke={l.color}
                            strokeWidth={isRain ? 1.75 : 1.25}
                            strokeOpacity={isRain ? 0.75 : 0.4}
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        />
                    ))}

                    {!isRain && (
                        <path
                            d={mainPath}
                            fill="none"
                            stroke={color}
                            strokeWidth={3}
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        />
                    )}

                    {nowInside && (
                        <g>
                            <line
                                x1={x(view.now)}
                                x2={x(view.now)}
                                y1={mt - 4}
                                y2={base}
                                stroke={accent}
                                strokeWidth={1.25}
                                strokeDasharray="2 4"
                            />
                            <rect x={x(view.now) - 22} y={mt - 24} width={44} height={18} rx={9} fill={accent} />
                            <text
                                x={x(view.now)}
                                y={mt - 11.5}
                                textAnchor="middle"
                                fontSize={10}
                                fontWeight={600}
                                fill="#fff"
                            >
                                Ahora
                            </text>
                        </g>
                    )}

                    {hovered && (
                        <g pointerEvents="none">
                            <line
                                x1={hoverX}
                                x2={hoverX}
                                y1={mt - 4}
                                y2={base}
                                stroke={textColor}
                                strokeOpacity={0.25}
                            />
                            {hovered.rows.map(({ id, color: c, p }) => (
                                <circle
                                    key={id}
                                    cx={x(midT(p))}
                                    cy={y(p.v)}
                                    r={3.5}
                                    fill={c}
                                    stroke="#fff"
                                    strokeWidth={2}
                                />
                            ))}
                            {!isRain && (
                                <circle
                                    cx={x(hovered.m.t)}
                                    cy={y(hovered.m.v)}
                                    r={6}
                                    fill={color}
                                    stroke="#fff"
                                    strokeWidth={3}
                                />
                            )}
                        </g>
                    )}

                    {/* IA de lluvia: corchete morado bajo cada día (de 9:00 a 9:00 hora peninsular) con su probabilidad y sus mm */}
                    {aiOn &&
                        view.aiRain.map((r) => {
                            const x0 = x(r.from) + 2,
                                x1 = x(r.to) - 2
                            const cx = (x0 + x1) / 2
                            const yb = h + 6
                            return (
                                <g key={r.day}>
                                    <title>
                                        {`IA: ${Math.round(r.prob * 100)} % de que caiga al menos 1 mm · ${num(r.mm, 1)} mm esperados (de 9:00 a 9:00)`}
                                    </title>
                                    <path
                                        d={`M${x0},${yb - 4}V${yb}H${x1}V${yb - 4}`}
                                        fill="none"
                                        stroke={colorAi}
                                        strokeWidth={1.5}
                                        strokeOpacity={0.6}
                                    />
                                    <text
                                        x={cx}
                                        y={yb + 16}
                                        textAnchor="middle"
                                        fontSize={11}
                                        fontWeight={700}
                                        fill={colorAi}
                                    >
                                        {x1 - x0 > 90
                                            ? `IA ${Math.round(r.prob * 100)} % · ${num(r.mm, 1)} mm`
                                            : `${Math.round(r.prob * 100)} %`}
                                    </text>
                                </g>
                            )
                        })}

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
                            ...(hoverX > w / 2
                                ? { right: w - hoverX + 14 }
                                : { left: hoverX + 14 }),
                            background: "rgba(15,23,42,0.92)",
                            color: "#f8fafc",
                            borderRadius: 14,
                            padding: "10px 12px",
                            fontSize: 12,
                            pointerEvents: "none",
                            boxShadow: "0 16px 40px rgba(15,23,42,0.28)",
                            whiteSpace: "nowrap",
                            minWidth: 120,
                        }}
                    >
                        <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 4, textTransform: "capitalize" }}>
                            {isRain
                                ? `${view.fmtTime.format(new Date(hovered.m.t - hovered.m.dt))} – ${view.fmtHour.format(new Date(hovered.m.t))}`
                                : view.fmtTime.format(new Date(hovered.m.t))}
                        </div>
                        <div style={{ fontSize: 20, fontWeight: 300, letterSpacing: "-0.02em" }}>
                            {num(hovered.m.v, meta.digits)} {meta.unit}
                        </div>
                        {hovered.rows.map(({ id, short, color: c, p }) => (
                            <div key={id} style={{ display: "flex", alignItems: "center", gap: 6, lineHeight: "1.65em" }}>
                                <span style={{ width: 6, height: 6, borderRadius: 3, background: c }} />
                                <span style={{ flex: 1, color: "#cbd5e1" }}>{short}</span>
                                <span style={{ fontWeight: 500 }}>
                                    {num(p.v, meta.digits)}
                                </span>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {visible.length > 0 && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 10px" }}>
                    {visible.map((l) => (
                        <span
                            key={l.id}
                            style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, color: mutedColor }}
                        >
                            <span style={{ width: 10, height: 2, borderRadius: 1, background: l.color }} />
                            {l.short}
                        </span>
                    ))}
                </div>
            )}

        </div>
    )
}

addPropertyControls(WeatherChart, {
    variable: {
        type: ControlType.Enum,
        title: "Variable",
        options: ["cloud", "pressure", "rain"],
        optionTitles: ["Nubosidad", "Presión", "Precipitación"],
        defaultValue: "cloud",
    },
    baseUrl: {
        type: ControlType.String,
        title: "URL del cubo",
        defaultValue: DEFAULT_URL,
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
        options: ["media", ...MODELS.map((m) => m[0])],
        optionTitles: ["Media de todos", ...MODELS.map((m) => m[1])],
        defaultValue: "media",
    },
    chartDays: {
        type: ControlType.Number,
        title: "Días",
        min: 1,
        max: 7,
        step: 1,
        defaultValue: 3,
    },
    chartHeight: {
        type: ControlType.Number,
        title: "Alto gráfica",
        min: 120,
        max: 400,
        step: 10,
        defaultValue: 200,
    },
    showModels: {
        type: ControlType.Boolean,
        title: "Otros modelos",
        defaultValue: true,
    },
    showAI: {
        type: ControlType.Boolean,
        title: "IA lluvia",
        defaultValue: true,
        hidden: (p: any) => p.variable !== "rain",
    },
    colorAi: {
        type: ControlType.Color,
        title: "Color IA",
        defaultValue: "#c026d3",
        hidden: (p: any) => p.variable !== "rain" || !p.showAI,
    },
    color: { type: ControlType.Color, title: "Color", defaultValue: "#3b82f6" },
    background: { type: ControlType.Color, title: "Fondo", defaultValue: "#ffffff" },
    textColor: { type: ControlType.Color, title: "Texto", defaultValue: "#0f172a" },
    mutedColor: { type: ControlType.Color, title: "Texto suave", defaultValue: "#64748b" },
    accent: { type: ControlType.Color, title: "Acento", defaultValue: "#2563eb" },
    radius: { type: ControlType.Number, title: "Esquinas", min: 0, max: 48, defaultValue: 17 },
    shadow: {
        type: ControlType.BoxShadow,
        title: "Sombra",
        defaultValue: "0 24px 60px rgba(15,23,42,0.16)",
    },
    titleFont: {
        type: ControlType.Font,
        title: "Fuente título",
        controls: "extended",
        defaultFontType: "sans-serif",
        defaultValue: {
            fontSize: "15px",
            lineHeight: "1.2em",
            letterSpacing: "0.02em",
            variant: "Medium",
        } as any,
    },
})
