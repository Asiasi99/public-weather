/**
 * TiempoMapa — una pieza del tiempo: el mapa de temperatura, lluvia o viento con tus datos
 * (la media de los 8 modelos cada 25 km), con una barra para mover la hora.
 *
 * Datos: mapa/index.json (los puntos), mapa/<paso>.json (uno cada 3 h) y mapa/contornos.json (Natural Earth).
 * Es solo para mirar: tocarlo no cambia la ciudad de la página.
 */
import { addPropertyControls, ControlType } from "framer"
import { useEffect, useMemo, useRef, useState } from "react"
import { BASE, hexRgb, MONO, mix, rgba, SANS, scale, setIdioma, t, uR, uRL, uT, useAjustesWeb, useTema, uV, uVL, wcol, windStops } from "./TiempoNucleo.tsx"

type Indice = { res: number; lat: number[]; lon: number[]; steps: string[] }
type Paso = { t: string; temp: (number | null)[]; rain: (number | null)[]; wind: (number | null)[]; dir: (number | null)[] }
type Capa = "temp" | "lluvia" | "viento"

const ZONAS: { id: string; es: string; en: string; box: [number, number, number, number] }[] = [
    { id: "pf", es: "Península y Francia", en: "Iberia & France", box: [-10.2, 35.4, 9.9, 51.4] },
    { id: "es", es: "España", en: "Spain", box: [-9.8, 35.6, 4.6, 44.0] },
    { id: "fr", es: "Francia", en: "France", box: [-5.3, 41.2, 9.9, 51.3] },
    { id: "ca", es: "Canarias", en: "Canary Islands", box: [-18.4, 27.5, -13.2, 29.5] },
    { id: "az", es: "Azores y Madeira", en: "Azores & Madeira", box: [-31.6, 32.3, -16.0, 40.0] },
]
const CIUDADES: [string, number, number][] = [
    ["Madrid", 40.42, -3.7], ["Barcelona", 41.39, 2.17], ["Valencia", 39.47, -0.38], ["Sevilla", 37.39, -5.98], ["Bilbao", 43.26, -2.93],
    ["A Coruña", 43.36, -8.41], ["Zaragoza", 41.65, -0.88], ["Málaga", 36.72, -4.42], ["Valladolid", 41.65, -4.72], ["Murcia", 37.99, -1.13],
    ["Lisboa", 38.72, -9.14], ["Porto", 41.15, -8.61], ["Paris", 48.86, 2.35], ["Lyon", 45.76, 4.84], ["Marseille", 43.3, 5.37],
    ["Bordeaux", 44.84, -0.58], ["Toulouse", 43.6, 1.44], ["Nantes", 47.22, -1.55], ["Strasbourg", 48.57, 7.75], ["Lille", 50.63, 3.06],
    ["Palma", 39.57, 2.65], ["Las Palmas", 28.12, -15.43], ["S/C Tenerife", 28.47, -16.25], ["Ponta Delgada", 37.74, -25.67], ["Funchal", 32.65, -16.91],
]
/** Lluvia como un radar: cian claro (poco) → azul → violeta → magenta (mucha), en mm cada 3 h */
const LLUVIA: [number, string][] = [
    [1, "#8fe3ff"],
    [3, "#3fa2ff"],
    [8, "#5b5bff"],
    [15, "#b04dff"],
    [30, "#ff3fbf"],
]

// Pocas ciudades, para que el mapa respire (las isotermas ya dan la temperatura)
const PRINCIPALES = new Set(["Madrid", "Barcelona", "Sevilla", "Bilbao", "Lisboa", "Paris", "Lyon", "Bordeaux", "Marseille", "Valencia", "A Coruña", "Palma", "Las Palmas", "S/C Tenerife", "Ponta Delgada", "Funchal"])

const cache = new Map<string, Promise<any>>()
function get<T>(url: string): Promise<T> {
    if (!cache.has(url)) {
        cache.set(url, fetch(url, { cache: "no-cache" }).then((r) => (r.ok ? r.json() : Promise.reject(r.status))))
        setTimeout(() => cache.delete(url), 10 * 60_000)
    }
    return cache.get(url)!
}

type Props = {
    capaInicial: Capa
    zonaInicial: string
    idioma: "auto" | "es" | "en"
    theme: "auto" | "claro" | "oscuro"
    tempCold: string
    tempMild: string
    tempWarm: string
    tempHot: string
    rainColor: string
    blur: number
    soloTierra: boolean
    bordes: boolean
    isotermas: boolean
    particulas: boolean
    windColor: string
    radius: number
    baseUrl: string
}

/**
 * @framerSupportedLayoutWidth any
 * @framerSupportedLayoutHeight auto
 * @framerIntrinsicWidth 390
 */
export default function TiempoMapa(props: Partial<Props>) {
    const {
        capaInicial = "temp",
        zonaInicial = "pf",
        idioma = "auto",
        theme = "auto",
        tempCold = "#3d6bff",
        tempMild = "#2ec7c0",
        tempWarm = "#ffc93c",
        tempHot = "#ff3d3d",
        rainColor = "#3d6bff",
        blur = 1,
        soloTierra = true,
        bordes = false,
        isotermas = true,
        particulas = true,
        windColor = "#e0248a",
        radius = 24,
        baseUrl = BASE,
    } = props
    const ajw = useAjustesWeb()
    setIdioma(ajw.idioma !== "auto" ? ajw.idioma : idioma)
    const { dark } = useTema(theme)
    const bg = dark ? "#05060a" : "#f5efe3",
        ink = dark ? "#eef0f6" : "#1d1a17",
        soft = dark ? "#7d8396" : "#8a7f72"
    const tcol = (v: number) =>
        scale(
            [
                [0, tempCold],
                [12, tempMild],
                [22, tempWarm],
                [32, tempHot],
            ],
            v
        )

    const ref = useRef<HTMLDivElement>(null)
    const canvas = useRef<HTMLCanvasElement>(null)
    const antes = useRef<HTMLCanvasElement>(null) // copia del fotograma anterior, para el fundido entre horas
    const aire = useRef<HTMLCanvasElement>(null) // las partículas del viento
    const campo = useRef<{ nx: number; ny: number; u: Float32Array; v: Float32Array; s: Float32Array } | null>(null)
    const [W, setW] = useState(390)
    const [idx, setIdx] = useState<Indice | null>(null)
    const [cont, setCont] = useState<{ lines: number[][] } | null>(null)
    const [paso, setPaso] = useState<Paso | null>(null)
    const [k, setK] = useState(0)
    const [capa, setCapa] = useState<Capa>(capaInicial)
    const [zona, setZona] = useState(ZONAS.find((z) => z.id === zonaInicial) ?? ZONAS[0])
    const [play, setPlay] = useState(false)
    const [err, setErr] = useState(false)
    useEffect(() => setCapa(capaInicial), [capaInicial])
    useEffect(() => setZona(ZONAS.find((z) => z.id === zonaInicial) ?? ZONAS[0]), [zonaInicial])

    useEffect(() => {
        const el = ref.current
        if (!el || typeof ResizeObserver === "undefined") return
        const ro = new ResizeObserver(() => setW(Math.max(260, el.clientWidth)))
        ro.observe(el)
        setW(Math.max(260, el.clientWidth))
        return () => ro.disconnect()
    }, [])
    useEffect(() => {
        get<Indice>(`${baseUrl}/mapa/index.json`)
            .then((j) => {
                setIdx(j)
                const now = Date.now()
                let best = 0
                j.steps.forEach((s, i) => {
                    if (Math.abs(Date.parse(s) - now) < Math.abs(Date.parse(j.steps[best]) - now)) best = i
                })
                setK(best)
            })
            .catch(() => setErr(true))
        get<{ lines: number[][] }>(`${baseUrl}/mapa/contornos.json`).then(setCont).catch(() => undefined)
    }, [baseUrl])
    useEffect(() => {
        if (!idx) return
        let vivo = true
        get<Paso>(`${baseUrl}/mapa/${k}.json`)
            .then((p) => vivo && setPaso(p))
            .catch(() => undefined)
        if (k + 1 < idx.steps.length) get<Paso>(`${baseUrl}/mapa/${k + 1}.json`).catch(() => undefined)
        return () => {
            vivo = false
        }
    }, [idx, k, baseUrl])
    useEffect(() => {
        if (!play || !idx) return
        const id = setInterval(() => setK((v) => (v + 1 < idx.steps.length ? v + 1 : 0)), 700)
        return () => clearInterval(id)
    }, [play, idx])

    // Proyección
    const [lo0, la0z, lo1, la1z] = zona.box
    const kx = W / (lo1 - lo0)
    const ky = kx / Math.cos((((la0z + la1z) / 2) * Math.PI) / 180)
    // se amplía la zona arriba y abajo para que los mandos de cristal no tapen tierra
    const la1 = la1z + 50 / ky,
        la0 = la0z - 86 / ky
    const H = Math.round((la1 - la0) * ky)
    const px = (lon: number) => (lon - lo0) * kx
    const py = (lat: number) => (la1 - lat) * ky

    // Pintar en el lienzo: celdas difuminadas, contornos y flechas del viento
    useEffect(() => {
        const cv = canvas.current
        if (!cv || !idx || !paso) return
        const dpr = typeof window !== "undefined" ? Math.min(2, window.devicePixelRatio || 1) : 1
        // fundido suave: lo que había se copia encima y se desvanece
        const pv = antes.current
        if (pv && cv.width && cv.height) {
            pv.width = cv.width
            pv.height = cv.height
            pv.getContext("2d")?.drawImage(cv, 0, 0)
            pv.style.transition = "none"
            pv.style.opacity = "1"
            requestAnimationFrame(() => requestAnimationFrame(() => {
                pv.style.transition = "opacity .45s ease"
                pv.style.opacity = "0"
            }))
        }
        cv.width = Math.round(W * dpr)
        cv.height = Math.round(H * dpr)
        const ctx = cv.getContext("2d")
        if (!ctx) return
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        ctx.clearRect(0, 0, W, H)
        // 1) Un píxel por punto de la rejilla en un lienzo pequeño; al estirarlo, el navegador mezcla los colores
        //    entre puntos (sin cuadrados ni malla) y luego se suaviza un poco más con un difuminado
        const r = idx.res
        const nx = Math.round((lo1 - lo0) / r) + 4,
            ny = Math.round((la1 - la0) / r) + 4
        const gx = (lon: number) => Math.round((lon - lo0) / r) + 2,
            gy = (lat: number) => Math.round((la1 - lat) / r) + 2
        const rgbaArr = new Float32Array(nx * ny * 4)
        const has = new Uint8Array(nx * ny)
        const tv = new Float32Array(nx * ny).fill(NaN) // temperatura (en la unidad elegida) para las isotermas
        for (let i = 0; i < idx.lat.length; i++) {
            const lat = idx.lat[i] / 100,
                lon = idx.lon[i] / 100
            const x = gx(lon),
                y = gy(lat)
            if (x < 0 || y < 0 || x >= nx || y >= ny) continue
            let col = "",
                a = 0
            if (capa === "temp") {
                const v = paso.temp[i]
                if (v == null) continue
                col = tcol(v / 10)
                a = 0.92
                tv[y * nx + x] = uT(v / 10)
            } else if (capa === "lluvia") {
                const v = paso.rain[i]
                if (v == null) continue
                col = scale(LLUVIA, v / 10)
                a = v < 1 ? 0 : Math.min(0.92, 0.45 + Math.sqrt(v / 10 / 12))
            } else {
                const v = paso.wind[i]
                if (v == null) continue
                col = wcol(v, windColor)
                a = 0.8
            }
            const [cr, cg, cb] = hexRgb(col) // vale para «#3d6bff» y para «rgb(61, 107, 255)» (como da Framer los colores)
            const q = (y * nx + x) * 4
            rgbaArr[q] = cr
            rgbaArr[q + 1] = cg
            rgbaArr[q + 2] = cb
            rgbaArr[q + 3] = a
            has[y * nx + x] = 1
        }
        // Rellenar los huecos con la media de los vecinos (dos pasadas): así no aparecen bordes oscuros
        for (let pass = 0; pass < 2; pass++) {
            const add: [number, number, number, number, number][] = []
            for (let y = 0; y < ny; y++)
                for (let x = 0; x < nx; x++) {
                    if (has[y * nx + x]) continue
                    let n = 0,
                        sr = 0,
                        sg = 0,
                        sb = 0,
                        sa = 0
                    for (let dy = -1; dy <= 1; dy++)
                        for (let dx = -1; dx <= 1; dx++) {
                            const xx = x + dx,
                                yy = y + dy
                            if (xx < 0 || yy < 0 || xx >= nx || yy >= ny || !has[yy * nx + xx]) continue
                            const q = (yy * nx + xx) * 4
                            sr += rgbaArr[q]
                            sg += rgbaArr[q + 1]
                            sb += rgbaArr[q + 2]
                            sa += rgbaArr[q + 3]
                            n++
                        }
                    if (n) add.push([y * nx + x, sr / n, sg / n, sb / n, sa / n])
                    if (n) {
                        let tn = 0,
                            ts = 0
                        for (let dy = -1; dy <= 1; dy++)
                            for (let dx = -1; dx <= 1; dx++) {
                                const xx = x + dx,
                                    yy = y + dy
                                if (xx < 0 || yy < 0 || xx >= nx || yy >= ny) continue
                                const v = tv[yy * nx + xx]
                                if (!isNaN(v)) {
                                    ts += v
                                    tn++
                                }
                            }
                        if (tn) tv[y * nx + x] = ts / tn
                    }
                }
            for (const [p, a1, a2, a3, a4] of add) {
                rgbaArr.set([a1, a2, a3, a4], p * 4)
                has[p] = 1
            }
        }
        // Campo de viento (u, v en px/s) para las partículas: un valor por punto, con los huecos rellenos
        {
            const u = new Float32Array(nx * ny).fill(NaN),
                vv = new Float32Array(nx * ny).fill(NaN),
                sp = new Float32Array(nx * ny).fill(NaN)
            for (let i = 0; i < idx.lat.length; i++) {
                const x = gx(idx.lon[i] / 100),
                    y = gy(idx.lat[i] / 100)
                const w = paso.wind[i],
                    d = paso.dir[i]
                if (x < 0 || y < 0 || x >= nx || y >= ny || w == null || d == null) continue
                const a = (d * Math.PI) / 180
                u[y * nx + x] = -Math.sin(a) * w
                vv[y * nx + x] = Math.cos(a) * w
                sp[y * nx + x] = w
            }
            for (let pass = 0; pass < 3; pass++) {
                const add: [number, number, number, number][] = []
                for (let y = 0; y < ny; y++)
                    for (let x = 0; x < nx; x++) {
                        if (!isNaN(u[y * nx + x])) continue
                        let n = 0, su = 0, sv = 0, ss = 0
                        for (let dy = -1; dy <= 1; dy++)
                            for (let dx = -1; dx <= 1; dx++) {
                                const q = (y + dy) * nx + x + dx
                                if (x + dx < 0 || y + dy < 0 || x + dx >= nx || y + dy >= ny || isNaN(u[q])) continue
                                su += u[q]; sv += vv[q]; ss += sp[q]; n++
                            }
                        if (n) add.push([y * nx + x, su / n, sv / n, ss / n])
                    }
                for (const [q, a1, a2, a3] of add) (u[q] = a1), (vv[q] = a2), (sp[q] = a3)
            }
            campo.current = { nx, ny, u, v: vv, s: sp }
        }
        const small = document.createElement("canvas")
        small.width = nx
        small.height = ny
        const sctx = small.getContext("2d")!
        const img = sctx.createImageData(nx, ny)
        for (let p = 0; p < nx * ny; p++) {
            img.data[p * 4] = rgbaArr[p * 4]
            img.data[p * 4 + 1] = rgbaArr[p * 4 + 1]
            img.data[p * 4 + 2] = rgbaArr[p * 4 + 2]
            img.data[p * 4 + 3] = has[p] ? Math.round(rgbaArr[p * 4 + 3] * 255) : 0
        }
        sctx.putImageData(img, 0, 0)
        // Solo sobre tierra: se recorta con los países (los anillos cerrados de los contornos)
        let tierra: Path2D | null = null
        if (soloTierra && cont) {
            tierra = new Path2D()
            for (const l of cont.lines) {
                if (l.length < 6 || l[0] !== l[l.length - 2] || l[1] !== l[l.length - 1]) continue
                for (let j = 0; j < l.length; j += 2) {
                    const x = px(l[j] / 100),
                        y = py(l[j + 1] / 100)
                    if (j) tierra.lineTo(x, y)
                    else tierra.moveTo(x, y)
                }
                tierra.closePath()
            }
        }
        // La tierra levantada del mar: una base con sombra suave
        if (tierra) {
            ctx.save()
            ctx.shadowColor = dark ? "rgba(0,0,0,.55)" : "rgba(40,50,70,.18)"
            ctx.shadowBlur = 22
            ctx.shadowOffsetY = 6
            ctx.fillStyle = dark ? "#161b28" : "#f3eee4"
            ctx.fill(tierra)
            ctx.restore()
        }
        ctx.save()
        if (tierra) ctx.clip(tierra)
        ctx.imageSmoothingEnabled = true
        ctx.imageSmoothingQuality = "high"
        ctx.filter = blur > 0 ? `blur(${((r * kx) / 3) * blur}px)` : "none"
        // Cada píxel del lienzo pequeño, centrado en su punto de la rejilla
        ctx.drawImage(small, px(lo0 - 2.5 * r), py(la1 + 2.5 * r), nx * r * kx, ny * r * ky)
        ctx.restore()

        // Isotermas: líneas que unen los sitios con la misma temperatura (cada 2 °C o 4 °F), con su valor
        if (capa === "temp" && isotermas) {
            // Suavizar un poco los valores para que las líneas no salgan en zigzag
            const sm = new Float32Array(nx * ny).fill(NaN)
            for (let y = 0; y < ny; y++)
                for (let x = 0; x < nx; x++) {
                    let n = 0,
                        sum = 0
                    for (let dy = -1; dy <= 1; dy++)
                        for (let dx = -1; dx <= 1; dx++) {
                            const xx = x + dx,
                                yy = y + dy
                            if (xx < 0 || yy < 0 || xx >= nx || yy >= ny) continue
                            const v = tv[yy * nx + xx]
                            if (!isNaN(v)) {
                                sum += v
                                n++
                            }
                        }
                    if (n >= 5) sm[y * nx + x] = sum / n
                }
            const cx = (gxp: number) => px(lo0 + (gxp - 2) * r),
                cy = (gyp: number) => py(la1 - (gyp - 2) * r)
            const step = uT(10) - uT(0) > 15 ? 4 : 2
            let vmin = Infinity,
                vmax = -Infinity
            for (const v of sm) if (!isNaN(v)) (vmin = Math.min(vmin, v)), (vmax = Math.max(vmax, v))
            ctx.save()
            if (tierra) ctx.clip(tierra)
            ctx.strokeStyle = dark ? "rgba(255,255,255,.32)" : "rgba(255,255,255,.75)"
            ctx.lineWidth = 0.8
            ctx.lineCap = "round"
            const etiquetasIso: [number, number, number][] = []
            const ciudadesPx = CIUDADES.filter(([n]) => PRINCIPALES.has(n)).map(([, la, lo]) => [px(lo), py(la)])
            for (let L = Math.ceil(vmin / step) * step; L <= vmax; L += step) {
                ctx.beginPath()
                const mids: [number, number][] = []
                for (let y = 0; y < ny - 1; y++)
                    for (let x = 0; x < nx - 1; x++) {
                        const a = sm[y * nx + x],
                            b = sm[y * nx + x + 1],
                            c = sm[(y + 1) * nx + x + 1],
                            d = sm[(y + 1) * nx + x]
                        if (isNaN(a) || isNaN(b) || isNaN(c) || isNaN(d)) continue
                        // Cuadrados en marcha: dónde cruza el nivel L cada lado de la celda
                        const pts: [number, number][] = []
                        const cruza = (v1: number, v2: number, x1: number, y1: number, x2: number, y2: number) => {
                            if ((v1 < L) !== (v2 < L)) {
                                const k = (L - v1) / (v2 - v1)
                                pts.push([cx(x1 + (x2 - x1) * k), cy(y1 + (y2 - y1) * k)])
                            }
                        }
                        cruza(a, b, x, y, x + 1, y)
                        cruza(b, c, x + 1, y, x + 1, y + 1)
                        cruza(d, c, x, y + 1, x + 1, y + 1)
                        cruza(a, d, x, y, x, y + 1)
                        for (let i = 0; i + 1 < pts.length; i += 2) {
                            ctx.moveTo(pts[i][0], pts[i][1])
                            ctx.lineTo(pts[i + 1][0], pts[i + 1][1])
                            mids.push([(pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2])
                        }
                    }
                ctx.stroke()
                // Una etiqueta cada ~160 px de línea, sin pisarse con otras
                for (const [mx, my] of mids) {
                    if (mx < 14 || my < 10 || mx > W - 14 || my > H - 8) continue
                    if (tierra && !ctx.isPointInPath(tierra, mx * dpr, my * dpr)) continue
                    if (etiquetasIso.some(([ex, ey, el]) => (ex - mx) ** 2 + (ey - my) ** 2 < (el === L ? 180 * 180 : 60 * 60))) continue
                    // ni encima de las pastillas de las ciudades (van a la derecha de su punto)
                    if (ciudadesPx.some(([cx2, cy2]) => mx > cx2 - 22 && mx < cx2 + 62 && Math.abs(my - cy2) < 18)) continue
                    etiquetasIso.push([mx, my, L])
                }
            }
            ctx.restore()
            ctx.font = `500 10px ${MONO}`
            ctx.textAlign = "center"
            ctx.textBaseline = "middle"
            for (const [x, y, L] of etiquetasIso) {
                const txt = `${Math.round(L)}°`
                const w = ctx.measureText(txt).width + 8
                ctx.fillStyle = dark ? "rgba(10,12,20,.55)" : "rgba(255,255,255,.7)"
                ctx.beginPath()
                ctx.roundRect?.(x - w / 2, y - 7, w, 14, 7)
                ctx.fill()
                ctx.fillStyle = rgba(ink, 0.75)
                ctx.fillText(txt, x, y + 0.5)
            }
        }
        // Costa: una línea de luz finita (en vez de un borde oscuro)
        if (tierra) {
            ctx.strokeStyle = dark ? "rgba(255,255,255,.16)" : "rgba(255,255,255,.9)"
            ctx.lineWidth = 1
            ctx.lineJoin = "round"
            ctx.stroke(tierra)
        }
        // 2) contornos (apagados por defecto: control «Bordes»)
        if (bordes && cont) {
            ctx.beginPath()
            for (const l of cont.lines) {
                for (let j = 0; j < l.length; j += 2) {
                    const x = px(l[j] / 100),
                        y = py(l[j + 1] / 100)
                    if (j) ctx.lineTo(x, y)
                    else ctx.moveTo(x, y)
                }
            }
            ctx.strokeStyle = rgba(ink, dark ? 0.35 : 0.3)
            ctx.lineWidth = 0.6
            ctx.lineJoin = "round"
            ctx.stroke()
        }
        // 3) flechas del viento
        if (capa === "viento" && !particulas) {
            const salto = Math.max(1, Math.round(22 / (r * kx)))
            ctx.strokeStyle = rgba(ink, 0.7)
            ctx.lineWidth = 1
            ctx.lineCap = "round"
            for (let i = 0; i < idx.lat.length; i++) {
                const lat = idx.lat[i] / 100,
                    lon = idx.lon[i] / 100
                if (lon < lo0 || lon > lo1 || lat < la0 || lat > la1) continue
                if (Math.round(lat / r) % salto || Math.round(lon / r) % salto) continue
                const d = paso.dir[i]
                if (d == null) continue
                ctx.save()
                ctx.translate(px(lon), py(lat))
                ctx.rotate(((d + 180) * Math.PI) / 180)
                ctx.beginPath()
                ctx.moveTo(0, 5)
                ctx.lineTo(0, -5)
                ctx.moveTo(-3, -2)
                ctx.lineTo(0, -5)
                ctx.lineTo(3, -2)
                ctx.stroke()
                ctx.restore()
            }
        }
    }, [idx, paso, cont, capa, zona, W, H, dark, blur, tempCold, tempMild, tempWarm, tempHot, rainColor, soloTierra, bordes, isotermas, windColor, particulas])

    // Partículas del viento (como en Windy): siguen el viento de cada sitio y dejan estela.
    // En la capa de viento van de colores (según la velocidad); en las otras, blancas y muy suaves.
    useEffect(() => {
        const cv = aire.current
        if (!cv || !particulas || !idx) return
        const ctx = cv.getContext("2d")
        if (!ctx) return
        const dpr = typeof window !== "undefined" ? Math.min(1.5, window.devicePixelRatio || 1) : 1
        cv.width = Math.round(W * dpr)
        cv.height = Math.round(H * dpr)
        const quieto = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches
        const r = idx.res
        const N = Math.round(Math.min(800, (W * H) / 380))
        const ps = Array.from({ length: N }, () => ({ x: Math.random() * W, y: Math.random() * H, vida: Math.random() * 3 }))
        const muestra = (x: number, y: number) => {
            const c = campo.current
            if (!c) return null
            const fx = (x / kx) / r + 2,
                fy = (y / ky) / r + 2 // del píxel a la rejilla (mismo origen que el dibujo)
            const x0 = Math.floor(fx), y0 = Math.floor(fy)
            if (x0 < 0 || y0 < 0 || x0 + 1 >= c.nx || y0 + 1 >= c.ny) return null
            const ax = fx - x0, ay = fy - y0
            const lerp = (arr: Float32Array) => {
                const a = arr[y0 * c.nx + x0], b = arr[y0 * c.nx + x0 + 1], d = arr[(y0 + 1) * c.nx + x0], e = arr[(y0 + 1) * c.nx + x0 + 1]
                return (a * (1 - ax) + b * ax) * (1 - ay) + (d * (1 - ax) + e * ax) * ay
            }
            const u = lerp(c.u), v = lerp(c.v), s = lerp(c.s)
            return isNaN(u) || isNaN(v) ? null : [u, v, s]
        }
        const color = capa === "viento"
        // colores ya calculados por velocidad redondeada
        const tintas = new Map<number, number[]>()
        const tinta = (kmh: number) => {
            const k = Math.round(kmh)
            let v = tintas.get(k)
            if (!v) tintas.set(k, (v = hexRgb(dark ? wcol(k, windColor) : mix(wcol(k, windColor), "#1d1a17", 0.15))))
            return v
        }
        let raf = 0, t0 = performance.now(), visible = true
        const io = typeof IntersectionObserver !== "undefined" ? new IntersectionObserver(([en]) => { visible = en.isIntersecting; if (visible && !raf) raf = requestAnimationFrame(frame) }) : null
        io?.observe(cv)
        const frame = (now: number) => {
            raf = 0
            // como mucho 30 fotogramas por segundo
            if (now - t0 < 31 && !quieto) { if (visible) raf = requestAnimationFrame(frame); return }
            const dt = Math.min(0.06, (now - t0) / 1000)
            t0 = now
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
            ctx.globalCompositeOperation = "destination-out"
            ctx.fillStyle = "rgba(0,0,0,.09)"
            ctx.fillRect(0, 0, W, H)
            ctx.globalCompositeOperation = dark ? "lighter" : "source-over"
            ctx.lineCap = "round"
            const k = Math.max(0.35, W / 900) // px por km/h y segundo
            for (const p of ps) {
                const m = muestra(p.x, p.y)
                p.vida += dt
                if (!m || p.vida > 4 || p.x < 0 || p.y < 0 || p.x > W || p.y > H) {
                    p.x = Math.random() * W; p.y = Math.random() * H; p.vida = 0
                    continue
                }
                const [u, v, s] = m
                const nx = p.x + u * k * dt * 1.6, ny = p.y + v * k * dt * 1.6
                const a = Math.min(1, p.vida * 2) * Math.min(1, (4 - p.vida) * 2)
                if (color) {
                    const [r0, g0, b0] = tinta(s)
                    ctx.strokeStyle = `rgba(${r0},${g0},${b0},${(0.85 * a).toFixed(3)})`
                } else ctx.strokeStyle = `rgba(255,255,255,${((dark ? 0.35 : 0.75) * a).toFixed(3)})`
                ctx.lineWidth = color ? 1.3 : 1
                ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(nx, ny); ctx.stroke()
                p.x = nx; p.y = ny
            }
            if (!quieto && visible) raf = requestAnimationFrame(frame)
        }
        t0 = performance.now() - 40
        frame(performance.now())
        return () => { cancelAnimationFrame(raf); io?.disconnect(); ctx.clearRect(0, 0, cv.width, cv.height) }
    }, [particulas, idx, paso, capa, W, H, dark, windColor, zona])

    const valorEn = (lat: number, lon: number) => {
        if (!idx || !paso) return null
        let best = -1,
            bd = Infinity
        for (let i = 0; i < idx.lat.length; i++) {
            const d = (idx.lat[i] / 100 - lat) ** 2 + (idx.lon[i] / 100 - lon) ** 2
            if (d < bd) {
                bd = d
                best = i
            }
        }
        if (best < 0 || bd > 0.15) return null
        if (capa === "temp") return paso.temp[best] == null ? null : `${Math.round(uT(paso.temp[best]! / 10))}°`
        if (capa === "lluvia") return paso.rain[best] == null || paso.rain[best]! < 1 ? null : uR(paso.rain[best]! / 10)
        return paso.wind[best] == null ? null : String(uV(paso.wind[best]!))
    }
    // Pocas ciudades, para que el mapa respire (las isotermas ya dan la temperatura)
    const etiquetas = useMemo(() => CIUDADES.filter(([n, la, lo]) => PRINCIPALES.has(n) && lo >= lo0 && lo <= lo1 && la >= la0 && la <= la1), [zona])

    const fmtPaso = (s: string) => new Intl.DateTimeFormat(t("es-ES", "en-GB"), { timeZone: "Europe/Madrid", weekday: "short", day: "numeric" }).format(new Date(s)).replace(".", "")
    const fmtHora = (s: string) => new Intl.DateTimeFormat(t("es-ES", "en-GB"), { timeZone: "Europe/Madrid", hour: "2-digit", minute: "2-digit" }).format(new Date(s))
    const fmtDiaCorto = (s: string) => new Intl.DateTimeFormat(t("es-ES", "en-GB"), { timeZone: "Europe/Madrid", weekday: "narrow" }).format(new Date(s))
    const leyenda =
        capa === "temp"
            ? `linear-gradient(90deg, ${[-5, 0, 6, 12, 18, 24, 30, 36].map((v) => tcol(v)).join(",")})`
            : capa === "lluvia"
              ? `linear-gradient(90deg, ${LLUVIA.map(([, c]) => c).join(",")})`
              : `linear-gradient(90deg, ${windStops(windColor).map(([, c]) => c).join(",")})`
    const marcas = capa === "temp" ? [-5, 12, 36].map((v) => `${Math.round(uT(v))}°`) : capa === "lluvia" ? [uR(0.1), uR(8), `${uR(30)} ${uRL()}`] : ["0", String(uV(35)), `${uV(75)} ${uVL()}`]

    // cristal: los mandos flotan encima del mapa
    const cristal = { background: dark ? "rgba(14,17,26,.55)" : "rgba(255,255,255,.62)", backdropFilter: "blur(14px) saturate(1.4)", WebkitBackdropFilter: "blur(14px) saturate(1.4)", boxShadow: `inset 0 0 0 1px ${dark ? "rgba(255,255,255,.08)" : "rgba(255,255,255,.7)"}, 0 6px 24px rgba(0,0,0,${dark ? 0.35 : 0.08})` }
    const mar = dark ? "radial-gradient(120% 90% at 30% 15%, #121a2c 0%, #0a0f1b 60%, #070a12 100%)" : "radial-gradient(120% 90% at 30% 15%, #f1f5f7 0%, #e1e9ef 60%, #d6e0e8 100%)"
    const puntos = `radial-gradient(${dark ? "rgba(255,255,255,.06)" : "rgba(30,50,80,.08)"} 1px, transparent 1.3px)`
    const capas: [Capa, string][] = [
        ["temp", t("Temperatura", "Temperature")],
        ["lluvia", t("Lluvia", "Rain")],
        ["viento", t("Viento", "Wind")],
    ]
    const ci = capas.findIndex(([id]) => id === capa)
    const nPasos = idx?.steps.length ?? 1
    const ahoraK = idx ? idx.steps.reduce((b, st, i) => (Math.abs(Date.parse(st) - Date.now()) < Math.abs(Date.parse(idx.steps[b]) - Date.now()) ? i : b), 0) : 0
    const cambiosDia = idx ? idx.steps.map((st, i) => [i, st] as [number, string]).filter(([i, st]) => i > 0 && fmtPaso(st) !== fmtPaso(idx.steps[i - 1])) : []

    return (
        <div ref={ref} style={{ width: "100%", color: ink, fontFamily: SANS }}>
            <div style={{ position: "relative", width: W, height: H, borderRadius: radius, overflow: "hidden", background: mar, isolation: "isolate" }}>
                <div style={{ position: "absolute", inset: 0, backgroundImage: puntos, backgroundSize: "14px 14px", pointerEvents: "none" }} />
                {err ? (
                    <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", fontSize: 13, color: soft }}>{t("No se pudo cargar el mapa.", "Couldn't load the map.")}</div>
                ) : (
                    <div style={{ position: "absolute", left: 0, top: 0, width: W, height: H }}>
                        <canvas ref={canvas} style={{ position: "absolute", inset: 0, width: W, height: H, display: "block" }} />
                        <canvas ref={antes} style={{ position: "absolute", inset: 0, width: W, height: H, display: "block", pointerEvents: "none", opacity: 0 }} />
                        {particulas && <canvas ref={aire} style={{ position: "absolute", inset: 0, width: W, height: H, display: "block", pointerEvents: "none" }} />}
                        {etiquetas.map(([n, la, lo]) => {
                            const v = valorEn(la, lo)
                            if (v == null) return null
                            const cc = capa === "temp" ? tcol(parseFloat(v)) : capa === "viento" ? wcol(parseFloat(v), windColor) : scale(LLUVIA, parseFloat(v))
                            return (
                                <span key={n} title={n} style={{ position: "absolute", left: px(lo), top: py(la), transform: "translate(-6px, -50%)", pointerEvents: "none", display: "flex", alignItems: "center", gap: 4, padding: "2px 7px 2px 4px", borderRadius: 999, ...cristal, boxShadow: cristal.boxShadow.replace(/0 6px 24px[^,]*$/, "0 2px 8px rgba(0,0,0,.08)") }}>
                                    <span style={{ width: 6, height: 6, borderRadius: 3, background: cc, boxShadow: `0 0 6px ${cc}` }} />
                                    <span style={{ fontFamily: SANS, fontWeight: 600, fontSize: 10.5, color: ink, letterSpacing: "-0.01em" }}>{v}</span>
                                </span>
                            )
                        })}
                        {!paso && <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", fontSize: 13, color: soft }}>{t("Cargando…", "Loading…")}</div>}
                    </div>
                )}

                {/* arriba: capas (con pastilla que se desliza) y la hora */}
                <div style={{ position: "absolute", top: 12, left: 12, right: 12, display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8, pointerEvents: "none" }}>
                    <div style={{ position: "relative", display: "flex", padding: 3, borderRadius: 999, pointerEvents: "auto", ...cristal }}>
                        <span style={{ position: "absolute", top: 3, bottom: 3, left: `calc(3px + ${ci} * (100% - 6px) / 3)`, width: "calc((100% - 6px) / 3)", borderRadius: 999, background: dark ? "rgba(255,255,255,.14)" : "#ffffff", boxShadow: "0 1px 4px rgba(0,0,0,.1)", transition: "left .35s cubic-bezier(.2,.8,.2,1)" }} />
                        {capas.map(([id, txt]) => (
                            <button key={id} type="button" onClick={() => setCapa(id)} aria-pressed={capa === id} style={{ position: "relative", flex: 1, minWidth: Math.min(92, (W - 140) / 3), padding: "6px 10px", border: "none", background: "transparent", color: capa === id ? ink : soft, fontFamily: SANS, fontSize: 12, fontWeight: capa === id ? 600 : 500, cursor: "pointer", whiteSpace: "nowrap" }}>
                                {txt}
                            </button>
                        ))}
                    </div>
                    {idx && (
                        <div style={{ padding: "5px 11px", borderRadius: 14, textAlign: "right", ...cristal }}>
                            <div style={{ fontFamily: MONO, fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase", color: soft }}>{fmtPaso(idx.steps[k])}</div>
                            <div style={{ fontSize: 17, fontWeight: 600, letterSpacing: "-0.02em", lineHeight: 1.1 }}>{fmtHora(idx.steps[k])}</div>
                        </div>
                    )}
                </div>

                {/* abajo: play, línea de tiempo y leyenda, en una barra de cristal */}
                {idx && (
                    <div style={{ position: "absolute", left: 12, right: 12, bottom: 12, padding: "10px 12px 9px", borderRadius: 18, ...cristal }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                            <button type="button" onClick={() => setPlay((v) => !v)} aria-label={play ? t("Pausa", "Pause") : t("Reproducir", "Play")} style={{ width: 32, height: 32, flex: "none", borderRadius: 16, border: "none", background: ink, color: bg, display: "grid", placeItems: "center", cursor: "pointer", boxShadow: "0 4px 12px rgba(0,0,0,.18)" }}>
                                <svg width="12" height="12" viewBox="0 0 12 12">{play ? <path d="M3 2h2v8H3zM7 2h2v8H7z" fill={bg} /> : <path d="M3.5 1.8l7 4.2-7 4.2z" fill={bg} />}</svg>
                            </button>
                            <div style={{ position: "relative", flex: 1, height: 30 }}>
                                {/* pista, días y «ahora» */}
                                <div style={{ position: "absolute", left: 0, right: 0, top: 9, height: 4, borderRadius: 2, background: rgba(ink, 0.12) }} />
                                <div style={{ position: "absolute", left: 0, top: 9, height: 4, borderRadius: 2, width: `${(k / Math.max(1, nPasos - 1)) * 100}%`, background: leyenda, transition: play ? "width .6s linear" : "width .2s" }} />
                                {cambiosDia.map(([i, st]) => (
                                    <span key={i} style={{ position: "absolute", left: `${(i / Math.max(1, nPasos - 1)) * 100}%`, top: 17, transform: "translateX(-50%)", fontFamily: MONO, fontSize: 8.5, color: soft, textTransform: "uppercase" }}>
                                        {fmtDiaCorto(st)}
                                    </span>
                                ))}
                                <span title={t("Ahora", "Now")} style={{ position: "absolute", left: `${(ahoraK / Math.max(1, nPasos - 1)) * 100}%`, top: 6, width: 2, height: 10, marginLeft: -1, borderRadius: 1, background: ink, opacity: 0.5 }} />
                                <span style={{ position: "absolute", left: `${(k / Math.max(1, nPasos - 1)) * 100}%`, top: 4, width: 14, height: 14, marginLeft: -7, borderRadius: 7, background: "#fff", boxShadow: `0 0 0 2px ${ink}, 0 2px 6px rgba(0,0,0,.25)`, transition: play ? "left .6s linear" : "left .2s", pointerEvents: "none" }} />
                                <input type="range" min={0} max={nPasos - 1} value={k} onChange={(e: any) => { setPlay(false); setK(Number(e.target.value)) }} aria-label={t("Hora", "Time")} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: 0, cursor: "pointer", margin: 0 }} />
                            </div>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
                            <span style={{ fontFamily: MONO, fontSize: 9, color: soft }}>{marcas[0]}</span>
                            <div style={{ flex: 1, height: 5, borderRadius: 3, background: leyenda, opacity: 0.9 }} />
                            <span style={{ fontFamily: MONO, fontSize: 9, color: soft }}>{marcas[2]}</span>
                        </div>
                    </div>
                )}
            </div>
            <div style={{ fontSize: 11, color: soft, marginTop: 8, padding: "0 4px" }}>{t("Media de 8 modelos cada 25 km · partículas: viento previsto.", "Average of 8 models every 25 km · particles: forecast wind.")}</div>
        </div>
    )
}

addPropertyControls(TiempoMapa, {
    capaInicial: { type: ControlType.Enum, title: "Capa", options: ["temp", "lluvia", "viento"], optionTitles: ["Temperatura", "Lluvia", "Viento"], defaultValue: "temp", displaySegmentedControl: true },
    zonaInicial: { type: ControlType.Enum, title: "Zona", options: ZONAS.map((z) => z.id), optionTitles: ZONAS.map((z) => z.es), defaultValue: "pf" },
    idioma: { type: ControlType.Enum, title: "Idioma", options: ["auto", "es", "en"], optionTitles: ["Auto", "Español", "English"], defaultValue: "auto", displaySegmentedControl: true },
    theme: { type: ControlType.Enum, title: "Tema", options: ["auto", "claro", "oscuro"], optionTitles: ["Auto", "Claro", "Oscuro"], defaultValue: "auto", displaySegmentedControl: true },
    tempCold: { type: ControlType.Color, title: "Temp. 0°", defaultValue: "#3d6bff" },
    tempMild: { type: ControlType.Color, title: "Temp. 12°", defaultValue: "#2ec7c0" },
    tempWarm: { type: ControlType.Color, title: "Temp. 22°", defaultValue: "#ffc93c" },
    tempHot: { type: ControlType.Color, title: "Temp. 32°", defaultValue: "#ff3d3d" },
    blur: { type: ControlType.Number, title: "Difuminado", min: 0, max: 3, step: 0.1, defaultValue: 1 },
    soloTierra: { type: ControlType.Boolean, title: "Solo tierra", defaultValue: true },
    bordes: { type: ControlType.Boolean, title: "Bordes", defaultValue: false },
    isotermas: { type: ControlType.Boolean, title: "Isotermas", defaultValue: true },
    particulas: { type: ControlType.Boolean, title: "Partículas viento", defaultValue: true },
    windColor: { type: ControlType.Color, title: "Color viento", defaultValue: "#e0248a" },
    radius: { type: ControlType.Number, title: "Esquinas", min: 0, max: 40, defaultValue: 24 },
    baseUrl: { type: ControlType.String, title: "URL de datos", defaultValue: BASE },
})
