/**
 * TiempoDatos — una pieza del tiempo: lo de ahora en una línea (sensación, lluvia, humedad y viento).
 * Usa la ciudad «global» (la que elige SelectorCiudad) o la que pongas en el panel. El tema claro/oscuro es común a todas las piezas.
 */
import { addPropertyControls, ControlType } from "framer"
import { BASE, Caja, SeccionDatos, useTiempo, type Props } from "./TiempoNucleo.tsx"

/**
 * @framerSupportedLayoutWidth any
 * @framerSupportedLayoutHeight auto
 * @framerIntrinsicWidth 390
 */
export default function TiempoDatos(props: Partial<Props>) {
    const v = useTiempo(props)
    return (
        <Caja v={v} radius={props.radius ?? 0}>
            {v.ready && <SeccionDatos v={v} />}
        </Caja>
    )
}

addPropertyControls(TiempoDatos, {
    cityId: { type: ControlType.String, title: "Ciudad", defaultValue: "global", placeholder: "global o madrid, sevilla…" },
    fondo: { type: ControlType.Enum, title: "Fondo", options: ["color", "cristal", "transparente"], optionTitles: ["Color", "Cristal", "Nada"], defaultValue: "color", displaySegmentedControl: true },
    showFeels: { type: ControlType.Boolean, title: "Sensación térmica", defaultValue: true },
    idioma: { type: ControlType.Enum, title: "Idioma", options: ["auto", "es", "en"], optionTitles: ["Auto", "Español", "English"], defaultValue: "auto", displaySegmentedControl: true },
    theme: { type: ControlType.Enum, title: "Tema", options: ["auto", "claro", "oscuro"], optionTitles: ["Auto", "Claro", "Oscuro"], defaultValue: "auto", displaySegmentedControl: true },
    bgColor: { type: ControlType.Color, title: "Fondo", defaultValue: "#f5efe3", hidden: (p: any) => p.theme !== "claro" },
    inkColor: { type: ControlType.Color, title: "Texto", defaultValue: "#1d1a17", hidden: (p: any) => p.theme !== "claro" },
    softColor: { type: ControlType.Color, title: "Texto suave", defaultValue: "#8a7f72", hidden: (p: any) => p.theme !== "claro" },
    tempCold: { type: ControlType.Color, title: "Temp. 0°", defaultValue: "#3d6bff" },
    tempMild: { type: ControlType.Color, title: "Temp. 12°", defaultValue: "#2ec7c0" },
    tempWarm: { type: ControlType.Color, title: "Temp. 22°", defaultValue: "#ffc93c" },
    tempHot: { type: ControlType.Color, title: "Temp. 32°", defaultValue: "#ff3d3d" },
    windColor: { type: ControlType.Color, title: "Viento", defaultValue: "#e0248a", hidden: (p: any) => !p.showWind },
    rainColor: { type: ControlType.Color, title: "Lluvia", defaultValue: "#8fb8f2", hidden: (p: any) => !p.showRain },
    radius: { type: ControlType.Number, title: "Esquinas", min: 0, max: 40, defaultValue: 0 },
    animate: { type: ControlType.Boolean, title: "Animaciones", defaultValue: true },
    baseUrl: { type: ControlType.String, title: "URL de datos", defaultValue: BASE },
})
