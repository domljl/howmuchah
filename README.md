# HowMuchAh

A mobile-first app for one school badminton group to track weekly attendance and shuttlecock contributions. Players see group attendance and their own account; organisers manage fees, guests, and payments.

The first implementation is in place. See [PLAN.md](PLAN.md) for the remaining release setup, [PRODUCT.md](PRODUCT.md) for product rules, and [DESIGN_BRIEF.md](DESIGN_BRIEF.md) for the selected light dashboard.

## Local setup

1. Install Node.js 22 or 24 and Java 21 or newer. Cloud Functions deploy on Node.js 22.
2. Run `npm install` and `npm --prefix functions install`.
3. Copy `.env.example` to `.env.local` and enter the Firebase web app values. Never put service account credentials in the web app or repository.
4. Run `npm run emulators` in one terminal and `npm run dev` in another.

The checked-in Firebase project ID is `demo-howmuchah`, which is reserved for local emulator use. Replace it with your own project only when configuring a real deployment. Firestore rules deny client writes to attendance and financial records; callable functions validate those operations. The first owner must be assigned manually in the Firebase Emulator or Firebase Console. No visitor becomes an organiser automatically.

Currency and the schedule time zone must be configured before check-in is enabled. Use fictional players and sample amounts in portfolio material; this repository must contain no real player, payment, account, or credential data.
