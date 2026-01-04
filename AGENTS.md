# AGENTS.md

## Project overview
- Beatcutter is a browser-based music video editor built with React + TypeScript + Vite.
- App state lives mostly in `App.tsx` and is passed into UI components.
- Audio analysis and beat grid logic live in `services/audioUtils.ts`.
- Auto-sync logic lives in `services/syncEngine.ts`.

## Dev workflow
- Install: `npm install`
- Run dev server: `npm run dev` (if running locally, the dev server is probably already running)
- There are no automated tests configured in this repo.

## Code structure
- `App.tsx`: top-level state, playback engine, and wiring of components.
- `components/`: UI elements such as `Timeline`, `Inspector`, and `PreviewPlayer`.
- `services/`: audio decoding/analysis and auto-sync algorithms.
- `constants.ts`: shared constants like `DEFAULT_FPS`, `DEFAULT_ZOOM`, `BEATS_PER_BAR`.
- `types.ts`: shared TypeScript interfaces.

## Conventions
- Prefer TypeScript-typed props and pure functional components.
- Keep timeline rendering and scrolling logic inside `components/Timeline.tsx`.
- Keep audio and beat-grid manipulation inside `services/audioUtils.ts`.
- Keep clip scheduling/auto-sync inside `services/syncEngine.ts`.
- UI uses Tailwind utility classes; match existing patterns.
- Avoid adding new dependencies without a clear need.

## Behavior notes
- Playback time is tracked in milliseconds in `PlaybackState` and converted to seconds only for rendering.
- Beat grid values are seconds; keep conversions explicit.
- The timeline width scales with `zoom` (pixels per second).

## When making changes
- Preserve existing state flow in `App.tsx`; prefer passing callbacks to components.
- If you add new controls, wire them through `App.tsx` and keep `Inspector`/`Timeline` focused.
- Keep changes minimal and localized to the relevant module.
