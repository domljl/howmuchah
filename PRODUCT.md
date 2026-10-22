# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Delegated: React, TypeScript, and Vite with Firebase Authentication, Firestore, and Firebase Hosting, selected for Google sign-in, persistent shared records, and low operating cost.

## Users

Badminton players use a phone before or after their weekly game to check in, see whether they are counted, and review their own shuttle contribution. Organisers approve members, set individual fees, correct attendance, and record money received.

## Product Purpose

Keep weekly attendance and shuttlecock contributions accurate for one school badminton group. Success means players can check themselves in once for a session, understand their own balance, and let organisers reconcile each month without chasing attendance in chat.

## Positioning

Attendance is shared with the group; each player's fee and payment history stays private to that player and organisers. Personal per-session fees make the monthly amount traceable to the sessions attended.

## Operating Context

The group plays after school once per week. The court is free; members contribute toward shuttlecocks. Check-in runs Friday 19:00 to Saturday 17:00 to allow next-day catch-up. A player may undo their check-in before cutoff; organisers handle changes afterward.

## Capabilities and Constraints

- Google sign-in and an invite flow; organisers approve new players and assign their fee before they see group information.
- Each player can have a different fixed fee for each attended session. Fee changes apply to future sessions; existing charges stay at their original amount.
- Players see the attendance list and their own monthly balance, charges, and payments. Only organisers see every player's financial details.
- Organisers record partial payments, apply payments to older charges first, and carry excess forward as credit.
- Organisers can add guests, set their fee, enter attendance and payments, and link their record if they later sign in.
- Start each player at zero; no historical import. No bank integration or automatic payment verification.
- Use trusted time for the check-in window. Preserve payment and attendance history when correcting records.
- Currency and the time zone used for the posted session schedule require confirmation before live setup.

## Brand Commitments

HowMuchAh is the working name. The repository is for a public portfolio; use fictional player examples and no real group, player, payment, or account data. No logo, visual identity, or brand style has been established.

## Evidence on Hand

The product brief and implementation plan are available in this repository. There are no verified product screenshots, user stories, testimonials, member records, or brand assets. Do not invent claims, proof, or real-looking personal data.

## Product Principles

- Make attendance state and next action obvious at a glance.
- Show each player exactly what they owe and why.
- Keep trust boundaries visible in access rules, not decorative UI.
- Make corrections and payments clear without erasing history.
- Keep weekly use fast on a phone and monthly organiser work easy to scan.
