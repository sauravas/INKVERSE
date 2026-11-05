import { forwardRef, useImperativeHandle, useLayoutEffect, useRef } from 'react'
import { snapToRules } from '../lib/lines'

/**
 * A text box that is part of the page: ruled like the paper, written in the
 * handwriting face, and growing one ruled line at a time as you type or
 * dictate, so typed words sit on the lines exactly like written ones.
 *
 * Enter submits (when onSubmit is given); Shift+Enter starts a new line.
 */
const LinedInput = forwardRef(function LinedInput(
  { value, onChange, onSubmit, placeholder, minLines = 1, className = '', autoFocus,
    disabled, size = 'body', children },
  ref,
) {
  const area = useRef(null)
  useImperativeHandle(ref, () => ({
    focus: () => area.current?.focus(),
    el: () => area.current,
  }))

  useLayoutEffect(() => {
    const el = area.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${snapToRules(el.scrollHeight, minLines)}px`
  }, [value, minLines])

  return (
    <div className={`lined-wrap ${className}`}>
      <textarea
        ref={area} rows={1} value={value} disabled={disabled} autoFocus={autoFocus}
        placeholder={placeholder} spellCheck
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && onSubmit) {
            e.preventDefault()
            if (value.trim()) onSubmit()
          }
        }}
        className={`lined-input hand lined-${size}`}
      />
      {children && <div className="lined-actions">{children}</div>}
    </div>
  )
})

export default LinedInput
