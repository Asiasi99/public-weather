/**
 * Tarjeta de dato (bento): un fondo de color difuminado que depende del valor, el número
 * grande de puntos en el centro y un indicador abajo. Elige en «Dato» qué muestra.
 * Usa la ciudad «global» de la página (la del selector).
 */
import { addPropertyControls, ControlType } from "framer"
import { useEffect, useId, useState } from "react"

// --- Datos (copia ligera de TiempoOverrides para no depender de otro archivo) ---
const BASE = "https://tmnnidlzmwxgpxufqkgm.supabase.co/storage/v1/object/public/weather"
const HOUR = 3600_000
type N = number | null
type CityBus = { city: string; subs: Set<() => void> }
function cityBus(): CityBus {
    const g = globalThis as unknown as { __tiempoCiudad?: CityBus }
    if (!g.__tiempoCiudad) g.__tiempoCiudad = { city: "madrid", subs: new Set() } as CityBus
    return g.__tiempoCiudad
}
type Model = { times: string[]; temp: number[]; rain: N[]; cloud: N[]; wind: N[]; windDir: N[]; hum?: N[] }
type Doc = { city: { tz: string; name: string }; models: Model[]; ml?: { times: string[]; temp: N[] }; ml_rain?: { days: string[]; prob: number[] } }
type Obs = { time: string; temp?: N; rain1h?: N; hum?: N; wind?: N; windDir?: N }
type Kind = "clear-day" | "clear-night" | "partly-day" | "partly-night" | "cloudy" | "overcast" | "drizzle" | "rain" | "unknown"
const cache = new Map<string, Promise<any>>()
function get(url: string) {
    if (!cache.has(url)) {
        cache.set(url, fetch(url, { cache: "no-cache" }).then((r) => r.json()))
        setTimeout(() => cache.delete(url), 10 * 60_000)
    }
    return cache.get(url)!
}
type Ahora = { temp: number; cloud: N; kind: Kind; wind: N; windDir: N; hum: N; rain: number; rainToday: N; max: number; min: number }
function useAhora(): Ahora | null {
    const [city, setCity] = useState(() => cityBus().city)
    const [out, setOut] = useState<Ahora | null>(null)
    useEffect(() => {
        const bus = cityBus()
        const on = () => setCity(bus.city)
        bus.subs.add(on)
        on()
        return () => {
            bus.subs.delete(on)
        }
    }, [])
    useEffect(() => {
        let alive = true
        Promise.all([get(`${BASE}/cities/${city}.json`) as Promise<Doc>, (get(`${BASE}/observed.json`) as Promise<{ cities: Record<string, Obs> }>).catch(() => null)])
            .then(([doc, observed]) => {
                if (!alive) return
                const now = Date.now()
                const near = (times: string[], vals: N[]) => {
                    let best: N = null,
                        bd = Infinity
                    times.forEach((t, i) => {
                        const d = Math.abs(Date.parse(t) - now)
                        if (vals[i] != null && d < bd && d <= 3 * HOUR) {
                            bd = d
                            best = vals[i]
                        }
                    })
                    return best as N
                }
                const avg = (f: (m: Model) => N) => {
                    const xs = doc.models.map(f).filter((v): v is number => v != null)
                    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null
                }
                const o = observed?.cities?.[city]
                const fresh = o && now - Date.parse(o.time) <= 3 * HOUR ? o : null
                const temp = fresh?.temp ?? (doc.ml ? near(doc.ml.times, doc.ml.temp) : null) ?? avg((m) => near(m.times, m.temp)) ?? 18
                const cloud = avg((m) => near(m.times, m.cloud))
                const rain = fresh?.rain1h ?? avg((m) => near(m.times, m.rain)) ?? 0
                const h = Number(new Intl.DateTimeFormat("en-GB", { timeZone: doc.city.tz, hour: "numeric", hourCycle: "h23" }).format(new Date(now)))
                const night = h < 7 || h >= 20
                const kind: Kind =
                    rain >= 2 ? "rain" : rain >= 0.3 ? "drizzle" : cloud == null ? "unknown" : cloud < 25 ? (night ? "clear-night" : "clear-day") : cloud < 60 ? (night ? "partly-night" : "partly-day") : cloud < 85 ? "cloudy" : "overcast"
                const wind = fresh && (o as Obs).wind != null ? (o as Obs).wind! : avg((m) => near(m.times, m.wind))
                const windDir = fresh && (o as Obs).windDir != null ? (o as Obs).windDir! : avg((m) => near(m.times, m.windDir))
                const hum = fresh && (o as Obs).hum != null ? (o as Obs).hum! : avg((m) => (m.hum ? near(m.times, m.hum) : null))
                const dayKey = (t: number) => new Intl.DateTimeFormat("en-CA", { timeZone: doc.city.tz }).format(new Date(t))
                const today = dayKey(now)
                const vals: number[] = []
                doc.models.forEach((m) => m.times.forEach((t, i) => dayKey(Date.parse(t)) === today && vals.push(m.temp[i])))
                const ri = doc.ml_rain?.days.indexOf(today) ?? -1
                setOut({ temp, cloud, kind, wind, windDir, hum, rain, rainToday: ri >= 0 ? doc.ml_rain!.prob[ri] : null, max: Math.round(Math.max(temp, ...vals)), min: Math.round(Math.min(temp, ...vals)) })
            })
            .catch(() => undefined)
        return () => {
            alive = false
        }
    }, [city])
    return out
}


// --- Colores ---
function mix(a: string, b: string, k: number) {
    const A = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16))
    const B = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16))
    return `#${A.map((v, i) => Math.round(v + (B[i] - v) * k).toString(16).padStart(2, "0")).join("")}`
}
function scale(stops: [number, string][], v: number) {
    if (v <= stops[0][0]) return stops[0][1]
    for (let i = 1; i < stops.length; i++) if (v <= stops[i][0]) return mix(stops[i - 1][1], stops[i][1], (v - stops[i - 1][0]) / (stops[i][0] - stops[i - 1][0]))
    return stops[stops.length - 1][1]
}
const TEMP: [number, string][] = [[-5, "#3b2bd1"], [3, "#2f6fe0"], [9, "#1fa2c9"], [14, "#3fbf9a"], [18, "#b9d35a"], [22, "#f6c341"], [27, "#f28a3a"], [33, "#e2452f"], [40, "#a11d33"]]
const WIND: [number, string][] = [[0, "#8fb3d9"], [12, "#5f86ee"], [25, "#6a5be0"], [40, "#a24fd8"], [60, "#e0407a"]]
const HUM: [number, string][] = [[0, "#f0b45a"], [40, "#62c7c2"], [70, "#3a8fd9"], [100, "#2c4fd0"]]
const CLOUD: [number, string][] = [[0, "#7fc4f5"], [50, "#a7a9d6"], [100, "#7d7f99"]]
const RAIN: [number, string][] = [[0, "#9db8e8"], [0.5, "#4f86f0"], [3, "#2c45d6"], [10, "#4320a8"]]
const FEELS = ["#3fbf8a", "#e6c84a", "#ef8a3a", "#e0405a"]
const COMPASS = ["N", "NE", "E", "SE", "S", "SO", "O", "NO"]
const KIND_LABEL: Record<Kind, string> = { "clear-day": "Despejado", "clear-night": "Despejado", "partly-day": "Poco nuboso", "partly-night": "Poco nuboso", cloudy: "Nuboso", overcast: "Cubierto", drizzle: "Lluvia débil", rain: "Lluvia", unknown: "Sin datos" }

type Dato = "temperatura" | "sensacion" | "viento" | "humedad" | "nubes" | "lluvia" | "lluviaHoy"

function feelsOf(t: number, wind: N, hum: N) {
    let f = t
    if (t <= 10 && wind != null && wind > 4.8) {
        const k = Math.pow(wind, 0.16)
        f = 13.12 + 0.6215 * t - 11.37 * k + 0.3965 * t * k
    } else if (t >= 26 && hum != null) {
        const T = (t * 9) / 5 + 32
        const hi = -42.379 + 2.04901523 * T + 10.14333127 * hum - 0.22475541 * T * hum - 0.00683783 * T * T - 0.05481717 * hum * hum + 0.00122874 * T * T * hum + 0.00085282 * T * hum * hum - 0.00000199 * T * T * hum * hum
        f = Math.max(t, ((hi - 32) * 5) / 9)
    }
    let level = f < -10 ? 3 : f < 0 ? 2 : f < 6 ? 1 : f >= 40 ? 3 : f >= 32 ? 2 : f >= 27 ? 1 : 0
    if (wind != null) level = Math.max(level, wind >= 70 ? 3 : wind >= 50 ? 2 : wind >= 35 ? 1 : 0)
    return { f, level }
}

// Qué enseña cada dato: título, subtítulo, número, unidad, color, posición en la barra (0-1) y pie
function describe(d: Dato, a: Ahora) {
    switch (d) {
        case "temperatura":
            return { title: "Temperatura", sub: KIND_LABEL[a.kind], value: `${Math.round(a.temp)}`, unit: "°", color: scale(TEMP, a.temp), pos: (a.temp + 5) / 45, foot: `${a.max}° / ${a.min}°` }
        case "sensacion": {
            const { f, level } = feelsOf(a.temp, a.wind, a.hum)
            return { title: "Sensación", sub: ["Bien", "Precaución", "Mal", "Peligro"][level], value: `${Math.round(f)}`, unit: "°", color: FEELS[level], pos: level / 3 + 0.12, foot: "Viento y humedad" }
        }
        case "viento":
            return { title: "Viento", sub: a.windDir != null ? `Del ${COMPASS[Math.round(a.windDir / 45) % 8]}` : "", value: a.wind != null ? `${Math.round(a.wind)}` : "–", unit: "km/h", color: scale(WIND, a.wind ?? 0), pos: (a.wind ?? 0) / 60, foot: (a.wind ?? 0) < 12 ? "Flojo" : (a.wind ?? 0) < 30 ? "Moderado" : "Fuerte" }
        case "humedad":
            return { title: "Humedad", sub: "Relativa", value: a.hum != null ? `${Math.round(a.hum)}` : "–", unit: "%", color: scale(HUM, a.hum ?? 50), pos: (a.hum ?? 0) / 100, foot: (a.hum ?? 50) < 35 ? "Seco" : (a.hum ?? 50) < 70 ? "Normal" : "Húmedo" }
        case "nubes":
            return { title: "Nubes", sub: KIND_LABEL[a.kind], value: a.cloud != null ? `${Math.round(a.cloud)}` : "–", unit: "%", color: scale(CLOUD, a.cloud ?? 50), pos: (a.cloud ?? 0) / 100, foot: (a.cloud ?? 0) < 25 ? "Despejado" : (a.cloud ?? 0) < 70 ? "Algunas" : "Cubierto" }
        case "lluvia":
            return { title: "Lluvia", sub: "Ahora", value: a.rain >= 0.05 ? a.rain.toFixed(1).replace(".", ",") : "0", unit: "mm/h", color: scale(RAIN, a.rain), pos: Math.min(1, a.rain / 6), foot: a.rain < 0.05 ? "Seco" : a.rain < 2 ? "Débil" : "Fuerte" }
        case "lluviaHoy":
            return { title: "Lluvia hoy", sub: "Probabilidad", value: a.rainToday != null ? `${Math.round(a.rainToday * 100)}` : "–", unit: "%", color: scale(RAIN, (a.rainToday ?? 0) * 4), pos: a.rainToday ?? 0, foot: "Previsión de la IA" }
    }
}

interface Props {
    dato: Dato
    textColor: string
    radius: number
    numberSize: number
    softness: number
    showBar: boolean
    color: string
}

/**
 * @framerSupportedLayoutWidth any
 * @framerSupportedLayoutHeight any
 * @framerIntrinsicWidth 180
 * @framerIntrinsicHeight 180
 */
export default function TarjetaDato({ dato = "temperatura", textColor = "#141414", radius = 26, numberSize = 54, softness = 0.6, showBar = true, color = "" }: Props) {
    const uid = useId().replace(/:/g, "")
    const a = useAhora()
    useEffect(() => {
        if (typeof document === "undefined" || document.getElementById("tarjeta-doto")) return
        const l = document.createElement("link")
        l.id = "tarjeta-doto"
        l.rel = "stylesheet"
        l.href = "https://fonts.googleapis.com/css2?family=Doto:wght@600;800&family=Geist:wght@400;500&display=swap"
        document.head.appendChild(l)
    }, [])
    const d = a ? describe(dato, a) : { title: "", sub: "", value: "··", unit: "", color: "#c8c8d0", pos: 0.5, foot: "" }
    const c = color || d.color
    const deep = mix(c, "#000000", 0.08)
    const pale = mix(c, "#ffffff", 0.55 + softness * 0.3)
    const pos = Math.max(0, Math.min(1, d.pos))
    const css = `
        @keyframes td-blob-${uid} { 0%,100% { transform: translate(0,0) scale(1); } 50% { transform: translate(4%,-3%) scale(1.08); } }
        .td-blob-${uid} { animation: td-blob-${uid} 9s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) { .td-blob-${uid} { animation: none; } }
    `
    const label = { fontFamily: "Geist, Inter, sans-serif", fontSize: 15, lineHeight: 1.25 }
    return (
        <div style={{ position: "relative", width: "100%", height: "100%", minHeight: 150, borderRadius: radius, overflow: "hidden", background: pale, color: textColor, transition: "background 1s ease" }}>
            <style>{css}</style>
            {/* La mancha de color: más intensa en el centro, se funde hacia los bordes */}
            <div
                className={`td-blob-${uid}`}
                style={{ position: "absolute", inset: "-15%", background: `radial-gradient(closest-side at 50% 52%, ${deep} 0%, ${c} 45%, ${mix(c, pale, 0.6)} 75%, ${pale} 100%)`, transition: "background 1s ease" }}
            />
            {/* Brillo suave arriba (cristal) */}
            <div style={{ position: "absolute", inset: 0, background: "linear-gradient(180deg, rgba(255,255,255,.28), rgba(255,255,255,0) 40%)" }} />
            <div style={{ position: "relative", height: "100%", boxSizing: "border-box", padding: 14, display: "flex", flexDirection: "column" }}>
                <div>
                    <div style={{ ...label, fontWeight: 600 }}>{d.title}</div>
                    <div style={{ ...label, fontSize: 13, opacity: 0.75 }}>{d.sub}</div>
                </div>
                <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 2 }}>
                    <span style={{ fontFamily: "Doto, monospace", fontWeight: 800, fontSize: numberSize, lineHeight: 1, letterSpacing: "-0.02em" }}>{d.value}</span>
                    <span style={{ ...label, fontSize: 16, fontWeight: 500, alignSelf: "flex-start", marginTop: 6, opacity: 0.85 }}>{d.unit}</span>
                </div>
                {showBar && (
                    // Indicador: una regla de rayitas y una marca donde cae el valor
                    <div style={{ position: "relative", height: 14, marginBottom: 6 }}>
                        <div style={{ position: "absolute", left: 0, right: 0, top: 4, height: 6, backgroundImage: `repeating-linear-gradient(90deg, ${textColor}66 0 1.5px, transparent 1px 6px)` }} />
                        <div style={{ position: "absolute", top: 0, left: `calc(${pos * 100}% - 1px)`, width: 2, height: 14, borderRadius: 1, background: textColor, transition: "left 1s ease" }} />
                    </div>
                )}
                <div style={{ ...label, fontSize: 13, fontWeight: 500, opacity: 0.8 }}>{d.foot}</div>
            </div>
        </div>
    )
}

addPropertyControls(TarjetaDato, {
    dato: {
        type: ControlType.Enum,
        title: "Dato",
        options: ["temperatura", "sensacion", "viento", "humedad", "nubes", "lluvia", "lluviaHoy"],
        optionTitles: ["Temperatura", "Sensación térmica", "Viento", "Humedad", "Nubes", "Lluvia ahora", "Lluvia hoy (%)"],
        defaultValue: "temperatura",
    },
    color: { type: ControlType.Color, title: "Color fijo", optional: true },
    textColor: { type: ControlType.Color, title: "Texto", defaultValue: "#141414" },
    numberSize: { type: ControlType.Number, title: "Tamaño número", min: 20, max: 140, defaultValue: 54 },
    softness: { type: ControlType.Number, title: "Suavidad", min: 0, max: 1, step: 0.05, defaultValue: 0.6 },
    radius: { type: ControlType.Number, title: "Esquinas", min: 0, max: 60, defaultValue: 26 },
    showBar: { type: ControlType.Boolean, title: "Regla", defaultValue: true },
})
