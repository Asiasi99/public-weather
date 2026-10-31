/**
 * TiempoAcierto — una pieza del tiempo: ¿acierta la IA? Lo que previeron la IA y los modelos frente a lo que midió AEMET.
 * Usa la ciudad «global» (la que elige SelectorCiudad) o la que pongas en el panel. El tema claro/oscuro es común a todas las piezas.
 */
import { addPropertyControls, ControlType } from "framer"
import { BASE, Caja, t, SeccionAcierto, useTiempo, type Props } from "./TiempoNucleo.tsx"

/**
 * @framerSupportedLayoutWidth any
 * @framerSupportedLayoutHeight auto
 * @framerIntrinsicWidth 390
 */
export default function TiempoAcierto(props: Partial<Props>) {
    const v = useTiempo(props)
    return (
        <Caja v={v} radius={props.radius ?? 0}>
            {v.ready && (v.rec.station ? <SeccionAcierto v={v} /> : <div style={{ padding: 20, fontSize: 13, color: v.softColor }}>{t("Esta ciudad aún no tiene recuento de la IA.", "This place has no AI scorecard yet.")}</div>)}
        </Caja>
    )
}

addPropertyControls(TiempoAcierto, {
    cityId: { type: ControlType.String, title: "Ciudad", defaultValue: "global", placeholder: "global o madrid, sevilla…" },
    fondo: { type: ControlType.Enum, title: "Fondo", options: ["color", "cristal", "transparente"], optionTitles: ["Color", "Cristal", "Nada"], defaultValue: "color", displaySegmentedControl: true },
    idioma: { type: ControlType.Enum, title: "Idioma", options: ["auto", "es", "en"], optionTitles: ["Auto", "Español", "English"], defaultValue: "auto", displaySegmentedControl: true },
    theme: { type: ControlType.Enum, title: "Tema", options: ["auto", "claro", "oscuro"], optionTitles: ["Auto", "Claro", "Oscuro"], defaultValue: "auto", displaySegmentedControl: true },
    bgColor: { type: ControlType.Color, title: "Fondo", defaultValue: "#f5efe3", hidden: (p: any) => p.theme !== "claro" },
    inkColor: { type: ControlType.Color, title: "Texto", defaultValue: "#1d1a17", hidden: (p: any) => p.theme !== "claro" },
    softColor: { type: ControlType.Color, title: "Texto suave", defaultValue: "#8a7f72", hidden: (p: any) => p.theme !== "claro" },
    tempCold: { type: ControlType.Color, title: "Temp. 0°", defaultValue: "#3d6bff" },
    tempMild: { type: ControlType.Color, title: "Temp. 12°", defaultValue: "#2ec7c0" },
    tempWarm: { type: ControlType.Color, title: "Temp. 22°", defaultValue: "#ffc93c" },
    tempHot: { type: ControlType.Color, title: "Temp. 32°", defaultValue: "#ff3d3d" },
    radius: { type: ControlType.Number, title: "Esquinas", min: 0, max: 40, defaultValue: 0 },
    animate: { type: ControlType.Boolean, title: "Animaciones", defaultValue: true },
    baseUrl: { type: ControlType.String, title: "URL de datos", defaultValue: BASE },
})
