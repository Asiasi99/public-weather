/**
 * TiempoMapa — una pieza del tiempo: el mapa de temperatura, lluvia o viento con tus datos
 * (la media de los 8 modelos cada 25 km), con una barra para mover la hora.
 *
 * Datos: mapa/index.json (los puntos), mapa/<paso>.json (uno cada 3 h) y mapa/contornos.json (Natural Earth).
 * Es solo para mirar: tocarlo no cambia la ciudad de la página.
 */
import { addPropertyControls, ControlType } from "framer"
import { useEffect, useMemo, useRef, useState } from "react"
import { BASE, MONO, mix, rgba, SANS, scale, setIdioma, t, uR, uRL, uT, useAjustesWeb, useTema, uV, uVL } from "./TiempoNucleo.tsx"

type Indice = { res: number; lat: number[]; lon: number[]; steps: string[] }
type Paso = { t: string; temp: (number | null)[]; rain: (number | null)[]; wind: (number | null)[]; dir: (number | null)[] }
type Capa = "temp" | "lluvia" | "viento"
type CityInfo = { id: string; name: string; lat: number; lon: number }

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
const VIENTO: [number, string][] = [
    [0, "#5b8bd6"],
    [15, "#2ec7c0"],
    [30, "#ffc93c"],
    [50, "#ff7a3c"],
    [75, "#e0248a"],
]

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
        radius = 0,
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
    const [lo0, la0, lo1, la1] = zona.box
    const kx = W / (lo1 - lo0)
    const ky = kx / Math.cos((((la0 + la1) / 2) * Math.PI) / 180)
    const H = Math.round((la1 - la0) * ky)
    const px = (lon: number) => (lon - lo0) * kx
    const py = (lat: number) => (la1 - lat) * ky

    // Pintar en el lienzo: celdas difuminadas, contornos y flechas del viento
    useEffect(() => {
        const cv = canvas.current
        if (!cv || !idx || !paso) return
        const dpr = typeof window !== "undefined" ? Math.min(2, window.devicePixelRatio || 1) : 1
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
            } else if (capa === "lluvia") {
                const v = paso.rain[i]
                if (v == null) continue
                col = rainColor
                a = v < 1 ? 0 : Math.min(0.95, 0.25 + Math.sqrt(v / 10 / 6))
            } else {
                const v = paso.wind[i]
                if (v == null) continue
                col = scale(VIENTO, v)
                a = 0.88
            }
            const [cr, cg, cb] = col.startsWith("#") ? [parseInt(col.slice(1, 3), 16), parseInt(col.slice(3, 5), 16), parseInt(col.slice(5, 7), 16)] : [0, 0, 0]
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
                }
            for (const [p, a1, a2, a3, a4] of add) {
                rgbaArr.set([a1, a2, a3, a4], p * 4)
                has[p] = 1
            }
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
        ctx.save()
        // Solo sobre tierra: se recorta con los países (los anillos cerrados de los contornos)
        if (soloTierra && cont) {
            const tierra = new Path2D()
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
            ctx.clip(tierra)
        }
        ctx.imageSmoothingEnabled = true
        ctx.imageSmoothingQuality = "high"
        ctx.filter = blur > 0 ? `blur(${((r * kx) / 3) * blur}px)` : "none"
        // Cada píxel del lienzo pequeño, centrado en su punto de la rejilla
        ctx.drawImage(small, px(lo0 - 2.5 * r), py(la1 + 2.5 * r), nx * r * kx, ny * r * ky)
        ctx.restore()
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
        if (capa === "viento") {
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
    }, [idx, paso, cont, capa, zona, W, H, dark, blur, tempCold, tempMild, tempWarm, tempHot, rainColor, soloTierra, bordes])

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
    const etiquetas = useMemo(() => CIUDADES.filter(([, la, lo]) => lo >= lo0 && lo <= lo1 && la >= la0 && la <= la1), [zona])

    const fmtPaso = (s: string) =>
        new Intl.DateTimeFormat(t("es-ES", "en-GB"), { timeZone: "Europe/Madrid", weekday: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(s)).replace(".", "")
    const chip = (activo: boolean): { [k: string]: any } => ({ padding: "5px 11px", borderRadius: 999, border: `1px solid ${activo ? ink : rgba(ink, 0.15)}`, background: activo ? rgba(ink, 0.06) : "transparent", color: activo ? ink : soft, fontFamily: SANS, fontSize: 13, fontWeight: activo ? 500 : 400, cursor: "pointer" })
    const leyenda =
        capa === "temp"
            ? `linear-gradient(90deg, ${[-5, 0, 6, 12, 18, 24, 30, 36].map((v) => tcol(v)).join(",")})`
            : capa === "lluvia"
              ? `linear-gradient(90deg, ${rgba(rainColor, 0.25)}, ${rgba(rainColor, 0.95)})`
              : `linear-gradient(90deg, ${VIENTO.map(([, c]) => c).join(",")})`
    const marcas = capa === "temp" ? [-5, 12, 36].map((v) => `${Math.round(uT(v))}°`) : capa === "lluvia" ? [uR(0.1), uR(3), `${uR(10)} ${uRL()} / 3 h`] : ["0", String(uV(30)), `${uV(75)} ${uVL()}`]

    return (
        <div ref={ref} style={{ width: "100%", background: bg, color: ink, borderRadius: radius, overflow: "hidden", fontFamily: SANS, padding: "16px 0 18px" }}>
            <div style={{ display: "flex", gap: 8, padding: "0 20px", flexWrap: "wrap" }}>
                {(
                    [
                        ["temp", t("Temperatura", "Temperature")],
                        ["lluvia", t("Lluvia", "Rain")],
                        ["viento", t("Viento", "Wind")],
                    ] as [Capa, string][]
                ).map(([id, txt]) => (
                    <button key={id} type="button" onClick={() => setCapa(id)} style={chip(capa === id)}>
                        {txt}
                    </button>
                ))}
            </div>
            <div style={{ display: "flex", gap: 6, padding: "8px 20px 10px", flexWrap: "wrap" }}>
                {ZONAS.map((z) => (
                    <button key={z.id} type="button" onClick={() => setZona(z)} style={{ ...chip(zona.id === z.id), padding: "3px 9px", fontSize: 12 }}>
                        {t(z.es, z.en)}
                    </button>
                ))}
            </div>
            {err ? (
                <div style={{ padding: 20, fontSize: 13, color: soft }}>{t("No se pudo cargar el mapa.", "Couldn't load the map.")}</div>
            ) : (
                <div style={{ position: "relative", width: W, height: H }}>
                    <canvas ref={canvas} style={{ width: W, height: H, display: "block" }} />
                    {etiquetas.map(([n, la, lo]) => {
                        const v = valorEn(la, lo)
                        if (v == null) return null
                        return (
                            <span key={n} title={n} style={{ position: "absolute", left: px(lo) - 2, top: py(la) - 2, pointerEvents: "none", display: "flex", alignItems: "center", gap: 4 }}>
                                <span style={{ width: 4, height: 4, borderRadius: 2, background: ink }} />
                                <span style={{ fontFamily: SANS, fontWeight: 500, fontSize: 11, color: ink, textShadow: `0 0 3px ${bg}, 0 0 3px ${bg}, 0 0 2px ${bg}` }}>{v}</span>
                            </span>
                        )
                    })}
                    {!paso && <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", fontSize: 13, color: soft }}>{t("Cargando…", "Loading…")}</div>}
                </div>
            )}
            <div style={{ padding: "10px 20px 0" }}>
                <div style={{ height: 8, borderRadius: 4, background: leyenda }} />
                <div style={{ display: "flex", justifyContent: "space-between", fontFamily: MONO, fontSize: 10, color: soft, marginTop: 3 }}>
                    {marcas.map((m) => (
                        <span key={m}>{m}</span>
                    ))}
                </div>
                {idx && (
                    <>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12 }}>
                            <button type="button" onClick={() => setK((v) => Math.max(0, v - 1))} style={chip(false)} aria-label={t("Antes", "Earlier")}>
                                ◀
                            </button>
                            <button type="button" onClick={() => setPlay((v) => !v)} style={chip(play)} aria-label={play ? t("Pausa", "Pause") : t("Reproducir", "Play")}>
                                {play ? "❚❚" : "▶"}
                            </button>
                            <button type="button" onClick={() => setK((v) => Math.min(idx.steps.length - 1, v + 1))} style={chip(false)} aria-label={t("Después", "Later")}>
                                ▶▶
                            </button>
                            <span style={{ flex: 1, textAlign: "right", fontWeight: 500, fontSize: 15, textTransform: "capitalize" }}>{fmtPaso(idx.steps[k])}</span>
                        </div>
                        <input type="range" min={0} max={idx.steps.length - 1} value={k} onChange={(e: any) => setK(Number(e.target.value))} style={{ width: "100%", marginTop: 10, accentColor: ink }} aria-label={t("Hora", "Time")} />
                        <div style={{ fontSize: 12, color: soft, marginTop: 4 }}>{t("Media de 8 modelos cada 25 km.", "Average of 8 models every 25 km.")}</div>
                    </>
                )}
            </div>
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
    rainColor: { type: ControlType.Color, title: "Lluvia", defaultValue: "#3d6bff" },
    blur: { type: ControlType.Number, title: "Difuminado", min: 0, max: 3, step: 0.1, defaultValue: 1 },
    soloTierra: { type: ControlType.Boolean, title: "Solo tierra", defaultValue: true },
    bordes: { type: ControlType.Boolean, title: "Bordes", defaultValue: false },
    radius: { type: ControlType.Number, title: "Esquinas", min: 0, max: 40, defaultValue: 0 },
    baseUrl: { type: ControlType.String, title: "URL de datos", defaultValue: BASE },
})
