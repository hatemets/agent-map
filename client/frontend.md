# Frontend Rules

**Applies to:** `client/**`.

## Architecture

- This is static HTML, CSS, and vanilla browser JavaScript. No framework,
  transpiler, build step, or component abstraction is hiding off-screen.
- `app.js` receives a canonical `RunGraph` from the server and renders all
  views from it. It must not parse transcripts, infer parentage, or recalculate
  token totals/costs.
- SVG is the graph canvas; CSS owns presentation, JavaScript owns structure,
  state, and interaction. Keep those boundaries clean.
- Preserve the observability contract: all views represent the same agents,
  hierarchy, status, timing, tokens, and cost. If a field is unclear, expose
  uncertainty rather than polishing it into a lie.

## State and Live Data

- Keep one explicit client state object. State transitions such as changing
  session, view, selected agent, or SSE connection must clean up the previous
  connection/listener before creating the next one.
- Treat API and SSE responses as fallible. Show a visible failed/empty state;
  do not render an empty graph as though the selected session contained no
  agents.
- Never use stale selected-agent data after a live graph update. If the agent
  disappeared or changed identity, close or refresh the drawer deliberately.
- Render functions should be deterministic from the graph and current UI state.
  Do not maintain a second, mutable hierarchy or metric cache in a view.
- The local dev page polls its static-source version and reloads after an edit.
  Keep that probe best-effort and separate from live-run connection status.
- Escape untrusted transcript-derived text by assigning it through `textContent`
  or SVG text nodes. Never interpolate prompts, project names, agent names, or
  activity into `innerHTML`.

## SVG and Interaction

- Use the `el()` SVG helper for SVG element construction. Keep rendering code
  structural; semantic visual styling belongs in `style.css`.
- `orderedAgents()` is the shared visual spine. Tree, timeline, and sequence
  must use it so ordering does not disagree between views.
- Maintain usable pan/zoom and the fit action after changing dimensions or
  view layouts. Do not let a large run become an invisible postage stamp.
- A dashed/inferred edge and unpriced cost are meaningful diagnostic states;
  preserve their visual distinction and explanatory copy.
- Use `requestAnimationFrame` for high-frequency pointer or resize work when
  needed. Do not trigger a full graph rebuild on every pointer event.

## Accessibility

- Keep native `<button>` elements for actions. Give icon-only controls an
  `aria-label` and descriptive title where useful.
- Tabs need correct `role="tablist"` / `role="tab"` semantics, a discernible
  selected state, keyboard operation, and visible focus. Preserve focus after
  an interaction that opens or closes the drawer.
- Never convey running, stalled, failed, inferred, or selected state by color
  alone. Pair color with text, shape, label, or border treatment.
- The UI must work at narrow widths and with keyboard navigation. A second
  monitor is nice, not an accessibility requirement.
- Respect `hidden` explicitly in CSS when a stronger display rule would
  otherwise override the browser's `[hidden] { display: none }` behavior.

## Design System

- The established direction is a dense, calm instrument panel: warm near-black
  surfaces, self-hosted Inter for all UI copy, monospaced telemetry, and
  restrained signal colors. Inter is bundled under the SIL Open Font License;
  do not replace it with Apple system fonts or a remote font request.
- Use the existing CSS custom properties for colors, typography, rail/drawer
  dimensions, and status/model colors. Add a token before scattering a repeated
  literal.
- Reserve bright colors for model identity and run status. Layout, labels, and
  contrast must still make the state understandable without color perception.
- Use tabular numerals and the existing formatting helpers for metrics. A
  different rounding rule per view makes operational data needlessly suspect.
- Prefer CSS media queries and layout primitives over JavaScript viewport
  branching. Check overflow, drawer behavior, and hit targets on narrow views.

## Verification

For a meaningful client change, run `npm test`, start the server, and manually
exercise the changed behavior at desktop and narrow widths. At minimum verify:

1. session selection and replacement of the existing live connection;
2. all three views render the same run without omitted nodes;
3. keyboard focus and every changed button/tab/drawer control;
4. inferred, running/stalled, unknown-cost, empty, and API-error surfaces if
   the change can affect them;
5. pan, zoom, and fit after any SVG layout change.

Do not claim visual completion based solely on a JavaScript test. The browser is
where SVG clipping, CSS cascade, focus behavior, and responsive layout go to
commit crimes.
