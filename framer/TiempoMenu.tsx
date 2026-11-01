/**
 * TiempoMenu — una pieza del tiempo: el menú de abajo, como en una app, con 3 botones:
 *   · Tiempo: sube al principio de la página;
 *   · Mapa: baja hasta el mapa (cualquier pieza TiempoMapa de la página);
 *   · Ajustes: abre una hoja desde abajo con las unidades, el idioma y el tema.
 * Se queda fijo abajo de la pantalla, en cristal. El botón activo se ilumina según lo que estás viendo.
 */
import { addPropertyControls, ControlType, RenderTarget } from "framer"
import { useEffect, useState } from "react"
import { createPortal } from "react-dom"
import { PanelAjustes } from "./TiempoAjustes.tsx"
import { rgba, SANS, t, useAjustesWeb, useTema, setIdioma } from "./TiempoNucleo.tsx"

type Props = { theme: "auto" | "claro" | "oscuro"; idioma: "auto" | "es" | "en" }
type Tab = "tiempo" | "mapa" | "ajustes"

const Icono = ({ tab, color }: { tab: Tab; color: string }) =>
    tab === "tiempo" ? (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="9" cy="9" r="3.2" />
            <path d="M9 2.8v1.4M2.8 9h1.4M4.6 4.6l1 1M13.4 4.6l-1 1" />
            <path d="M8.5 19.5h9a3.5 3.5 0 0 0 .4-7 5 5 0 0 0-9.5 1.3A2.9 2.9 0 0 0 8.5 19.5Z" fill={rgba(color, 0.08)} />
        </svg>
    ) : tab === "mapa" ? (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3.5 6.5 9 4l6 2.5 5.5-2.5v13.5L15 20l-6-2.5-5.5 2.5Z" fill={rgba(color, 0.08)} />
            <path d="M9 4v13.5M15 6.5V20" />
        </svg>
    ) : (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round">
            <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
            <circle cx="16" cy="7" r="2" fill={rgba(color, 0.08)} />
            <circle cx="10" cy="17" r="2" fill={rgba(color, 0.08)} />
        </svg>
    )

/**
 * @framerSupportedLayoutWidth any
 * @framerSupportedLayoutHeight fixed
 * @framerIntrinsicWidth 390
 * @framerIntrinsicHeight 92
 */
export default function TiempoMenu(props: Partial<Props>) {
    const { theme = "auto", idioma = "auto" } = props
    const ajw = useAjustesWeb()
    setIdioma(ajw.idioma !== "auto" ? ajw.idioma : idioma)
    const { dark } = useTema(theme)
    const ink = dark ? "#eef0f6" : "#1d1a17",
        soft = dark ? "#8b91a3" : "#8a7f72",
        bg = dark ? "#05060a" : "#f5efe3"
    const [activo, setActivo] = useState<Tab>("tiempo")
    const [hoja, setHoja] = useState(false)
    const enLienzo = typeof RenderTarget !== "undefined" && RenderTarget.current() === RenderTarget.canvas

    // ¿Se está viendo el mapa? Entonces se ilumina «Mapa»
    useEffect(() => {
        if (enLienzo || typeof document === "undefined" || typeof IntersectionObserver === "undefined") return
        const mapa = document.querySelector('[data-tiempo="mapa"]')
        if (!mapa) return
        const io = new IntersectionObserver(([e]) => setActivo((a) => (a === "ajustes" ? a : e.isIntersecting ? "mapa" : "tiempo")), { threshold: 0.35 })
        io.observe(mapa)
        return () => io.disconnect()
    }, [enLienzo])
    // con la hoja abierta, Escape la cierra
    useEffect(() => {
        if (!hoja || typeof window === "undefined") return
        const k = (e: KeyboardEvent) => e.key === "Escape" && setHoja(false)
        window.addEventListener("keydown", k)
        return () => window.removeEventListener("keydown", k)
    }, [hoja])

    const ir = (tab: Tab) => {
        if (tab === "ajustes") {
            setHoja(true)
            return
        }
        setActivo(tab)
        if (typeof window === "undefined") return
        if (tab === "tiempo") window.scrollTo({ top: 0, behavior: "smooth" })
        else document.querySelector('[data-tiempo="mapa"]')?.scrollIntoView({ behavior: "smooth", block: "start" })
    }
    const tabs: [Tab, string][] = [
        ["tiempo", t("Tiempo", "Weather")],
        ["mapa", t("Mapa", "Map")],
        ["ajustes", t("Ajustes", "Settings")],
    ]
    const sel = hoja ? "ajustes" : activo
    const idx = tabs.findIndex(([k]) => k === sel)
    const cristal = { background: dark ? "rgba(18,21,32,.62)" : "rgba(255,255,255,.66)", backdropFilter: "blur(18px) saturate(1.5)", WebkitBackdropFilter: "blur(18px) saturate(1.5)", boxShadow: `inset 0 0 0 1px ${dark ? "rgba(255,255,255,.08)" : "rgba(255,255,255,.8)"}, 0 10px 34px rgba(0,0,0,${dark ? 0.45 : 0.14})` }

    const hojaUI = (
        <div style={{ position: "fixed", inset: 0, zIndex: 1000, pointerEvents: hoja ? "auto" : "none" }}>
            <div onClick={() => setHoja(false)} style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,.28)", opacity: hoja ? 1 : 0, transition: "opacity .3s" }} />
            <div
                role="dialog"
                aria-modal="true"
                aria-label={t("Ajustes", "Settings")}
                style={{ position: "absolute", left: 0, right: 0, bottom: 0, margin: "0 auto", maxWidth: 520, maxHeight: "86vh", overflowY: "auto", padding: "10px 20px 28px", borderRadius: "26px 26px 0 0", background: bg, color: ink, boxShadow: "0 -10px 40px rgba(0,0,0,.18)", transform: hoja ? "translateY(0)" : "translateY(105%)", transition: "transform .42s cubic-bezier(.2,.9,.2,1)" }}
            >
                <div style={{ width: 38, height: 5, borderRadius: 3, background: rgba(ink, 0.18), margin: "0 auto 10px" }} />
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontFamily: SANS, fontWeight: 600, fontSize: 20, letterSpacing: "-0.02em" }}>{t("Ajustes", "Settings")}</span>
                    <button type="button" onClick={() => setHoja(false)} style={{ border: "none", background: "transparent", color: ink, fontFamily: SANS, fontSize: 15, fontWeight: 600, cursor: "pointer", padding: 6 }}>
                        {t("Listo", "Done")}
                    </button>
                </div>
                <PanelAjustes theme={theme} />
            </div>
        </div>
    )

    return (
        <div style={{ position: "relative", width: "100%", height: "100%", display: "flex", alignItems: "flex-end", justifyContent: "center", paddingBottom: 18, pointerEvents: "none", fontFamily: SANS }}>
            <nav aria-label={t("Menú", "Menu")} style={{ position: "relative", display: "flex", padding: 5, borderRadius: 999, pointerEvents: "auto", ...cristal }}>
                {/* la pastilla que marca el botón activo y se desliza */}
                <span style={{ position: "absolute", top: 5, bottom: 5, left: `calc(5px + ${idx} * 84px)`, width: 84, borderRadius: 999, background: dark ? "rgba(255,255,255,.12)" : "#ffffff", boxShadow: "0 2px 8px rgba(0,0,0,.08)", transition: "left .38s cubic-bezier(.2,.9,.2,1)" }} />
                {tabs.map(([k, txt]) => {
                    const on = k === sel
                    return (
                        <button key={k} type="button" onClick={() => ir(k)} aria-current={on ? "page" : undefined} style={{ position: "relative", width: 84, padding: "7px 0 6px", border: "none", background: "transparent", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 2, color: on ? ink : soft, transition: "color .25s" }}>
                            <span style={{ transition: "transform .3s cubic-bezier(.2,.9,.2,1)", transform: on ? "scale(1.08)" : "scale(1)" }}>
                                <Icono tab={k} color={on ? ink : soft} />
                            </span>
                            <span style={{ fontSize: 10.5, fontWeight: on ? 600 : 500, letterSpacing: "0.01em" }}>{txt}</span>
                        </button>
                    )
                })}
            </nav>
            {!enLienzo && typeof document !== "undefined" ? createPortal(hojaUI, document.body) : null}
        </div>
    )
}

addPropertyControls(TiempoMenu, {
    idioma: { type: ControlType.Enum, title: "Idioma", options: ["auto", "es", "en"], optionTitles: ["Auto", "Español", "English"], defaultValue: "auto", displaySegmentedControl: true },
    theme: { type: ControlType.Enum, title: "Tema", options: ["auto", "claro", "oscuro"], optionTitles: ["Auto", "Claro", "Oscuro"], defaultValue: "auto", displaySegmentedControl: true },
})
