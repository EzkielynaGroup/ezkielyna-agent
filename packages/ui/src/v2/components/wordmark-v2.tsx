import { type ComponentProps } from "solid-js"
import { lionDataURI } from "../../components/ezkielyna-mark"

// Ezkielyna Agent: lion + wordmark replace the OpenCode block wordmark (same export and props).
export function WordmarkV2(props: Pick<ComponentProps<"svg">, "class">) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 720 129"
      fill="none"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <image href={lionDataURI} x="40" y="0" width="129" height="129" opacity="0.95" />
      <text
        x="190"
        y="94"
        font-family="'Source Serif 4', Georgia, serif"
        font-size="96"
        font-weight="600"
        letter-spacing="2"
        fill="currentColor"
        opacity="0.6"
      >
        ezkielyna
      </text>
    </svg>
  )
}
