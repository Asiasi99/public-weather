// Pedido: «quiero que se vea en la web cada día si acierta o no, o sea los días pasados».
// Lee el mismo cities/<id>.json que WeatherCard y enseña su parte «acierto» (scripts/ml/acierto.py):
// para cada día pasado, lo que dijo la IA la víspera (en morado) y lo que midió AEMET.
import { addPropertyControls, ControlType } from "framer"
import { startTransition, useEffect, useState } from "react"
import type { CSSProperties } from "react"

type N = number | null
type Acierto = {
    station: { id: string; name: string; km: number }
    days: {
        day: string
        rain?: { prob: number; mm: number; mod_prob: N; mod_mm: N }
        temp?: { max: number; min: number; mod_max: N; mod_min: N }
        obs: { mm: N; tmax: N; tmin: N } | null
    }[]
}
type CityDoc = { city: { id: string; name: string }; acierto?: Acierto }

const DEFAULT_URL =
    "https://tmnnidlzmwxgpxufqkgm.supabase.co/storage/v1/object/public/weather"
const OUTFIT_STACK = "Outfit, sans-serif"
const OK = "#1baf7a"
const BAD = "#e34948"
const TEMP_OK = 2 // la máxima «acierta» si falla por 2° o menos
const WET_MM = 1 // «llueve» = al menos 1 mm en el día (como al entrenar la IA)

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

const num = (v: number, digits = 0) =>
    v.toLocaleString("es-ES", { maximumFractionDigits: digits })
const pct = (p: number) => `${Math.round(p * 100)} %`
const fmtDay = new Intl.DateTimeFormat("es-ES", { timeZone: "UTC", weekday: "short", day: "numeric" })

function Drop({ size = 10 }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 12 12" style={{ display: "inline-block", verticalAlign: "-1px" }} aria-hidden>
            <path d="M6 1.2C6 1.2 2.4 5.4 2.4 7.6a3.6 3.6 0 0 0 7.2 0C9.6 5.4 6 1.2 6 1.2z" fill="#60a5fa" />
        </svg>
    )
}

// Un círculo verde con ✓ si acertó, rojo con ✗ si falló; nada si aún no se sabe.
function Mark({ hit }: { hit: boolean | null }) {
    if (hit == null) return null
    return (
        <span
            aria-label={hit ? "Acertó" : "Falló"}
            style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: 18,
                height: 18,
                borderRadius: 9,
                background: hit ? OK : BAD,
                color: "#fff",
                fontSize: 11,
                fontWeight: 700,
                lineHeight: 1,
            }}
        >
            {hit ? "✓" : "✗"}
        </span>
    )
}

interface Props {
    baseUrl: string
    cityId: string
    days: number
    colorAi: string
    background: string
    textColor: string
    mutedColor: string
    radius: number
    shadow: string
    style?: CSSProperties
}

/**
 * ¿Acertó la IA? Los días pasados: lo que dijo la víspera y lo que midió AEMET.
 *
 * @framerSupportedLayoutWidth any
 * @framerSupportedLayoutHeight auto
 */
export default function AciertoIA(props: Props) {
    const {
        baseUrl = DEFAULT_URL,
        cityId = "madrid",
        days = 7,
        colorAi = "#c026d3",
        background = "#ffffff",
        textColor = "#0f172a",
        mutedColor = "#64748b",
        radius = 17,
        shadow = "0 24px 60px rgba(15,23,42,0.16)",
        style,
    } = props
    useEffect(() => ensureOutfitFont(), [])
    const url = baseUrl ? `${baseUrl.replace(/\/$/, "")}/cities/${cityId}.json` : ""
    const [data, setData] = useState<CityDoc | null>(null)
    const [error, setError] = useState<string | null>(null)

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

    const box: CSSProperties = {
        width: "100%",
        minWidth: 0,
        boxSizing: "border-box",
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
    const chip: CSSProperties = {
        padding: "5px 10px",
        borderRadius: 999,
        background: "rgba(15,23,42,0.05)",
        fontSize: 12,
    }

    if (error) return <div style={box}>No se pudo cargar el historial ({error}).</div>
    if (!data) return <div style={box}><span style={muted}>Cargando…</span></div>
    const ac = data.acierto
    if (!ac)
        return (
            <div style={box}>
                <span style={muted}>
                    Aún no hay historial de la IA para {data.city.name} (solo se puede comprobar en las
                    ciudades con una estación de AEMET cerca).
                </span>
            </div>
        )

    // Para cada día: ¿acertó si llovería? ¿y la máxima? (null = AEMET aún no lo ha publicado)
    const rows = ac.days.slice(-Math.max(1, days)).map((d) => {
        const o = d.obs
        const rained = o?.mm != null ? o.mm >= WET_MM : null
        const hit = (p: N | undefined) => (p != null && rained != null ? p >= 0.5 === rained : null)
        const err = d.temp && o?.tmax != null ? d.temp.max - o.tmax : null
        const modErr = d.temp?.mod_max != null && o?.tmax != null ? d.temp.mod_max - o.tmax : null
        return { ...d, rained, rainHit: hit(d.rain?.prob), rainModHit: hit(d.rain?.mod_prob), err, modErr }
    })
    const score = (xs: (boolean | null)[]) => {
        const v = xs.filter((x): x is boolean => x != null)
        return { hits: v.filter(Boolean).length, n: v.length }
    }
    const mae = (xs: (number | null)[]) => {
        const v = xs.filter((x): x is number => x != null)
        return v.length ? v.reduce((a, b) => a + Math.abs(b), 0) / v.length : null
    }
    const rainIa = score(rows.map((r) => r.rainHit))
    const rainMod = score(rows.map((r) => r.rainModHit))
    const tIa = mae(rows.map((r) => r.err))
    const tMod = mae(rows.filter((r) => r.err != null).map((r) => r.modErr))
    const todayKey = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid" }).format(new Date())
    const waiting = rows.every((r) => r.obs == null)

    return (
        <div style={box}>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                <div style={{ ...muted, fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase" }}>
                    ¿Acertó la IA? · {data.city.name}
                </div>
                <div style={{ ...muted, fontSize: 11 }}>
                    Medido en AEMET {ac.station.name} (a {num(ac.station.km, 1)} km)
                </div>
            </div>

            {rows.length === 0 ? (
                <div style={muted}>
                    Aún no hay días pasados. Cada día se apunta lo que dice la IA la víspera y, cuando AEMET
                    publica lo medido (tarda de 1 a 4 días), aquí se ve si acertó.
                </div>
            ) : (
                <>
                    {waiting && (
                        <div style={muted}>
                            Ya se está apuntando lo que dice la IA. AEMET publica lo medido unos 4 días después:
                            hasta entonces cada día sale «Pendiente» y luego aparece su ✓ o ✗.
                        </div>
                    )}
                    {(rainIa.n > 0 || tIa != null) && (
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                            {rainIa.n > 0 && (
                                <span style={chip}>
                                    <Drop /> ¿Llueve o no?{" "}
                                    <b style={{ color: colorAi }}>IA {rainIa.hits} de {rainIa.n}</b>
                                    {rainMod.n > 0 && (
                                        <span style={{ color: mutedColor }}> · modelos {rainMod.hits} de {rainMod.n}</span>
                                    )}
                                </span>
                            )}
                            {tIa != null && (
                                <span style={chip}>
                                    Máxima: se equivoca <b style={{ color: colorAi }}>IA ±{num(tIa, 1)}°</b>
                                    {tMod != null && <span style={{ color: mutedColor }}> · modelos ±{num(tMod, 1)}°</span>}
                                </span>
                            )}
                        </div>
                    )}
                    <div
                        style={{
                            display: "grid",
                            gridTemplateColumns: `repeat(${rows.length}, minmax(64px, 1fr))`,
                            gap: 4,
                            overflowX: "auto",
                        }}
                        // En móvil se desliza: empieza mostrando los días más recientes.
                        ref={(el: HTMLDivElement | null) => {
                            if (el) el.scrollLeft = el.scrollWidth
                        }}
                    >
                        {rows.map((r) => (
                            <div
                                key={r.day}
                                style={{
                                    display: "flex",
                                    flexDirection: "column",
                                    alignItems: "center",
                                    gap: 6,
                                    padding: "8px 2px",
                                    borderRadius: 14,
                                    background: "rgba(15,23,42,0.03)",
                                    minWidth: 0,
                                    textAlign: "center",
                                }}
                            >
                                <span style={{ fontSize: 12, fontWeight: 600, textTransform: "capitalize", whiteSpace: "nowrap" }}>
                                    {r.day === todayKey ? "Hoy" : fmtDay.format(new Date(`${r.day}T12:00:00Z`))}
                                </span>
                                {/* Lluvia: lo que dijo (morado) → lo que cayó */}
                                {r.rain && (
                                    <div
                                        title={`Lluvia de 9:00 a 9:00 · IA: ${pct(r.rain.prob)} y ${num(r.rain.mm, 1)} mm${
                                            r.rain.mod_prob != null
                                                ? ` · modelos: ${pct(r.rain.mod_prob)} y ${num(r.rain.mod_mm ?? 0, 1)} mm`
                                                : ""
                                        }${r.obs?.mm != null ? ` · cayeron ${num(r.obs.mm, 1)} mm` : ""}`}
                                        style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}
                                    >
                                        <span style={{ fontSize: 11, fontWeight: 700, color: colorAi }}>
                                            <Drop size={9} /> {pct(r.rain.prob)}
                                        </span>
                                        <span style={{ fontSize: 11, color: mutedColor, whiteSpace: "nowrap" }}>
                                            {r.rained == null ? "Pendiente" : r.rained ? `Llovió ${num(r.obs!.mm!, 1)}` : "No llovió"}
                                        </span>
                                        <Mark hit={r.rainHit} />
                                    </div>
                                )}
                                {/* Máxima: lo que dijo (morado) → la medida */}
                                {r.temp && (
                                    <div
                                        title={`Máxima · IA: ${num(r.temp.max, 1)}°${
                                            r.temp.mod_max != null ? ` · modelos: ${num(r.temp.mod_max, 1)}°` : ""
                                        }${r.obs?.tmax != null ? ` · medida: ${num(r.obs.tmax, 1)}°` : ""}`}
                                        style={{
                                            display: "flex",
                                            flexDirection: "column",
                                            alignItems: "center",
                                            gap: 2,
                                            paddingTop: 6,
                                            borderTop: "1px solid rgba(15,23,42,0.06)",
                                            width: "80%",
                                        }}
                                    >
                                        <span style={{ fontSize: 11, fontWeight: 700, color: colorAi }}>
                                            Máx. {Math.round(r.temp.max)}°
                                        </span>
                                        <span style={{ fontSize: 11, color: mutedColor, whiteSpace: "nowrap" }}>
                                            {r.err == null ? "Pendiente" : `Real ${Math.round(r.obs!.tmax!)}°`}
                                        </span>
                                        <Mark hit={r.err == null ? null : Math.abs(r.err) <= TEMP_OK} />
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                    <div style={{ ...muted, fontSize: 11 }}>
                        En morado, lo que dijo la IA la víspera. ✓ si acertó si llovería (al menos 1 mm, de 9:00 a
                        9:00) y si la máxima falló por {TEMP_OK}° o menos.
                    </div>
                </>
            )}
        </div>
    )
}

addPropertyControls(AciertoIA, {
    baseUrl: { type: ControlType.String, title: "URL del cubo", defaultValue: DEFAULT_URL },
    cityId: {
        type: ControlType.Enum,
        title: "Ciudad",
        options: CITIES.map((c) => c[0]),
        optionTitles: CITIES.map((c) => c[1]),
        defaultValue: "madrid",
    },
    days: { type: ControlType.Number, title: "Días pasados", min: 1, max: 10, step: 1, defaultValue: 7 },
    colorAi: { type: ControlType.Color, title: "Color IA", defaultValue: "#c026d3" },
    background: { type: ControlType.Color, title: "Fondo", defaultValue: "#ffffff" },
    textColor: { type: ControlType.Color, title: "Texto", defaultValue: "#0f172a" },
    mutedColor: { type: ControlType.Color, title: "Texto suave", defaultValue: "#64748b" },
    radius: { type: ControlType.Number, title: "Esquinas", min: 0, max: 48, defaultValue: 17 },
    shadow: { type: ControlType.BoxShadow, title: "Sombra", defaultValue: "0 24px 60px rgba(15,23,42,0.16)" },
})
