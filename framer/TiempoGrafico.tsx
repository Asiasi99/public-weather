/**
 * TiempoGrafico — una pieza del tiempo: la tira de los próximos días (temperatura, viento, lluvia, nubes, sol e IA).
 * Usa la ciudad «global» (la que elige SelectorCiudad) o la que pongas en el panel. El tema claro/oscuro es común a todas las piezas.
 */
import { addPropertyControls, ControlType } from "framer"
import { BASE, Caja, SeccionGrafico, useTiempo, type Props } from "./TiempoNucleo.tsx"

/**
 * @framerSupportedLayoutWidth any
 * @framerSupportedLayoutHeight auto
 * @framerIntrinsicWidth 390
 */
export default function TiempoGrafico(props: Partial<Props>) {
    const v = useTiempo(props)
    return (
        <Caja v={v} radius={props.radius ?? 0}>
            {v.ready && <SeccionGrafico v={v} />}
        </Caja>
    )
}

addPropertyControls(TiempoGrafico, {
    cityId: { type: ControlType.String, title: "Ciudad", defaultValue: "global", placeholder: "global o madrid, sevilla…" },
    fondo: { type: ControlType.Enum, title: "Fondo", options: ["color", "cristal", "transparente"], optionTitles: ["Color", "Cristal", "Nada"], defaultValue: "color", displaySegmentedControl: true },
    days: { type: ControlType.Number, title: "Días", min: 1, max: 7, step: 1, defaultValue: 7 },
    hourHeight: { type: ControlType.Number, title: "Alto por hora", min: 4, max: 24, step: 1, unit: " px", defaultValue: 9 },
    showWind: { type: ControlType.Boolean, title: "Viento", defaultValue: true },
    showRain: { type: ControlType.Boolean, title: "Lluvia", defaultValue: true },
    showFeels: { type: ControlType.Boolean, title: "Sensación térmica", defaultValue: true },
    showAlerts: { type: ControlType.Boolean, title: "Avisos", defaultValue: true },
    showAI: { type: ControlType.Boolean, title: "Etiquetas IA", defaultValue: true },
    showSpread: { type: ControlType.Boolean, title: "Corrección IA por día", defaultValue: true },
    showClouds: { type: ControlType.Boolean, title: "Nubes", defaultValue: true },
    showModels: { type: ControlType.Boolean, title: "Botón modelos", defaultValue: true },
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
    windMax: { type: ControlType.Number, title: "Escala viento", min: 20, max: 120, step: 5, unit: " km/h", defaultValue: 50, hidden: (p: any) => !p.showWind },
    rainColor: { type: ControlType.Color, title: "Lluvia", defaultValue: "#8fb8f2", hidden: (p: any) => !p.showRain },
    cloudColor: { type: ControlType.Color, title: "Nubes", defaultValue: "#aebbd9", hidden: (p: any) => !p.showClouds || p.theme === "oscuro" },
    lineWidth: { type: ControlType.Number, title: "Grosor curva", min: 0.5, max: 6, step: 0.1, defaultValue: 1.6 },
    blur: { type: ControlType.Number, title: "Difuminado", min: 0, max: 24, step: 1, defaultValue: 10 },
    texture: { type: ControlType.Enum, title: "Textura", options: ["puntos", "grano", "nada"], optionTitles: ["Puntos", "Grano", "Nada"], defaultValue: "puntos", displaySegmentedControl: true },
    grain: { type: ControlType.Number, title: "Fuerza textura", min: 0, max: 1, step: 0.05, defaultValue: 0.6, hidden: (p: any) => p.texture === "nada" },
    radius: { type: ControlType.Number, title: "Esquinas", min: 0, max: 40, defaultValue: 0 },
    animate: { type: ControlType.Boolean, title: "Animaciones", defaultValue: true },
    baseUrl: { type: ControlType.String, title: "URL de datos", defaultValue: BASE },
})
