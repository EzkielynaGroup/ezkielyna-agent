import { type ComponentProps } from "solid-js"

import { lionDataURI } from "./ezkielyna-mark"

// Ezkielyna Agent: the OpenCode block marks are replaced by the Ezkielyna lion. Same exports and props.
export const Mark = (props: { class?: string }) => {
  return (
    <svg
      data-component="logo-mark"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 20 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <image href={lionDataURI} width="20" height="20" />
    </svg>
  )
}

export const Splash = (props: Pick<ComponentProps<"svg">, "ref" | "class">) => {
  return (
    <svg
      ref={props.ref}
      data-component="logo-splash"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 100 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <image href={lionDataURI} width="100" height="100" />
    </svg>
  )
}

export const Logo = (props: { class?: string }) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 234 42"
      fill="none"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <image href={lionDataURI} x="0" y="0" width="42" height="42" />
      <text
        x="52"
        y="31"
        font-family="'Source Serif 4', Georgia, serif"
        font-size="28"
        font-weight="600"
        letter-spacing="0.5"
        fill="var(--icon-strong-base)"
      >
        ezkielyna
      </text>
    </svg>
  )
}
