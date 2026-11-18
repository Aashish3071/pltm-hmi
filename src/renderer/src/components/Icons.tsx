/** Line icons (24 × 24, stroke = currentColor). */
const PATHS: Record<string, string> = {
  start: 'M12 3v8 M6.3 6.3a8 8 0 1 0 11.4 0',
  stop: 'M7 7h10v10H7z',
  resume: 'M8 5l11 7-11 7z',
  reset: 'M4 12a8 8 0 1 0 2.6-5.9 M4 4v4.5h4.5',
  homing: 'M3 11l9-7 9 7 M5 10v10h14V10 M10 20v-6h4v6',
  report: 'M6 3h9l4 4v14H6z M14 3v5h5 M9 13h7 M9 17h7',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  logout: 'M15 4h4v16h-4 M10 8l-4 4 4 4 M6 12h10',
  close: 'M6 6l12 12 M18 6L6 18',
  bell: 'M18 16v-5a6 6 0 1 0-12 0v5l-2 2h16z M10 21h4',
  up: 'M12 19V5 M6 11l6-6 6 6',
  down: 'M12 5v14 M6 13l6 6 6-6',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M4 21a8 8 0 0 1 16 0',
  lock: 'M6 11h12v10H6z M8 11V7a4 4 0 0 1 8 0v4',
  gauge: 'M12 14l4-4 M3.5 18a9 9 0 1 1 17 0',
  plug: 'M9 2v6 M15 2v6 M6 8h12v4a6 6 0 0 1-12 0z M12 18v4'
}

export type IconName = keyof typeof PATHS

export function Icon({ name, size = 22, stroke = 2 }: { name: IconName; size?: number; stroke?: number }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  )
}
