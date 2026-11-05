import { useLayoutEffect, useRef, useState } from 'react'
import { snapToRules } from '../lib/lines'

/**
 * Occupies a whole number of ruled lines, whatever its content measures, so
 * the text after a fraction, a diagram or a picture lands back on the lines.
 * Content is centred in the space it is given.
 */
export default function Snap({ children, className = '', as: Tag = 'div', min = 1 }) {
  const inner = useRef(null)
  const [h, setH] = useState(null)
  useLayoutEffect(() => {
    const el = inner.current
    if (!el) return undefined
    const measure = () => setH(snapToRules(el.getBoundingClientRect().height, min))
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [min])
  return (
    <Tag className={`flex flex-col justify-center ${className}`} style={{ height: h ?? 'auto' }}>
      <div ref={inner}>{children}</div>
    </Tag>
  )
}
