# HowMuchAh — Player Home Design Brief

## Job and audience

Players open the mobile home around Friday badminton to check in, see who else is coming, and understand their own monthly shuttle contribution. Organisers use the same home and keep session check-in first, with management tasks available after it.

## Outcome and product truth

Make the current session and its check-in state obvious, then show the player's own monthly balance and the group's attendance. Check-in opens Friday at 7 PM and closes Saturday at 5 PM. A player can undo their own check-in before the cutoff; an organiser handles corrections after it. Each attended session keeps the fee that applied when it was recorded. Players see group attendance and their own finances; organisers can see and manage all records.

## Direction contract

THESIS: Use the familiar mobile dashboard arrangement for the weekly badminton task: current session first, the player's bill next, and group attendance below. Keep the app direct and conventional.

OWN-WORLD: Keep the familiar dashboard layout, using the layered-record sketch's colors: white and pale gray surfaces, charcoal text, magenta for the primary action and open state, and green only for confirmed attendance. Use a system sans-serif scale, clear spacing, and familiar mobile navigation and controls. Color must not carry meaning without text.

STORY: Players see whether Friday check-in is open, whether they have checked in, and when the window closes. They can take or undo their own action while the window is open, review their own monthly balance, and scan group attendance without seeing other players' finances.

FIRST VIEWPORT: A compact app bar and date lead into a Friday session card with the open/closed state, 7 PM start, Saturday 5 PM cutoff, and a full-width check-in action. Put the player's monthly balance and per-session fee below, then a concise attendance list. Keep this order for organisers; put approvals, fee changes, guest records, corrections, and payment entry in a clearly labelled management area.

FORM: The user chose the category-standard dashboard on the decision board, over the two more styled options. The selected first-screen composition is [the simple dashboard sketch](.impeccable/mocks/decision/clean-dashboard.html). Seed reference: `seed:d700024586d1c3cb`. Use Google Calendar, Apple Wallet, and Splitwise as the polish references.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Interaction and states

- Show whether check-in is not open, open, already checked in, or closed; provide the matching action or explanation.
- Before Saturday 5 PM, let a player undo their own check-in. After cutoff, route corrections to organisers and preserve the change history.
- Make each monthly total traceable to attended sessions, the fee charged at that time, payments received, remaining balance, or excess credit.
- Let a player request access by invite; keep attendance and financial views unavailable until an organiser approves them and assigns a fee.
- Keep guest attendance and payments in organiser controls. Allow linking the guest record if they later join.
- Show loading, empty-month, network-error, no-balance, partial-payment, and credit states without hiding the primary session state.

## Scope and constraints

This brief covers the authenticated mobile home and its route into session history and organiser management. It does not define every administrative form or implement the app. Never expose another player's fee, bill, payment, or balance on the group view. Use only fictional, labelled sample names and amounts in portfolio material. Currency and the schedule time zone remain open for live setup; do not hard-code either from the sketches. Preserve keyboard access, visible focus, clear text labels, reduced-motion behavior, and the privacy boundary between a player's own finances and group attendance.
