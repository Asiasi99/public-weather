/**
 * TiempoNucleo — la base común de las piezas del tiempo (no es un componente para el lienzo).
 *
 * Aquí están los datos, el tema claro/oscuro compartido y las cinco secciones:
 *   SeccionAhora (esfera, temperatura, estado, frase) · SeccionAvisos · SeccionDatos (sensación, lluvia, humedad, viento)
 *   SeccionGrafico (la tira de los próximos días) · SeccionAcierto (¿acierta la IA?)
 * Las usan TiempoAhora, TiempoAvisos, TiempoDatos, TiempoGrafico, TiempoAcierto y TiempoVertical (todo junto).
 */
import { RenderTarget } from "framer"
import { useEffect, useMemo, useRef, useState } from "react"

export const BASE = "https://tmnnidlzmwxgpxufqkgm.supabase.co/storage/v1/object/public/weather"
const HOUR = 3600_000
export const MONO = "'Geist Mono', ui-monospace, Menlo, monospace"
export const SANS = "Satoshi, Geist, 'Inter Tight', system-ui, sans-serif"

// ---------------- Idioma (español o inglés) ----------------
// «auto» sigue al navegador. Cada texto lleva sus dos idiomas en el mismo sitio: t("Lluvia", "Rain").
let IDI: "es" | "en" = "es"
export function setIdioma(i: "auto" | "es" | "en") {
    IDI = i === "auto" ? (typeof navigator !== "undefined" && !/^es/i.test(navigator.language || "es") ? "en" : "es") : i
}
export const t = (es: string, en: string) => (IDI === "en" ? en : es)
const LOC = () => (IDI === "en" ? "en-GB" : "es-ES")
const dec1 = (v: number) => (IDI === "en" ? v.toFixed(1) : v.toFixed(1).replace(".", ","))

// ---------------- Ciudad global (compartida con los demás componentes) ----------------
type CityBus = { city: string; place?: unknown; subs: Set<() => void> }
export function cityBus(): CityBus {
    const g = globalThis as unknown as { __tiempoCiudad?: CityBus }
    if (!g.__tiempoCiudad) g.__tiempoCiudad = { city: "madrid", place: null, subs: new Set() }
    return g.__tiempoCiudad
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

// ---------------- Tema compartido (claro / oscuro) para que el buscador y la página cambien a la vez ----------------
type TemaBus = { tema: "claro" | "oscuro"; subs: Set<() => void> }
function temaBus(): TemaBus {
    const g = globalThis as unknown as { __tiempoTema?: TemaBus }
    if (!g.__tiempoTema) g.__tiempoTema = { tema: "claro", subs: new Set() }
    return g.__tiempoTema
}
const TEMA_KEY = "tiempo-tema"
function readSaved(): "claro" | "oscuro" | null {
    try {
        const v = localStorage.getItem(TEMA_KEY)
        return v === "claro" || v === "oscuro" ? v : null
    } catch {
        return null
    }
}

// ---------------- Datos ----------------
type N = number | null
type Model = {
    id?: string
    times: string[]
    temp: N[]
    rain?: N[]
    cloud?: N[]
    cloudLow?: N[]
    cloudMid?: N[]
    cloudHigh?: N[]
    wind?: N[]
    windDir?: N[]
    hum?: N[]
}
type Doc = { city: { id: string; name: string; tz: string; lat?: number; lon?: number }; models: Model[]; ml?: { times: string[]; temp: N[]; p10?: N[]; p90?: N[]; mae_ia?: number; mae_media?: number }; ml_rain?: { days: string[]; prob: N[]; mm: N[] }; acierto?: Acierto }
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
        setTimeout(() => cache.delete(url), 10 * 60_000)
    }
    return cache.get(url)! as Promise<T>
}

type Hour = { t: number; temp: number; rain: number; wind: N; dir: N; hum: N; lo: N; mid: N; hi: N; cloud: N; sd: N; corr: N }

/** Valor de una serie en el instante t: interpola entre las dos muestras de alrededor (si están a menos de 7 h) */
function at(ts: number[], vals: N[] | undefined, t: number): N {
    if (!vals || !ts.length) return null
    let i = 0
    while (i < ts.length && ts[i] < t) i++
    const a = i - 1,
        b = i
    const va = a >= 0 ? vals[a] : null,
        vb = b < ts.length ? vals[b] : null
    if (va != null && vb != null && ts[b] - ts[a] <= 7 * HOUR) return va + ((vb - va) * (t - ts[a])) / Math.max(1, ts[b] - ts[a])
    if (vb != null && b < ts.length && Math.abs(ts[b] - t) <= 3 * HOUR) return vb
    if (va != null && a >= 0 && Math.abs(ts[a] - t) <= 3 * HOUR) return va
    return null
}
/** Lluvia por hora: la del tramo que contiene t, repartida entre las horas del tramo */
function rainAt(ts: number[], vals: N[] | undefined, t: number): N {
    if (!vals) return null
    for (let i = 1; i < ts.length; i++) {
        if (ts[i - 1] < t + 1 && t <= ts[i]) {
            const v = vals[i]
            return v == null ? null : v / Math.max(1, (ts[i] - ts[i - 1]) / HOUR)
        }
    }
    return null
}
const mean = (xs: N[]) => {
    const v = xs.filter((x): x is number => x != null && isFinite(x))
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null
}
/**
 * Desviación de la temperatura en un momento (en °): cuánto puede variar respecto a lo previsto.
 * Con la IA sale de su rango 10-90 % (en una campana, de p10 a p90 hay 2,56 desviaciones);
 * sin IA, de lo que discrepan los modelos entre sí.
 */
function spreadAt(ml: { times: string[]; p10?: N[]; p90?: N[] } | undefined, mlTs: number[], ms: { m: { temp?: N[] }; ts: number[] }[], t: number): N {
    if (ml?.p10 && ml?.p90) {
        const a = at(mlTs, ml.p10, t),
            b = at(mlTs, ml.p90, t)
        if (a != null && b != null) return Math.max(0, b - a) / 2.563
    }
    const v = ms.map(({ m, ts }) => at(ts, m.temp, t)).filter((x): x is number => x != null)
    if (v.length < 2) return null
    const mu = v.reduce((s, x) => s + x, 0) / v.length
    return Math.sqrt(v.reduce((s, x) => s + (x - mu) * (x - mu), 0) / (v.length - 1))
}

/** Un día del «¿acertó la IA?» (scripts/ml/acierto.py): lo que se previó y lo que midió AEMET */
type AciertoDay = {
    day: string
    temp?: { max: N; min: N; mod_max: N; mod_min: N }
    rain?: { prob: N; mm: N; mod_prob: N; mod_mm: N }
    obs: { mm: N; tmax: N; tmin: N } | null
}
type Acierto = { station?: { id: string; name: string; km: number }; days: AciertoDay[] }

/** Recuento de los últimos días con dato medido: error medio de la IA y de los modelos, y quién se acercó más */
function recuento(a: Acierto | undefined | null) {
    const days = a?.days ?? []
    const rows = days.filter((d) => d.obs && d.temp).slice(-7)
    let eI = 0,
        eM = 0,
        n = 0,
        winI = 0,
        winM = 0
    for (const r of rows) {
        const pairs: [N, N, N][] = [
            [r.temp!.max, r.temp!.mod_max, r.obs!.tmax],
            [r.temp!.min, r.temp!.mod_min, r.obs!.tmin],
        ]
        for (const [p, m, o] of pairs) {
            if (p == null || m == null || o == null) continue
            const ai = Math.abs(p - o),
                mo = Math.abs(m - o)
            eI += ai
            eM += mo
            n++
            if (ai < mo - 0.05) winI++
            else if (mo < ai - 0.05) winM++
        }
    }
    const pend = days.filter((d) => !d.obs && d.day <= new Date().toISOString().slice(0, 10)).length
    const maeI = n ? eI / n : null,
        maeM = n ? eM / n : null
    const dec = (v: number) => dec1(uTd(v))
    const resumen =
        maeI == null || maeM == null
            ? t("Aún sin datos medidos: AEMET los publica de 1 a 4 días después.", "No measurements yet: AEMET publishes them 1 to 4 days later.")
            : maeI < maeM - 0.05
              ? t(`La IA va acertando: falla ${dec(maeI)}° de media; los modelos solos, ${dec(maeM)}°.`, `The AI is doing well: average error ${dec(maeI)}°; models alone, ${dec(maeM)}°.`)
              : maeI > maeM + 0.05
                ? t(`Estos días la IA va peor: falla ${dec(maeI)}° de media; los modelos solos, ${dec(maeM)}°.`, `Lately the AI is doing worse: average error ${dec(maeI)}°; models alone, ${dec(maeM)}°.`)
                : t(`Empate: los dos fallan unos ${dec(maeI)}° de media.`, `A tie: both are off by about ${dec(maeI)}°.`)
    return { rows, n, maeI, maeM, winI, winM, pend, resumen, station: a?.station ?? null }
}

/**
 * ¿Llueve de verdad a esta hora? Lluvia media de al menos 0,05 mm y el cielo cubierto al menos a la mitad
 * (así no sale lluvia «de un solo modelo» con el cielo despejado). Sin dato de nubes, vale solo la lluvia.
 */
function llueve(h: { rain: number; cloud?: N; lo?: N; mid?: N; hi?: N }) {
    if (h.rain < 0.05) return false
    const nub = h.cloud ?? (h.lo != null || h.mid != null || h.hi != null ? Math.max(h.lo ?? 0, h.mid ?? 0, h.hi ?? 0) : null)
    return nub == null || nub >= 50
}

/** Corrección media de la IA en un día (°): + si cree que hará más que los modelos, − si menos */
function dayCorr(list: { corr?: N }[]): number | null {
    const v = list.map((h) => h.corr).filter((x): x is number => x != null)
    return v.length >= 3 ? v.reduce((s, x) => s + x, 0) / v.length : null
}
/**
 * Qué corrige la IA ese día y por qué, por tramos: madrugada (antes de salir el sol), día y noche
 * (después de ponerse). Para cada tramo: sus horas, cuánto corrige de media y la razón probable.
 * Es una explicación probable: la IA no «dice» sus motivos, pero aprende de los errores de los
 * modelos aquí, y esos errores casi siempre vienen de estas situaciones (cielo, viento, lluvia…).
 */
type Tramo = { nombre: string; desde: number; hasta: number; c: number; razon: string }
function explicaIA(list: Hour[], esNoche: (t: number) => boolean, fmt: (v: number) => string): { tramos: Tramo[]; acuerdo: string | null } {
    const m = (xs: N[]) => {
        const v = xs.filter((x): x is number => x != null)
        return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null
    }
    const nube = (h: Hour) => h.cloud ?? (h.lo != null || h.mid != null || h.hi != null ? Math.max(h.lo ?? 0, h.mid ?? 0, h.hi ?? 0) : null)
    // tramos seguidos de noche / día
    const runs: Hour[][] = []
    list.forEach((h, i) => {
        if (i && esNoche(h.t) === esNoche(list[i - 1].t)) runs[runs.length - 1].push(h)
        else runs.push([h])
    })
    const tramos: Tramo[] = []
    runs.forEach((r, i) => {
        const c = m(r.map((h) => h.corr))
        if (c == null || r.length < 2) return
        const noche = esNoche(r[0].t)
        const nombre = !noche ? t("Día", "Daytime") : i === 0 ? t("Madrugada", "Early hours") : t("Noche", "Night")
        const nub = m(r.map(nube)) ?? 50,
            vie = m(r.map((h) => h.wind)) ?? 0,
            llueve = r.some((h) => h.rain >= 0.3)
        let razon: string
        if (Math.abs(c) < 0.3) razon = t("Los modelos ya cuadran con lo que se mide aquí: apenas toca.", "The models already match what's measured here.")
        else if (noche) {
            if (c < 0 && nub < 35 && vie < 12) razon = t("Despejado y sin viento: el suelo pierde calor y enfría más de lo que dan los modelos.", "Clear and calm: the ground loses heat and it gets colder than the models say.")
            else if (c < 0) razon = t("Aquí a esas horas suele hacer más frío de lo que dan los modelos.", "It's usually colder here at those hours than the models say.")
            else if (nub >= 60) razon = t("Las nubes hacen de manta y no dejan enfriar tanto.", "Clouds act as a blanket and stop it cooling as much.")
            else if (vie >= 15) razon = t("El viento mezcla el aire y no deja que enfríe.", "Wind mixes the air and stops it cooling.")
            else razon = t("Aquí a esas horas suele hacer menos frío de lo que dan los modelos.", "It's usually milder here at those hours than the models say.")
        } else {
            if (c < 0 && llueve) razon = t("La lluvia refresca y no sube tanto.", "Rain cools things down, so it doesn't warm as much.")
            else if (c < 0 && nub >= 60) razon = t("Muchas nubes: frenan el sol y no sube tanto.", "Thick cloud blocks the sun, so it doesn't warm as much.")
            else if (c < 0) razon = t("Los modelos suelen pasarse de calor aquí de día.", "The models usually run too warm here during the day.")
            else if (nub < 30) razon = t("Sol pleno: aquí calienta más de lo que dan los modelos.", "Full sun: it gets warmer here than the models say.")
            else razon = t("De día aquí suele hacer más de lo que dan los modelos.", "Days here tend to be warmer than the models say.")
        }
        tramos.push({ nombre, desde: r[0].t, hasta: r[r.length - 1].t + HOUR, c, razon })
    })
    const sd = m(list.map((h) => h.sd))
    const acuerdo = sd != null && sd >= 1.5 ? t(`Los modelos no se ponen de acuerdo (±${fmt(sd).replace(/^[+−]/, "")}): la IA se fía más de los que mejor aciertan aquí.`, `The models disagree (±${fmt(sd).replace(/^[+−]/, "")}): the AI trusts the ones that do best here.`) : null
    return { tramos, acuerdo }
}
const signo = (v: number) => (Math.abs(v) < 0.05 ? dec1(0) : `${v > 0 ? "+" : "−"}${dec1(Math.abs(v))}`)

function meanDir(ds: N[], ws: N[]) {
    let x = 0,
        y = 0,
        n = 0
    ds.forEach((d, i) => {
        if (d == null) return
        const w = ws[i] ?? 1
        x += Math.sin((d * Math.PI) / 180) * (w || 1)
        y += Math.cos((d * Math.PI) / 180) * (w || 1)
        n++
    })
    return n ? ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360 : null
}

function buildHours(doc: Doc, hours: number): Hour[] {
    const t0 = Math.floor(Date.now() / HOUR) * HOUR
    const ms = doc.models.map((m) => ({ m, ts: m.times.map((s) => Date.parse(s)) }))
    const mlTs = doc.ml ? doc.ml.times.map((s) => Date.parse(s)) : []
    const out: Hour[] = []
    for (let k = 0; k <= hours; k++) {
        const t = t0 + k * HOUR
        const mTemp = mean(ms.map(({ m, ts }) => at(ts, m.temp, t)))
        const ai = doc.ml ? at(mlTs, doc.ml.temp, t) : null
        const temp = ai ?? mTemp
        if (temp == null) continue
        const winds = ms.map(({ m, ts }) => at(ts, m.wind, t))
        out.push({
            t,
            temp,
            rain: mean(ms.map(({ m, ts }) => rainAt(ts, m.rain, t))) ?? 0,
            wind: mean(winds),
            dir: meanDir(
                ms.map(({ m, ts }) => at(ts, m.windDir, t)),
                winds
            ),
            hum: mean(ms.map(({ m, ts }) => at(ts, m.hum, t))),
            lo: mean(ms.map(({ m, ts }) => at(ts, m.cloudLow, t))),
            mid: mean(ms.map(({ m, ts }) => at(ts, m.cloudMid, t))),
            hi: mean(ms.map(({ m, ts }) => at(ts, m.cloudHigh, t))),
            cloud: mean(ms.map(({ m, ts }) => at(ts, m.cloud, t))),
            sd: spreadAt(doc.ml, mlTs, ms, t),
            corr: ai != null && mTemp != null ? ai - mTemp : null,
        })
    }
    return out
}

// ---------------- Colores ----------------
export function hexRgb(c: string): number[] {
    const v = (c || "").trim()
    if (v.startsWith("#")) {
        const h = v.length === 4 || v.length === 5 ? [...v.slice(1, 4)].map((x) => x + x).join("") : v.slice(1, 7)
        const out = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16))
        return out.some((n) => isNaN(n)) ? [128, 128, 128] : out
    }
    const m = v.match(/rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i)
    return m ? [m[1], m[2], m[3]].map((n) => Math.round(Number(n))) : [128, 128, 128]
}
export const mix = (a: string, b: string, k: number) => {
    const A = hexRgb(a),
        B = hexRgb(b)
    return `#${A.map((v, i) => Math.round(v + (B[i] - v) * Math.min(1, Math.max(0, k))).toString(16).padStart(2, "0")).join("")}`
}
export const rgba = (c: string, a: number) => `rgba(${hexRgb(c).join(",")},${a.toFixed(3)})`
export function scale(stops: [number, string][], v: number) {
    if (v <= stops[0][0]) return stops[0][1]
    for (let i = 1; i < stops.length; i++) if (v <= stops[i][0]) return mix(stops[i - 1][1], stops[i][1], (v - stops[i - 1][0]) / (stops[i][0] - stops[i - 1][0]))
    return stops[stops.length - 1][1]
}

/**
 * Colores del viento según la velocidad (km/h), distintos de los de la temperatura:
 * calma lavanda pálida → violeta → magenta («Color viento») → rosa-rojo intenso con temporal.
 */
export const windStops = (acento = "#e0248a"): [number, string][] => [
    [0, "#d9d4ff"],
    [10, "#ab9cff"],
    [22, "#7c5cff"],
    [35, "#b43cf0"],
    [50, acento],
    [75, "#ff2d55"],
]
export const wcol = (kmh: number, acento?: string) => scale(windStops(acento), kmh)

// Curva suave que pasa por todos los puntos (Catmull-Rom), vale para curvas verticales
function curve(p: [number, number][]): string {
    if (!p.length) return ""
    const f = (v: number) => v.toFixed(1)
    let d = `M${f(p[0][0])},${f(p[0][1])}`
    for (let i = 0; i < p.length - 1; i++) {
        const p0 = p[i - 1] ?? p[i],
            p1 = p[i],
            p2 = p[i + 1],
            p3 = p[i + 2] ?? p2
        const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6],
            c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6]
        d += `C${f(c1[0])},${f(c1[1])} ${f(c2[0])},${f(c2[1])} ${f(p2[0])},${f(p2[1])}`
    }
    return d
}

// ---------------- Sensación térmica y avisos ----------------
/** Lo que nota el cuerpo: con frío y viento, el viento enfría (wind chill); con calor y humedad, la humedad calienta (índice de calor NOAA) */
function feelsOf(t: number, wind: N, hum: N) {
    if (t <= 10 && wind != null && wind > 4.8) {
        const v = Math.pow(wind, 0.16)
        return 13.12 + 0.6215 * t - 11.37 * v + 0.3965 * t * v
    }
    if (t >= 26 && hum != null) {
        const T = t * 1.8 + 32,
            R = hum
        const HI = -42.379 + 2.04901523 * T + 10.14333127 * R - 0.22475541 * T * R - 0.00683783 * T * T - 0.05481717 * R * R + 0.00122874 * T * T * R + 0.00085282 * T * R * R - 0.00000199 * T * T * R * R
        return Math.max(t, (HI - 32) / 1.8)
    }
    return t
}
// Colores de aviso como los de AEMET: amarillo, naranja, rojo
const ALERT = ["", "#f2c94c", "#f2994a", "#eb5757"]
type AlertRun = { kind: string; level: number; a: number; b: number }

// ---------------- Sol: salida y puesta (ecuación del amanecer, precisión de ~1 min) ----------------
function sunTimes(dayMs: number, lat: number, lon: number): [number, number] | null {
    const rad = Math.PI / 180
    const n = Math.round(dayMs / 86400000 + 2440587.5 - 2451545.0 + 0.0008)
    const Js = n - lon / 360
    const M = (357.5291 + 0.98560028 * Js) % 360
    const C = 1.9148 * Math.sin(M * rad) + 0.02 * Math.sin(2 * M * rad) + 0.0003 * Math.sin(3 * M * rad)
    const L = (M + C + 180 + 102.9372) % 360
    const Jt = 2451545.0 + Js + 0.0053 * Math.sin(M * rad) - 0.0069 * Math.sin(2 * L * rad)
    const dec = Math.asin(Math.sin(L * rad) * Math.sin(23.4397 * rad))
    const cosW = (Math.sin(-0.833 * rad) - Math.sin(lat * rad) * Math.sin(dec)) / (Math.cos(lat * rad) * Math.cos(dec))
    if (cosW < -1 || cosW > 1) return null
    const w = Math.acos(cosW) / rad
    const toMs = (J: number) => (J - 2440587.5) * 86400000
    return [toMs(Jt - w / 360), toMs(Jt + w / 360)]
}

// ---------------- Frases para debajo de la temperatura ----------------
// Situaciones del cielo y estilos. Las frases rotan a lo largo del día (cambian cada hora, sin repetirse al recargar).
type Sit = "sol" | "pocas" | "nocheClara" | "nocheNubes" | "nuboso" | "cubierto" | "llovizna" | "lluvia" | "calor" | "frio" | "viento" | "niebla"
export type Estilo = "mezcla" | "clasico" | "practico" | "loQueViene" | "poetico" | "humor" | "minimo" | "propia"

const FRASES: Record<"clasico" | "poetico" | "humor", Record<Sit, string[]>> = {
    clasico: {
        sol: ["Es hora de sol.", "Cielo limpio de punta a punta.", "Día abierto. Sal a por él.", "Sol pleno, sin peros.", "Ni una nube a la vista."],
        pocas: ["Sol, con alguna nube de paso.", "Claros y alguna nube viajera.", "Sol con compañía.", "Nubes sueltas, sol de fondo.", "Casi despejado."],
        nocheClara: ["Noche clara. Mira arriba.", "Cielo despejado esta noche.", "Noche limpia y tranquila.", "Estrellas a la vista.", "Ni una nube tapa la noche."],
        nocheNubes: ["Noche tranquila.", "Noche con algunas nubes.", "Nubes de paso en la oscuridad.", "Noche serena, cielo a ratos.", "Calma nocturna."],
        nuboso: ["Gris, pero seco.", "Más nube que sol.", "Cielo entre algodones.", "Nublado, sin lluvia.", "El sol se esconde a ratos."],
        cubierto: ["Cielo de techo bajo.", "Todo gris, de lado a lado.", "Cubierto y quieto.", "Un día de luz suave.", "Las nubes lo tapan todo."],
        llovizna: ["Chispea. Paraguas pequeño.", "Cae una lluvia fina.", "Llovizna ligera.", "Gotas sueltas en el aire.", "Moja poco, pero moja."],
        lluvia: ["Sí. Está lloviendo.", "Lluvia de las de verdad.", "Día de agua.", "Llueve con ganas.", "El suelo ya brilla."],
        calor: ["Calor de los que pesan.", "Aprieta el sol.", "Día de mucho calor.", "Ambiente caldeado.", "Calor intenso hoy."],
        frio: ["Frío de bufanda.", "Hace frío de verdad.", "El aire corta.", "Día frío.", "Temperaturas bajas."],
        viento: ["Sopla con fuerza.", "Día de viento.", "El aire no para.", "Rachas fuertes.", "Viento protagonista."],
        niebla: ["Niebla y humedad.", "El aire está espeso.", "Visibilidad reducida.", "Humedad a tope.", "Todo envuelto en bruma."],
    },
    poetico: {
        sol: ["La luz tiene el día libre.", "El cielo se ha puesto su mejor azul.", "Todo brilla un poco más hoy.", "El sol firma cada sombra.", "Un azul sin borrones."],
        pocas: ["Nubes que pasean sin prisa.", "El sol juega al escondite.", "Algodones sueltos sobre el azul.", "Luz y sombra se turnan.", "Un cielo con párrafos sueltos."],
        nocheClara: ["Las estrellas están de guardia.", "La noche se ha quitado el velo.", "Un cielo para contar estrellas.", "La luna tiene el escenario libre.", "Noche de cristal."],
        nocheNubes: ["La noche se tapa con una manta fina.", "Nubes que cruzan sin hacer ruido.", "La ciudad duerme bajo algodón.", "Oscuridad suave.", "Noche de murmullo."],
        nuboso: ["El cielo se ha puesto un jersey gris.", "Luz tamizada, como de estudio.", "Un día de acuarela.", "El sol habla en voz baja.", "Nubes con ganas de quedarse."],
        cubierto: ["Un techo de nubes, bajito.", "El cielo cerrado por reformas.", "Gris perla de lado a lado.", "La luz llega filtrada.", "Un día en blanco y negro."],
        llovizna: ["El cielo susurra agua.", "Lluvia que casi no pesa.", "Gotas que no tienen prisa.", "Un rocío que cae del cielo.", "Llueve en voz baja."],
        lluvia: ["El cielo tiene mucho que decir.", "La ciudad suena a lluvia.", "Charcos que reflejan farolas.", "Agua para todos.", "Día de cristales mojados."],
        calor: ["El aire vibra sobre el asfalto.", "El verano no se quiere ir.", "Las sombras cotizan al alza.", "Todo arde un poco.", "El sol no da tregua."],
        frio: ["El aire tiene filo.", "El vaho se ve al hablar.", "Frío de manos en los bolsillos.", "Un día de lana.", "El invierno asoma la nariz."],
        viento: ["El viento reordena la ciudad.", "Todo se mueve, hasta las ideas.", "El aire tiene prisa.", "Las ramas bailan solas.", "Un día despeinado."],
        niebla: ["La ciudad se ha borrado un poco.", "Todo parece un sueño.", "El mundo termina a cien metros.", "Niebla de película.", "Paisaje en pausa."],
    },
    humor: {
        sol: ["El cielo ha venido a trabajar.", "Ni una nube. Sospechoso.", "Sol en modo influencer.", "Hoy no hay excusas.", "Las gafas de sol, felices."],
        pocas: ["Algunas nubes, por decorar.", "Nubes de atrezo.", "Sol con figurantes.", "Nubes que no se comprometen.", "Un poco de todo, sin drama."],
        nocheClara: ["Las estrellas han fichado.", "La luna sin filtros.", "Noche de wifi cósmico.", "Cielo en alta definición.", "Ideal para pedir deseos."],
        nocheNubes: ["La noche, en modo incógnito.", "Estrellas: hoy no toca.", "Nubes haciendo horas extra.", "La luna, de vacaciones.", "Oscuro y punto."],
        nuboso: ["El sol, en una reunión.", "Gris, pero sin dramas.", "Las nubes han venido a quedarse un rato.", "Día en modo ahorro de energía.", "Ni frío ni calor: nublado."],
        cubierto: ["El cielo, en mantenimiento.", "Gris corporativo.", "Alguien ha bajado la persiana.", "Hoy el sol teletrabaja.", "Techo de cincuenta sombras de gris."],
        llovizna: ["Chispea. Ni pa' ti ni pa' mí.", "Lluvia de las que no se deciden.", "Moja pero no convence.", "El cielo estornuda.", "Lluvia en versión demo."],
        lluvia: ["Sí. Está lloviendo.", "El paraguas por fin tiene trabajo.", "Las plantas, encantadas.", "Día de pelo encrespado.", "Lluvia nivel: se nota."],
        calor: ["Hace un calor que derrite opiniones.", "El aire acondicionado es tu mejor amigo.", "Hoy los helados cotizan al alza.", "Sudar sin hacer deporte: hoy sí.", "El sol, sin moderación."],
        frio: ["Hace frío de abrazar el radiador.", "Hoy la manta no se separa de ti.", "El frío ha venido sin avisar.", "Día de capas, como una cebolla.", "Ni los pingüinos salen."],
        viento: ["Peinarse hoy es opcional.", "El paraguas, en modo cometa.", "Viento de los que se llevan las ganas.", "Hoy vuela hasta la ropa tendida.", "Rachas con personalidad."],
        niebla: ["Modo Silent Hill activado.", "No se ve ni el vecino.", "Niebla de las que da pereza.", "El mundo, en baja resolución.", "Visibilidad: la justa."],
    },
}

type FraseCtx = {
    sit: Sit
    now: number
    tz: string
    temp: number
    feels: number
    wind: number | null
    hum: number | null
    night: boolean
    hours: { t: number; temp: number; rain: number; wind: number | null }[]
    suns: { t: number; rise: boolean }[]
    days: number
}

function pickRot(list: string[], now: number, salt: number) {
    const k = Math.floor(now / 3600000) + salt
    return list[((k % list.length) + list.length) % list.length]
}

/** Consejos de asesor: cada uno con su importancia; se enseñan los más importantes primero */
function consejos(c: FraseCtx): string[] {
    const fmtHr = new Intl.DateTimeFormat(LOC(), { timeZone: c.tz, hour: "numeric" })
    const hr = (t: number) => String(Number(fmtHr.format(new Date(Math.round(t / H) * H))))
    const H = 3600000
    const next = (n: number) => c.hours.filter((h) => h.t >= c.now - H / 2 && h.t <= c.now + n * H)
    const tips: [number, string][] = []
    const f = Math.round(c.feels)
    const w = c.wind ?? 0
    // Paraguas
    const rainNext = next(12).find((h) => h.rain >= 0.3)
    const rainNow = c.sit === "lluvia" || c.sit === "llovizna"
    if (rainNow) {
        const stop = c.hours.find((h) => h.t > c.now && h.rain < 0.2)
        tips.push([100, stop && stop.t - c.now < 10 * H ? t(`Paraguas hasta las ${hr(stop.t)}.`, `Umbrella until ${hr(stop.t)}:00.`) : t("Paraguas todo el día.", "Umbrella all day.")])
    } else if (rainNext) {
        const min = Math.round((rainNext.t - c.now) / 60000)
        tips.push([95, min <= 60 ? t("Llueve pronto: coge paraguas.", "Rain soon: take an umbrella.") : t(`Paraguas desde las ${hr(rainNext.t)}.`, `Umbrella from ${hr(rainNext.t)}:00.`)])
    }
    // Ropa según lo que se nota (y lo que se notará luego)
    const later = next(10)
    const fMin = Math.round(Math.min(f, ...later.map((h) => h.temp)))
    const fMax = Math.round(Math.max(f, ...later.map((h) => h.temp)))
    if (f <= 0) tips.push([90, t("Abrigo, gorro y guantes.", "Coat, hat and gloves.")])
    else if (f < 8) tips.push([80, t("Hoy, abrigo.", "Coat today.")])
    else if (f < 14) tips.push([70, t("Hoy, chaqueta.", "Jacket today.")])
    else if (f < 19) tips.push([45, t("Una capa ligera basta.", "A light layer is enough.")])
    else if (f < 27) tips.push([30, t("Manga corta.", "T-shirt weather.")])
    else tips.push([75, t("Ropa fresca y agua.", "Light clothes and water.")])
    if (fMax - fMin >= 9) tips.push([65, t("Viste por capas.", "Dress in layers.")])
    // Calor y sol
    if (!c.night && f >= 32) tips.push([88, t("Evita el sol de 14 a 18 h.", "Avoid the sun from 14:00 to 18:00.")])
    if (!c.night && (c.sit === "sol" || c.sit === "pocas") && c.temp >= 18) tips.push([50, t("Hoy, crema solar.", "Sunscreen today.")])
    // Viento
    if (w >= 55) tips.push([92, t("Viento fuerte: recoge lo que vuele.", "Strong wind: secure loose items.")])
    else if (w >= 35) tips.push([60, t("Mejor chubasquero que paraguas.", "Raincoat rather than umbrella.")])
    else if (w >= 25) tips.push([35, t("En bici, viento en contra.", "Headwind on the bike.")])
    // Niebla / conducción
    if (c.sit === "niebla") tips.push([85, t("Niebla: conduce con luces.", "Fog: drive with lights on.")])
    else if ((c.hum ?? 0) >= 92 && c.night) tips.push([40, t("Niebla al amanecer.", "Fog at dawn.")])
    if (rainNow && w >= 30) tips.push([70, t("Calzada mojada: con calma.", "Wet roads: take it easy.")])
    if (c.temp <= 2 && c.night) tips.push([82, t("Hielo al amanecer.", "Ice at dawn.")])
    // Mejor momento para salir: la próxima franja de día sin lluvia, con poco viento y temperatura más agradable
    const day = (t: number) => !c.suns.length || (() => {
        const last = c.suns.filter((s) => s.t <= t).pop()
        return last ? last.rise : false
    })()
    const cand = next(14).filter((h) => h.t > c.now && day(h.t) && h.rain < 0.2 && (h.wind ?? 0) < 30)
    if (cand.length >= 2) {
        const score = (h: { temp: number }) => -Math.abs(h.temp - 21)
        const best = cand.reduce((a, h) => (score(h) > score(a) ? h : a))
        const a = Math.max(c.now, best.t - H),
            b = best.t + H
        const dk = (t: number) => new Intl.DateTimeFormat("en-CA", { timeZone: c.tz }).format(new Date(t))
        tips.push([55, dk(best.t) === dk(c.now) ? t(`Sal de ${hr(a)} a ${hr(b)} h.`, `Go out from ${hr(a)}:00 to ${hr(b)}:00.`) : t(`Mañana, sal de ${hr(a)} a ${hr(b)} h.`, `Tomorrow, go out from ${hr(a)}:00 to ${hr(b)}:00.`)])
    }
    // Ropa tendida
    const dry = next(8)
    const dryOk = !dry.some((h) => h.rain >= 0.2) && (c.hum ?? 70) < 75 && !c.night
    if (dryOk && (w >= 8 || c.sit === "sol" || c.sit === "pocas")) tips.push([38, t("Buen día para tender.", "Good day to dry laundry.")])
    else if (dry.some((h) => h.rain >= 0.2) && !c.night) tips.push([42, t("Hoy no tiendas.", "Don't hang laundry today.")])
    // Casa
    if (!c.night && c.temp >= 14 && c.temp <= 24 && w < 25 && !rainNow) tips.push([25, t("Ventila la casa.", "Air out the house.")])
    if (c.night && c.temp >= 24) tips.push([58, t("Ventila de madrugada.", "Air out before dawn.")])
    if (f < 10 && c.night) tips.push([33, t("Baja las persianas.", "Close the blinds.")])
    // Sin lluvia en días
    if (!c.hours.some((h) => h.t >= c.now && h.rain >= 0.3)) tips.push([28, t("Riega las plantas.", "Water the plants.")])
    // Estrellas
    if (c.night && c.sit === "nocheClara") tips.push([22, t("Noche de estrellas.", "Starry night.")])
    if (!tips.length) tips.push([1, t("Día tranquilo.", "Quiet day.")])
    return tips.sort((a, b) => b[0] - a[0]).map((t) => t[1])
}

/** Lo que viene en las próximas horas y días */
function loQueViene(c: FraseCtx): string[] {
    const fmtH = new Intl.DateTimeFormat(LOC(), { timeZone: c.tz, hour: "2-digit", minute: "2-digit" })
    const fmtD = new Intl.DateTimeFormat(LOC(), { timeZone: c.tz, weekday: "long" })
    const dayKey = (t: number) => new Intl.DateTimeFormat("en-CA", { timeZone: c.tz }).format(new Date(t))
    const out: string[] = []
    const rain = c.hours.find((h) => h.t > c.now && h.rain >= 0.3)
    if (rain) out.push(dayKey(rain.t) === dayKey(c.now) ? t(`Lloverá a las ${fmtH.format(new Date(rain.t))}.`, `Rain at ${fmtH.format(new Date(rain.t))}.`) : t(`Lloverá el ${fmtD.format(new Date(rain.t))}.`, `Rain on ${fmtD.format(new Date(rain.t))}.`))
    else out.push(t(`Sin lluvia en ${c.days} días.`, `No rain for ${c.days} days.`))
    const today = dayKey(c.now)
    const tomorrowKey = dayKey(c.now + 86400000)
    const todayMax = Math.max(...c.hours.filter((h) => dayKey(h.t) === today).map((h) => h.temp), c.temp)
    const tom = c.hours.filter((h) => dayKey(h.t) === tomorrowKey)
    if (tom.length > 12) {
        const tMax = Math.round(Math.max(...tom.map((h) => h.temp)))
        const diff = tMax - Math.round(todayMax)
        out.push(diff >= 3 ? t(`Mañana sube a ${tMax}°.`, `Warmer tomorrow: ${tMax}°.`) : diff <= -3 ? t(`Mañana baja a ${tMax}°.`, `Cooler tomorrow: ${tMax}°.`) : t(`Mañana, parecido.`, `Similar tomorrow.`))
    }
    const windy = c.hours.find((h) => h.t > c.now && (h.wind ?? 0) >= 40)
    if (windy) out.push(t(`Viento fuerte el ${fmtD.format(new Date(windy.t))}.`, `Strong wind on ${fmtD.format(new Date(windy.t))}.`))
    const nextSun = c.suns.find((s) => s.t > c.now)
    if (nextSun) out.push(nextSun.rise ? t(`Amanece a las ${fmtH.format(new Date(nextSun.t))}.`, `Sunrise at ${fmtH.format(new Date(nextSun.t))}.`) : t(`El sol se pone a las ${fmtH.format(new Date(nextSun.t))}.`, `Sunset at ${fmtH.format(new Date(nextSun.t))}.`))
    return out
}

function frase(estilo: Estilo, c: FraseCtx, propia: string, estado: string): { main: string; sub?: string } {
    const salt = c.sit.length
    if (estilo === "propia") return { main: propia || "Escribe tu frase en el panel." }
    if (estilo === "minimo") {
        return { main: t(`${estado}. Se nota ${Math.round(c.feels)}°.`, `${estado}. Feels like ${Math.round(c.feels)}°.`) }
    }
    if (estilo === "practico") {
        const l = consejos(c)
        return { main: l[0] }
    }
    if (estilo === "loQueViene") {
        const l = loQueViene(c)
        return { main: l[0] }
    }
    const set = estilo === "poetico" ? FRASES.poetico : estilo === "humor" ? FRASES.humor : FRASES.clasico
    const main = pickRot(set[c.sit], c.now, salt)
    if (estilo === "mezcla") return { main: consejos(c)[0] ?? main }
    return { main }
}

// ---------------- Opciones ----------------
export type Props = {
    cityId: string
    baseUrl: string
    days: number
    hourHeight: number
    showHeader: boolean
    showWind: boolean
    showRain: boolean
    showClouds: boolean
    showAI: boolean
    showSpread: boolean
    showScore: boolean
    showModels: boolean
    idioma: "auto" | "es" | "en"
    showPhrase: boolean
    bgColor: string
    inkColor: string
    softColor: string
    tempCold: string
    tempMild: string
    tempWarm: string
    tempHot: string
    windColor: string
    rainColor: string
    cloudColor: string
    lineWidth: number
    blur: number
    grain: number
    texture: "puntos" | "grano" | "nada"
    sphereBlur: number
    /** dónde va el cielo animado: dentro de la tarjeta, fuera (lo pinta la pieza TiempoFondo detrás de la página) o ninguno */
    cielo: "tarjeta" | "fuera" | "no"
    /** fondo de la tarjeta: su color, cristal (translúcido con desenfoque, deja ver el cielo) o nada */
    fondo: "color" | "cristal" | "transparente"
    showFeels: boolean
    phraseStyle: Estilo
    customPhrase: string
    showAlerts: boolean
    theme: "auto" | "claro" | "oscuro"
    windMax: number
    radius: number
    animate: boolean
}

export const DEFAULTS: Props = {
    cityId: "global",
    baseUrl: BASE,
    days: 7,
    hourHeight: 9,
    showHeader: true,
    showWind: true,
    showRain: true,
    showClouds: true,
    showAI: true,
    showSpread: true,
    showScore: true,
    showModels: true,
    idioma: "auto" as const,
    showPhrase: false,
    bgColor: "#f5efe3",
    inkColor: "#1d1a17",
    softColor: "#8a7f72",
    tempCold: "#3d6bff",
    tempMild: "#2ec7c0",
    tempWarm: "#ffc93c",
    tempHot: "#ff3d3d",
    windColor: "#e0248a",
    rainColor: "#8fb8f2",
    cloudColor: "#ffffff",
    lineWidth: 1.6,
    blur: 10,
    grain: 0.6,
    texture: "puntos" as const,
    sphereBlur: 4,
    cielo: "tarjeta",
    fondo: "color",
    showFeels: true,
    phraseStyle: "practico" as Estilo,
    customPhrase: "",
    showAlerts: true,
    theme: "auto" as const,
    windMax: 50,
    radius: 22,
    animate: true,
}

let uidN = 0

// ---------------- El cielo de partículas ----------------
type Sky = "sol" | "nubes" | "lluvia" | "noche"
/**
 * El cielo: el fondo vivo de la tarjeta, de borde a borde. Dibuja el tiempo de ahora con partículas.
 *
 * Como mirar por una ventana grande:
 *   1. aurora: 4 manchas grandes de luz con los colores de la temperatura que se mueven despacio
 *      (frío → azules y violetas, templado → verdes, calor → naranjas y rojos);
 *   2. sol (resplandor que respira) o estrellas que parpadean;
 *   3. nubes en dos capas (lejos y cerca, como un paralaje), tantas como nubosidad, empujadas por el viento;
 *   4. viento: cientos de partículas con estela que siguen la dirección real del viento y hacen remolinos
 *      suaves; con rachas aceleran; si pasas el cursor se apartan;
 *   5. lluvia (o nieve si hace ≤1°) inclinada por el viento, y chispas cálidas que suben con mucho calor.
 */
export function Cielo({ color, sky, cloud, wind, dir, temp, dark, ink, nubesBlur, acento, uid }: { color: string; acento?: string; sky: Sky; cloud: number; wind: number; dir: number | null; temp: number; dark: boolean; ink: string; nubesBlur: number; uid: string }) {
    const ref = useRef<HTMLDivElement>(null)
    const cfg = useRef({ color, sky, cloud, wind, dir, temp, dark, ink, nubesBlur, acento })
    cfg.current = { color, sky, cloud, wind, dir, temp, dark, ink, nubesBlur, acento }
    useEffect(() => {
        const box = ref.current
        if (!box) return
        const fondo = document.createElement("canvas"), estela = document.createElement("canvas")
        for (const cv of [fondo, estela]) {
            cv.style.cssText = "position:absolute;inset:0;width:100%;height:100%;pointer-events:none"
            box.appendChild(cv)
        }
        const g = fondo.getContext("2d"), e = estela.getContext("2d")
        if (!g || !e) return
        const quieto = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches
        let W = 1, H = 1, dpr = 1
        const tam = () => {
            const r = box.getBoundingClientRect()
            W = Math.max(1, r.width); H = Math.max(1, r.height)
            dpr = Math.min(W * H > 600000 ? 1 : 2, (typeof devicePixelRatio !== "undefined" && devicePixelRatio) || 1)
            for (const cv of [fondo, estela]) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr) }
        }
        tam()
        const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(tam) : null
        ro?.observe(box)
        // el cursor aparta las partículas
        let px = -9999, py = -9999
        const mover = (ev: PointerEvent) => { const r = box.getBoundingClientRect(); px = ev.clientX - r.left; py = ev.clientY - r.top }
        const salir = () => { px = py = -9999 }
        window.addEventListener("pointermove", mover, { passive: true })
        document.addEventListener("pointerleave", salir)
        // solo se anima si se ve
        let visible = true
        const io = typeof IntersectionObserver !== "undefined" ? new IntersectionObserver(([en]) => { visible = en.isIntersecting; if (visible && !raf) raf = requestAnimationFrame(frame) }) : null
        io?.observe(box)

        const rnd = Math.random
        const rgb = (c: string) => hexRgb(c)
        const col = (c: string, a: number) => { const [r, gg, b] = rgb(c); return `rgba(${r},${gg},${b},${Math.max(0, Math.min(1, a))})` }
        const MAXP = 360
        const parts = Array.from({ length: MAXP }, () => ({ x: rnd(), y: rnd(), v: 0.55 + rnd() * 0.9, vida: rnd(), s: 0.6 + rnd() * 1.1 }))
        const nubes = Array.from({ length: 12 }, (_, i) => ({ x: rnd() * 1.6 - 0.3, y: rnd() * 0.75, r: 0.14 + rnd() * 0.2, capa: i % 2, f: rnd() * 6 }))
        const gotas = Array.from({ length: 160 }, () => ({ x: rnd() * 1.4 - 0.2, y: rnd(), v: 0.75 + rnd() * 0.6, l: 0.5 + rnd() * 0.8 }))
        const estrellas = Array.from({ length: 60 }, () => ({ x: rnd(), y: rnd() * 0.85, s: 0.4 + rnd() * 1.1, f: rnd() * 6 }))
        const chispas = Array.from({ length: 40 }, () => ({ x: rnd(), y: rnd(), v: 0.3 + rnd() * 0.7, s: 1 + rnd() * 2.4, f: rnd() * 6 }))
        // paleta de la aurora según la temperatura
        const paleta = (c: typeof cfg.current) => {
            const T = c.temp
            const extra = T >= 28 ? ["#ff4d2e", "#ffb02e"] : T >= 20 ? ["#ff9a3d", "#ffd36b"] : T >= 12 ? ["#4fd1a5", "#7cc7ff"] : T >= 4 ? ["#5aa8ff", "#8b7bff"] : ["#7fb6ff", "#b59cff"]
            const noche = c.sky === "noche" ? "#3b3fa8" : c.sky === "lluvia" ? "#4a6fb5" : mix(c.color, "#ffffff", 0.3)
            return [c.color, extra[0], extra[1], noche]
        }
        let t0 = performance.now(), raf = 0, tt = rnd() * 100
        const frame = (now: number) => {
            raf = 0
            const dt = Math.min(0.05, Math.max(0.001, (now - t0) / 1000)); t0 = now; tt += dt
            const c = cfg.current
            const d = ((c.dir ?? 270) * Math.PI) / 180
            const ux = -Math.sin(d), uy = Math.cos(d) // hacia dónde va el viento
            const fuerza = Math.min(1, c.wind / 45)
            const racha = 1 + 0.45 * Math.max(0, Math.sin(tt * 0.7) * Math.sin(tt * 0.31 + 1)) // rachas
            const vel = (22 + fuerza * 170) * racha
            const D = Math.max(W, H)

            // ---- capa de fondo ----
            g.setTransform(dpr, 0, 0, dpr, 0, 0)
            g.globalCompositeOperation = "source-over"
            g.clearRect(0, 0, W, H)
            // 1. aurora
            g.globalCompositeOperation = c.dark ? "lighter" : "source-over"
            const pal = paleta(c)
            const centros = [
                [0.78 + 0.12 * Math.sin(tt * 0.13), 0.18 + 0.1 * Math.cos(tt * 0.17), 0.62],
                [0.55 + 0.25 * Math.sin(tt * 0.09 + 2), 0.05 + 0.12 * Math.sin(tt * 0.11), 0.5],
                [0.95 + 0.1 * Math.cos(tt * 0.12 + 1), 0.55 + 0.18 * Math.sin(tt * 0.1 + 3), 0.55],
                [0.3 + 0.2 * Math.cos(tt * 0.07 + 4), 0.9 + 0.08 * Math.sin(tt * 0.15), 0.6],
            ]
            centros.forEach(([x, y, r], i) => {
                const R = D * r * (1 + 0.06 * Math.sin(tt * 0.5 + i))
                const gr = g.createRadialGradient(x * W, y * H, 0, x * W, y * H, R)
                const a = (c.dark ? 0.32 : 0.42) * (i === 3 ? 0.7 : 1)
                gr.addColorStop(0, col(pal[i], a)); gr.addColorStop(0.5, col(pal[i], a * 0.4)); gr.addColorStop(1, col(pal[i], 0))
                g.fillStyle = gr; g.fillRect(0, 0, W, H)
            })
            g.globalCompositeOperation = "source-over"
            // 2. sol o estrellas
            if (c.sky === "sol") {
                const p = 1 + 0.07 * Math.sin(tt * 1.1)
                const sx = W * 0.84, sy = H * 0.16
                const s = g.createRadialGradient(sx, sy, 0, sx, sy, Math.min(W, H) * 0.6 * p)
                s.addColorStop(0, `rgba(255,250,232,${c.dark ? 0.55 : 0.9})`); s.addColorStop(0.25, "rgba(255,222,150,.35)"); s.addColorStop(1, "rgba(255,210,140,0)")
                g.fillStyle = s; g.fillRect(0, 0, W, H)
                // rayos que giran muy despacio
                g.save(); g.translate(sx, sy); g.rotate(tt * 0.05)
                for (let i = 0; i < 10; i++) {
                    g.rotate((Math.PI * 2) / 10)
                    const L = Math.min(W, H) * (0.5 + 0.15 * Math.sin(tt * 0.8 + i * 1.7))
                    const lg = g.createLinearGradient(0, 0, L, 0)
                    lg.addColorStop(0, "rgba(255,236,190,.22)"); lg.addColorStop(1, "rgba(255,236,190,0)")
                    g.fillStyle = lg; g.beginPath(); g.moveTo(0, -3); g.lineTo(L, -14); g.lineTo(L, 14); g.lineTo(0, 3); g.fill()
                }
                g.restore()
            }
            if (c.sky === "noche" || (c.dark && c.cloud < 0.6 && c.sky !== "lluvia")) {
                for (const s of estrellas) {
                    const a = (0.25 + 0.75 * (0.5 + 0.5 * Math.sin(tt * 1.4 + s.f))) * (1 - c.cloud * 0.85)
                    g.fillStyle = c.dark ? `rgba(255,255,255,${a})` : col(c.ink, a * 0.4)
                    g.beginPath(); g.arc(s.x * W, s.y * H, s.s, 0, Math.PI * 2); g.fill()
                }
            }
            // 3. nubes en dos capas
            const nN = Math.round(Math.min(1, c.cloud * 1.1) * nubes.length)
            g.filter = c.nubesBlur > 0 ? `blur(${c.nubesBlur}px)` : "none"
            const tono = c.sky === "lluvia" ? (c.dark ? "#5d6679" : "#8e98ab") : c.dark ? "#cfd5e2" : "#ffffff"
            for (let i = 0; i < nN; i++) {
                const n = nubes[i]
                const k = n.capa ? 1 : 0.55 // la capa de cerca va más rápido
                n.x += (ux * (10 + vel * 0.22) * k * dt) / W
                n.y += (uy * (4 + vel * 0.05) * k * dt) / H
                if (n.x > 1.5) n.x = -0.5; if (n.x < -0.5) n.x = 1.5
                if (n.y > 0.95) n.y = -0.2; if (n.y < -0.2) n.y = 0.95
                const R = n.r * Math.max(W, 280) * (n.capa ? 1 : 0.75)
                const a = (c.sky === "lluvia" ? 0.7 : c.dark ? 0.28 : 0.8) * (n.capa ? 1 : 0.6)
                for (const [dx, dy, rr] of [[0, 0, 1], [-0.6, 0.18, 0.72], [0.6, 0.14, 0.78], [0.2, -0.32, 0.62], [-0.25, -0.2, 0.55]]) {
                    const cx = n.x * W + dx * R + Math.sin(tt * 0.3 + n.f + dx) * 4, cy = n.y * H + dy * R * 0.55
                    const s = g.createRadialGradient(cx, cy, 0, cx, cy, R * rr)
                    s.addColorStop(0, col(tono, a)); s.addColorStop(0.55, col(tono, a * 0.55)); s.addColorStop(1, col(tono, 0))
                    g.fillStyle = s; g.fillRect(cx - R * rr, cy - R * rr, R * rr * 2, R * rr * 2)
                }
            }
            g.filter = "none"
            // 5a. calor: chispas que suben
            if (c.temp >= 26) {
                const k = Math.min(1, (c.temp - 26) / 10)
                g.globalCompositeOperation = c.dark ? "lighter" : "source-over"
                for (const p of chispas) {
                    p.y -= (p.v * 26 * dt) / H; p.x += (Math.sin(tt * 1.4 + p.f) * 10 * dt) / W
                    if (p.y < -0.05) { p.y = 1.05; p.x = rnd() }
                    const a = k * 0.75 * Math.min(1, p.y * 2) * (0.6 + 0.4 * Math.sin(tt * 3 + p.f))
                    const r = p.s * 3.2
                    const s = g.createRadialGradient(p.x * W, p.y * H, 0, p.x * W, p.y * H, r)
                    s.addColorStop(0, `rgba(255,${Math.round(190 - 100 * k)},80,${a})`); s.addColorStop(1, "rgba(255,120,60,0)")
                    g.fillStyle = s; g.fillRect(p.x * W - r, p.y * H - r, r * 2, r * 2)
                }
                g.globalCompositeOperation = "source-over"
            }
            // 5b. lluvia o nieve
            if (c.sky === "lluvia") {
                const nieve = c.temp <= 1
                g.strokeStyle = c.dark ? "rgba(195,218,255,.6)" : "rgba(55,95,185,.5)"
                g.fillStyle = c.dark ? "rgba(255,255,255,.9)" : "rgba(120,140,180,.8)"
                g.lineWidth = 1.1; g.lineCap = "round"
                const sx = ux * (0.12 + fuerza * 0.7)
                for (const p of gotas) {
                    const vy = nieve ? 45 * p.v : 520 * p.v
                    p.y += (vy * dt) / H
                    p.x += (sx * vy * dt) / W + (nieve ? (Math.sin(tt * 1.5 + p.l * 9) * 14 * dt) / W : 0)
                    if (p.y > 1.05) { p.y = -0.05; p.x = rnd() * 1.4 - 0.2 }
                    if (nieve) { g.beginPath(); g.arc(p.x * W, p.y * H, 1 + p.l * 1.4, 0, Math.PI * 2); g.fill(); continue }
                    const L = 14 * p.l
                    g.beginPath(); g.moveTo(p.x * W, p.y * H); g.lineTo(p.x * W - sx * L, p.y * H - L); g.stroke()
                }
            }

            // ---- capa del viento: partículas con estela (la estela se borra poco a poco) ----
            e.setTransform(dpr, 0, 0, dpr, 0, 0)
            e.globalCompositeOperation = "destination-out"
            e.fillStyle = `rgba(0,0,0,${0.13 + (1 - fuerza) * 0.07})`
            e.fillRect(0, 0, W, H)
            e.globalCompositeOperation = c.dark ? "lighter" : "source-over"
            const n = Math.round(90 + fuerza * (MAXP - 90))
            e.lineCap = "round"
            // bandas de racha que cruzan la tarjeta en la dirección del viento
            const banda = (X: number, Y: number) => 0.5 + 0.5 * Math.sin((X * ux + Y * uy) * 0.012 - tt * (1.2 + fuerza * 2.5)) * Math.sin(X * 0.004 + Y * 0.006 + tt * 0.3)
            for (let i = 0; i < n; i++) {
                const p = parts[i]
                const X = p.x * W, Y = p.y * H
                // campo de remolinos suave encima de la dirección del viento
                const ang = Math.sin(X * 0.006 + tt * 0.35) * Math.cos(Y * 0.008 - tt * 0.27) * (1.1 - fuerza * 0.6)
                let vx = ux * Math.cos(ang) - uy * Math.sin(ang), vy = ux * Math.sin(ang) + uy * Math.cos(ang)
                // el cursor las aparta
                const dx = X - px, dy = Y - py, d2 = dx * dx + dy * dy
                if (d2 < 9000) { const f = (1 - d2 / 9000) * 2.2; const dd = Math.sqrt(d2) || 1; vx += (dx / dd) * f; vy += (dy / dd) * f }
                const m = 0.45 + 1.1 * banda(X, Y) // 0.45 (claro entre rachas) … 1.55 (racha)
                const sp = vel * p.v * m
                const kmh = Math.max(2, c.wind * racha * m * p.v)
                const nx = X + vx * sp * dt, ny = Y + vy * sp * dt
                p.vida += dt * 0.35
                const a = Math.min(1, p.vida * 3) * Math.min(1, (1.6 - p.vida) * 2)
                if (a > 0) {
                    const wc = c.dark ? wcol(kmh, c.acento) : mix(wcol(kmh, c.acento), c.ink, 0.25)
                    // debajo del número, más calma: así se lee bien la temperatura
                    const calma = 0.3 + 0.7 * Math.min(1, Math.max(0, (X / W - 0.12) / 0.5))
                    e.strokeStyle = col(wc, (c.dark ? 0.7 : 0.62) * a * calma * (0.5 + 0.5 * Math.min(1, m)))
                    e.lineWidth = p.s * (0.7 + 0.6 * m)
                    e.beginPath(); e.moveTo(X, Y); e.lineTo(nx, ny); e.stroke()
                }
                p.x = nx / W; p.y = ny / H
                if (p.vida > 1.6 || p.x < -0.05 || p.x > 1.05 || p.y < -0.05 || p.y > 1.05) { p.x = rnd(); p.y = rnd(); p.vida = 0 }
            }
            if (!quieto && visible) raf = requestAnimationFrame(frame)
        }
        frame(performance.now() + 16)
        return () => {
            cancelAnimationFrame(raf); ro?.disconnect(); io?.disconnect()
            window.removeEventListener("pointermove", mover); document.removeEventListener("pointerleave", salir)
            fondo.remove(); estela.remove()
        }
    }, [])
    return <div ref={ref} data-cielo={uid} style={{ position: "absolute", inset: 0, pointerEvents: "none" }} />
}

/** Número que sube hasta su valor al aparecer (escribe el texto directamente, sin re-pintar React) */
function CountUp({ value, from, ms = 1400, animate }: { value: number; from: number; ms?: number; animate: boolean }) {
    const ref = useRef<HTMLSpanElement>(null)
    useEffect(() => {
        const el = ref.current
        if (!el) return
        if (!animate || typeof requestAnimationFrame === "undefined") {
            el.textContent = String(Math.round(value))
            return
        }
        const t0 = performance.now()
        let raf = 0
        const tick = (t: number) => {
            const k = Math.min(1, (t - t0) / ms)
            const e = 1 - Math.pow(1 - k, 4)
            el.textContent = String(Math.round(from + (value - from) * e))
            if (k < 1) raf = requestAnimationFrame(tick)
        }
        raf = requestAnimationFrame(tick)
        return () => cancelAnimationFrame(raf)
    }, [value, from, ms, animate])
    return <span ref={ref}>{Math.round(value)}</span>
}

const KIND_LABEL = (k: string) => (({ sol: t("Despejado", "Clear"), nubes: t("Nuboso", "Cloudy"), lluvia: t("Lluvia", "Rain"), noche: t("Despejado", "Clear") }) as Record<string, string>)[k]

// ---------------- Tema compartido: el botón sol/luna de cualquier pieza cambia todas ----------------
type TemaManual = { manual: "claro" | "oscuro" | null; mSubs: Set<() => void> }
function temaManual(): TemaManual {
    const g = globalThis as unknown as { __tiempoTemaManual?: TemaManual }
    if (!g.__tiempoTemaManual) g.__tiempoTemaManual = { manual: readSaved(), mSubs: new Set() }
    return g.__tiempoTemaManual
}
// ---------------- Ajustes del visitante (unidades e idioma), compartidos por todas las piezas ----------------
// La pieza TiempoAjustes los cambia; se guardan en el navegador y todas las piezas se vuelven a pintar.
export type AjustesWeb = { temp: "C" | "F"; viento: "kmh" | "mph" | "ms" | "kn"; lluvia: "mm" | "in"; idioma: "auto" | "es" | "en" }
const AJ_DEF: AjustesWeb = { temp: "C", viento: "kmh", lluvia: "mm", idioma: "auto" }
const AJ_KEY = "tiempo-ajustes"
type AjBus = { aj: AjustesWeb; subs: Set<() => void> }
function ajustesBus(): AjBus {
    const g = globalThis as unknown as { __tiempoAjustes?: AjBus }
    if (!g.__tiempoAjustes) {
        let aj = AJ_DEF
        try {
            const v = localStorage.getItem(AJ_KEY)
            if (v) aj = { ...AJ_DEF, ...(JSON.parse(v) as Partial<AjustesWeb>) }
        } catch {}
        g.__tiempoAjustes = { aj, subs: new Set() }
    }
    return g.__tiempoAjustes
}
export function cambiarAjustes(p: Partial<AjustesWeb>) {
    const bus = ajustesBus()
    bus.aj = { ...bus.aj, ...p }
    try {
        localStorage.setItem(AJ_KEY, JSON.stringify(bus.aj))
    } catch {}
    bus.subs.forEach((f) => f())
}
/** Los ajustes del visitante; la pieza se vuelve a pintar cuando cambian */
export function useAjustesWeb(): AjustesWeb {
    const [aj, setAj] = useState(() => ajustesBus().aj)
    useEffect(() => {
        const bus = ajustesBus()
        const on = () => setAj(bus.aj)
        bus.subs.add(on)
        on()
        return () => {
            bus.subs.delete(on)
        }
    }, [])
    AJ = aj
    return aj
}
let AJ: AjustesWeb = AJ_DEF
/** Unidades: reciben °C, km/h y mm y devuelven lo elegido */
export const uT = (c: number) => (AJ.temp === "F" ? (c * 9) / 5 + 32 : c)
export const uTd = (c: number) => (AJ.temp === "F" ? (c * 9) / 5 : c)
export const uV = (kmh: number) => Math.round(AJ.viento === "mph" ? kmh * 0.621371 : AJ.viento === "ms" ? kmh / 3.6 : AJ.viento === "kn" ? kmh * 0.539957 : kmh)
export const uVL = () => (AJ.viento === "mph" ? "mph" : AJ.viento === "ms" ? "m/s" : AJ.viento === "kn" ? "kn" : "km/h")
export const uR = (mm: number) => {
    const v = (AJ.lluvia === "in" ? mm / 25.4 : mm).toFixed(AJ.lluvia === "in" ? 2 : 1)
    return IDI === "en" ? v : v.replace(".", ",")
}
export const uRL = () => (AJ.lluvia === "in" ? "in" : "mm")
/** Tema elegido a mano por el visitante (o null para seguir al navegador) */
export function setTemaManual(m: "claro" | "oscuro" | null) {
    const bus = temaManual()
    bus.manual = m
    try {
        if (m) localStorage.setItem(TEMA_KEY, m)
        else localStorage.removeItem(TEMA_KEY)
    } catch {}
    bus.mSubs.forEach((f) => f())
}

export function useTema(theme: Props["theme"]) {
    const [sysDark, setSysDark] = useState(() => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-color-scheme: dark)").matches)
    const [manual, setManual] = useState(() => temaManual().manual)
    useEffect(() => {
        const mq = typeof window !== "undefined" ? window.matchMedia?.("(prefers-color-scheme: dark)") : null
        const onMq = () => mq && setSysDark(mq.matches)
        mq?.addEventListener?.("change", onMq)
        const bus = temaManual()
        const on = () => setManual(bus.manual)
        bus.mSubs.add(on)
        on()
        return () => {
            mq?.removeEventListener?.("change", onMq)
            bus.mSubs.delete(on)
        }
    }, [])
    const dark = theme === "auto" ? (manual ? manual === "oscuro" : sysDark) : theme === "oscuro"
    const toggleTheme = () => {
        const bus = temaManual()
        bus.manual = dark ? "claro" : "oscuro"
        try {
            localStorage.setItem(TEMA_KEY, bus.manual)
        } catch {}
        bus.mSubs.forEach((f) => f())
    }
    return { dark, toggleTheme, manual }
}

/**
 * Todo lo que necesitan las piezas: los datos de la ciudad, el tema y lo que se calcula a partir de ellos.
 * Cada pieza (Ahora, Avisos, Datos, Gráfico, ¿Acierta la IA?) llama a este gancho; los datos se descargan una sola vez.
 */
export function useTiempo(props: Partial<Props>) {
    const p = { ...DEFAULTS, ...props } as Props
    const ajw = useAjustesWeb()
    setIdioma(ajw.idioma !== "auto" ? ajw.idioma : p.idioma)
    const {
        cityId,
        baseUrl,
        days,
        hourHeight,
        showHeader,
        showWind,
        showRain,
        showClouds,
        showAI,
        showSpread,
        showScore,
        bgColor: bgP,
        inkColor: inkP,
        softColor: softP,
        tempCold,
        tempMild,
        tempWarm,
        tempHot,
        windColor,
        rainColor,
        cloudColor: cloudP,
        lineWidth,
        blur,
        grain,
        texture,
        sphereBlur,
        showFeels,
        phraseStyle,
        customPhrase,
        showAlerts,
        theme,
        windMax,
        radius,
        animate,
    } = p
    const { dark, toggleTheme } = useTema(theme)
    const bgColor = dark ? "#05060a" : bgP,
        inkColor = dark ? "#eef0f6" : inkP,
        softColor = dark ? "#7d8396" : softP,
        cloudColor = dark ? "#c9d4ff" : cloudP === "#ffffff" ? "#aebbd9" : cloudP
    const gridColor = dark ? "#3d6bff" : inkColor
    const ref = useRef<HTMLDivElement>(null)
    // Avisa al buscador y pinta el fondo de la página (solo en la web, no en el lienzo de Framer)
    useEffect(() => {
        const bus = temaBus()
        bus.tema = dark ? "oscuro" : "claro"
        bus.subs.forEach((f) => f())
        const onCanvas = typeof RenderTarget !== "undefined" && RenderTarget.current() === RenderTarget.canvas
        if (!onCanvas && typeof document !== "undefined") {
            document.body.style.transition = "background-color .6s ease"
            document.body.style.backgroundColor = bgColor
            let el = ref.current?.parentElement ?? null
            while (el && el !== document.body) {
                const bgc = getComputedStyle(el).backgroundColor
                if (bgc && !/rgba\(0, 0, 0, 0\)|transparent/.test(bgc)) {
                    el.style.transition = "background-color .6s ease"
                    el.style.backgroundColor = bgColor
                }
                el = el.parentElement
            }
            document.documentElement.style.colorScheme = dark ? "dark" : "light"
        }
    }, [dark, bgColor])
    const uid = useMemo(() => `tv${++uidN}`, [])
    const globalCity = useGlobalCity()
    const city = cityId === "global" ? globalCity : cityId
    const [doc, setDoc] = useState<Doc | null>(null)
    const [obs, setObs] = useState<Obs | null>(null)
    const [err, setErr] = useState(false)
    const [W, setW] = useState(390)

    // Letras: Satoshi (Fontshare, gratis también para uso comercial) para todo el texto y Geist Mono para las etiquetas
    useEffect(() => {
        if (typeof document === "undefined") return
        const add = (id: string, href: string) => {
            if (document.getElementById(id)) return
            const l = document.createElement("link")
            l.id = id
            l.rel = "stylesheet"
            l.href = href
            document.head.appendChild(l)
        }
        add("tv-fonts-satoshi", "https://api.fontshare.com/v2/css?f[]=satoshi@300,400,500,700,900&display=swap")
        add("tv-fonts", "https://fonts.googleapis.com/css2?family=Geist:wght@100..700&family=Geist+Mono:wght@400;500&display=swap")
    }, [])
    useEffect(() => {
        let alive = true
        setErr(false)
        Promise.all([get<Doc>(`${baseUrl}/cities/${city}.json`), get<{ cities: Record<string, Obs> }>(`${baseUrl}/observed.json`).catch(() => null)])
            .then(([d, o]) => {
                if (!alive) return
                setDoc(d)
                setObs(o?.cities?.[city] ?? null)
            })
            .catch(() => alive && setErr(true))
        return () => {
            alive = false
        }
    }, [city, baseUrl])
    useEffect(() => {
        const el = ref.current
        if (!el || typeof ResizeObserver === "undefined") return
        const ro = new ResizeObserver(() => setW(Math.max(260, el.clientWidth)))
        ro.observe(el)
        setW(Math.max(260, el.clientWidth))
        return () => ro.disconnect()
    }, [])

    const hours = useMemo(() => (doc ? buildHours(doc, Math.round(days * 24)) : []), [doc, days])
    const tz = doc?.city.tz ?? "Europe/Madrid"


    const box = { background: bgColor, color: inkColor, borderRadius: radius, overflow: "hidden" as const, fontFamily: SANS, width: "100%" }
    const base = { p, ref, uid, W, dark, toggleTheme, bgColor, inkColor, softColor, cloudColor, gridColor, box, doc, err }
    if (err || !doc || hours.length < 2) return { ...base, ready: false as const }

    // ---- Escala de color de la temperatura ----
    const tStops: [number, string][] = [
        [0, tempCold],
        [12, tempMild],
        [22, tempWarm],
        [32, tempHot],
    ]
    const tcol = (v: number) => scale(tStops, v)

    // ---- Lo de ahora (lo medido si es reciente) ----
    const h0 = hours[0]
    const fresh = obs && Date.now() - Date.parse(obs.time) <= 3 * HOUR ? obs : null
    const now = {
        temp: fresh?.temp ?? h0.temp,
        hum: fresh?.hum ?? h0.hum,
        wind: fresh?.wind ?? h0.wind,
        dir: fresh?.windDir ?? h0.dir,
        rain: fresh?.rain1h ?? h0.rain,
    }

    // ---- Geometría de la tira ----
    const PAD_T = 26,
        PAD_B = 28
    const H = PAD_T + (hours.length - 1) * hourHeight + PAD_B
    const y = (t: number) => PAD_T + ((t - hours[0].t) / HOUR) * hourHeight
    const G = 84 // columna izquierda: fecha, viento y lluvia
    const RX = 62,
        RW = 14 // columna de lluvia, al lado del viento
    const CLOUD_W = showClouds ? 64 : 0 // columna derecha: nubes
    const X0 = G + 8,
        X1 = W - CLOUD_W - 34
    const feels = hours.map((h) => feelsOf(h.temp, h.wind, h.hum))
    // (la sensación térmica ya no se dibuja en el gráfico: solo cuenta la temperatura para la escala)
    const tMin = Math.min(...hours.map((h) => h.temp)),
        tMax = Math.max(...hours.map((h) => h.temp))
    const tx = (v: number) => X0 + ((v - (tMin - 1)) / Math.max(1, tMax - tMin + 2)) * (X1 - X0)

    // Temperatura (un punto cada 2 h; la curva Catmull-Rom lo suaviza)
    const tPts = hours.filter((_, k) => k % 2 === 0 || k === hours.length - 1).map((h) => [tx(h.temp), y(h.t)] as [number, number])
    const tLine = curve(tPts)
    const yEnd = y(hours[hours.length - 1].t)
    const tArea = `${tLine}L${X0 - 8},${yEnd.toFixed(1)}L${X0 - 8},${PAD_T}Z`
    const gradStops = hours.filter((_, k) => k % 3 === 0 || k === hours.length - 1)

    // Días: líneas a medianoche (hora local) y máx/mín de cada día
    const dayKey = (t: number) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(t))
    const fmtDay = new Intl.DateTimeFormat(LOC(), { timeZone: tz, day: "2-digit", month: "2-digit" })
    const fmtWd = new Intl.DateTimeFormat(LOC(), { timeZone: tz, weekday: "short" })
    const fmtHour = new Intl.DateTimeFormat(LOC(), { timeZone: tz, hour: "2-digit", minute: "2-digit" })
    const groups: { key: string; start: number; list: Hour[] }[] = []
    hours.forEach((h) => {
        const k = dayKey(h.t)
        const g = groups[groups.length - 1]
        if (!g || g.key !== k) groups.push({ key: k, start: h.t, list: [h] })
        else g.list.push(h)
    })
    const marks = groups.flatMap((g) => {
        if (g.list.length < 6) return []
        const hi = g.list.reduce((a, h) => (h.temp > a.temp ? h : a)),
            lo = g.list.reduce((a, h) => (h.temp < a.temp ? h : a))
        return [
            { k: `h${g.key}`, h: hi, hot: true },
            { k: `l${g.key}`, h: lo, hot: false },
        ]
    })

    // ---- IA: hasta dónde corrige la temperatura, cuánto acierta y la probabilidad de lluvia de cada día ----
    const aiEnd = doc.ml?.times?.length ? Date.parse(doc.ml.times[doc.ml.times.length - 1]) : null
    const aiOn = showAI && aiEnd != null && aiEnd > hours[0].t
    const rec = recuento(doc.acierto)
    const maeIa = doc.ml?.mae_ia ?? null,
        maeMed = doc.ml?.mae_media ?? null
    const rainProbOf = (key: string): number | null => {
        if (!showAI || !doc.ml_rain) return null
        const i = doc.ml_rain.days.indexOf(key)
        return i >= 0 ? doc.ml_rain.prob[i] ?? null : null
    }
    const dec = (v: number) => dec1(uTd(v))

    // Lluvia: total de cada día, escrito junto a su columna a la hora en que más llueve,
    // con la probabilidad de la IA («✦ 70 %») si la hay
    const rainDays = groups.flatMap((g) => {
        const tot = g.list.reduce((a, h) => a + (llueve(h) ? h.rain : 0), 0)
        const prob = rainProbOf(g.key)
        if (tot < 0.2 && !(prob != null && prob >= 0.3)) return []
        const m = tot >= 0.2 ? g.list.reduce((a, h) => (h.rain > a.rain ? h : a)) : g.list[Math.floor(g.list.length / 2)]
        return [{ t: m.t, mm: tot, prob }]
    })
    // Sensación térmica: nivel de cada hora (0 bien, 1 precaución, 2 mal, 3 peligro)
    const feelsLevel = (f: number, w: N) => {
        let l = f < -10 ? 3 : f < -5 ? 2 : f < 0 ? 1 : f >= 40 ? 3 : f >= 36 ? 2 : f >= 32 ? 1 : 0
        if (w != null) l = Math.max(l, w >= 70 ? 3 : w >= 55 ? 2 : w >= 40 ? 1 : 0)
        return l
    }
    const fPts = hours.filter((_, k) => k % 2 === 0 || k === hours.length - 1).map((h) => [tx(feelsOf(h.temp, h.wind, h.hum)), y(h.t)] as [number, number])
    const fLine = curve(fPts)
    // Avisos sacados de la previsión: calor, frío/heladas, viento y lluvia fuerte
    const alerts: AlertRun[] = []
    const pushRun = (kind: string, h: Hour, level: number) => {
        if (!level) return
        const last = [...alerts].reverse().find((r) => r.kind === kind)
        if (last && h.t - last.b <= HOUR) {
            last.b = h.t
            last.level = Math.max(last.level, level)
        } else alerts.push({ kind, level, a: h.t, b: h.t })
    }
    hours.forEach((h, k) => {
        const f = feels[k]
        pushRun(t("Calor", "Heat"), h, f >= 40 ? 3 : f >= 36 ? 2 : f >= 32 ? 1 : 0)
        pushRun(h.temp <= 0 && f > -5 ? t("Heladas", "Frost") : t("Frío", "Cold"), h, f <= -10 ? 3 : f <= -5 ? 2 : h.temp <= 0 ? 1 : 0)
        pushRun(t("Viento fuerte", "Strong wind"), h, h.wind == null ? 0 : h.wind >= 70 ? 3 : h.wind >= 55 ? 2 : h.wind >= 40 ? 1 : 0)
        pushRun(t("Lluvia fuerte", "Heavy rain"), h, h.rain >= 15 ? 3 : h.rain >= 7 ? 2 : h.rain >= 3 ? 1 : 0)
    })
    alerts.sort((a, b) => b.level - a.level || a.a - b.a)
    const fmtRange = (r: AlertRun) => {
        const wd = (t: number) => fmtWd.format(new Date(t)).replace(".", "")
        const hh = (t: number) => new Intl.DateTimeFormat(LOC(), { timeZone: tz, hour: "numeric" }).format(new Date(t))
        return dayKey(r.a) === dayKey(r.b) ? `${wd(r.a)} ${hh(r.a)}–${hh(r.b + HOUR)} h` : `${wd(r.a)} ${hh(r.a)} h → ${wd(r.b)} ${hh(r.b + HOUR)} h`
    }
    // Horas con lluvia seguidas → bloques con gotas que caen
    const rainRuns: { a: number; b: number; k: number }[] = []
    hours.forEach((h) => {
        if (!llueve(h)) return
        const last = rainRuns[rainRuns.length - 1]
        if (last && h.t - last.b <= HOUR) {
            last.b = h.t
            last.k = Math.max(last.k, Math.min(1, h.rain / 3))
        } else rainRuns.push({ a: h.t, b: h.t, k: Math.min(1, h.rain / 3) })
    })

    // Viento: una línea magenta (más a la derecha cuanto más sopla) y flechas cada 3 h
    // La escala se ajusta al viento de estos días (hasta «Escala viento»), para que la raya se mueva de verdad
    const windHours = hours.filter((h) => h.wind != null)
    const wVals = windHours.map((h) => h.wind!)
    const wHi = Math.min(windMax, Math.max(0, ...wVals)),
        wLo = Math.max(0, Math.min(wHi, ...wVals))
    const wRange = Math.max(8, wHi - wLo)
    const wBase = Math.max(0, wLo - wRange * 0.12)
    const wScale = wBase + wRange * 1.15
    // la raya va de 20 a 58 px: el mínimo de estos días pegado al borde y el máximo al lado de la lluvia
    const wx = (v: number) => 20 + (Math.max(0, Math.min(v, wScale) - wBase) / (wScale - wBase)) * 38
    const wLine = curve(windHours.filter((_, k) => k % 2 === 0).map((h) => [wx(h.wind!), y(h.t)] as [number, number]))
    const dayStarts = [hours[0].t, ...hours.filter((h, k) => k > 0 && new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(h.t)) !== new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(hours[k - 1].t))).map((h) => h.t)]
    // flechas cada 3 h, menos justo debajo de la fecha de cada día (para no taparla)
    // Día y noche con el sol de verdad: salida y puesta de cada día según la ciudad
    const lat = doc.city.lat ?? 40.4,
        lon = doc.city.lon ?? -3.7
    const suns: { t: number; rise: boolean }[] = []
    for (let d = -1; d <= days + 1; d++) {
        const st = sunTimes(Math.floor(hours[0].t / 86400000) * 86400000 + d * 86400000 + 12 * HOUR, lat, lon)
        if (st) suns.push({ t: st[0], rise: true }, { t: st[1], rise: false })
    }
    suns.sort((a, b) => a.t - b.t)
    // Luz del día de 0 (noche) a 1 (día), con un crepúsculo de ±50 min; y un brillo dorado alrededor de cada salida/puesta
    const dayLight = (t: number) => {
        const last = suns.filter((s) => s.t <= t).pop()
        const next = suns.find((s) => s.t > t)
        const ease = (x: number) => Math.min(1, Math.max(0, x))
        const W50 = 50 * 60_000
        let v = last ? (last.rise ? 1 : 0) : next && !next.rise ? 1 : 0
        if (last && t - last.t < W50) v = last.rise ? 0.5 + 0.5 * ease((t - last.t) / W50) : 0.5 - 0.5 * ease((t - last.t) / W50)
        if (next && next.t - t < W50) v = next.rise ? 0.5 - 0.5 * ease((next.t - t) / W50) : 0.5 + 0.5 * ease((next.t - t) / W50)
        return v
    }
    const sunMarks = suns.filter((s) => s.t >= hours[0].t && s.t <= hours[hours.length - 1].t)
    // Cinta del viento: luz magenta desde el borde hasta la raya
    const wPts = windHours.filter((_, k) => k % 2 === 0).map((h) => [wx(h.wind!), y(h.t)] as [number, number])
    const wArea = wPts.length > 1 ? `${curve(wPts)}L18,${wPts[wPts.length - 1][1].toFixed(1)}L18,${wPts[0][1].toFixed(1)}Z` : ""
    // Racha más fuerte de cada día (para escribir su velocidad junto a la raya)
    const windPeaks = groups.flatMap((g) => {
        const l = g.list.filter((h) => h.wind != null)
        if (l.length < 6) return []
        const m = l.reduce((a, h) => (h.wind! > a.wind! ? h : a))
        return m.t - g.start < 4 * HOUR ? [] : [m]
    })
    const arrows = windHours.filter((h, k) => k % 3 === 1 && h.dir != null && !dayStarts.some((d) => h.t >= d - HOUR && h.t < d + 3.5 * HOUR))

    // Nubes: tres columnas finas (bajas, medias, altas)
    const hasLayers = hours.some((h) => h.lo != null || h.mid != null || h.hi != null)
    const cols: [keyof Hour, string][] = hasLayers
        ? [
              ["lo", "B"],
              ["mid", "M"],
              ["hi", "A"],
          ]
        : [["cloud", "N"]]
    const CW = 11,
        CG = 7
    const cx0 = W - CLOUD_W + (CLOUD_W - (cols.length * CW + (cols.length - 1) * CG)) / 2


    const lab = { fontFamily: MONO, fontSize: 10, letterSpacing: "0.06em", textTransform: "uppercase" as const, color: softColor }
    // etiqueta con el color de su dato, como en la referencia de IBM
    const labC = (c: string) => ({ ...lab, color: dark ? mix(c, "#ffffff", 0.25) : mix(c, inkColor, 0.4) })
    const nowCol = tcol(now.temp)
    // El cielo de ahora para la esfera y la frase
    const night = dayLight(Date.now()) < 0.5
    const cloudNow = (h0.cloud ?? mean([h0.lo, h0.mid, h0.hi]) ?? 30) / 100
    const sky: Sky = now.rain >= 0.3 ? "lluvia" : night ? "noche" : cloudNow >= 0.6 ? "nubes" : "sol"
    const stateLabel = now.rain >= 0.3 ? t("Lluvia", "Rain") : cloudNow >= 0.85 ? t("Cubierto", "Overcast") : cloudNow >= 0.6 ? t("Nuboso", "Cloudy") : cloudNow >= 0.25 ? t("Poco nuboso", "Partly cloudy") : KIND_LABEL(sky)
    // La frase de debajo: según el cielo de ahora, lo que se nota y lo que viene
    const feelsNow = feelsOf(now.temp, now.wind, now.hum)
    const lowCloud = (h0.lo ?? 0) / 100
    const sit: Sit =
        now.rain >= 2 ? "lluvia" : now.rain >= 0.3 ? "llovizna" : (now.hum ?? 0) >= 96 && lowCloud >= 0.8 ? "niebla" : (now.wind ?? 0) >= 40 ? "viento" : !night && feelsNow >= 32 ? "calor" : feelsNow <= 3 ? "frio" : night ? (cloudNow < 0.4 ? "nocheClara" : "nocheNubes") : cloudNow >= 0.85 ? "cubierto" : cloudNow >= 0.6 ? "nuboso" : cloudNow >= 0.25 ? "pocas" : "sol"
    const fr = frase(phraseStyle, { sit, now: Date.now(), tz, temp: now.temp, feels: feelsNow, wind: now.wind, hum: now.hum, night, hours, suns, days }, customPhrase, stateLabel)
    const phrase = fr.main
    const today = groups[0]?.list ?? []
    const todayMax = today.length ? Math.round(Math.max(now.temp, ...today.map((h) => h.temp))) : null,
        todayMin = today.length ? Math.round(Math.min(now.temp, ...today.map((h) => h.temp))) : null

    const css = `
        @keyframes ${uid}-nudge { 0%,100% { transform: translateY(1.5px); opacity: .55 } 50% { transform: translateY(-1.5px); opacity: 1 } }
        @keyframes ${uid}-fall { from { background-position: 0 0 } to { background-position: 0 16px } }
        @keyframes ${uid}-drift { 0%,100% { transform: translateY(-3px) } 50% { transform: translateY(3px) } }
        @keyframes ${uid}-pulse { 0% { transform: scale(1); opacity: .55 } 100% { transform: scale(2.6); opacity: 0 } }
        @keyframes ${uid}-in { from { opacity: 0; transform: translateY(14px); filter: blur(8px) } to { opacity: 1; transform: none; filter: blur(0) } }
        @keyframes ${uid}-orbin { from { opacity: 0 } to { opacity: 1 } }
        @keyframes ${uid}-reveal { from { clip-path: inset(0 0 100% 0) } to { clip-path: inset(0 0 0 0) } }
        @keyframes ${uid}-draw { from { stroke-dashoffset: 1 } to { stroke-dashoffset: 0 } }
        @keyframes ${uid}-spinK { to { transform: rotate(360deg) } }
        @keyframes ${uid}-breathK { 0%,100% { opacity: .55; transform: scale(1) } 50% { opacity: .9; transform: scale(1.06) } }
        @keyframes ${uid}-twK { 0%,100% { opacity: .2 } 50% { opacity: 1 } }
        @keyframes ${uid}-flowK { from { transform: translateX(-50%) } to { transform: translateX(0) } }
        @keyframes ${uid}-sdriftK { from { transform: translateX(-35%) } to { transform: translateX(35%) } }
        @keyframes ${uid}-srainK { from { transform: translate3d(0,-30%,0) } to { transform: translate3d(-6%,30%,0) } }
        .${uid}-in { animation: ${uid}-in 1s cubic-bezier(.2,.8,.2,1) both }
        .${uid}-orb { animation: ${uid}-orbin 1.8s cubic-bezier(.16,1,.3,1) both }
        .${uid}-strip { animation: ${uid}-reveal 2.6s cubic-bezier(.65,0,.15,1) .5s both }
        .${uid}-draw { stroke-dasharray: 1; animation: ${uid}-draw 3s cubic-bezier(.65,0,.15,1) .5s both }
        .${uid}-ring { transform-box: fill-box; transform-origin: center; animation: ${uid}-pulse 2.4s ease-out infinite }
        .${uid}-spin { animation: ${uid}-spinK 30s linear infinite }
        .${uid}-breath { animation: ${uid}-breathK 6s ease-in-out infinite }
        .${uid}-tw { animation: ${uid}-twK 3s ease-in-out infinite }
        .${uid}-flow { animation: ${uid}-flowK 9s linear infinite }
        .${uid}-sdrift { animation: ${uid}-sdriftK 20s ease-in-out infinite alternate }
        .${uid}-srain { animation: ${uid}-srainK .7s linear infinite }
        .${uid}-arrow { animation: ${uid}-nudge 2.4s ease-in-out infinite }
        .${uid}-rain { animation: ${uid}-fall .9s linear infinite }
        .${uid}-cloud { animation: ${uid}-drift 6s ease-in-out infinite }
        ${animate ? "" : `[class^="${uid}-"] { animation: none !important }`}
        @media (prefers-reduced-motion: reduce) { [class^="${uid}-"] { animation: none !important } }
    `

    return {
        ...base,
        ready: true as const,
        doc,
        CG, CLOUD_W, CW, G, H, PAD_B, PAD_T, RW, RX, X0, X1, aiEnd, aiOn, alerts, arrows, cloudNow, cols, css, cx0, dayKey, dayLight, dayStarts, dec, fLine, fPts, feels, feelsLevel, feelsNow, fmtDay, fmtHour, fmtRange, fmtWd, fr, fresh, gradStops, groups, h0, hasLayers, hours, lab, labC, lat, lon, lowCloud, maeIa, maeMed, marks, night, now, nowCol, phrase, pushRun, rainDays, rainProbOf, rainRuns, rec, sit, sky, stateLabel, sunMarks, suns, tArea, tLine, tMax, tMin, tPts, tStops, tcol, today, todayMax, todayMin, tx, tz, wArea, wLine, wPts, wScale, windHours, windPeaks, wx, y, yEnd,
    }
}
export type Vista = Extract<ReturnType<typeof useTiempo>, { ready: true }>

/** Caja de cada pieza: fondo del tema, «Cargando…» o «No hay datos» */
export function Caja({ v, radius, children, style }: { v: ReturnType<typeof useTiempo>; radius?: number; children?: any; style?: any }) {
    const fondo = (v.p as Props | undefined)?.fondo ?? "color"
    const vidrio =
        fondo === "cristal"
            ? { background: rgba(v.bgColor, v.dark ? 0.42 : 0.5), backdropFilter: "blur(16px) saturate(1.3)", WebkitBackdropFilter: "blur(16px) saturate(1.3)", boxShadow: `inset 0 0 0 1px ${rgba(v.dark ? "#ffffff" : "#ffffff", v.dark ? 0.08 : 0.55)}, 0 8px 30px ${rgba("#000000", v.dark ? 0.25 : 0.05)}` }
            : fondo === "transparente"
              ? { background: "transparent" }
              : {}
    const box = { ...v.box, borderRadius: radius ?? v.box.borderRadius, ...vidrio }
    if (!v.ready)
        return (
            <div ref={v.ref} style={{ ...box, padding: 20, fontSize: 13, color: v.softColor }}>
                {v.err ? t("No hay datos para esta ciudad.", "No data for this place.") : t("Cargando…", "Loading…")}
            </div>
        )
    return (
        <div ref={v.ref} style={{ ...box, position: "relative", isolation: "isolate", transition: "background-color .6s ease, color .6s ease", ...style }}>
            <style>{v.css}</style>
            {children}
        </div>
    )
}

/** El cielo animado, a sangre, para ponerlo detrás de la página (pieza TiempoFondo) */
export function CieloFondo({ v, fundido }: { v: Vista; fundido: number }) {
    const m = fundido > 0 ? `linear-gradient(#000 ${100 - fundido}%, transparent)` : undefined
    return (
        <div aria-hidden style={{ position: "absolute", inset: 0, pointerEvents: "none", WebkitMaskImage: m, maskImage: m }}>
            <Cielo color={v.nowCol} sky={v.sky} cloud={v.cloudNow} wind={v.now.wind ?? 0} dir={v.now.dir} temp={v.now.temp} dark={v.dark} ink={v.inkColor} nubesBlur={v.p.sphereBlur} acento={v.p.windColor} uid={v.uid} />
        </div>
    )
}

export function SeccionAhora({ v }: { v: Vista }) {
    const { p, CG, CLOUD_W, CW, G, H, PAD_B, PAD_T, RW, RX, X0, X1, aiEnd, aiOn, alerts, arrows, cloudNow, cols, css, cx0, dayKey, dayLight, dayStarts, dec, fLine, fPts, feels, feelsLevel, feelsNow, fmtDay, fmtHour, fmtRange, fmtWd, fr, fresh, gradStops, groups, h0, hasLayers, hours, lab, labC, lat, lon, lowCloud, maeIa, maeMed, marks, night, now, nowCol, phrase, pushRun, rainDays, rainProbOf, rainRuns, rec, sit, sky, stateLabel, sunMarks, suns, tArea, tLine, tMax, tMin, tPts, tStops, tcol, today, todayMax, todayMin, tx, tz, wArea, wLine, wPts, wScale, windHours, windPeaks, wx, y, yEnd, uid, W, dark, toggleTheme, bgColor, inkColor, softColor, cloudColor, gridColor, doc } = v
    const { cityId, baseUrl, days, hourHeight, showHeader, showWind, showRain, showClouds, showAI, showSpread, showScore, tempCold, tempMild, tempWarm, tempHot, windColor, rainColor, lineWidth, blur, grain, texture, sphereBlur, showFeels, phraseStyle, customPhrase, showAlerts, theme, windMax, radius, animate } = p
    const [iaOpen, setIaOpen] = useState(false)
    return (
        <>
            <div style={{ padding: "20px 20px 4px", minHeight: 200 }}>
                    {p.cielo === "tarjeta" && (
                        <>
                        {/* el cielo va de fondo de toda la tarjeta, de borde a borde (se funde abajo si la tarjeta es muy alta) */}
                        <div aria-hidden className={`${uid}-orb`} style={{ position: "absolute", top: 0, left: 0, right: 0, height: "100%", maxHeight: 820, zIndex: -1, pointerEvents: "none", WebkitMaskImage: "linear-gradient(#000 70%, transparent)", maskImage: "linear-gradient(#000 70%, transparent)" }}>
                            <Cielo color={nowCol} sky={sky} cloud={cloudNow} wind={now.wind ?? 0} dir={now.dir} temp={now.temp} dark={dark} ink={inkColor} nubesBlur={sphereBlur} acento={windColor} uid={uid} />
                        </div>
                        </>
                    )}
                    {/* botón sol / luna para cambiar entre modo claro y oscuro */}
                    <button
                        onClick={toggleTheme}
                        aria-label={dark ? t("Modo claro", "Light mode") : t("Modo oscuro", "Dark mode")}
                        className={`${uid}-in`}
                        style={{ position: "absolute", top: 14, right: 14, zIndex: 3, width: 34, height: 34, borderRadius: 17, border: `1px solid ${rgba(inkColor, 0.14)}`, background: rgba(bgColor, 0.55), backdropFilter: "blur(10px)", WebkitBackdropFilter: "blur(10px)", display: "grid", placeItems: "center", cursor: "pointer", padding: 0, animationDelay: "500ms" }}
                    >
                        <svg width="16" height="16" viewBox="0 0 16 16" style={{ transition: "transform .6s cubic-bezier(.2,.8,.2,1)", transform: dark ? "rotate(-15deg)" : "rotate(0deg)" }}>
                            {dark ? (
                                <path d="M13.2 10.2A5.6 5.6 0 0 1 5.8 2.8a5.6 5.6 0 1 0 7.4 7.4Z" fill="none" stroke={inkColor} strokeWidth="1.3" strokeLinejoin="round" />
                            ) : (
                                <g stroke={inkColor} strokeWidth="1.3" strokeLinecap="round">
                                    <circle cx="8" cy="8" r="3" fill="none" />
                                    <path d="M8 1.5v1.3M8 13.2v1.3M1.5 8h1.3M13.2 8h1.3M3.4 3.4l.9.9M11.7 11.7l.9.9M3.4 12.6l.9-.9M11.7 4.3l.9-.9" />
                                </g>
                            )}
                        </svg>
                    </button>
                    <div style={{ position: "relative" }}>
                        <div className={`${uid}-in`} style={{ display: "flex", gap: 10, alignItems: "baseline", animationDelay: "80ms" }}>
                            <span style={{ fontFamily: SANS, fontWeight: 500, fontSize: 15, letterSpacing: "-0.01em" }}>{doc.city.name}</span>
                            <span style={{ fontFamily: MONO, fontSize: 11, color: softColor }}>
                                {fmtWd.format(new Date()).replace(".", "")} · {fmtHour.format(new Date())}
                            </span>
                        </div>
                        <div className={`${uid}-in`} style={{ fontFamily: SANS, fontWeight: 300, fontSize: Math.round(W * 0.44), lineHeight: 0.86, letterSpacing: "-0.07em", marginTop: 22, marginLeft: -6, color: inkColor, animationDelay: "160ms", fontVariantNumeric: "tabular-nums" }}>
                            <CountUp value={uT(now.temp)} from={uT(now.temp) - 9} animate={animate} />
                            <span style={{ fontSize: "0.42em", verticalAlign: "0.95em", letterSpacing: 0, marginLeft: 2 }}>°</span>
                        </div>
                        <div className={`${uid}-in`} style={{ fontFamily: MONO, fontSize: 11, letterSpacing: "0.14em", textTransform: "uppercase", color: softColor, marginTop: 14, animationDelay: "260ms" }}>
                            {stateLabel}
                            {todayMax != null && (
                                <span style={{ letterSpacing: "0.04em", marginLeft: 10 }}>
                                    ↑ {Math.round(uT(todayMax))}° ↓ {Math.round(uT(todayMin!))}°
                                </span>
                            )}
                            {aiOn && (
                                <button
                                    type="button"
                                    onClick={() => setIaOpen((v) => !v)}
                                    aria-expanded={iaOpen}
                                    style={{ marginLeft: 10, padding: "3px 8px 3px 7px", borderRadius: 999, border: `1px solid ${rgba(tempMild, 0.55)}`, background: rgba(tempMild, dark ? 0.12 : 0.1), color: inkColor, fontFamily: MONO, fontSize: 9.5, letterSpacing: "0.1em", textTransform: "uppercase", cursor: "pointer", verticalAlign: "1px" }}
                                >
                                    <span style={{ color: tempMild, marginRight: 4 }}>✦</span>IA
                                </button>
                            )}
                        </div>
                        {aiOn && iaOpen && (
                            <div style={{ fontFamily: SANS, fontSize: 13, lineHeight: 1.4, color: softColor, marginTop: 8, maxWidth: "92%", padding: "8px 10px", borderLeft: `2px solid ${tempMild}`, background: rgba(tempMild, dark ? 0.08 : 0.06), borderRadius: "0 8px 8px 0" }}>
                                <b style={{ color: inkColor, fontWeight: 600 }}>{t("Ajustado con IA.", "AI-adjusted.")}</b> {t("Corregimos los modelos con lo medido por AEMET en", "We correct the models with what AEMET measured in")} {doc.city.name}, {t("hasta el", "until")} {fmtWd.format(new Date(aiEnd!)).replace(".", "")} {fmtHour.format(new Date(aiEnd!))}.
                                {maeIa != null && maeMed != null && (
                                    <>
                                        {" "}
                                        {t(`Falla de media ${dec(maeIa)}° (los modelos solos, ${dec(maeMed)}°).`, `Average error ${dec(maeIa)}° (models alone, ${dec(maeMed)}°).`)}
                                    </>
                                )}
                            </div>
                        )}
                        {/* la frase de debajo (apagada por defecto: control «Frase») */}
                        {p.showPhrase && (
                        <div className={`${uid}-in`} style={{ fontFamily: SANS, fontWeight: 500, fontSize: Math.round(Math.min(phrase.length > 34 ? 25 : 31, W * (phrase.length > 34 ? 0.066 : 0.08))), lineHeight: 1.12, letterSpacing: "-0.025em", marginTop: 8, maxWidth: phrase.length > 34 ? "92%" : "78%", animationDelay: "340ms", textWrap: "balance" as any }}>
                                {phrase}
                            </div>
                        )}
                </div>
            </div>
        </>
    )
}

export function SeccionAvisos({ v }: { v: Vista }) {
    const { p, CG, CLOUD_W, CW, G, H, PAD_B, PAD_T, RW, RX, X0, X1, aiEnd, aiOn, alerts, arrows, cloudNow, cols, css, cx0, dayKey, dayLight, dayStarts, dec, fLine, fPts, feels, feelsLevel, feelsNow, fmtDay, fmtHour, fmtRange, fmtWd, fr, fresh, gradStops, groups, h0, hasLayers, hours, lab, labC, lat, lon, lowCloud, maeIa, maeMed, marks, night, now, nowCol, phrase, pushRun, rainDays, rainProbOf, rainRuns, rec, sit, sky, stateLabel, sunMarks, suns, tArea, tLine, tMax, tMin, tPts, tStops, tcol, today, todayMax, todayMin, tx, tz, wArea, wLine, wPts, wScale, windHours, windPeaks, wx, y, yEnd, uid, W, dark, toggleTheme, bgColor, inkColor, softColor, cloudColor, gridColor, doc } = v
    const { cityId, baseUrl, days, hourHeight, showHeader, showWind, showRain, showClouds, showAI, showSpread, showScore, tempCold, tempMild, tempWarm, tempHot, windColor, rainColor, lineWidth, blur, grain, texture, sphereBlur, showFeels, phraseStyle, customPhrase, showAlerts, theme, windMax, radius, animate } = p
    return (
        <>
            <div style={{ padding: "0 20px" }}>
                        {(
                            <div className={`${uid}-in`} style={{ display: "flex", flexWrap: "wrap", gap: 6, animationDelay: "400ms" }}>
                                {alerts.length === 0 ? (
                                    <span style={{ fontFamily: MONO, fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: softColor }}>{t(`✓ Sin avisos en ${days} días`, `✓ No warnings for ${days} days`)}</span>
                                ) : (
                                    alerts.slice(0, 3).map((r) => (
                                        <span key={`p${r.kind}${r.a}`} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 10px 5px 8px", borderRadius: 999, background: rgba(ALERT[r.level], dark ? 0.16 : 0.2), boxShadow: `inset 0 0 0 1px ${rgba(ALERT[r.level], 0.55)}`, fontFamily: SANS, fontSize: 12, color: inkColor }}>
                                            <span style={{ width: 7, height: 7, borderRadius: 4, background: ALERT[r.level], boxShadow: `0 0 8px ${ALERT[r.level]}` }} />
                                            <b style={{ fontWeight: 600 }}>{r.kind}</b>
                                            <span style={{ fontFamily: MONO, fontSize: 10, color: softColor }}>{fmtRange(r)}</span>
                                        </span>
                                    ))
                                )}
                            </div>
                        )}
            </div>
        </>
    )
}

export function SeccionDatos({ v }: { v: Vista }) {
    const { p, CG, CLOUD_W, CW, G, H, PAD_B, PAD_T, RW, RX, X0, X1, aiEnd, aiOn, alerts, arrows, cloudNow, cols, css, cx0, dayKey, dayLight, dayStarts, dec, fLine, fPts, feels, feelsLevel, feelsNow, fmtDay, fmtHour, fmtRange, fmtWd, fr, fresh, gradStops, groups, h0, hasLayers, hours, lab, labC, lat, lon, lowCloud, maeIa, maeMed, marks, night, now, nowCol, phrase, pushRun, rainDays, rainProbOf, rainRuns, rec, sit, sky, stateLabel, sunMarks, suns, tArea, tLine, tMax, tMin, tPts, tStops, tcol, today, todayMax, todayMin, tx, tz, wArea, wLine, wPts, wScale, windHours, windPeaks, wx, y, yEnd, uid, W, dark, toggleTheme, bgColor, inkColor, softColor, cloudColor, gridColor, doc } = v
    const { cityId, baseUrl, days, hourHeight, showHeader, showWind, showRain, showClouds, showAI, showSpread, showScore, tempCold, tempMild, tempWarm, tempHot, windColor, rainColor, lineWidth, blur, grain, texture, sphereBlur, showFeels, phraseStyle, customPhrase, showAlerts, theme, windMax, radius, animate } = p
    return (
        <>
            <div style={{ padding: "0 20px 10px" }}>
                        <div style={{ display: "grid", gridTemplateColumns: `repeat(${showFeels ? 4 : 3}, minmax(0, 1fr))`, borderTop: `1px solid ${rgba(inkColor, 0.12)}` }}>
                            {[
                                ...(showFeels ? [[t("Sensación", "Feels like"), String(Math.round(uT(feelsOf(now.temp, now.wind, now.hum)))), "°", ALERT[feelsLevel(feelsOf(now.temp, now.wind, now.hum), null)] || nowCol, null]] : []),
                                [t("Lluvia", "Rain"), now.rain >= 0.1 ? uR(now.rain) : "0", uRL(), rainColor, null],
                                [t("Humedad", "Humidity"), now.hum != null ? String(Math.round(now.hum)) : "–", "%", "#33b3ad", null],
                                [t("Viento", "Wind"), now.wind != null ? String(uV(now.wind)) : "–", uVL(), now.wind != null ? wcol(now.wind, windColor) : windColor, now.dir],
                            ].map(([k, v, u, c, d], n) => (
                                <div key={String(k)} className={`${uid}-in`} style={{ paddingTop: 12, paddingLeft: n ? (showFeels ? 9 : 12) : 0, minWidth: 0, borderLeft: n ? `1px solid ${rgba(inkColor, 0.08)}` : undefined, animationDelay: `${440 + n * 70}ms` }}>
                                    <div style={labC(String(c))}>{k}</div>
                                    <div style={{ display: "flex", alignItems: "baseline", gap: 4, marginTop: 6 }}>
                                        {d != null && (
                                            <svg width="13" height="13" viewBox="0 0 18 18" style={{ transform: `rotate(${Number(d) + 180}deg)`, alignSelf: "center" }}>
                                                <path d="M9 15V3M4 8l5-5 5 5" stroke={inkColor} strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                                            </svg>
                                        )}
                                        <span style={{ fontFamily: SANS, fontWeight: 300, fontSize: showFeels ? 24 : 28, letterSpacing: "-0.04em", lineHeight: 1 }}>{v}</span>
                                        <span style={{ fontFamily: MONO, fontSize: 10, color: softColor }}>{u}</span>
                                    </div>
                                </div>
                            ))}
                        </div>
            </div>
        </>
    )
}

export function SeccionGrafico({ v }: { v: Vista }) {
    const { p, CG, CLOUD_W, CW, G, H, PAD_B, PAD_T, RW, RX, X0, X1, aiEnd, aiOn, alerts, arrows, cloudNow, cols, css, cx0, dayKey, dayLight, dayStarts, dec, fLine, fPts, feels, feelsLevel, feelsNow, fmtDay, fmtHour, fmtRange, fmtWd, fr, fresh, gradStops, groups, h0, hasLayers, hours, lab, labC, lat, lon, lowCloud, maeIa, maeMed, marks, night, now, nowCol, phrase, pushRun, rainDays, rainProbOf, rainRuns, rec, sit, sky, stateLabel, sunMarks, suns, tArea, tLine, tMax, tMin, tPts, tStops, tcol, today, todayMax, todayMin, tx, tz, wArea, wLine, wPts, wScale, windHours, windPeaks, wx, y, yEnd, uid, W, dark, toggleTheme, bgColor, inkColor, softColor, cloudColor, gridColor, doc } = v
    const { cityId, baseUrl, days, hourHeight, showHeader, showWind, showRain, showClouds, showAI, showSpread, showScore, tempCold, tempMild, tempWarm, tempHot, windColor, rainColor, lineWidth, blur, grain, texture, sphereBlur, showFeels, phraseStyle, customPhrase, showAlerts, theme, windMax, radius, animate } = p
    const [verModelos, setVerModelos] = useState(false)
    const [iaDia, setIaDia] = useState<string | null>(null) // el día cuyo «por qué» está abierto
    // Cada modelo por separado: una línea gris fina (tramos sin hueco, un punto cada 2 h)
    const NOMBRE: Record<string, string> = { ifs: "ECMWF", aifs: "ECMWF IA", gfs: "GFS", "icon-eu": "ICON", arpege: "ARPEGE", arome: "AROME", ukmo: "UKMO", gem: "GEM" }
    const modelLines = useMemo(() => {
        if (!verModelos) return []
        return doc.models.map((m, i) => {
            const ts = m.times.map((s) => Date.parse(s))
            const segs: [number, number][][] = []
            let cur: [number, number][] = []
            let last: [number, number] | null = null
            hours.forEach((h, k) => {
                if (k % 2 && k !== hours.length - 1) return
                const v = at(ts, m.temp, h.t)
                if (v == null) {
                    if (cur.length > 1) segs.push(cur)
                    cur = []
                    return
                }
                const pt: [number, number] = [Math.max(X0 - 6, Math.min(X1 + 10, tx(v))), y(h.t)]
                cur.push(pt)
                last = pt
            })
            if (cur.length > 1) segs.push(cur)
            return { id: m.id ?? `m${i}`, name: NOMBRE[m.id ?? ""] ?? (m.id ?? `Modelo ${i + 1}`).toUpperCase(), d: segs.map((s) => curve(s)).join(""), end: last as [number, number] | null }
        })
    }, [verModelos, doc, hours, W])
    return (
        <>
            <div
                className={`${uid}-strip`}
                style={{ position: "relative", height: H, touchAction: "pan-y" }}
            >
                <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ position: "absolute", inset: 0, overflow: "visible" }}>
                    <defs>
                        <linearGradient id={`${uid}-t`} gradientUnits="userSpaceOnUse" x1="0" x2="0" y1={PAD_T} y2={yEnd}>
                            {gradStops.map((h) => (
                                <stop key={h.t} offset={((y(h.t) - PAD_T) / Math.max(1, yEnd - PAD_T)).toFixed(4)} stopColor={tcol(h.temp)} />
                            ))}
                        </linearGradient>
                        {/* el relleno se apaga hacia la izquierda: la luz está pegada a la curva */}
                        <linearGradient id={`${uid}-fade`} gradientUnits="userSpaceOnUse" x1={X0 - 8} x2={X1} y1="0" y2="0">
                            <stop offset="0" stopColor="#fff" stopOpacity="0.05" />
                            <stop offset="0.45" stopColor="#fff" stopOpacity="0.45" />
                            <stop offset="1" stopColor="#fff" stopOpacity="1" />
                        </linearGradient>
                        <mask id={`${uid}-m`}>
                            <rect x="0" y="0" width={W} height={H} fill={`url(#${uid}-fade)`} />
                        </mask>
                        <filter id={`${uid}-blur`} x="-20%" y="-5%" width="140%" height="110%">
                            <feGaussianBlur stdDeviation={blur} />
                        </filter>
                        <filter id={`${uid}-soft`} x="-50%" y="-5%" width="200%" height="110%">
                            <feGaussianBlur stdDeviation={5} />
                        </filter>
                        {/* grano: puntitos de ruido que solo aparecen dentro del relleno (efecto spray) */}
                        <filter id={`${uid}-grain`} x="0" y="0" width="100%" height="100%">
                            <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="3" result="n" />
                            <feColorMatrix in="n" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -2.2 1.35" result="a" />
                            <feComposite in="SourceGraphic" in2="a" operator="in" />
                        </filter>
                        <filter id={`${uid}-wide`} x="-40%" y="-10%" width="180%" height="120%">
                            <feGaussianBlur stdDeviation={blur * 2.4} />
                        </filter>
                        {/* trama de puntos (halftone): solo se ven los puntos dentro del relleno */}
                        <pattern id={`${uid}-dots`} width="4.5" height="4.5" patternUnits="userSpaceOnUse">
                            <circle cx="2.25" cy="2.25" r="1" fill="#fff" />
                        </pattern>
                        <mask id={`${uid}-dm`}>
                            <rect x="0" y="0" width={W} height={H} fill={`url(#${uid}-dots)`} mask={`url(#${uid}-m)`} />
                        </mask>
                        <linearGradient id={`${uid}-dayline`} gradientUnits="userSpaceOnUse" x1="0" x2={W} y1="0" y2="0">
                            <stop offset="0" stopColor={gridColor} stopOpacity={0} />
                            <stop offset="0.15" stopColor={gridColor} stopOpacity={dark ? 0.4 : 0.2} />
                            <stop offset="0.85" stopColor={gridColor} stopOpacity={dark ? 0.4 : 0.2} />
                            <stop offset="1" stopColor={gridColor} stopOpacity={0} />
                        </linearGradient>
                        {/* el viento cambia de color con la velocidad, hora a hora (como la temperatura) */}
                        <linearGradient id={`${uid}-wind`} gradientUnits="userSpaceOnUse" x1="0" x2="0" y1={PAD_T} y2={yEnd}>
                            {windHours
                                .filter((_, k) => k % 2 === 0)
                                .map((h) => (
                                    <stop key={h.t} offset={((y(h.t) - PAD_T) / Math.max(1, yEnd - PAD_T)).toFixed(4)} stopColor={dark ? wcol(h.wind!, windColor) : mix(wcol(h.wind!, windColor), "#2a1f3a", 0.12)} />
                                ))}
                        </linearGradient>
                        {/* la cinta se apaga hacia el borde izquierdo */}
                        <linearGradient id={`${uid}-wfade`} gradientUnits="userSpaceOnUse" x1="16" x2={60} y1="0" y2="0">
                            <stop offset="0" stopColor="#fff" stopOpacity="0" />
                            <stop offset="1" stopColor="#fff" stopOpacity="1" />
                        </linearGradient>
                        <mask id={`${uid}-wm`}>
                            <rect x="0" y="0" width="70" height={H} fill={`url(#${uid}-wfade)`} />
                        </mask>
                    </defs>

                    {/* rejilla fina: cada 6 h muy suave y una línea a medianoche */}
                    {hours
                        .filter((h) => new Date(h.t).getUTCHours() % 6 === 0)
                        .map((h) => (
                            <line key={`g${h.t}`} x1={G} x2={W - CLOUD_W} y1={y(h.t)} y2={y(h.t)} stroke={rgba(gridColor, dark ? 0.1 : 0.05)} strokeWidth={1} />
                        ))}
                    {groups.slice(1).map((g) => (
                        <line key={g.key} x1={0} x2={W} y1={y(g.start)} y2={y(g.start)} stroke={`url(#${uid}-dayline)`} strokeWidth={1} />
                    ))}


                    {/* los modelos por separado: líneas grises finas, debajo de la temperatura */}
                    {modelLines.map((m) => (
                        <path key={`ml${m.id}`} d={m.d} fill="none" stroke={rgba(softColor, dark ? 0.55 : 0.5)} strokeWidth={0.8} strokeLinecap="round" strokeLinejoin="round" />
                    ))}
                    {/* temperatura: luz difuminada + grano + la curva */}
                    {/* 1. un halo muy ancho; 2. la luz difuminada; 3. la textura (puntos o grano); 4. una sola línea fina que brilla */}
                    <path d={tArea} fill={`url(#${uid}-t)`} mask={`url(#${uid}-m)`} opacity={dark ? 0.55 : 0.4} filter={blur > 0 ? `url(#${uid}-wide)` : undefined} />
                    <path d={tArea} fill={`url(#${uid}-t)`} mask={`url(#${uid}-m)`} opacity={dark ? 0.8 : 0.65} filter={blur > 0 ? `url(#${uid}-blur)` : undefined} />
                    {texture === "puntos" && grain > 0 && <path d={tArea} fill={`url(#${uid}-t)`} mask={`url(#${uid}-dm)`} opacity={grain} />}
                    {texture === "grano" && grain > 0 && <path d={tArea} fill={`url(#${uid}-t)`} mask={`url(#${uid}-m)`} opacity={grain} filter={`url(#${uid}-grain)`} />}
                    <path d={tLine} fill="none" stroke={`url(#${uid}-t)`} strokeWidth={lineWidth + 5} strokeOpacity={dark ? 0.6 : 0.35} filter={`url(#${uid}-soft)`} />
                    <path className={`${uid}-draw`} pathLength={1} d={tLine} fill="none" stroke={`url(#${uid}-t)`} strokeWidth={lineWidth} strokeLinecap="round" />
                    {/* avisos: una barra de color en el borde derecho durante las horas del aviso */}
                    {showAlerts &&
                        alerts.map((r) => (
                            <g key={`al${r.kind}${r.a}`}>
                                <rect x={W - 6} y={y(r.a) - 2} width={4} height={y(r.b) - y(r.a) + 4} rx={2} fill={ALERT[r.level]} />
                                <rect x={W - 10} y={y(r.a) - 4} width={10} height={y(r.b) - y(r.a) + 8} rx={4} fill={ALERT[r.level]} opacity={0.35} filter={`url(#${uid}-soft)`} />
                            </g>
                        ))}

                    {/* viento: línea magenta con un brillo */}
                    {showWind && wLine && (
                        <>
                            {wArea && <path d={wArea} fill={`url(#${uid}-wind)`} fillOpacity={dark ? 0.6 : 0.5} mask={`url(#${uid}-wm)`} filter={`url(#${uid}-soft)`} />}
                            <path d={wLine} fill="none" stroke={`url(#${uid}-wind)`} strokeOpacity={0.55} strokeWidth={5} filter={`url(#${uid}-soft)`} />
                            <path className={`${uid}-draw`} pathLength={1} d={wLine} fill="none" stroke={`url(#${uid}-wind)`} strokeWidth={2} strokeLinecap="round" />
                        </>
                    )}

                    {/* nubes: tres columnas */}
                    {showClouds &&
                        cols.map(([key], ci) => {
                            const x = cx0 + ci * (CW + CG)
                            const id = `${uid}-c${ci}`
                            return (
                                <g key={String(key)}>
                                    <defs>
                                        <linearGradient id={id} gradientUnits="userSpaceOnUse" x1="0" x2="0" y1={PAD_T} y2={yEnd}>
                                            {hours
                                                .filter((_, k) => k % 2 === 0)
                                                .map((h) => {
                                                    // Pasados 2-4 días ya no hay nubes por altura (los modelos que las separan acaban
                                                    // antes): entonces las tres columnas enseñan las nubes totales, como una sola franja
                                                    const v = (h[key] as N) ?? (h.lo == null && h.mid == null && h.hi == null ? h.cloud : null) ?? 0
                                                    return <stop key={h.t} offset={((y(h.t) - PAD_T) / Math.max(1, yEnd - PAD_T)).toFixed(4)} stopColor={cloudColor} stopOpacity={Math.min(1, Math.max(0, (v - 8) / 85)) * (dark ? 0.5 : 1)} />
                                                })}
                                        </linearGradient>
                                    </defs>
                                    <line x1={x + CW / 2} x2={x + CW / 2} y1={PAD_T - 4} y2={yEnd + 4} stroke={rgba(softColor, 0.25)} strokeWidth={1} strokeDasharray="1 3" />
                                    <rect className={`${uid}-cloud`} x={x - 5} y={PAD_T} width={CW + 10} height={yEnd - PAD_T} rx={CW} fill={`url(#${id})`} filter={`url(#${uid}-soft)`} style={{ animationDelay: `${ci * -2}s` }} />
                                    <rect x={x + 2} y={PAD_T} width={CW - 4} height={yEnd - PAD_T} rx={CW / 2} fill={`url(#${id})`} opacity={dark ? 0.6 : 0.95} />
                                </g>
                            )
                        })}

                    {/* ahora: un punto al principio de la curva */}
                    <circle cx={tPts[0][0]} cy={tPts[0][1]} r={5} fill={inkColor} />
                    <circle className={`${uid}-ring`} cx={tPts[0][0]} cy={tPts[0][1]} r={6} fill="none" stroke={inkColor} strokeWidth={1} />
                </svg>

                {/* gotas que caen en las horas de lluvia */}
                {/* lluvia: una franja al lado del viento solo en las horas en que llueve, con gotas que caen */}
                {showRain &&
                    rainRuns.map((r) => {
                        const top = y(r.a) - hourHeight / 2,
                            h = y(r.b) - y(r.a) + hourHeight
                        const col = mix(rainColor, "#3d6bff", 0.35)
                        return (
                            <span
                                key={r.a}
                                aria-label={t("Lluvia", "Rain")}
                                className={`${uid}-rain`}
                                style={{
                                    position: "absolute",
                                    left: RX,
                                    width: RW,
                                    top,
                                    height: h,
                                    borderRadius: RW / 2,
                                    backgroundColor: rgba(col, 0.18 + 0.4 * r.k),
                                    boxShadow: `0 0 10px ${rgba(col, 0.35 + 0.3 * r.k)}`,
                                    backgroundImage: `url("data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='14' height='16'><g stroke='${dark ? "#dce8ff" : mix(col, "#1d3a8a", 0.4)}' stroke-width='1.2' stroke-linecap='round'><line x1='4' y1='1' x2='3.2' y2='5'/><line x1='10.5' y1='9' x2='9.7' y2='13'/></g></svg>`)}")`,
                                    backgroundSize: "14px 16px",
                                    pointerEvents: "none",
                                }}
                            />
                        )
                    })}

                {/* flechas del viento: apuntan hacia donde sopla */}
                {showWind &&
                    arrows.map((h, k) => (
                        <span key={h.t} style={{ position: "absolute", left: wx(h.wind!) - 20, top: y(h.t) - 6, width: 12, height: 12, transform: `rotate(${h.dir! + 180}deg)`, pointerEvents: "none" }}>
                            <svg className={`${uid}-arrow`} width="12" height="12" viewBox="0 0 12 12" style={{ display: "block", animationDelay: `${(k % 5) * -0.5}s` }}>
                                <path d="M6 10.5V2M3 5L6 2 9 5" stroke={dark ? mix(wcol(h.wind!, windColor), "#ffffff", 0.2) : mix(wcol(h.wind!, windColor), inkColor, 0.2)} strokeOpacity={0.9} strokeWidth="1.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                        </span>
                    ))}

                {/* fecha de cada día */}
                {groups.map((g, k) => (
                    <span key={g.key} style={{ position: "absolute", left: 8, top: k === 0 ? 2 : y(g.start) + 5, lineHeight: 1.1, textShadow: `0 0 6px ${bgColor}, 0 0 2px ${bgColor}`, pointerEvents: "none" }}>
                        <span style={{ display: "block", fontFamily: SANS, fontWeight: 600, fontSize: 12.5, letterSpacing: "-0.01em", color: inkColor, textTransform: "capitalize" }}>{k === 0 ? t("Hoy", "Today") : fmtWd.format(new Date(g.start)).replace(".", "")}</span>
                        <span style={{ display: "block", fontFamily: MONO, fontSize: 9, color: softColor, marginTop: 1 }}>{fmtDay.format(new Date(g.start))}</span>
                    </span>
                ))}

                {/* la IA de cada día: un botón pequeño «✦ por qué» que abre lo que corrige, por tramos de horas */}
                {showSpread &&
                    showAI &&
                    groups.map((g, k) => {
                        const media = dayCorr(g.list)
                        if (media == null) return null
                        const top = k === 0 ? 4 : y(g.start) + 4
                        const open = iaDia === g.key
                        const fd = (x: number) => `${signo(uTd(x))}°`
                        const ex = open ? explicaIA(g.list, (tt) => dayLight(tt) < 0.5, fd) : null
                        const hh = (tt: number) => new Intl.DateTimeFormat(LOC(), { hour: "2-digit", hourCycle: "h23", timeZone: tz }).format(new Date(tt))
                        return (
                            <div key={`ia${g.key}`} style={{ position: "absolute", right: CLOUD_W + 4, top, zIndex: open ? 30 : 4, display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
                                <button
                                    type="button"
                                    onClick={() => setIaDia(open ? null : g.key)}
                                    aria-expanded={open}
                                    style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 7px 2px 6px", borderRadius: 999, border: `1px solid ${rgba(tempMild, open ? 0.8 : 0.45)}`, background: open ? rgba(tempMild, 0.14) : rgba(bgColor, 0.85), fontFamily: MONO, fontSize: 8.5, lineHeight: 1.3, color: inkColor, cursor: "pointer", whiteSpace: "nowrap" }}
                                >
                                    <span style={{ color: tempMild }}>✦</span> {t("por qué", "why")}
                                    <svg width="7" height="7" viewBox="0 0 8 8" style={{ transition: "transform .25s", transform: open ? "rotate(180deg)" : "none" }}>
                                        <path d="M1.5 3l2.5 2.5L6.5 3" stroke={softColor} strokeWidth="1.3" fill="none" strokeLinecap="round" />
                                    </svg>
                                </button>
                                {open && ex && (
                                    <div className={`${uid}-in`} style={{ marginTop: 6, width: Math.min(236, W - 110), padding: "10px 12px", borderRadius: 14, background: bgColor, border: `1px solid ${rgba(inkColor, 0.1)}`, boxShadow: "0 12px 34px rgba(0,0,0,.14)", fontFamily: SANS, color: inkColor, textAlign: "left" }}>
                                        <div style={{ fontFamily: MONO, fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase", color: softColor, marginBottom: 6 }}>{t("Lo que corrige la IA", "What the AI corrects")}</div>
                                        {ex.tramos.map((r) => (
                                            <div key={r.desde} style={{ padding: "6px 0", borderTop: `1px solid ${rgba(inkColor, 0.07)}` }}>
                                                <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                                                    <b style={{ fontWeight: 600, fontSize: 12 }}>{r.nombre}</b>
                                                    <span style={{ fontFamily: MONO, fontSize: 9.5, color: softColor }}>
                                                        {hh(r.desde)}–{hh(r.hasta)} h
                                                    </span>
                                                    <span style={{ marginLeft: "auto", fontFamily: MONO, fontSize: 11, fontWeight: 600, color: Math.abs(r.c) < 0.3 ? softColor : r.c < 0 ? tempCold : mix(tempWarm, tempHot, 0.5) }}>{fd(r.c)}</span>
                                                </div>
                                                <div style={{ fontSize: 11, lineHeight: 1.35, color: softColor, marginTop: 2 }}>{r.razon}</div>
                                            </div>
                                        ))}
                                        {ex.acuerdo && <div style={{ fontSize: 11, lineHeight: 1.35, color: softColor, padding: "6px 0", borderTop: `1px solid ${rgba(inkColor, 0.07)}` }}>{ex.acuerdo}</div>}
                                        <div style={{ display: "flex", justifyContent: "space-between", fontFamily: MONO, fontSize: 9.5, color: softColor, paddingTop: 6, borderTop: `1px solid ${rgba(inkColor, 0.07)}` }}>
                                            <span>{t("Media de todo el día", "Whole-day average")}</span>
                                            <span style={{ color: inkColor }}>{fd(media)}</span>
                                        </div>
                                    </div>
                                )}
                            </div>
                        )
                    })}

                {/* la velocidad más alta de cada día, junto a la raya del viento */}
                {showWind &&
                    windPeaks.map((h) => (
                        <span key={`wp${h.t}`} style={{ position: "absolute", left: wx(h.wind!) + 5, top: y(h.t) - 7, fontFamily: MONO, fontSize: 9.5, lineHeight: 1, color: dark ? mix(wcol(h.wind!, windColor), "#ffffff", 0.3) : mix(wcol(h.wind!, windColor), inkColor, 0.35), whiteSpace: "nowrap", padding: "2px 3px", borderRadius: 4, background: rgba(bgColor, 0.8), pointerEvents: "none" }}>
                            {uV(h.wind!)}
                            <span style={{ fontSize: 7.5, marginLeft: 1, opacity: 0.8 }}>{uVL()}</span>
                        </span>
                    ))}

                {/* lluvia total de cada día, junto a su columna */}
                {showRain &&
                    rainDays.map((d) => (
                        <span key={`rd${d.t}`} style={{ position: "absolute", left: RX + RW + 4, top: y(d.t) - 6, fontFamily: MONO, fontSize: 9, lineHeight: 1, color: dark ? mix(rainColor, "#ffffff", 0.3) : mix(rainColor, "#1d3a8a", 0.55), textShadow: `0 0 4px ${bgColor}, 0 0 2px ${bgColor}`, whiteSpace: "nowrap", pointerEvents: "none" }}>
                            {d.mm >= 0.2 && (
                                <>
                                    {uR(d.mm)}
                                    <span style={{ fontSize: 7.5, marginLeft: 1 }}>{uRL()}</span>
                                </>
                            )}
                            {d.prob != null && d.prob >= 0.1 && (
                                <span title={t("Probabilidad de al menos 1 mm, según la IA", "Chance of at least 1 mm, according to the AI")} style={{ marginLeft: d.mm >= 0.2 ? 4 : 0, padding: "1px 4px", borderRadius: 999, border: `1px solid ${rgba(tempMild, 0.5)}`, fontSize: 7.5, color: inkColor, background: rgba(bgColor, 0.85) }}>
                                    <span style={{ color: tempMild }}>✦</span> {Math.round(d.prob * 100)} %
                                </span>
                            )}
                        </span>
                    ))}

                {/* hasta dónde llega la corrección de la IA */}
                {aiOn && aiEnd! < hours[hours.length - 1].t - 6 * HOUR && (
                    <>
                        <span style={{ position: "absolute", left: X0 - 8, width: X1 - X0 + 16, top: y(aiEnd!), borderTop: `1px dashed ${rgba(tempMild, 0.6)}`, pointerEvents: "none" }} />
                        <span style={{ position: "absolute", left: X0 - 6, top: y(aiEnd!) - 15, display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 6px", borderRadius: 999, border: `1px solid ${rgba(tempMild, 0.55)}`, background: rgba(bgColor, 0.9), fontFamily: MONO, fontSize: 8, letterSpacing: "0.06em", textTransform: "uppercase", color: inkColor, whiteSpace: "nowrap", pointerEvents: "none" }}>
                            <span style={{ color: tempMild }}>✦</span> {t("IA hasta aquí · después, modelos", "AI up to here · then models")}
                        </span>
                    </>
                )}

                {/* salida y puesta de sol: solo la hora, pequeña */}
                {sunMarks.map((s) => (
                    <span key={`s${s.t}`} title={s.rise ? t("Amanecer", "Sunrise") : t("Atardecer", "Sunset")} style={{ position: "absolute", top: y(s.t) - 4 + (marks.some((m) => m.hot && Math.abs(y(m.h.t) - y(s.t)) < 18) ? 16 : 0), right: CLOUD_W + 4, fontFamily: MONO, fontSize: 7.5, lineHeight: 1, letterSpacing: "0.02em", color: softColor, opacity: 0.75, pointerEvents: "none", textShadow: `0 0 4px ${bgColor}` }}>
                        {fmtHour.format(new Date(s.t))}
                    </span>
                ))}

                {/* botón para ver cada modelo por separado */}
                {p.showModels && (
                    <button
                        type="button"
                        onClick={() => setVerModelos((v) => !v)}
                        aria-pressed={verModelos}
                        style={{ position: "absolute", left: X0 - 6, top: 2, padding: "2px 8px", borderRadius: 999, border: `1px solid ${rgba(softColor, verModelos ? 0.7 : 0.35)}`, background: verModelos ? rgba(softColor, 0.14) : rgba(bgColor, 0.7), color: verModelos ? inkColor : softColor, fontFamily: MONO, fontSize: 8.5, letterSpacing: "0.08em", textTransform: "uppercase", cursor: "pointer", zIndex: 2 }}
                    >
                        {verModelos ? t("✕ Modelos", "✕ Models") : t(`≋ ${doc.models.length} modelos`, `≋ ${doc.models.length} models`)}
                    </button>
                )}
                {/* nombre de cada modelo al final de su línea */}
                {modelLines.map((m, i) =>
                    m.end ? (
                        <span key={`mn${m.id}`} style={{ position: "absolute", left: m.end[0] + 4, top: m.end[1] + 2 + (i % 4) * 9, fontFamily: MONO, fontSize: 7, letterSpacing: "0.04em", color: softColor, opacity: 0.85, whiteSpace: "nowrap", pointerEvents: "none" }}>
                            {m.name}
                        </span>
                    ) : null
                )}

                {/* B M A encima de las nubes */}
                {showClouds &&
                    cols.map(([key, l], ci) => (
                        <span key={String(key)} style={{ position: "absolute", top: 4, left: cx0 + ci * (CW + CG), width: CW, textAlign: "center", fontFamily: MONO, fontSize: 9, color: softColor, pointerEvents: "none" }}>
                            {l}
                        </span>
                    ))}

                {/* máxima a la derecha del pico, mínima a la izquierda del valle */}
                {marks.map((m) => (
                    <span
                        key={m.k}
                        style={{
                            position: "absolute",
                            top: y(m.h.t),
                            left: tx(m.h.temp) + (m.hot ? 10 : -10),
                            transform: `translate(${m.hot ? "0" : "-100%"}, -50%)`,
                            fontFamily: SANS,
                            fontWeight: m.hot ? 600 : 400,
                            fontSize: m.hot ? 14 : 12,
                            color: m.hot ? inkColor : softColor,
                            whiteSpace: "nowrap",
                            pointerEvents: "none",
                        }}
                    >
                        {Math.round(uT(m.h.temp))}°
                    </span>
                ))}

            </div>
        </>
    )
}

export function SeccionAcierto({ v }: { v: Vista }) {
    const { p, CG, CLOUD_W, CW, G, H, PAD_B, PAD_T, RW, RX, X0, X1, aiEnd, aiOn, alerts, arrows, cloudNow, cols, css, cx0, dayKey, dayLight, dayStarts, dec, fLine, fPts, feels, feelsLevel, feelsNow, fmtDay, fmtHour, fmtRange, fmtWd, fr, fresh, gradStops, groups, h0, hasLayers, hours, lab, labC, lat, lon, lowCloud, maeIa, maeMed, marks, night, now, nowCol, phrase, pushRun, rainDays, rainProbOf, rainRuns, rec, sit, sky, stateLabel, sunMarks, suns, tArea, tLine, tMax, tMin, tPts, tStops, tcol, today, todayMax, todayMin, tx, tz, wArea, wLine, wPts, wScale, windHours, windPeaks, wx, y, yEnd, uid, W, dark, toggleTheme, bgColor, inkColor, softColor, cloudColor, gridColor, doc } = v
    const { cityId, baseUrl, days, hourHeight, showHeader, showWind, showRain, showClouds, showAI, showSpread, showScore, tempCold, tempMild, tempWarm, tempHot, windColor, rainColor, lineWidth, blur, grain, texture, sphereBlur, showFeels, phraseStyle, customPhrase, showAlerts, theme, windMax, radius, animate } = p
    return (
        <>
            {showAI && showScore && rec.station && (
                <div style={{ padding: "22px 20px 24px", borderTop: `1px solid ${rgba(inkColor, 0.1)}` }}>
                    <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", color: softColor }}>
                        <span style={{ color: tempMild }}>✦</span> {t("¿Acierta la IA?", "Is the AI right?")} · {rec.station.name}
                    </div>
                    <div style={{ fontFamily: SANS, fontWeight: 500, fontSize: 17, lineHeight: 1.3, letterSpacing: "-0.015em", marginTop: 8, color: inkColor, textWrap: "balance" as any }}>{rec.resumen}</div>
                    {rec.n > 0 && (
                        <div style={{ fontFamily: MONO, fontSize: 10, color: softColor, marginTop: 6 }}>
                            {t(`Más cerca: IA ${rec.winI} · modelos ${rec.winM} (máximas y mínimas de ${rec.rows.length} ${rec.rows.length === 1 ? "día" : "días"})`, `Closer: AI ${rec.winI} · models ${rec.winM} (highs and lows of ${rec.rows.length} ${rec.rows.length === 1 ? "day" : "days"})`)}
                        </div>
                    )}
                    {rec.rows.length > 0 && (
                        <div style={{ display: "grid", gridTemplateColumns: "auto 1fr 1fr 1fr", columnGap: 10, rowGap: 6, marginTop: 14, fontFamily: MONO, fontSize: 10.5, fontVariantNumeric: "tabular-nums", alignItems: "baseline" }}>
                            {["", t("Real", "Actual"), "✦ IA", t("Modelos", "Models")].map((h) => (
                                <span key={`h${h}`} style={{ fontSize: 9, letterSpacing: "0.1em", textTransform: "uppercase", color: h === "✦ IA" ? tempMild : softColor }}>
                                    {h}
                                </span>
                            ))}
                            {rec.rows
                                .slice()
                                .reverse()
                                .map((r) => {
                                    const o = r.obs!,
                                        t = r.temp!
                                    const near = (p: N, m: N, v: N, ai: boolean) => p != null && m != null && v != null && (ai ? Math.abs(p - v) < Math.abs(m - v) - 0.05 : Math.abs(m - v) < Math.abs(p - v) - 0.05)
                                    const cell = (mx: N, mn: N, ai: boolean) => (
                                        <span>
                                            <b style={{ fontWeight: near(t.max, t.mod_max, o.tmax, ai) ? 700 : 400, color: near(t.max, t.mod_max, o.tmax, ai) ? inkColor : softColor }}>{mx != null ? Math.round(uT(mx)) : "–"}°</b>
                                            <span style={{ color: softColor }}> / </span>
                                            <b style={{ fontWeight: near(t.min, t.mod_min, o.tmin, ai) ? 700 : 400, color: near(t.min, t.mod_min, o.tmin, ai) ? inkColor : softColor }}>{mn != null ? Math.round(uT(mn)) : "–"}°</b>
                                        </span>
                                    )
                                    const dd = new Date(`${r.day}T12:00:00Z`)
                                    return [
                                        <span key={`d${r.day}`} style={{ color: softColor, textTransform: "capitalize" }}>
                                            {fmtWd.format(dd).replace(".", "")} {fmtDay.format(dd).slice(0, 2)}
                                        </span>,
                                        <span key={`o${r.day}`} style={{ color: inkColor }}>
                                            {o.tmax != null ? Math.round(uT(o.tmax)) : "–"}° / {o.tmin != null ? Math.round(uT(o.tmin)) : "–"}°
                                        </span>,
                                        <span key={`i${r.day}`}>{cell(t.max, t.min, true)}</span>,
                                        <span key={`m${r.day}`}>{cell(t.mod_max, t.mod_min, false)}</span>,
                                    ]
                                })}
                        </div>
                    )}
                    <div style={{ fontFamily: SANS, fontSize: 12, lineHeight: 1.4, color: softColor, marginTop: 12 }}>
                        {t(`Máxima / mínima de cada día. En negrita, quien se acercó más a lo medido por AEMET${rec.pend > 0 ? `; ${rec.pend} ${rec.pend === 1 ? "día pendiente" : "días pendientes"} de dato` : ""}.`, `High / low of each day. In bold: whoever came closer to what AEMET measured${rec.pend > 0 ? `; ${rec.pend} ${rec.pend === 1 ? "day" : "days"} still pending` : ""}.`)}
                    </div>
                </div>
            )}
        </>
    )
}
