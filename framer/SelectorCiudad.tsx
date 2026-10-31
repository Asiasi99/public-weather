/**
 * Selector de ciudad o pueblo: cambia la ciudad «global» de la página. Todos los TiempoApp con
 * «Ciudad: Global» y todos los overrides de TiempoOverrides la siguen.
 *
 * Modo «Buscar pueblo»: escribes cualquier pueblo de España (buscador de Open-Meteo) y se usan
 * los datos de la ciudad con previsión más cercana; el nombre del pueblo se ve en withCiudad y la
 * ciudad de origen en withFuente.
 */
import { useEffect, useRef, useState } from "react"
import { addPropertyControls, ControlType } from "framer"

const BASE = "https://tmnnidlzmwxgpxufqkgm.supabase.co/storage/v1/object/public/weather"

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


type Place = { name: string; detail: string; km: number; cityName: string }
type CityBus = { city: string; place?: Place | null; subs: Set<() => void> }
function cityBus(): CityBus {
    const g = globalThis as unknown as { __tiempoCiudad?: CityBus }
    if (!g.__tiempoCiudad) g.__tiempoCiudad = { city: "madrid", place: null, subs: new Set() }
    return g.__tiempoCiudad
}
function setCity(city: string, place: Place | null) {
    const bus = cityBus()
    bus.city = city
    bus.place = place
    bus.subs.forEach((f) => f())
}

// Las ciudades con previsión y sus coordenadas (de index.json), para buscar la más cercana a un pueblo
type CityInfo = { id: string; name: string; lat: number; lon: number }
let citiesPromise: Promise<CityInfo[]> | null = null
function loadCities(): Promise<CityInfo[]> {
    if (!citiesPromise) citiesPromise = fetch(`${BASE}/index.json`).then((r) => r.json()).then((j) => j.cities as CityInfo[])
    return citiesPromise
}
function km(a: { lat: number; lon: number }, b: { lat: number; lon: number }) {
    const R = 6371,
        r = Math.PI / 180
    const dLat = (b.lat - a.lat) * r,
        dLon = (b.lon - a.lon) * r
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2
    return 2 * R * Math.asin(Math.sqrt(h))
}
type GeoHit = { name: string; latitude: number; longitude: number; admin1?: string; admin2?: string }

interface Props {
    mode: "buscar" | "lista"
    initial: string
    placeholder: string
    background: string
    color: string
    muted: string
    accent: string
    font: any
    radius: number
    padding: number
    border: string
    followTheme: boolean
}

// Tema compartido con TiempoVertical (claro / oscuro)
type TemaBus = { tema: "claro" | "oscuro"; subs: Set<() => void> }
function useTema(): "claro" | "oscuro" | null {
    const [t, setT] = useState<"claro" | "oscuro" | null>(() => (globalThis as any).__tiempoTema?.tema ?? null)
    useEffect(() => {
        const g = globalThis as unknown as { __tiempoTema?: TemaBus }
        if (!g.__tiempoTema) g.__tiempoTema = { tema: "claro", subs: new Set() }
        const bus = g.__tiempoTema
        const on = () => setT(bus.tema)
        bus.subs.add(on)
        on()
        return () => {
            bus.subs.delete(on)
        }
    }, [])
    return t
}

/**
 * @framerSupportedLayoutWidth any
 * @framerSupportedLayoutHeight auto
 */
export default function SelectorCiudad({
    mode = "buscar",
    initial = "madrid",
    placeholder = "Busca tu pueblo…",
    background: background0 = "#141418",
    color: color0 = "#f4f3ef",
    muted: muted0 = "#8a8986",
    accent: accent0 = "#8f7bff",
    font,
    radius = 10,
    padding = 10,
    border: border0 = "rgba(255,255,255,0.12)",
    followTheme = true,
}: Props) {
    // Si sigue el tema de la app, sus colores cambian solos con el modo claro / oscuro
    const tema = useTema()
    const T = followTheme && tema
    const background = T ? (tema === "oscuro" ? "rgba(255,255,255,0.06)" : "rgba(255,255,255,0.6)") : background0,
        color = T ? (tema === "oscuro" ? "#eef0f6" : "#1d1a17") : color0,
        muted = T ? (tema === "oscuro" ? "#7d8396" : "#8a7f72") : muted0,
        accent = T ? "#3d6bff" : accent0,
        border = T ? (tema === "oscuro" ? "rgba(255,255,255,0.12)" : "rgba(29,26,23,0.12)") : border0
    const listBg = T ? (tema === "oscuro" ? "#0d0e14" : "#fbf8f2") : background
    const [city, setCityState] = useState(() => cityBus().city)
    const [q, setQ] = useState("")
    const [hits, setHits] = useState<GeoHit[]>([])
    const [open, setOpen] = useState(false)
    const [label, setLabel] = useState("")
    const timer = useRef<any>(null)

    // La ciudad de partida: la del panel
    useEffect(() => {
        const bus = cityBus()
        if (initial && bus.city !== initial && !bus.place) setCity(initial, null)
        const on = () => {
            setCityState(bus.city)
            setLabel(bus.place ? bus.place.name : CITIES.find((c) => c[0] === bus.city)?.[1] ?? bus.city)
        }
        bus.subs.add(on)
        on()
        return () => {
            bus.subs.delete(on)
        }
    }, [initial])

    // Buscar mientras escribes (con una pequeña espera para no preguntar en cada letra)
    useEffect(() => {
        if (mode !== "buscar") return
        clearTimeout(timer.current)
        if (q.trim().length < 2) {
            setHits([])
            return
        }
        timer.current = setTimeout(() => {
            fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q.trim())}&count=6&language=es&countryCode=ES`)
                .then((r) => r.json())
                .then((j) => setHits((j.results ?? []) as GeoHit[]))
                .catch(() => setHits([]))
        }, 250)
    }, [q, mode])

    const choose = async (h: GeoHit) => {
        const list = await loadCities()
        const here = { lat: h.latitude, lon: h.longitude }
        const best = list.reduce((a, b) => (km(here, b) < km(here, a) ? b : a))
        const d = km(here, best)
        // Si el pueblo es una de las ciudades (o está a menos de 3 km), sin aviso de «datos de»
        setCity(best.id, d < 3 ? null : { name: h.name, detail: [h.admin2, h.admin1].filter(Boolean).join(", "), km: Math.round(d), cityName: best.name })
        setQ("")
        setHits([])
        setOpen(false)
    }

    const text = { ...(font || { fontFamily: "'JetBrains Mono', ui-monospace, monospace", fontSize: 12 }), color }
    const shell = {
        width: "100%",
        boxSizing: "border-box" as const,
        background,
        border: `1px solid ${border}`,
        borderRadius: radius,
        padding: `${padding}px ${padding + 6}px`,
        ...text,
        outline: "none",
    }

    if (mode === "lista")
        return (
            <select
                value={city}
                onChange={(e: { target: { value: string } }) => setCity(e.target.value, null)}
                style={{ ...shell, appearance: "none", WebkitAppearance: "none", cursor: "pointer" }}
            >
                {CITIES.map(([id, name]) => (
                    <option key={id} value={id}>
                        {name}
                    </option>
                ))}
            </select>
        )

    return (
        <div style={{ position: "relative", width: "100%" }}>
            <input
                value={open ? q : label}
                placeholder={placeholder}
                onFocus={() => {
                    setOpen(true)
                    setQ("")
                }}
                onBlur={() => setTimeout(() => setOpen(false), 150)}
                onChange={(e: { target: { value: string } }) => setQ(e.target.value)}
                onKeyDown={(e: { key: string }) => {
                    if (e.key === "Enter" && hits[0]) choose(hits[0])
                }}
                style={shell}
            />
            {open && hits.length > 0 && (
                <div
                    style={{
                        position: "absolute",
                        zIndex: 20,
                        top: "calc(100% + 6px)",
                        left: 0,
                        right: 0,
                        background: listBg,
                        border: `1px solid ${border}`,
                        borderRadius: radius,
                        overflow: "hidden",
                        boxShadow: "0 12px 30px rgba(0,0,0,0.35)",
                    }}
                >
                    {hits.map((h, i) => (
                        <div
                            key={`${h.name}-${i}`}
                            onMouseDown={() => choose(h)}
                            style={{ padding: `${padding - 2}px ${padding + 6}px`, cursor: "pointer", borderTop: i ? `1px solid ${border}` : "none", ...text }}
                            onMouseEnter={(e: { currentTarget: { style: { background: string } } }) => (e.currentTarget.style.background = "rgba(255,255,255,0.06)")}
                            onMouseLeave={(e: { currentTarget: { style: { background: string } } }) => (e.currentTarget.style.background = "transparent")}
                        >
                            <span>{h.name}</span>
                            <span style={{ color: muted, marginLeft: 8, fontSize: "0.85em" }}>{[h.admin2, h.admin1].filter(Boolean).join(", ")}</span>
                        </div>
                    ))}
                    <div style={{ padding: `6px ${padding + 6}px`, color: accent, fontSize: 10, fontFamily: "'JetBrains Mono', ui-monospace, monospace" }}>Se usan los datos de la ciudad con previsión más cercana</div>
                </div>
            )}
        </div>
    )
}

addPropertyControls(SelectorCiudad, {
    followTheme: { type: ControlType.Boolean, title: "Seguir tema app", defaultValue: true },
    mode: { type: ControlType.Enum, title: "Modo", options: ["buscar", "lista"], optionTitles: ["Buscar pueblo", "Lista de ciudades"], defaultValue: "buscar", displaySegmentedControl: true },
    initial: { type: ControlType.Enum, title: "Ciudad inicial", options: CITIES.map((c) => c[0]), optionTitles: CITIES.map((c) => c[1]), defaultValue: "madrid" },
    placeholder: { type: ControlType.String, title: "Texto vacío", defaultValue: "Busca tu pueblo…", hidden: (p: any) => p.mode !== "buscar" },
    background: { type: ControlType.Color, title: "Fondo", defaultValue: "#141418", hidden: (p: any) => p.followTheme !== false },
    color: { type: ControlType.Color, title: "Texto", defaultValue: "#f4f3ef", hidden: (p: any) => p.followTheme !== false },
    muted: { type: ControlType.Color, title: "Texto suave", defaultValue: "#8a8986", hidden: (p: any) => p.followTheme !== false },
    accent: { type: ControlType.Color, title: "Acento", defaultValue: "#8f7bff", hidden: (p: any) => p.followTheme !== false },
    border: { type: ControlType.Color, title: "Borde", defaultValue: "rgba(255,255,255,0.12)", hidden: (p: any) => p.followTheme !== false },
    font: { type: ControlType.Font, title: "Letra", controls: "extended" },
    radius: { type: ControlType.Number, title: "Esquinas", min: 0, max: 40, defaultValue: 10 },
    padding: { type: ControlType.Number, title: "Margen", min: 0, max: 30, defaultValue: 10 },
})
