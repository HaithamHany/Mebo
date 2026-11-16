/**
 * Which sound files ship in public/audio/ (names without .mp3), as listed by
 * Vite at build or dev-server start (vite.config.ts). Optional cues that are
 * not on this list are never requested.
 */
declare const __MEBO_AUDIO_FILES__: string[] | undefined

const shipped = new Set<string>(typeof __MEBO_AUDIO_FILES__ === 'undefined' ? [] : __MEBO_AUDIO_FILES__)

export const hasAudioFile = (name: string) => shipped.has(name)
