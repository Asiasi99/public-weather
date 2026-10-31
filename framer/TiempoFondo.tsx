/**
 * TiempoFondo — una pieza del tiempo: el cielo animado (viento, nubes, lluvia, calor) para poner DETRÁS
 * de la página, a sangre, más grande que las tarjetas. Usa la misma ciudad que las demás piezas.
 *
 * Cómo usarlo: ponlo como primera capa de la página (posición absoluta, arriba, ancho completo) y en
 * TiempoAhora elige «Cielo: Fuera» para que la tarjeta sea transparente y se vea este cielo detrás.
 */
import { addPropertyControls, ControlType } from "framer"
import { CieloFondo, useTiempo, type Props } from "./TiempoNucleo.tsx"

/**
 * @framerSupportedLayoutWidth any
 * @framerSupportedLayoutHeight any
 * @framerIntrinsicWidth 390
 * @framerIntrinsicHeight 700
 */
export default function TiempoFondo(props: Partial<Props> & { fundido?: number }) {
    const v = useTiempo(props)
    return (
        <div ref={v.ref} style={{ position: "relative", width: "100%", height: "100%", overflow: "hidden", pointerEvents: "none", ...(props as any).style }}>
            {v.ready && <CieloFondo v={v} fundido={props.fundido ?? 35} />}
        </div>
    )
}

addPropertyControls(TiempoFondo, {
    cityId: { type: ControlType.String, title: "Ciudad", defaultValue: "global", placeholder: "global o madrid, sevilla…" },
    fundido: { type: ControlType.Number, title: "Fundido abajo", min: 0, max: 80, step: 5, unit: "%", defaultValue: 35 },
    sphereBlur: { type: ControlType.Number, title: "Difuminado nubes", min: 0, max: 12, step: 0.5, defaultValue: 4 },
    windColor: { type: ControlType.Color, title: "Color viento", defaultValue: "#e0248a" },
    theme: { type: ControlType.Enum, title: "Tema", options: ["auto", "claro", "oscuro"], optionTitles: ["Auto", "Claro", "Oscuro"], defaultValue: "auto", displaySegmentedControl: true },
})
