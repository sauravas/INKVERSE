import { useDictation, voiceSupported } from '../lib/dictation'

/**
 * Tap to talk. The words appear in the box as they are recognised; a pause
 * (or a second tap) ends it. `onText(committed, partial)` and `onDone(text)`
 * come straight from useDictation.
 */
export default function MicButton({ onText, onDone, subjectId, size = 'md', title }) {
  const d = useDictation({ onText, onDone, subjectId })
  const on = d.state === 'listening' || d.state === 'starting'
  const px = size === 'sm' ? 'h-7 w-7 text-sm' : 'h-8 w-8 text-base'
  return (
    <span className="relative inline-flex items-center">
      <button type="button" onClick={d.toggle}
              title={d.error || (voiceSupported() ? (title || 'Ask by voice')
                : 'Voice needs http://localhost on this laptop')}
              className={`${px} inline-flex shrink-0 items-center justify-center rounded-full
                transition ${on ? 'bg-red-600 text-white' : d.error
                  ? 'bg-amber-100 text-amber-800' : 'bg-black/5 text-ink hover:bg-black/10'}`}
              style={on ? { boxShadow: `0 0 0 ${2 + Math.round(d.level * 10)}px rgba(220,38,38,0.25)` }
                : undefined}>
        {d.state === 'starting' ? '…' : on ? '■' : '🎤'}
      </button>
      {d.error && (
        <span className="absolute left-full top-1/2 z-20 ml-2 w-56 -translate-y-1/2 rounded
                         bg-amber-50 px-2 py-1 text-[11px] leading-4 text-amber-900 shadow
                         ring-1 ring-amber-300">
          {d.error}
        </span>
      )}
    </span>
  )
}
