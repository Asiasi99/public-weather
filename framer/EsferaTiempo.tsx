/**
 * Esfera del tiempo: una bola con el color de la temperatura de ahora y, dentro, el cielo:
 * brillo de sol si está despejado, nubes que pasan si está nublado, lluvia que cae si llueve
 * y estrellas de noche. Usa la ciudad «global» de la página (la del selector).
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
type Model = { times: string[]; temp: number[]; rain: N[]; cloud: N[]; wind?: N[] }
type Doc = { city: { tz: string }; models: Model[]; ml?: { times: string[]; temp: N[] } }
type Obs = { time: string; temp?: N; rain1h?: N }
type Kind = "clear-day" | "clear-night" | "partly-day" | "partly-night" | "cloudy" | "overcast" | "drizzle" | "rain" | "unknown"
const cache = new Map<string, Promise<any>>()
function get(url: string) {
    if (!cache.has(url)) {
        cache.set(url, fetch(url, { cache: "no-cache" }).then((r) => r.json()))
        setTimeout(() => cache.delete(url), 10 * 60_000)
    }
    return cache.get(url)!
}
function useAhora(): { temp: number; cloud: N; kind: Kind; wind: N; rain: number } | null {
    const [city, setCity] = useState(() => cityBus().city)
    const [out, setOut] = useState<{ temp: number; cloud: N; kind: Kind; wind: N; rain: number } | null>(null)
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
                setOut({ temp, cloud, kind, rain, wind: avg((m) => (m.wind ? near(m.times, m.wind) : null)) })
            })
            .catch(() => undefined)
        return () => {
            alive = false
        }
    }, [city])
    return out
}

const VIVID: [number, string][] = [
    [-5, "#3b2bd1"], [3, "#2f6fe0"], [9, "#1fa2c9"], [14, "#3fbf9a"], [18, "#b9d35a"],
    [22, "#f6c341"], [27, "#f28a3a"], [33, "#e2452f"], [40, "#a11d33"],
]
function mix(a: string, b: string, k: number) {
    const A = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16))
    const B = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16))
    return `#${A.map((v, i) => Math.round(v + (B[i] - v) * k).toString(16).padStart(2, "0")).join("")}`
}
function toHsl(hex: string): [number, number, number] {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    const mx = Math.max(r, g, b),
        mn = Math.min(r, g, b)
    const l = (mx + mn) / 2
    if (mx === mn) return [0, 0, l]
    const d = mx - mn
    const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn)
    const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4
    return [h * 60, s, l]
}
function fromHsl(h: number, s: number, l: number) {
    h = ((h % 360) + 360) % 360
    const f = (n: number) => {
        const k = (n + h / 30) % 12
        const a = s * Math.min(l, 1 - l)
        return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))))
    }
    return `#${[f(0), f(8), f(4)].map((v) => v.toString(16).padStart(2, "0")).join("")}`
}
/** Gira el tono de un color y ajusta su luz: para sacar los tonos vecinos de la iridiscencia. */
function shift(hex: string, dh: number, dl = 0, sat = 1) {
    const [h, s, l] = toHsl(hex)
    return fromHsl(h + dh, Math.min(1, s * sat), Math.max(0, Math.min(1, l + dl)))
}
function tempColor(t: number) {
    if (t <= VIVID[0][0]) return VIVID[0][1]
    for (let i = 1; i < VIVID.length; i++) if (t <= VIVID[i][0]) return mix(VIVID[i - 1][1], VIVID[i][1], (t - VIVID[i - 1][0]) / (VIVID[i][0] - VIVID[i - 1][0]))
    return VIVID[VIVID.length - 1][1]
}

interface Props {
    blur: number
    glow: number
    cloudColor: string
    animate: boolean
    preview: "auto" | "sol" | "nubes" | "lluvia" | "noche"
    previewTemp: number
    previewWind: number
    iridescence: number
}

/**
 * @framerSupportedLayoutWidth fixed
 * @framerSupportedLayoutHeight fixed
 * @framerIntrinsicWidth 160
 * @framerIntrinsicHeight 160
 */
export default function EsferaTiempo({ blur = 2.5, glow = 0.6, cloudColor = "#eef1f7", animate = true, preview = "auto", previewTemp = 20, previewWind = 10, iridescence = 1 }: Props) {
    const uid = useId().replace(/:/g, "")
    const a = useAhora()
    // En el lienzo puedes forzar un cielo para ver cómo queda («Vista»)
    const temp = preview === "auto" ? (a?.temp ?? 18) : previewTemp
    const kind = a?.kind ?? "unknown"
    const sky =
        preview !== "auto"
            ? preview
            : kind === "rain" || kind === "drizzle"
              ? "lluvia"
              : kind === "clear-night" || kind === "partly-night"
                ? "noche"
                : kind === "cloudy" || kind === "overcast" || kind === "unknown"
                  ? "nubes"
                  : "sol"
    const cloud = preview === "auto" ? (a?.cloud ?? 50) / 100 : sky === "nubes" ? 0.8 : sky === "lluvia" ? 0.9 : sky === "sol" ? 0.25 : 0.2
    const c = tempColor(temp)
    const night = sky === "noche"
    // Viento: de 0 (calma) a 1 (40 km/h o más); mueve más rápido el degradado
    const wind = preview === "auto" ? (a?.wind ?? 0) : previewWind
    const windK = Math.max(0, Math.min(1, wind / 40))
    // Colores con sentido: la temperatura manda; las nubes la agrisan, la lluvia la azula y la noche la oscurece hacia añil
    let base = c
    if (cloud > 0.3) base = mix(base, "#9aa3b4", (cloud - 0.3) * 0.7)
    if (sky === "lluvia") base = mix(base, "#3a64d8", 0.5)
    // De noche no se mezcla (saldría un color sucio): se oscurece un poco y el borde se va a añil
    if (night) base = shift(base, 0, -0.1, 0.9)
    const light = mix(base, "#ffffff", night ? 0.25 : 0.55)
    const dark = mix(base, "#000000", 0.45)

    const css = `
        @keyframes es-spin-${uid} { to { transform: rotate(360deg); } }
        @keyframes es-drift-${uid} { from { transform: translateX(-35%); } to { transform: translateX(35%); } }
        @keyframes es-rain-${uid} { from { transform: translate3d(0,-30%,0); } to { transform: translate3d(-6%,30%,0); } }
        @keyframes es-breath-${uid} { 0%,100% { opacity: .55; transform: scale(1); } 50% { opacity: .9; transform: scale(1.06); } }
        @keyframes es-twinkle-${uid} { 0%,100% { opacity: .2; } 50% { opacity: 1; } }
        @keyframes es-flow-${uid} { from { transform: translateX(-50%); } to { transform: translateX(0%); } }
        .es-spin-${uid} { animation: es-spin-${uid} ${(30 - 24 * windK).toFixed(1)}s linear infinite; }
        .es-drift-${uid} { animation: es-drift-${uid} ${(20 - 15 * windK).toFixed(1)}s ease-in-out infinite alternate; }
        .es-flow-${uid} { animation: es-flow-${uid} ${(9 - 7 * windK).toFixed(1)}s linear infinite; }
        .es-rain-${uid} { animation: es-rain-${uid} .7s linear infinite; }
        .es-breath-${uid} { animation: es-breath-${uid} 6s ease-in-out infinite; }
        .es-tw-${uid} { animation: es-twinkle-${uid} 3s ease-in-out infinite; }
        ${animate ? "" : `[class*="es-"] { animation: none !important; }`}
        @media (prefers-reduced-motion: reduce) { [class*="es-"] { animation: none !important; } }
    `
    const full = { position: "absolute" as const, inset: 0, borderRadius: "50%" }
    // Iridiscencia: tonos vecinos girando el color de la temperatura (como en una pompa de jabón)
    const k = iridescence
    // Tonos vecinos de la misma familia (sin saltar a colores que no tocan)
    const core = shift(base, 0, night ? 0.06 : 0.12, 0.95)
    const h1 = shift(base, 18 * k, 0.04, 0.95)
    const h2 = shift(base, -24 * k, -0.04, 0.9)
    const deep = night ? "#1d2563" : shift(base, 8 * k, -0.24, 0.85)

    return (
        <div style={{ position: "relative", width: "100%", height: "100%" }}>
            <style>{css}</style>
            {/* Resplandor que sale de la esfera hacia fuera */}
            <div
                className={`es-breath-${uid}`}
                style={{ ...full, inset: 0, background: `radial-gradient(closest-side, ${h1}${Math.min(255, Math.round(glow * 150)).toString(16).padStart(2, "0")}, ${h2}${Math.min(255, Math.round(glow * 70)).toString(16).padStart(2, "0")} 55%, transparent 82%)`, pointerEvents: "none" }}
            />
            {/* La esfera: degradado de varios tonos, con el borde que se disuelve */}
            <div
                style={{
                    ...full,
                    inset: "12%",
                    overflow: "hidden",
                    filter: blur > 0 ? `blur(${blur}px)` : undefined,
                    WebkitMaskImage: "radial-gradient(circle, #000 50%, rgba(0,0,0,.6) 63%, transparent 71%)",
                    maskImage: "radial-gradient(circle, #000 50%, rgba(0,0,0,.6) 63%, transparent 71%)",
                    background: `radial-gradient(circle at 36% 30%, ${mix(core, "#ffffff", 0.35)} 0%, ${core} 22%, ${h1} 48%, ${h2} 74%, ${deep} 100%)`,
                }}
            >
                {/* Remolinos de color que giran en sentidos opuestos */}
                <div
                    className={`es-spin-${uid}`}
                    style={{ ...full, inset: "-20%", background: `conic-gradient(from 0deg, ${h1}, ${h2}, ${deep}, ${core}, ${h1})`, filter: "blur(22px)", opacity: 0.5 * k, mixBlendMode: "overlay" }}
                />
                <div
                    className={`es-spin-${uid}`}
                    style={{
                        ...full,
                        inset: "-10%",
                        animationDuration: "28s",
                        animationDirection: "reverse",
                        background: `radial-gradient(55% 45% at 72% 70%, ${h2}dd, transparent 70%), radial-gradient(45% 40% at 24% 72%, ${deep}cc, transparent 70%), radial-gradient(40% 35% at 66% 26%, ${h1}cc, transparent 70%)`,
                        filter: "blur(12px)",
                        opacity: 0.85 * k,
                    }}
                />
                {/* Viento: franjas claras que corren de lado (más rápido cuanto más sopla) */}
                {windK > 0.15 && (
                    <div
                        className={`es-flow-${uid}`}
                        style={{ position: "absolute", top: 0, bottom: 0, left: 0, width: "200%", background: `repeating-linear-gradient(90deg, transparent 0 12%, ${mix(base, "#ffffff", 0.6)}55 18%, transparent 26%)`, filter: "blur(8px)", opacity: 0.4 + 0.5 * windK }}
                    />
                )}
                {/* Velo de nubes: cuanto más nublado, más lechoso */}
                {cloud > 0.2 && <div style={{ ...full, background: `radial-gradient(circle at 50% 40%, ${cloudColor}${Math.round(Math.min(1, (cloud - 0.2) * 0.8) * 200).toString(16).padStart(2, "0")}, transparent 75%)` }} />}
                {sky === "sol" && <div className={`es-breath-${uid}`} style={{ position: "absolute", left: "8%", top: "6%", width: "58%", height: "58%", borderRadius: "50%", background: "radial-gradient(closest-side, rgba(255,255,245,.85), rgba(255,240,210,0))" }} />}
                {/* Noche: sombra añil que cubre media esfera (como la cara oscura de un planeta) */}
                {night && <div style={{ ...full, background: "radial-gradient(circle at 72% 78%, #141b4fdd 0%, #1d2563aa 35%, transparent 70%)" }} />}
                {night &&
                    Array.from({ length: 16 }, (_, i) => (
                        <span key={i} className={`es-tw-${uid}`} style={{ position: "absolute", left: `${12 + ((i * 37) % 76)}%`, top: `${10 + ((i * 53) % 70)}%`, width: i % 4 ? 2 : 3, height: i % 4 ? 2 : 3, borderRadius: 2, background: "#fff", animationDelay: `${(i % 6) * 0.5}s` }} />
                    ))}
                {cloud > 0.15 && (
                    <div className={`es-drift-${uid}`} style={{ position: "absolute", inset: "-10% -40%", opacity: Math.min(1, 0.2 + cloud * 0.7) }}>
                        {[
                            [18, 26, 26, 24], [30, 20, 30, 28], [42, 28, 24, 22],
                            [46, 50, 30, 26], [58, 44, 32, 30], [70, 52, 24, 22],
                            [22, 64, 28, 22], [34, 60, 30, 26],
                        ].map(([x, y, w, h], i) => (
                            <span key={i} style={{ position: "absolute", left: `${x}%`, top: `${y}%`, width: `${w}%`, height: `${h}%`, borderRadius: "50%", background: `radial-gradient(closest-side, ${sky === "lluvia" ? mix(cloudColor, "#5a6a8a", 0.45) : cloudColor}, transparent)`, filter: "blur(7px)" }} />
                        ))}
                    </div>
                )}
                {sky === "lluvia" && (
                    <div className={`es-rain-${uid}`} style={{ position: "absolute", inset: "-30% -10%", backgroundImage: "repeating-linear-gradient(100deg, rgba(220,236,255,.65) 0 1.2px, transparent 1.2px 9px)", maskImage: "repeating-linear-gradient(180deg, #000 0 10px, transparent 10px 18px)", WebkitMaskImage: "repeating-linear-gradient(180deg, #000 0 10px, transparent 10px 18px)", filter: "blur(.6px)" }} />
                )}
            </div>
            {/* Borde de arcoíris (aberración cromática): un anillo de colores que gira, desenfocado */}
            {k > 0 && (
                <div
                    className={`es-spin-${uid}`}
                    style={{
                        ...full,
                        inset: "10%",
                        animationDuration: "40s",
                        background: "conic-gradient(from 90deg, #ff5f6d, #ffc371, #f9f871, #5fffd0, #5fb8ff, #9a6bff, #ff5fd1, #ff5f6d)",
                        WebkitMaskImage: "radial-gradient(circle, transparent 56%, #000 66%, transparent 78%)",
                        maskImage: "radial-gradient(circle, transparent 56%, #000 66%, transparent 78%)",
                        filter: "blur(9px)",
                        opacity: 0.38 * k,
                        mixBlendMode: "screen",
                        pointerEvents: "none",
                    }}
                />
            )}
        </div>
    )
}

addPropertyControls(EsferaTiempo, {
    preview: {
        type: ControlType.Enum,
        title: "Vista",
        options: ["auto", "sol", "nubes", "lluvia", "noche"],
        optionTitles: ["Tiempo real", "Sol", "Nubes", "Lluvia", "Noche"],
        defaultValue: "auto",
    },
    previewTemp: { type: ControlType.Number, title: "Temp. de prueba", min: -10, max: 42, defaultValue: 20, hidden: (p: any) => p.preview === "auto" },
    previewWind: { type: ControlType.Number, title: "Viento de prueba", min: 0, max: 60, unit: " km/h", defaultValue: 10, hidden: (p: any) => p.preview === "auto" },
    iridescence: { type: ControlType.Number, title: "Iridiscencia", min: 0, max: 1, step: 0.05, defaultValue: 1 },
    blur: { type: ControlType.Number, title: "Difuminado", min: 0, max: 8, step: 0.5, defaultValue: 2.5 },
    glow: { type: ControlType.Number, title: "Halo", min: 0, max: 1, step: 0.05, defaultValue: 0.6 },
    cloudColor: { type: ControlType.Color, title: "Color nubes", defaultValue: "#eef1f7" },
    animate: { type: ControlType.Boolean, title: "Animación", defaultValue: true },
})
