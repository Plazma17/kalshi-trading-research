import { useRef, useState, type ReactNode } from 'react'

/** Wraps a control; shows `label` as a tooltip only after hovering > 1 second. */
export default function Tip({
  label,
  children
}: {
  label: string
  children: ReactNode
}): JSX.Element {
  const [show, setShow] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  return (
    <span
      className="tipwrap"
      onMouseEnter={() => {
        timer.current = setTimeout(() => setShow(true), 1000)
      }}
      onMouseLeave={() => {
        clearTimeout(timer.current)
        setShow(false)
      }}
    >
      {children}
      {show && <span className="tip">{label}</span>}
    </span>
  )
}
