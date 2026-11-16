# Audio credits

The one music track is by **Kevin MacLeod** (incompetech.com), licensed
**Creative Commons Attribution 4.0**. Free to use commercially — including in a
monetised YouTube video — provided the attribution below appears somewhere the
audience can see it (a description box is fine).

| File | Track | Used for |
|---|---|---|
| `work.mp3` | *Mechanolith* | Rises while a tool is running |

There is no intro music. The JARVIS start-up tracks (`boot-music.mp3`,
*Impact Prelude*, and `ambient.mp3`, *Ossuary 6 – Air*) were removed: MeBo's
activation is a soft synthesised chime followed by its spoken introduction.

## Attribution to paste into a video description

```
Music by Kevin MacLeod (incompetech.com)
  "Mechanolith"       — Licensed under Creative Commons: By Attribution 4.0
http://creativecommons.org/licenses/by/4.0/
```

## Replacing it

Drop in any MP3 named `work.mp3` and it takes over — nothing in the code
references the track name. Other sources worth a look: incompetech.com (same
licence), Pixabay Music (CC0, no attribution at all), and the YouTube Audio
Library.

The short interface sounds — the activation chime, wake pips, tool ticks, the
completion chime — are not files. They're synthesised in Web Audio in
`src/lib/sfx.ts`, so there's nothing to download and nothing to credit. Drop
`boot.mp3`, `wake.mp3`, `listen.mp3`, `tool.mp3`, `done.mp3` or `error.mp3` in
here to override any of them.
