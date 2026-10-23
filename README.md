# HowMuchAh

A mobile-first app for one school badminton group to track weekly attendance and shuttlecock contributions. Players see group attendance and monthly paid/unpaid status; individual fee amounts and balances remain private to the player and organisers.

## Local setup

Use Node.js 22 or 24. Run `npm install` and add the values from `.env.example` to `.env.local` (create it if needed), including the Clerk publishable key and API-only settings. Start the API with `npm run api:dev` and the frontend in another terminal with `npm run dev`.

Create a Clerk application with Google sign-in enabled. Set `CLERK_SECRET_KEY`, `DATABASE_URL`, and `INITIAL_OWNER_EMAIL` only for the API; the first verified sign-in matching that email becomes the group owner. `APP_ORIGINS` must list the exact frontend origins allowed to call the API. The API applies `server/schema.sql` on startup.

The frontend is a static Vite app hosted on Netlify. The API and PostgreSQL run on the existing VPS, with the database kept on a private Docker network. Configure the API URL in `VITE_API_URL` for production and add the production frontend origin to `APP_ORIGINS`. Never commit database credentials, Clerk secret keys, player/payment records, or a real PayNow QR image. Portfolio examples should use fictional data.

Check with `npm run typecheck`, `npm test`, and `npm run build`.

## GitHub deployment

`.github/workflows/deploy.yml` runs checks for pull requests into `main`. After a merge, it builds and publishes the frontend to Netlify and deploys the matching commit to the VPS. API deployment keeps `/opt/howmuchah/api.env`, uses the existing `howmuchah` Docker network, checks container health, and restores the previous image if the new one fails.

Add these GitHub Actions repository variables:

- `NETLIFY_SITE_ID`
- `VITE_CLERK_PUBLISHABLE_KEY`
- `VITE_API_URL` (for example, `https://api.howmuchah.dominiclim.dev`)

Add these GitHub Actions repository secrets:

- `NETLIFY_AUTH_TOKEN`
- `VPS_HOST`
- `VPS_USER`
- `VPS_SSH_KEY` (dedicated deployment key; never use a personal key)
- `VPS_KNOWN_HOSTS` (pinned VPS host-key line)

The VPS deploy account needs access to `/opt/howmuchah`, Docker, Git, and `flock`. Docker access is root-equivalent; use a dedicated key/account and do not reuse your personal SSH key. Configure the repository’s `main` branch rules to require pull requests and the `verify` check, so normal changes land through a reviewed merge. GitHub-hosted deployments require the listed variables and secrets before merging; no credentials belong in Git.
