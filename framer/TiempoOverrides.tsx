/**
 * Overrides del tiempo: pon cualquier texto o marco en el lienzo de Framer y, en el panel
 * (Code Overrides → TiempoOverrides), elige qué dato muestra. Así diseñas tú la letra, el
 * tamaño y el sitio, y el dato llega solo.
 *
 * Todos usan la ciudad «global» de la página (la que eligen SelectorCiudad o los
 * overrides withCiudadSiguiente / withCiudadAnterior), la misma que los componentes TiempoApp
 * con «Ciudad: Global».
 */
import { useEffect, useState, type ComponentType } from "react"

const BASE = "https://tmnnidlzmwxgpxufqkgm.supabase.co/storage/v1/object/public/weather"
const HOUR = 3600_000

export const CITIES: [string, string][] = [
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


// --- Ciudad global (compartida con TiempoApp y SelectorCiudad por globalThis) ---
type Place = { name: string; detail: string; km: number; cityName: string }
type CityBus = { city: string; place?: Place | null; subs: Set<() => void> }
function cityBus(): CityBus {
    const g = globalThis as unknown as { __tiempoCiudad?: CityBus }
    if (!g.__tiempoCiudad) g.__tiempoCiudad = { city: "madrid", place: null, subs: new Set() }
    return g.__tiempoCiudad
}
function setGlobalCity(id: string) {
    const bus = cityBus()
    bus.city = id
    bus.place = null
    bus.subs.forEach((f) => f())
}
function usePlace(): Place | null {
    const [place, setPlace] = useState<Place | null>(() => cityBus().place ?? null)
    useEffect(() => {
        const bus = cityBus()
        const on = () => setPlace(bus.place ?? null)
        bus.subs.add(on)
        on()
        return () => {
            bus.subs.delete(on)
        }
    }, [])
    return place
}
function useGlobalCity(): string {
    const [city, setCity] = useState(() => cityBus().city)
    useEffect(() => {
        const bus = cityBus()
        const on = () => setCity(bus.city)
        bus.subs.add(on)
        on()
        return () => {
            bus.subs.delete(on)
        }
    }, [])
    return city
}

// --- Datos: el JSON de la ciudad y lo medido (AEMET), con caché para no pedirlos dos veces ---
type N = number | null
type Model = { times: string[]; temp: number[]; rain: N[]; cloud: N[]; wind: N[]; windDir: N[]; hum?: N[] }
type Doc = {
    city: { id: string; name: string; tz: string }
    models: Model[]
    ml?: { times: string[]; temp: N[] }
    ml_rain?: { days: string[]; prob: number[]; mm: number[] }
}
type Obs = { time: string; temp?: N; hum?: N; wind?: N; windDir?: N; rain1h?: N }
const cache = new Map<string, Promise<any>>()
function get<T>(url: string): Promise<T> {
    if (!cache.has(url)) {
        cache.set(
            url,
            fetch(url, { cache: "no-cache" }).then((r) => {
                if (!r.ok) throw new Error(String(r.status))
                return r.json()
            })
        )
        // Se refresca cada 10 min
        setTimeout(() => cache.delete(url), 10 * 60_000)
    }
    return cache.get(url)! as Promise<T>
}

const COMPASS = ["N", "NE", "E", "SE", "S", "SO", "O", "NO"]
const compass = (deg: number) => COMPASS[Math.round(deg / 45) % 8]
type Kind = "clear-day" | "clear-night" | "partly-day" | "partly-night" | "cloudy" | "overcast" | "drizzle" | "rain" | "unknown"
function kindOf(rain: number, cloud: N, night: boolean): Kind {
    if (rain >= 2) return "rain"
    if (rain >= 0.3) return "drizzle"
    if (cloud == null) return "unknown"
    if (cloud < 25) return night ? "clear-night" : "clear-day"
    if (cloud < 60) return night ? "partly-night" : "partly-day"
    if (cloud < 85) return "cloudy"
    return "overcast"
}
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
// Color de la temperatura (la misma escala «viva» de TiempoApp)
const VIVID: [number, string][] = [
    [-5, "#3b2bd1"], [3, "#2f6fe0"], [9, "#1fa2c9"], [14, "#3fbf9a"], [18, "#b9d35a"],
    [22, "#f6c341"], [27, "#f28a3a"], [33, "#e2452f"], [40, "#a11d33"],
]
function mix(a: string, b: string, k: number) {
    const A = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16))
    const B = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16))
    return `#${A.map((v, i) => Math.round(v + (B[i] - v) * k).toString(16).padStart(2, "0")).join("")}`
}
function tempColor(t: number) {
    if (t <= VIVID[0][0]) return VIVID[0][1]
    for (let i = 1; i < VIVID.length; i++) if (t <= VIVID[i][0]) return mix(VIVID[i - 1][1], VIVID[i][1], (t - VIVID[i - 1][0]) / (VIVID[i][0] - VIVID[i - 1][0]))
    return VIVID[VIVID.length - 1][1]
}

export type Ahora = {
    city: string
    date: string
    temp: number
    max: number | null
    min: number | null
    wind: N
    windDir: N
    hum: N
    cloud: N
    rain: number
    rainToday: N
    kind: Kind
}

// Lo de ahora: la temperatura medida si es reciente (menos de 3 h); si no, la de la IA; si no, la media de los modelos
function computeNow(doc: Doc, obs: Obs | null): Ahora {
    const now = Date.now()
    const tz = doc.city.tz
    const hourOf = (t: number) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "numeric", hourCycle: "h23" }).format(new Date(t)))
    const dayKey = (t: number) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(t))
    const near = (times: string[], vals: N[]) => {
        let best: N = null,
            bd = Infinity
        times.forEach((s, i) => {
            const d = Math.abs(Date.parse(s) - now)
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
    const meanTemp = avg((m) => near(m.times, m.temp))
    const aiTemp = doc.ml ? near(doc.ml.times, doc.ml.temp) : null
    const fresh = obs && now - Date.parse(obs.time) <= 3 * HOUR ? obs : null
    const temp = fresh?.temp ?? aiTemp ?? meanTemp ?? 0
    const cloud = avg((m) => near(m.times, m.cloud))
    const rain = fresh?.rain1h ?? avg((m) => near(m.times, m.rain)) ?? 0
    // Máxima y mínima de hoy (hora local): de la IA si la hay; si no, de la media
    const today = dayKey(now)
    const todayVals: number[] = []
    if (doc.ml) doc.ml.times.forEach((s, i) => dayKey(Date.parse(s)) === today && doc.ml!.temp[i] != null && todayVals.push(doc.ml!.temp[i] as number))
    if (todayVals.length < 3)
        doc.models.forEach((m) => m.times.forEach((s, i) => dayKey(Date.parse(s)) === today && todayVals.push(m.temp[i])))
    const ri = doc.ml_rain?.days.indexOf(today) ?? -1
    return {
        city: doc.city.name,
        date: new Intl.DateTimeFormat("es-ES", { timeZone: tz, weekday: "short", day: "numeric", month: "short" }).format(new Date(now)).replace(/\./g, ""),
        temp,
        max: todayVals.length ? Math.round(Math.max(...todayVals, temp)) : null,
        min: todayVals.length ? Math.round(Math.min(...todayVals, temp)) : null,
        wind: fresh?.wind ?? avg((m) => near(m.times, m.wind)),
        windDir: fresh?.windDir ?? avg((m) => near(m.times, m.windDir)),
        hum: fresh?.hum ?? avg((m) => (m.hum ? near(m.times, m.hum) : null)),
        cloud,
        rain,
        rainToday: ri >= 0 ? doc.ml_rain!.prob[ri] : null,
        kind: kindOf(rain, cloud, hourOf(now) < 7 || hourOf(now) >= 20),
    }
}

/** El dato de ahora de la ciudad global (o null mientras carga). */
export function useAhora(): Ahora | null {
    const city = useGlobalCity()
    const [now, setNow] = useState<Ahora | null>(null)
    useEffect(() => {
        let alive = true
        Promise.all([
            get<Doc>(`${BASE}/cities/${city}.json`),
            get<{ cities: Record<string, Obs> }>(`${BASE}/observed.json`).catch(() => null),
        ])
            .then(([doc, observed]) => alive && setNow(computeNow(doc, observed?.cities?.[city] ?? null)))
            .catch(() => undefined)
        return () => {
            alive = false
        }
    }, [city])
    return now
}

// --- Overrides de texto: pon uno en una capa de texto y su contenido se sustituye por el dato ---
// Cada override toma el dato de ahora (useAhora) y lo escribe en el texto de la capa.

export function withCiudad(Component: ComponentType<any>): ComponentType<any> {
    return (props: any) => {
        const a = useAhora()
        const place = usePlace()
        return <Component {...props} text={place ? place.name : a ? a.city : "…"} />
    }
}
/** De dónde salen los datos cuando eliges un pueblo: «Datos de Madrid · 25 km» (vacío si es una ciudad). */
export function withFuente(Component: ComponentType<any>): ComponentType<any> {
    return (props: any) => {
        const place = usePlace()
        return <Component {...props} text={place ? `Datos de ${place.cityName} · ${place.km} km` : ""} />
    }
}
export function withFecha(Component: ComponentType<any>): ComponentType<any> {
    return (props: any) => {
        const a = useAhora()
        return <Component {...props} text={a ? ((a) => a.date)(a) : "–"} />
    }
}
export function withTemperatura(Component: ComponentType<any>): ComponentType<any> {
    return (props: any) => {
        const a = useAhora()
        return <Component {...props} text={a ? ((a) => `${Math.round(a.temp)}°`)(a) : "–"} />
    }
}
export function withTemperaturaNumero(Component: ComponentType<any>): ComponentType<any> {
    return (props: any) => {
        const a = useAhora()
        return <Component {...props} text={a ? ((a) => `${Math.round(a.temp)}`)(a) : "–"} />
    }
}
export function withEstado(Component: ComponentType<any>): ComponentType<any> {
    return (props: any) => {
        const a = useAhora()
        return <Component {...props} text={a ? ((a) => KIND_LABEL[a.kind])(a) : "–"} />
    }
}
export function withFrase(Component: ComponentType<any>): ComponentType<any> {
    return (props: any) => {
        const a = useAhora()
        return <Component {...props} text={a ? ((a) => WITTY[a.kind])(a) : "–"} />
    }
}
export function withMaxMin(Component: ComponentType<any>): ComponentType<any> {
    return (props: any) => {
        const a = useAhora()
        return <Component {...props} text={a ? ((a) => (a.max != null ? `${a.max}° / ${a.min}°` : "–"))(a) : "–"} />
    }
}
export function withMaxima(Component: ComponentType<any>): ComponentType<any> {
    return (props: any) => {
        const a = useAhora()
        return <Component {...props} text={a ? ((a) => (a.max != null ? `${a.max}°` : "–"))(a) : "–"} />
    }
}
export function withMinima(Component: ComponentType<any>): ComponentType<any> {
    return (props: any) => {
        const a = useAhora()
        return <Component {...props} text={a ? ((a) => (a.min != null ? `${a.min}°` : "–"))(a) : "–"} />
    }
}
export function withViento(Component: ComponentType<any>): ComponentType<any> {
    return (props: any) => {
        const a = useAhora()
        return <Component {...props} text={a ? ((a) => (a.wind != null ? `${Math.round(a.wind)} km/h${a.windDir != null ? " " + compass(a.windDir) : ""}` : "–"))(a) : "–"} />
    }
}
export function withHumedad(Component: ComponentType<any>): ComponentType<any> {
    return (props: any) => {
        const a = useAhora()
        return <Component {...props} text={a ? ((a) => (a.hum != null ? `${Math.round(a.hum)} %` : "–"))(a) : "–"} />
    }
}
export function withNubes(Component: ComponentType<any>): ComponentType<any> {
    return (props: any) => {
        const a = useAhora()
        return <Component {...props} text={a ? ((a) => (a.cloud != null ? `${Math.round(a.cloud)} %` : "–"))(a) : "–"} />
    }
}
export function withLluvia(Component: ComponentType<any>): ComponentType<any> {
    return (props: any) => {
        const a = useAhora()
        return <Component {...props} text={a ? ((a) => `${a.rain >= 0.05 ? String(Math.round(a.rain * 10) / 10).replace(".", ",") : "0"} mm/h`)(a) : "–"} />
    }
}
export function withLluviaHoy(Component: ComponentType<any>): ComponentType<any> {
    return (props: any) => {
        const a = useAhora()
        return <Component {...props} text={a ? ((a) => (a.rainToday != null ? `${Math.round(a.rainToday * 100)} %` : "–"))(a) : "–"} />
    }
}

// --- Overrides de marco: el fondo o el color del texto según el tiempo ---
/** Fondo del marco del color de la temperatura de ahora. */
export function withFondoTemperatura(Component: ComponentType<any>): ComponentType<any> {
    return (props: any) => {
        const a = useAhora()
        return <Component {...props} style={{ ...props.style, background: a ? tempColor(a.temp) : undefined, transition: "background 1s ease" }} />
    }
}
/** Fondo del marco con un degradado del color de la temperatura (más suave). */
export function withDegradadoTemperatura(Component: ComponentType<any>): ComponentType<any> {
    return (props: any) => {
        const a = useAhora()
        const c = a ? tempColor(a.temp) : "#808080"
        return <Component {...props} style={{ ...props.style, background: `radial-gradient(120% 90% at 20% 0%, ${c}, transparent 70%)`, transition: "background 1s ease" }} />
    }
}
/** Color del texto del color de la temperatura de ahora. */
export function withColorTemperatura(Component: ComponentType<any>): ComponentType<any> {
    return (props: any) => {
        const a = useAhora()
        return <Component {...props} style={{ ...props.style, color: a ? tempColor(a.temp) : undefined }} />
    }
}

// --- Overrides para cambiar de ciudad (ponlos en botones) ---
function cityStep(step: number) {
    const ids = CITIES.map((c) => c[0])
    const i = ids.indexOf(cityBus().city)
    setGlobalCity(ids[(i + step + ids.length) % ids.length])
}
export function withCiudadSiguiente(Component: ComponentType<any>): ComponentType<any> {
    return (props: any) => <Component {...props} onTap={() => cityStep(1)} style={{ ...props.style, cursor: "pointer" }} />
}
export function withCiudadAnterior(Component: ComponentType<any>): ComponentType<any> {
    return (props: any) => <Component {...props} onTap={() => cityStep(-1)} style={{ ...props.style, cursor: "pointer" }} />
}
