/**
 * TiempoAjustes — una pieza del tiempo: el botón ⚙︎ que abre los ajustes del visitante.
 *
 * Unidades (°C/°F, viento, lluvia), idioma y tema. Se guardan en el navegador del visitante y cambian
 * todas las piezas de la página a la vez (Ahora, Datos, Gráfico, ¿Acierta la IA?, Mapa…).
 */
import { addPropertyControls, ControlType } from "framer"
import { useState } from "react"
import { cambiarAjustes, MONO, rgba, SANS, setTemaManual, t, useAjustesWeb, useTema, type AjustesWeb } from "./TiempoNucleo.tsx"

type Props = { theme: "auto" | "claro" | "oscuro"; align: "izquierda" | "derecha"; abierto: boolean }

/**
 * @framerSupportedLayoutWidth any
 * @framerSupportedLayoutHeight auto
 * @framerIntrinsicWidth 390
 */
export default function TiempoAjustes(props: Partial<Props>) {
    const { theme = "auto", align = "derecha", abierto = false } = props
    const aj = useAjustesWeb()
    const { dark, manual } = useTema(theme)
    const [open, setOpen] = useState(abierto)
    const ink = dark ? "#eef0f6" : "#1d1a17",
        soft = dark ? "#7d8396" : "#8a7f72",
        bg = dark ? "#05060a" : "#f5efe3"

    // Botones en fila para elegir una opción
    const Opciones = <T extends string>({ valor, opciones, cambiar }: { valor: T; opciones: [T, string][]; cambiar: (v: T) => void }) => (
        <div style={{ display: "flex", gap: 3, padding: 3, borderRadius: 12, background: rgba(ink, 0.06) }}>
            {opciones.map(([v, etiqueta]) => {
                const activo = v === valor
                return (
                    <button
                        key={v}
                        type="button"
                        aria-pressed={activo}
                        onClick={() => cambiar(v)}
                        style={{ flex: 1, padding: "7px 4px", borderRadius: 9, border: "none", cursor: "pointer", background: activo ? bg : "transparent", boxShadow: activo ? "0 1px 3px rgba(0,0,0,.08)" : "none", color: activo ? ink : soft, fontFamily: SANS, fontSize: 13, fontWeight: activo ? 500 : 400 }}
                    >
                        {etiqueta}
                    </button>
                )
            })}
        </div>
    )
    const fila = (titulo: string, cont: any) => (
        <div style={{ marginTop: 14 }}>
            <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: soft, marginBottom: 6 }}>{titulo}</div>
            {cont}
        </div>
    )
    const set = <K extends keyof AjustesWeb>(k: K) => (v: AjustesWeb[K]) => cambiarAjustes({ [k]: v } as Partial<AjustesWeb>)
    const modo = theme !== "auto" ? theme : manual ?? "auto"

    return (
        <div style={{ width: "100%", fontFamily: SANS, color: ink, display: "flex", flexDirection: "column", alignItems: align === "derecha" ? "flex-end" : "flex-start" }}>
            <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                aria-expanded={open}
                aria-label={t("Ajustes", "Settings")}
                style={{ width: 36, height: 36, borderRadius: 18, border: `1px solid ${rgba(ink, 0.14)}`, background: rgba(bg, 0.6), backdropFilter: "blur(10px)", WebkitBackdropFilter: "blur(10px)", display: "grid", placeItems: "center", cursor: "pointer", padding: 0 }}
            >
                <svg width="16" height="16" viewBox="0 0 16 16" style={{ transition: "transform .4s", transform: open ? "rotate(60deg)" : "none" }}>
                    <circle cx="8" cy="8" r="2.4" stroke={ink} strokeWidth="1.3" fill="none" />
                    <path d="M8 1.6v1.8M8 12.6v1.8M1.6 8h1.8M12.6 8h1.8M3.5 3.5l1.3 1.3M11.2 11.2l1.3 1.3M3.5 12.5l1.3-1.3M11.2 4.8l1.3-1.3" stroke={ink} strokeWidth="1.3" strokeLinecap="round" />
                </svg>
            </button>
            {open && (
                <div style={{ width: "100%", marginTop: 10, padding: "6px 16px 16px", borderRadius: 16, background: bg, border: `1px solid ${rgba(ink, 0.1)}`, boxShadow: "0 8px 30px rgba(0,0,0,.08)" }}>
                    {fila(t("Temperatura", "Temperature"), <Opciones valor={aj.temp} opciones={[["C", "°C"], ["F", "°F"]]} cambiar={set("temp")} />)}
                    {fila(t("Viento", "Wind"), <Opciones valor={aj.viento} opciones={[["kmh", "km/h"], ["mph", "mph"], ["ms", "m/s"], ["kn", t("nudos", "knots")]]} cambiar={set("viento")} />)}
                    {fila(t("Lluvia", "Rain"), <Opciones valor={aj.lluvia} opciones={[["mm", "mm"], ["in", t("pulgadas", "inches")]]} cambiar={set("lluvia")} />)}
                    {fila(t("Idioma", "Language"), <Opciones valor={aj.idioma} opciones={[["auto", t("Automático", "Automatic")], ["es", "Español"], ["en", "English"]]} cambiar={set("idioma")} />)}
                    {theme === "auto" &&
                        fila(
                            t("Tema", "Appearance"),
                            <Opciones<"auto" | "claro" | "oscuro">
                                valor={modo}
                                opciones={[
                                    ["auto", t("Automático", "Automatic")],
                                    ["claro", t("Claro", "Light")],
                                    ["oscuro", t("Oscuro", "Dark")],
                                ]}
                                cambiar={(v) => setTemaManual(v === "auto" ? null : v)}
                            />
                        )}
                    <div style={{ fontSize: 12, lineHeight: 1.45, color: soft, marginTop: 14 }}>
                        {t("Se guarda en este navegador. Fuentes: AEMET, ECMWF, DWD, NOAA, Météo-France, Met Office, ECCC; lugares: GeoNames; mapa: Natural Earth.", "Saved in this browser. Sources: AEMET, ECMWF, DWD, NOAA, Météo-France, Met Office, ECCC; places: GeoNames; map: Natural Earth.")}
                    </div>
                </div>
            )}
        </div>
    )
}

addPropertyControls(TiempoAjustes, {
    align: { type: ControlType.Enum, title: "Botón", options: ["izquierda", "derecha"], optionTitles: ["Izquierda", "Derecha"], defaultValue: "derecha", displaySegmentedControl: true },
    abierto: { type: ControlType.Boolean, title: "Abierto al cargar", defaultValue: false },
    theme: { type: ControlType.Enum, title: "Tema", options: ["auto", "claro", "oscuro"], optionTitles: ["Auto", "Claro", "Oscuro"], defaultValue: "auto", displaySegmentedControl: true },
})
