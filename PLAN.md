# HowMuchAh implementation plan

**Status:** Local implementation complete. VPS PostgreSQL and a private API container are running; Clerk production and Netlify accounts exist. DNS, Google OAuth credentials, frontend deploy, HTTPS routing, and end-to-end release verification remain.
**Date:** 2026-10-22

## Product scope

### Agreed requirements

- One private badminton group at a school; court use is free and contributions cover shuttlecocks.
- HowMuchAh is the working name for a mobile-first web app.
- Players sign in with Google and join by invite. A join request remains pending and reveals no group data until an organiser approves it and assigns a per-person session fee.
- Each attended session has a fixed fee for that person. For example, Player A may pay S$2 per session and Player B S$5.
- A fee assignment is required before participation. Fee changes apply to future sessions only; existing attendance charges keep their original fee.
- Check-in opens automatically Friday at 19:00 and closes Saturday at 17:00, Asia/Singapore time. Saturday catch-up is supported. Each person can check in once per Friday session.
- Players may undo their own check-in before the cutoff. After cutoff, only organisers can make corrections. Enforce windows using trusted server time.
- Create monthly bills and record payments manually. Payments can be partial, cover multiple months, or exceed what is owed and leave credit. No bank integration.
- Start with zero balances; do not import historical attendance or opening debts.
- Players can see group attendance and each player's paid/unpaid/no-bill status, but only their own fees, balance, and payment history. Organisers can see all group financial details.
- Show the organiser's PayNow QR code; organisers manually record received payments. Do not attempt bank or QR payment verification.
- Organisers can add guests by name and fee, and record guest attendance and payments. An organiser can later link an approved Google account to that guest history without losing or duplicating records.
- Multiple organisers share management access for approvals, fees, attendance, and payments. The owner grants and revokes organiser roles.

### Proposed implementation defaults

These are practical defaults for the first version and can be revised before implementation:

- Use SGD and one group.
- Attribute a session to the Friday date for monthly billing, even when its Saturday check-in falls in the next month.
- Apply payments to the oldest valid charges first; excess remains as player credit.
- Keep attribution for organiser corrections. Reversing attendance that was already paid creates credit.
- If the network is unavailable, show a clear failure and do not claim a check-in was saved.
- Prevent co-organisers from accidentally removing the owner's access.

## Proposed stack and boundaries

- React, TypeScript, and Vite for the client.
- Clerk Google sign-in, a Fastify API and PostgreSQL on the existing VPS, and Netlify for the static single-page app.
- The browser sends Clerk session tokens to the API. The API checks roles, trusted time, fees, and money before database writes; PostgreSQL credentials stay on the server.
- No scheduled job is needed. The API derives the current Friday session from trusted server time and the configured IANA time zone.
- Keep database and Clerk secrets in server environment variables. The database will stay on the VPS's private Docker network; never commit real player, payment, QR, or credential data.
- Verify API authorization and finance privacy before launch. The public health endpoint probes PostgreSQL and returns unavailable when the database cannot be reached.
- Do not put an external AI service in the product runtime.

## Data and behavior design

Keep records small and separate by visibility:

- Membership and public player display data: approval status, display name, and role needed by group members.
- Private fee history: member or guest, amount in integer cents, effective session date, and fee version.
- Attendance: one stable session/player record, visible to group members without money fields.
- Private attendance charges: attendance reference, frozen fee amount, validity/correction state, and attribution.
- Payments: player or guest, amount in integer cents, received date, and correction metadata.

Calculate balances from valid charges and payments instead of storing editable totals. Preserve history when a player is deactivated. Avoid a general event-sourcing framework.

Use a stable unique session/player key and atomic writes so retries or concurrent organisers cannot create duplicate check-ins or charges. Freeze the applicable fee for the Friday session, so a Saturday catch-up has the same fee as a Friday check-in. Fee changes take effect on future sessions, not according to the time a player checks in. Organiser-entered attendance for an earlier session since launch uses that session's applicable fee, not the newest fee.

Represent corrections by voiding or correcting the relevant record with who/when attribution. Retrying a payment action must not duplicate a receipt. Correcting a paid attendance must leave the account with the corresponding credit. Never return another player’s fee, charge details, payment history, or balance to a player; group-visible monthly status is limited to paid/unpaid/no bill.

## Delivery sequence

1. **Foundation:** React/TypeScript/Vite frontend, Clerk auth, PostgreSQL schema, Fastify API, Netlify config, and Docker runtime are in place. VPS PostgreSQL and the API container are running; the API is bound to localhost and its health endpoint successfully queries PostgreSQL. Local typecheck, tests, and production build pass.
2. **Access and membership:** API supports Google-authenticated invite requests, approvals, role changes, and owner protection; end-to-end live setup remains.
3. **Sessions and charges:** implemented. Weekly window, self-undo, organiser corrections, guest attendance, and fee snapshots use server time and atomic writes.
4. **Payments and summaries:** API supports private ledgers, manual payment recording/reversal, public paid/unpaid statuses, and PayNow QR storage; UI is connected, but live database integration remains unverified.
5. **Release readiness:** finish Clerk Google sign-in, secrets, DNS and HTTPS routing, deploy the Netlify frontend, then verify authenticated end-to-end flows. Keep demo data fictional and separate from group records.

## Acceptance checks for implementation

- Unauthenticated visitors and pending members cannot read group data. Pending members receive no group data before approval.
- Players can read group attendance without amounts. A player cannot read another player's fee, charge, payment, or balance, or change fees, roles, or payments.
- An active invite can lead to an approval with a required fee; guest linking preserves one history without duplicate identity or charges.
- Server-time boundary checks reject Friday 18:59, allow Friday 19:00 and Saturday 16:59, and reject Saturday 17:00 in Asia/Singapore.
- A session crossing a calendar-month boundary is billed to Friday's month. Device clock changes and refreshes do not bypass the window.
- Repeated, retried, and concurrent check-ins create one attendance and one charge. Undo and re-check retain the original session fee even after a rate change.
- Organiser corrections for late attendance leave no orphan valid charge. Correction history identifies the organiser.
- Four sessions at S$2 for Player A total S$8; four at S$5 for Player B total S$20.
- For S$8 owed, a S$5 payment leaves S$3; a second S$5 payment leaves S$2 credit. Payments spanning months apply oldest charges first. Reversing a paid visit creates credit.
- Multiple organisers can act concurrently without lost updates or duplicate receipts. Co-organiser actions cannot remove the owner's access.
- Mobile and keyboard flows show clear saved, pending, and failed states; an uncertain network result is never presented as confirmed.

Local verification: `npm run typecheck`, `npm test`, and `npm run build`. The VPS API health endpoint has been verified against PostgreSQL. Authenticated API/database integration and frontend deployment remain before release.

## Explicitly out of scope for v1

No bank integration, reminders, shuttle inventory or purchase tracking, advance court reservations, multi-group platform, real-data demo, or historical balance import.

## Setup decisions still needed before live use

Complete DNS and Google OAuth configuration, add production secrets to the VPS environment, and establish the initial owner through the verified-email bootstrap process. The previously created Filess database is not in use. A first visitor must never become an organiser automatically. Keep test/demo data separate from real group data; portfolio screenshots must use fictional Player A/B examples only.
