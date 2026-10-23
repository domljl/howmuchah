import { useEffect, useMemo, useState } from "react";
import { ClerkProvider, SignInButton, useAuth, useClerk, useUser } from "@clerk/react";
import { calculateLedger, monthlyDueMinor } from "../shared/domain.js";
import { DateTime } from "luxon";
import { callFunction, getBootstrap, setTokenProvider } from "./api.js";
import { formatAmount, parseAmount } from "./money.js";

type Member = { id: string; displayName: string; role: "owner" | "organizer" | "player"; status: "approved" | "pending" | "removed"; linkedGuestId?: string; approvedAt?: string; paymentStatus?: "none" | "paid" | "unpaid"; sessionsBilled?: number };
type Guest = { id: string; displayName: string; status: "active" | "linked"; linkedUid?: string; removedAt?: string };
type Attendance = { id: string; playerUid: string; guestId?: string; displayName: string; sessionDate: string; status: "active" | "void" };
type Charge = { id: string; playerUid: string; guestId?: string; sessionDate: string; amountMinor: number; status: "active" | "void" };
type Payment = { id: string; playerUid: string; guestId?: string; amountMinor: number; receivedAt: string; note?: string };
type Reversal = { id: string; playerUid: string; guestId?: string; paymentUid: string; amountMinor: number; reversedAt: string };
type Fee = { id: string; playerUid: string; amountMinor: number; effectiveFrom: string };
type Settings = { timeZone?: string; currency?: string; launchSessionDate?: string; paymentQrDataUrl?: string };
type SessionInfo = { configured: boolean; sessionDate?: string; currentDate?: string; isOpen?: boolean; opensAt?: string; closesAt?: string; timeZone?: string; currency?: string };
type PaymentStatus = { id: string; displayName: string; isGuest: boolean; paymentStatus: "none" | "paid" | "unpaid" };
type Dashboard = { member: Member | null; settings?: Settings | null; session?: SessionInfo; attendance?: Attendance[]; monthAttendance?: Attendance[]; charges?: Charge[]; linkedCharges?: Charge[]; payments?: Payment[]; linkedPayments?: Payment[]; myFees?: Fee[]; reversals?: Reversal[]; linkedReversals?: Reversal[]; members?: Member[]; paymentStatuses?: PaymentStatus[]; requests?: Member[]; allCharges?: Charge[]; allPayments?: Payment[]; allReversals?: Reversal[]; fees?: Fee[]; guests?: Guest[] };
type Tab = "home" | "sessions" | "bill" | "manage";

function messageOf(error: unknown): string { return error instanceof Error ? error.message : "Something went wrong. Please try again."; }
async function paymentRequest(target: string, amountMinor: number, note: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${target}\n${amountMinor}\n${note}`)));
  const storageKey = `howmuchah-payment-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  let requestId = sessionStorage.getItem(storageKey);
  if (!requestId) { requestId = crypto.randomUUID(); sessionStorage.setItem(storageKey, requestId); }
  return { storageKey, requestId };
}
function dateLabel(date: string, timeZone?: string) {
  if (!timeZone) return date;
  const localDate = DateTime.fromISO(date, { zone: timeZone }).set({ hour: 12 });
  return new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric", timeZone }).format(localDate.toJSDate());
}

export default function App() {
  const key = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
  return key ? <ClerkProvider publishableKey={key}><SignedInApp /></ClerkProvider> : <SetupPage />;
}

function SignedInApp() {
  const { isLoaded, isSignedIn, getToken } = useAuth();
  const { user } = useUser();
  const { signOut } = useClerk();
  const [data, setData] = useState<Dashboard | null>(null);
  const [tab, setTab] = useState<Tab>("home");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => { setTokenProvider(getToken); }, [getToken]);
  useEffect(() => {
    if (!isSignedIn) { setData(null); return; }
    let active = true;
    const refresh = async () => { try { const next = await getBootstrap<Dashboard>(); if (active) { setData(next); setError(""); } } catch (cause) { if (active) setError(messageOf(cause)); } };
    void refresh();
    const timer = window.setInterval(refresh, 20_000);
    window.addEventListener("howmuchah:refresh", refresh);
    return () => { active = false; window.clearInterval(timer); window.removeEventListener("howmuchah:refresh", refresh); };
  }, [isSignedIn]);
  const member = data?.member ?? null;
  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get("invite");
    if (!isSignedIn || !user || member || !code) return;
    void callFunction<{ status: string }>("joinWithInvite", { code }).then(() => { window.history.replaceState({}, "", window.location.pathname); setNotice("Your request is with the organisers."); }).catch((cause) => setError(messageOf(cause)));
  }, [isSignedIn, user, member]);
  const ledger = useMemo(() => calculateLedger(
    [...(data?.charges ?? []), ...(data?.linkedCharges ?? [])],
    [...(data?.payments ?? []), ...(data?.linkedPayments ?? [])].map((item) => ({ id: item.id, amountMinor: item.amountMinor, receivedAt: item.receivedAt })),
    [...(data?.reversals ?? []), ...(data?.linkedReversals ?? [])].map((item) => item.paymentUid),
  ), [data]);
  const isOrganizer = member?.role === "owner" || member?.role === "organizer";
  if (!isLoaded) return <LoadingPage label="Connecting securely…" />;
  if (!isSignedIn) return <SignIn error={error} />;
  if (!data) return <LoadingPage label="Loading your group access…" error={error} onSignOut={() => void signOut()} />;
  if (member?.status === "pending") return <PendingPage name={member.displayName} notice={notice} onSignOut={() => void signOut()} />;
  if (member?.status === "removed") return <LoadingPage label="Your access to this group has been removed." onSignOut={() => void signOut()} />;
  if (!member) return <JoinPage error={error} onJoin={(code) => void callFunction("joinWithInvite", { code }).then(() => { setNotice("Your request is with the organisers."); }).catch((cause) => setError(messageOf(cause)))} onSignOut={() => void signOut()} />;
  const settings = data.settings ?? null;
  const session: SessionInfo = data.session ?? { configured: false };
  const currency = settings?.currency ?? session.currency;
  const actions = { error: (value: string) => setError(value), notice: (value: string) => setNotice(value), clear: () => { setError(""); setNotice(""); } };
  return <div className="app-shell">
    <header className="topbar"><a className="brand" href="#home" onClick={(event) => { event.preventDefault(); setTab("home"); }}>HowMuchAh<span className="brand-dot">.</span></a><div className="account"><span className="account-name">{member.displayName}</span><button className="text-button" onClick={() => void signOut()}>Sign out</button></div></header>
    <main className="page-content"><div className="page-heading"><div><p className="eyebrow">SCHOOL BADMINTON GROUP</p><h1>{tab === "home" ? "Your session" : tab === "bill" ? "Your bill" : tab === "sessions" ? "Sessions" : "Manage group"}</h1></div></div>
      {error && <div className="alert alert-error" role="alert">{error}<button aria-label="Dismiss" onClick={() => setError("")}><CloseIcon /></button></div>}{notice && <div className="alert alert-success" role="status">{notice}<button aria-label="Dismiss" onClick={() => setNotice("")}><CloseIcon /></button></div>}
      {tab === "home" && <HomePage session={session} sessionReady member={member} attendance={data.attendance ?? []} ledger={ledger} currency={currency} fee={(data.myFees ?? []).filter((item) => !session.sessionDate || item.effectiveFrom <= session.sessionDate).at(-1)} paymentStatuses={data.paymentStatuses ?? []} onCheckIn={async (undo) => { actions.clear(); try { await callFunction(undo ? "undoCheckIn" : "checkIn"); actions.notice(undo ? "Your check-in was undone." : "You’re checked in for this session."); } catch (cause) { actions.error(messageOf(cause)); } }} />}
      {tab === "bill" && <BillPage ledger={ledger} currency={currency} payments={[...(data.payments ?? []), ...(data.linkedPayments ?? [])]} reversals={[...(data.reversals ?? []), ...(data.linkedReversals ?? [])]} qr={settings?.paymentQrDataUrl} />}
      {tab === "sessions" && <SessionsPage attendance={data.monthAttendance ?? []} members={data.members ?? []} currentDate={session.currentDate} sessionDate={session.sessionDate} isOpen={session.isOpen} timeZone={session.timeZone} launchDate={settings?.launchSessionDate} />}
      {tab === "manage" && isOrganizer && <ManagePage actor={member} settings={settings} session={session} members={data.members ?? []} requests={data.requests ?? []} charges={data.allCharges ?? []} payments={data.allPayments ?? []} reversals={data.allReversals ?? []} fees={data.fees ?? []} guests={data.guests ?? []} actions={actions} />}
    </main><nav className="bottom-nav" aria-label="Main navigation"><NavButton active={tab === "home"} icon="home" onClick={() => setTab("home")}>Home</NavButton><NavButton active={tab === "sessions"} icon="sessions" onClick={() => setTab("sessions")}>Sessions</NavButton><NavButton active={tab === "bill"} icon="bill" onClick={() => setTab("bill")}>My bill</NavButton>{isOrganizer && <NavButton active={tab === "manage"} icon="manage" onClick={() => setTab("manage")}>Manage</NavButton>}</nav>
  </div>;
}

function SetupPage() {
  return <main className="center-page"><span className="brand">HowMuchAh<span className="brand-dot">.</span></span><section className="plain-card"><p className="eyebrow">LOCAL SETUP</p><h1>Connect your sign-in</h1><p>Copy <code>.env.example</code> to <code>.env.local</code> and add your Clerk publishable key. Start the API with <code>npm run api:dev</code>.</p><p>Keep your Clerk secret key and database URL in the API environment only.</p></section></main>;
}

function LoadingPage({ label, error, onSignOut }: { label: string; error?: string; onSignOut?: () => void }) {
  return <main className="center-page" aria-live="polite"><span className="brand">HowMuchAh<span className="brand-dot">.</span></span><p className="muted">{error || label}</p>{error && onSignOut && <button className="secondary-button" onClick={onSignOut}>Sign out</button>}</main>;
}

function SignIn({ error }: { error: string }) {
  return <main className="center-page"><span className="brand">HowMuchAh<span className="brand-dot">.</span></span><section className="plain-card"><p className="eyebrow">FRIDAY BADMINTON</p><h1>Keep the game simple.</h1><p className="muted">Check in for the session and keep track of your own shuttle contribution.</p><SignInButton mode="modal"><button className="primary-button">Continue with Google</button></SignInButton>{error && <p className="form-error" role="alert">{error}</p>}</section></main>;
}

function PendingPage({ name, notice, onSignOut }: { name: string; notice: string; onSignOut: () => void }) {
  return <main className="center-page"><span className="brand">HowMuchAh<span className="brand-dot">.</span></span><section className="plain-card"><p className="eyebrow">REQUEST RECEIVED</p><h1>You’re in the queue, {name.split(" ")[0]}.</h1><p className="muted">An organiser needs to approve your request and set your fee before group attendance becomes visible.</p>{notice && <p role="status">{notice}</p>}<button className="secondary-button" onClick={onSignOut}>Sign out</button></section></main>;
}

function JoinPage({ error, onJoin, onSignOut }: { error: string; onJoin: (code: string) => void; onSignOut: () => void }) {
  const [code, setCode] = useState("");
  return <main className="center-page"><span className="brand">HowMuchAh<span className="brand-dot">.</span></span><form className="plain-card" onSubmit={(event) => { event.preventDefault(); onJoin(code.trim()); }}><p className="eyebrow">PRIVATE GROUP</p><h1>Join your badminton group</h1><p className="muted">Enter the invite code from an organiser. You won’t see group information until your request is approved.</p><label>Invite code<input value={code} onChange={(event) => setCode(event.target.value)} autoComplete="off" required /></label>{error && <p className="form-error" role="alert">{error}</p>}<button className="primary-button" disabled={!code.trim()}>Request access</button><button type="button" className="text-button signout-link" onClick={onSignOut}>Sign out</button></form></main>;
}

function HomePage({ session, sessionReady, member, attendance, ledger, currency, fee, paymentStatuses, onCheckIn }: {
  session: SessionInfo | null; sessionReady: boolean; member: Member;
  attendance: Attendance[]; ledger: ReturnType<typeof calculateLedger>; currency?: string;
  fee?: Fee;
  paymentStatuses: PaymentStatus[];
  onCheckIn: (undo: boolean) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const mineAsPlayer = attendance.some((entry) => entry.playerUid === member.id && entry.status === "active");
  const countedGuestRecord = Boolean(member.linkedGuestId && attendance.some((entry) => entry.guestId === member.linkedGuestId && entry.status === "active"));
  const mine = mineAsPlayer || countedGuestRecord;
  const totalComing = attendance.filter((entry) => entry.status === "active").length;
  const billMonth = session?.currentDate?.slice(0, 7);
  const monthCharges = ledger.charges.filter((charge) => charge.sessionDate.slice(0, 7) === billMonth);
  const monthDueMinor = monthlyDueMinor(ledger.charges, billMonth ?? "");
  const monthLabel = billMonth ? new Intl.DateTimeFormat(undefined, { month: "long" }).format(new Date(`${billMonth}-01T12:00:00Z`)) : "Monthly";
  const amountDue = currency ? formatAmount(monthDueMinor, currency) : "—";
  return <div className="dashboard-stack">
    <section className="session-card">
      <div className="session-topline"><div><p className="eyebrow">{session?.sessionDate ? dateLabel(session.sessionDate, session.timeZone) : "THIS WEEK"}</p><h2>Badminton</h2></div><span className={`state-pill ${mine ? "state-success" : session?.isOpen ? "state-open" : "state-closed"}`}>{mine ? "CHECKED IN" : session?.isOpen ? "CHECK-IN OPEN" : "NOT OPEN"}</span></div>
      {!sessionReady ? <p className="muted">Checking the session time…</p> : !session?.configured ? <p className="session-time">An organiser needs to set the group time zone and currency before check-in can open.</p> : <>
        <p className="session-time">Friday · 7:00 pm<br /><span>Closes Saturday at 5:00 pm · {session.timeZone}</span></p>
        <button className={`primary-button session-action ${mine ? "button-soft" : ""}`} disabled={busy || (!session.isOpen && !mine) || (mine && (!session.isOpen || !mineAsPlayer))} onClick={async () => { setBusy(true); try { await onCheckIn(mine); } finally { setBusy(false); } }}>
          {busy ? "Saving…" : countedGuestRecord && !mineAsPlayer ? "Already counted as guest" : mineAsPlayer && session.isOpen ? "Undo check-in" : mine ? "Check-in closed" : session.isOpen ? "Check in" : "Opens Friday at 7:00 pm"}
        </button>
        {mine && <p className="success-note">{countedGuestRecord && !mineAsPlayer ? "Your guest attendance is included in this session." : "You’re on the list for this session."}</p>}
      </>}
    </section>
    <section className="balance-card">
      <div><p className="eyebrow">YOUR {monthLabel.toUpperCase()} BILL</p><h2>{currency ? amountDue : "Setup required"}</h2><p className="muted">{monthCharges.length} attended session{monthCharges.length === 1 ? "" : "s"} · {fee && currency ? `${formatAmount(fee.amountMinor, currency)} per session` : "fee not assigned"}{ledger.creditMinor > 0 && currency ? ` · ${formatAmount(ledger.creditMinor, currency)} credit available` : ""}</p></div>
      <span className="balance-mark" aria-hidden="true">$</span>
    </section>
    <section className="attendance-card">
      <div className="section-heading"><div><p className="eyebrow">FRIDAY SESSION</p><h2>Who’s coming</h2></div><span className="count-pill">{totalComing} {totalComing === 1 ? "player" : "players"}</span></div>
      {attendance.filter((entry) => entry.status === "active").sort((a, b) => a.displayName.localeCompare(b.displayName)).map((entry) => <div className="player-row" key={entry.id}><span className="presence-dot" aria-hidden="true" />{entry.displayName}<span className="row-note">Checked in</span></div>)}
      {totalComing === 0 && <p className="empty-state">No one has checked in yet. You can be first.</p>}
      <p className="privacy-note">Attendance and monthly payment status are shared with the group. Fee amounts are private.</p>
    </section>
    <section className="plain-card month-card"><div className="section-heading"><div><p className="eyebrow">THIS MONTH</p><h2>Payment status</h2></div></div>{paymentStatuses.map((person) => <div className="player-row" key={person.id}><span>{person.displayName}{person.isGuest && <small className="muted"> guest</small>}</span><span className="row-note">{person.paymentStatus === "none" ? "No bill" : person.paymentStatus === "paid" ? "Paid" : "Unpaid"}</span></div>)}</section>
  </div>;
}

function BillPage({ ledger, currency, payments, reversals, qr }: { ledger: ReturnType<typeof calculateLedger>; currency?: string; payments: Payment[]; reversals: Reversal[]; qr?: string }) {
  const byMonth = new Map<string, typeof ledger.charges>();
  for (const charge of ledger.charges) {
    const key = charge.sessionDate.slice(0, 7);
    byMonth.set(key, [...(byMonth.get(key) ?? []), charge]);
  }
  const monthTitle = (month: string) => new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${month}-01T12:00:00Z`));
  return <div className="dashboard-stack">
    <section className="balance-card large-balance"><div><p className="eyebrow">CURRENT BALANCE</p><h2>{currency ? (ledger.balanceMinor < 0 ? `${formatAmount(ledger.creditMinor, currency)} credit` : formatAmount(ledger.amountDueMinor, currency)) : "Set up required"}</h2><p className="muted">Based on your attended sessions and recorded payments.</p></div></section>
    {[...byMonth.entries()].sort(([a], [b]) => b.localeCompare(a)).map(([month, entries]) => <section className="plain-card month-card" key={month}><div className="section-heading"><h2>{monthTitle(month)}</h2><span className="muted">{entries.length} session{entries.length === 1 ? "" : "s"}</span></div>{entries.map((entry) => <div className="money-row" key={entry.id}><span>{dateLabel(entry.sessionDate, "UTC")}</span><strong>{currency ? formatAmount(entry.amountMinor, currency) : "—"}</strong></div>)}</section>)}
    {qr && <section className="plain-card month-card"><h2>PayNow</h2><p className="muted">Scan to pay. Your organiser will update your payment status after receiving it.</p><img className="paynow-qr" src={qr} alt="Group PayNow QR code" /></section>}
    <section className="plain-card month-card"><h2>Payments received</h2>{payments.length ? [...payments].sort((a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime()).map((payment) => <div className="money-row" key={payment.id}><span>{new Date(payment.receivedAt).toLocaleDateString()}{reversals.some((reversal) => reversal.paymentUid === payment.id) && <small className="muted">Reversed</small>}</span><strong>{currency ? formatAmount(payment.amountMinor, currency) : "—"}</strong></div>) : <p className="empty-state">No payments recorded yet.</p>}</section>
  </div>;
}

function SessionsPage({ attendance, members, currentDate, sessionDate, isOpen, timeZone, launchDate }: { attendance: Attendance[]; members: Member[]; currentDate?: string; sessionDate?: string; isOpen?: boolean; timeZone?: string; launchDate?: string }) {
  if (!currentDate || !timeZone) return <section className="plain-card"><h2>Sessions</h2><p className="muted">An organiser needs to configure the group schedule first.</p></section>;
  const monthStart = DateTime.fromISO(`${currentDate.slice(0, 7)}-01`, { zone: timeZone });
  const monthLabel = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric", timeZone }).format(monthStart.set({ day: 15, hour: 12 }).toJSDate());
  const fridays: string[] = [];
  for (let day = 1; day <= (monthStart.daysInMonth ?? 31); day++) {
    const date = monthStart.set({ day }).toISODate()!;
    if (monthStart.set({ day }).weekday === 5 && date <= currentDate && (!launchDate || date >= launchDate)) fridays.push(date);
  }
  if (sessionDate && sessionDate.startsWith(currentDate.slice(0, 7)) && !fridays.includes(sessionDate) && (!launchDate || sessionDate >= launchDate)) fridays.push(sessionDate);
  return <div className="dashboard-stack"><section className="plain-card"><p className="eyebrow">MONTHLY ATTENDANCE</p><h2>{monthLabel}</h2><p className="muted">Check-in runs Friday at 7:00 pm through Saturday at 5:00 pm. Attendance is shared with the group.</p></section>{fridays.sort().reverse().map((date) => {
    const attended = attendance.filter((entry) => entry.sessionDate === date && entry.status === "active");
    const present = new Set(attended.filter((entry) => !entry.guestId).map((entry) => entry.playerUid));
    const linkedGuestIds = new Set(members.map((person) => person.linkedGuestId).filter((id): id is string => Boolean(id)));
    const guestAttendees = attended.filter((entry) => entry.guestId && !linkedGuestIds.has(entry.guestId)).sort((a, b) => a.displayName.localeCompare(b.displayName));
    const upcoming = date > currentDate || (date === sessionDate && !isOpen);
    return <section className="plain-card month-card" key={date}><div className="section-heading"><h2>{dateLabel(date, timeZone)}</h2><span className="count-pill">{attended.length} attended</span></div>{upcoming && <p className="muted">This session has not opened yet.</p>}{members.slice().sort((a, b) => a.displayName.localeCompare(b.displayName)).map((person) => {
      const linkedGuestPresent = Boolean(person.linkedGuestId && attended.some((entry) => entry.guestId === person.linkedGuestId));
      const attendedSession = present.has(person.id) || linkedGuestPresent;
      const joinedDate = person.approvedAt ? DateTime.fromISO(person.approvedAt, { zone: timeZone }).toISODate() : undefined;
      const joinedLater = !attendedSession && joinedDate && date < joinedDate;
      return <div className="player-row" key={person.id}><span className={`presence-dot ${attendedSession ? "" : "presence-away"}`} aria-hidden="true" />{person.displayName}<span className="row-note">{upcoming ? "Not yet" : attendedSession ? "Checked in" : joinedLater ? "Joined later" : "Not checked in"}</span></div>;
    })}{guestAttendees.map((guest) => <div className="player-row" key={guest.id}><span className="presence-dot" aria-hidden="true" />{guest.displayName}<span className="row-note">Guest · checked in</span></div>)}{members.length === 0 && guestAttendees.length === 0 && <p className="empty-state">No players in this group yet.</p>}</section>;
    })}{fridays.length === 0 && <section className="plain-card"><p className="empty-state">No Friday sessions recorded for this month yet.</p></section>}</div>;
}

function NavButton({ active, icon, children, onClick }: { active: boolean; icon: "home" | "sessions" | "bill" | "manage"; children: string; onClick: () => void }) {
  const paths = {
    home: <><path d="m3.5 10.5 8.5-7 8.5 7" /><path d="M5.5 9.5v10h13v-10M9.5 19.5v-6h5v6" /></>,
    sessions: <><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M8 9h8M8 13h8M8 17h4" /></>,
    bill: <><rect x="5" y="3.5" width="14" height="17" rx="2" /><path d="M8.5 8h7M8.5 12h7M8.5 16h3" /></>,
    manage: <><path d="M4 6h16M4 12h16M4 18h16" /><circle cx="9" cy="6" r="2" fill="var(--paper)" /><circle cx="15" cy="12" r="2" fill="var(--paper)" /><circle cx="11" cy="18" r="2" fill="var(--paper)" /></>,
  };
  return <button className={`nav-item ${active ? "nav-active" : ""}`} aria-current={active ? "page" : undefined} onClick={onClick}><span className="nav-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[icon]}</svg></span><span>{children}</span></button>;
}

function CloseIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="m6 6 12 12M18 6 6 18" /></svg>;
}

function ManagePage({ actor, settings, session, members, requests, charges, payments, reversals, fees, guests, actions }: {
  actor: Member; settings: Settings | null; session: SessionInfo | null; members: Member[]; requests: Member[];
  charges: Charge[]; payments: Payment[]; reversals: Reversal[]; fees: Fee[]; guests: Guest[];
  actions: { error: (value: string) => void; notice: (value: string) => void; clear: () => void };
}) {
  const [inviteCode, setInviteCode] = useState("");
  const action = async (work: () => Promise<unknown>, success: string) => {
    actions.clear();
    try { await work(); actions.notice(success); return true; } catch (cause) { actions.error(messageOf(cause)); return false; }
  };
  const [qrBusy, setQrBusy] = useState(false);
  const activePayments = payments.filter((payment) => !reversals.some((reversal) => reversal.paymentUid === payment.id));
  const groupBalances = members.map((person) => {
    const guestId = person.linkedGuestId;
    const personReversals = reversals.filter((reversal) => reversal.playerUid === person.id || reversal.guestId === guestId).map((reversal) => reversal.paymentUid);
    const ledger = calculateLedger(
      charges.filter((charge) => charge.playerUid === person.id || charge.guestId === guestId),
      payments.filter((payment) => payment.playerUid === person.id || payment.guestId === guestId).map((payment) => ({ id: payment.id, amountMinor: payment.amountMinor, receivedAt: payment.receivedAt })),
      personReversals,
    );
    return { person, ledger };
  });
  const guestRecords = guests.filter((guest) => guest.status === "active");
  const unlinkedGuests = guestRecords.filter((guest) => !guest.removedAt);
  const guestBalances = guestRecords.map((guest) => ({ guest, ledger: calculateLedger(
    charges.filter((charge) => charge.guestId === guest.id),
    payments.filter((payment) => payment.guestId === guest.id).map((payment) => ({ id: payment.id, amountMinor: payment.amountMinor, receivedAt: payment.receivedAt })),
    reversals.filter((reversal) => reversal.guestId === guest.id).map((reversal) => reversal.paymentUid),
  ) }));
  return <div className="dashboard-stack manager-stack">
    {actor.role === "owner" && <GroupSettingsForm settings={settings} session={session} onSave={(timeZone, currency) => action(() => callFunction("setGroupSettings", { timeZone, currency }), "Group settings saved.")} />}
    <section className="plain-card manager-card"><h2>PayNow QR code</h2><p className="muted">Players can scan this from their bill. Use PNG, JPEG, or WebP up to 2 MB.</p>{settings?.paymentQrDataUrl && <img className="paynow-qr" src={settings.paymentQrDataUrl} alt="Current group PayNow QR code" />}<label>Upload QR image<input type="file" accept="image/png,image/jpeg,image/webp" disabled={qrBusy} onChange={async (event) => { const input = event.currentTarget; const file = input.files?.[0]; if (!file) return; if (file.size > 2_000_000) { actions.error("Choose an image under 2 MB."); input.value = ""; return; } setQrBusy(true); try { const data = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",")[1] ?? ""); reader.onerror = () => reject(new Error("Could not read that image.")); reader.readAsDataURL(file); }); await action(() => callFunction("setPaynowQr", { data, mimeType: file.type }), "PayNow QR updated."); } catch (cause) { actions.error(messageOf(cause)); } finally { setQrBusy(false); input.value = ""; } }} /></label>{settings?.paymentQrDataUrl && <button className="text-button danger-button" onClick={() => void action(() => callFunction("setPaynowQr", { data: null }), "PayNow QR removed.")}>Remove QR code</button>}</section>
    <InviteCard inviteCode={inviteCode} onCreate={() => action(async () => {
      const result = await callFunction<{ code: string }>("createInvite");
      setInviteCode(result.code);
    }, "Invite code created. Send it to your friends.")} onCopy={() => action(async () => {
      if (!navigator.clipboard) throw new Error("Clipboard unavailable. Select and copy the invite code instead.");
      await navigator.clipboard.writeText(inviteCode);
    }, "Invite code copied.")} />
    <section className="plain-card manager-card"><div className="section-heading"><div><p className="eyebrow">ACCESS REQUESTS</p><h2>Waiting for approval</h2></div><span className="count-pill">{requests.length}</span></div>
      {requests.length === 0 ? <p className="empty-state">No one is waiting right now.</p> : requests.map((request) => <ApproveRow key={request.id} request={request} currency={settings?.currency} onError={actions.error} onApprove={(amountMinor) => action(() => callFunction("approveMember", { playerUid: request.id, amountMinor }), `${request.displayName} approved.`)} />)}
    </section>
    <section className="plain-card manager-card"><p className="eyebrow">GROUP MEMBERS</p><h2>Fees and roles</h2>{members.map((person) => {
      const currentFee = fees.filter((fee) => fee.playerUid === person.id && (!session?.sessionDate || fee.effectiveFrom <= session.sessionDate)).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
      return <MemberRow key={person.id} member={person} fee={currentFee} currency={settings?.currency} actorRole={actor.role} onError={actions.error}
        onFee={(amountMinor) => action(() => callFunction("updateMemberFee", { playerUid: person.id, amountMinor }), `Fee updated for ${person.displayName}.`)}
        onRole={(role) => action(() => callFunction("setOrganizerRole", { playerUid: person.id, role }), "Member role updated.")}
        onRemove={() => action(() => callFunction("removeMember", { playerUid: person.id }), `${person.displayName} removed. Past records are kept.`)} />;
    })}</section>
    <GuestManagement guests={unlinkedGuests} members={members} fees={fees} currency={settings?.currency} sessionDate={session?.sessionDate} onError={actions.error}
      onCreate={(displayName, amountMinor) => action(() => callFunction("createGuest", { displayName, amountMinor }), "Guest added.")}
      onFee={(guestId, amountMinor) => action(() => callFunction("updateGuestFee", { guestId, amountMinor }), "Guest fee updated for future sessions.")}
      onRemove={(guestId) => action(() => callFunction("removeGuest", { guestId }), "Guest removed. Past records are kept.")}
      onLink={(guestId, playerUid) => action(() => callFunction("linkGuestAccount", { guestId, playerUid }), "Guest history linked to player account.")} />
    <section className="plain-card manager-card"><p className="eyebrow">RECORD A PAYMENT</p><h2>Log money received</h2><PaymentForm members={members} guests={guestRecords} currency={settings?.currency} onError={actions.error} onSave={(target, amountMinor, note, requestId) => action(() => target.startsWith("guest:") ? callFunction("recordGuestPayment", { guestId: target.slice(6), amountMinor, note, requestId }) : callFunction("recordPayment", { playerUid: target.slice(7), amountMinor, note, requestId }), "Payment recorded.")} /></section>
    <section className="plain-card manager-card"><p className="eyebrow">FIX ATTENDANCE</p><h2>Correct a past session</h2><AttendanceForm members={members} guests={guestRecords} onSave={(target, sessionDate, present) => action(() => target.startsWith("guest:") ? callFunction("recordGuestAttendance", { guestId: target.slice(6), sessionDate, present }) : callFunction("recordAttendance", { playerUid: target.slice(7), sessionDate, present }), "Attendance updated.")} /></section>
    <section className="plain-card manager-card"><p className="eyebrow">PAYMENT HISTORY</p><h2>Recent payments</h2>{activePayments.length ? activePayments.slice().sort((a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime()).slice(0, 10).map((payment) => {
      const payer = members.find((item) => item.id === payment.playerUid)?.displayName ?? guests.find((item) => item.id === payment.guestId)?.displayName ?? "Player";
      return <div className="payment-row" key={payment.id}><div><strong>{payer}</strong><span className="muted">{new Date(payment.receivedAt).toLocaleDateString()} · {settings?.currency ? formatAmount(payment.amountMinor, settings.currency) : ""}</span></div><button className="text-button danger-button" onClick={() => {
        const reason = window.prompt("Why is this payment being reversed?");
        if (reason?.trim()) void action(() => callFunction("reversePayment", { paymentId: payment.id, reason: reason.trim() }), "Payment reversed; the balance now reflects the correction.");
      }}>Reverse</button></div>;
    }) : <p className="empty-state">No payments recorded yet.</p>}</section>
    <section className="plain-card manager-card"><p className="eyebrow">ORGANISER VIEW</p><h2>Group balances</h2>{groupBalances.map(({ person, ledger }) => <div className="money-row" key={person.id}><span>{person.displayName}</span><strong>{settings?.currency ? (ledger.balanceMinor < 0 ? `${formatAmount(ledger.creditMinor, settings.currency)} credit` : formatAmount(ledger.amountDueMinor, settings.currency)) : "—"}</strong></div>)}{guestBalances.map(({ guest, ledger }) => <div className="money-row" key={guest.id}><span>{guest.displayName} <small className="muted">{guest.removedAt ? "removed guest" : "guest"}</small></span><strong>{settings?.currency ? (ledger.balanceMinor < 0 ? `${formatAmount(ledger.creditMinor, settings.currency)} credit` : formatAmount(ledger.amountDueMinor, settings.currency)) : "—"}</strong></div>)}</section>
  </div>;
}

function GroupSettingsForm({ settings, session, onSave }: { settings: Settings | null; session: SessionInfo | null; onSave: (timeZone: string, currency: string) => Promise<unknown> }) {
  const [timeZone, setTimeZone] = useState(settings?.timeZone ?? "");
  const [currency, setCurrency] = useState(settings?.currency ?? "");
  const [busy, setBusy] = useState(false);
  return <form className="plain-card manager-card" onSubmit={async (event) => { event.preventDefault(); setBusy(true); try { await onSave(timeZone, currency); } finally { setBusy(false); } }}>
    <p className="eyebrow">ONE-TIME GROUP SETUP</p><h2>Schedule and currency</h2><p className="muted">Check-in uses trusted server time. Choose the time zone and currency your group uses.</p>
    <div className="form-grid"><label>Time zone<input value={timeZone} onChange={(event) => setTimeZone(event.target.value)} placeholder="Asia/Singapore" autoComplete="off" required /></label><label>Currency<input value={currency} onChange={(event) => setCurrency(event.target.value.toUpperCase())} placeholder="SGD" maxLength={3} autoComplete="off" required /></label></div>
    {settings?.launchSessionDate && <p className="muted">Group records start from {settings.launchSessionDate}. {session?.timeZone && `Current time zone: ${session.timeZone}.`}</p>}
    <button className="primary-button" disabled={busy}>{busy ? "Saving…" : "Save group settings"}</button>
  </form>;
}

export function InviteCard({ inviteCode, onCreate, onCopy }: { inviteCode: string; onCreate: () => unknown; onCopy: () => unknown }) {
  return <section className="plain-card manager-card"><p className="eyebrow">INVITE PLAYERS</p><h2>Share an invite code</h2><p className="muted">Create a code, then ask friends to visit the website, sign in with Google, and enter it. Codes last seven days, allow up to 20 requests, and still need organiser approval.</p><button className="secondary-button" onClick={onCreate}>Create invite code</button>{inviteCode && <><label className="invite-output">Invite code<input readOnly value={inviteCode} onFocus={(event) => event.currentTarget.select()} /></label><button className="text-button" onClick={() => void onCopy()}>Copy code</button></>}</section>;
}

function ApproveRow({ request, currency, onApprove, onError }: { request: Member; currency?: string; onApprove: (amountMinor: number) => Promise<unknown>; onError: (message: string) => void }) {
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  return <form className="request-row" onSubmit={async (event) => { event.preventDefault(); if (!currency) return; setBusy(true); try { await onApprove(parseAmount(amount, currency)); } catch (cause) { onError(messageOf(cause)); } finally { setBusy(false); } }}>
    <div><strong>{request.displayName}</strong><span className="muted">Joined the request queue</span></div><label className="compact-label">Fee / session<input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder={currency ? formatAmount(0, currency) : "Set currency"} required /></label><button className="primary-button small-button" disabled={!currency || busy}>{busy ? "Saving…" : "Approve"}</button>
  </form>;
}

function MemberRow({ member, fee, currency, actorRole, onFee, onRole, onRemove, onError }: {
  member: Member; fee?: Fee; currency?: string; actorRole: Member["role"];
  onError: (message: string) => void;
  onFee: (amountMinor: number) => Promise<unknown>; onRole: (role: "organizer" | "player") => Promise<unknown>; onRemove: () => Promise<unknown>;
}) {
  const [amount, setAmount] = useState("");
  return <div className="member-row"><div className="member-heading"><div><strong>{member.displayName}</strong><span className="muted">{fee && currency ? `${formatAmount(fee.amountMinor, currency)} / session` : "Fee not set"}</span></div><span className="role-pill">{member.role}</span></div><form className="inline-form" onSubmit={async (event) => { event.preventDefault(); if (!currency) return; try { await onFee(parseAmount(amount, currency)); } catch (cause) { onError(messageOf(cause)); } }}><label className="sr-only" htmlFor={`fee-${member.id}`}>New session fee for {member.displayName}</label><input id={`fee-${member.id}`} inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="New fee" required /><button className="secondary-button small-button" disabled={!currency}>Set future fee</button></form>{actorRole === "owner" && member.role !== "owner" && <select aria-label={`Role for ${member.displayName}`} value={member.role} onChange={(event) => void onRole(event.target.value as "organizer" | "player")}><option value="player">Player</option><option value="organizer">Organiser</option></select>}{member.role !== "owner" && <button className="text-button danger-button" onClick={() => { if (window.confirm(`Remove ${member.displayName} from this group? Their attendance and payments will be kept.`)) void onRemove().catch((cause) => onError(messageOf(cause))); }}>Remove player</button>}</div>;
}

function PaymentForm({ members, guests, currency, onSave, onError }: { members: Member[]; guests: Guest[]; currency?: string; onSave: (target: string, amountMinor: number, note: string, requestId: string) => Promise<unknown>; onError: (message: string) => void }) {
  const [target, setTarget] = useState(""); const [amount, setAmount] = useState(""); const [note, setNote] = useState(""); const [busy, setBusy] = useState(false);
  return <form className="form-stack" onSubmit={async (event) => { event.preventDefault(); if (!currency) return; setBusy(true); try { const amountMinor = parseAmount(amount, currency); const { storageKey, requestId } = await paymentRequest(target, amountMinor, note); if (await onSave(target, amountMinor, note, requestId)) { sessionStorage.setItem(storageKey, crypto.randomUUID()); setAmount(""); setNote(""); } } catch (cause) { onError(messageOf(cause)); } finally { setBusy(false); } }}><label>Player<select value={target} onChange={(event) => setTarget(event.target.value)} required><option value="">Choose a player</option><optgroup label="Members">{members.map((member) => <option key={member.id} value={`member:${member.id}`}>{member.displayName}</option>)}</optgroup><optgroup label="Guests">{guests.map((guest) => <option key={guest.id} value={`guest:${guest.id}`}>{guest.displayName} ({guest.removedAt ? "removed guest" : "guest"})</option>)}</optgroup></select></label><label>Amount<input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder={currency ? formatAmount(0, currency) : "Set currency first"} required /></label><label>Note <span className="muted">(optional)</span><input value={note} onChange={(event) => setNote(event.target.value)} maxLength={160} /></label><button className="primary-button" disabled={!currency || busy}>{busy ? "Saving…" : "Record payment"}</button></form>;
}

function AttendanceForm({ members, guests, onSave }: { members: Member[]; guests: Guest[]; onSave: (target: string, date: string, present: boolean) => Promise<unknown> }) {
  const [target, setTarget] = useState(""); const [date, setDate] = useState(""); const [present, setPresent] = useState(true); const [busy, setBusy] = useState(false);
  return <form className="form-stack" onSubmit={async (event) => { event.preventDefault(); setBusy(true); try { await onSave(target, date, present); } finally { setBusy(false); } }}><label>Player<select value={target} onChange={(event) => setTarget(event.target.value)} required><option value="">Choose a player</option><optgroup label="Members">{members.map((member) => <option key={member.id} value={`member:${member.id}`}>{member.displayName}</option>)}</optgroup><optgroup label="Guests">{guests.map((guest) => <option key={guest.id} value={`guest:${guest.id}`}>{guest.displayName} ({guest.removedAt ? "removed guest" : "guest"})</option>)}</optgroup></select></label><label>Friday session date<input type="date" value={date} onChange={(event) => setDate(event.target.value)} required /></label><label className="checkbox-label"><input type="checkbox" checked={present} onChange={(event) => setPresent(event.target.checked)} /> Player attended</label><button className="secondary-button" disabled={busy}>{busy ? "Saving…" : "Save correction"}</button></form>;
}

function GuestManagement({ guests, members, fees, currency, sessionDate, onCreate, onFee, onRemove, onLink, onError }: {
  guests: Guest[]; members: Member[]; fees: Fee[]; currency?: string; sessionDate?: string; onError: (message: string) => void;
  onCreate: (name: string, amountMinor: number) => Promise<unknown>;
  onFee: (guestId: string, amountMinor: number) => Promise<unknown>;
  onRemove: (guestId: string) => Promise<unknown>;
  onLink: (guestId: string, playerUid: string) => Promise<unknown>;
}) {
  const [name, setName] = useState(""); const [amount, setAmount] = useState(""); const [busy, setBusy] = useState(false);
  return <section className="plain-card manager-card"><p className="eyebrow">GUEST PLAYERS</p><h2>Add a guest</h2><form className="inline-form" onSubmit={async (event) => { event.preventDefault(); if (!currency) return; setBusy(true); try { if (await onCreate(name.trim(), parseAmount(amount, currency))) { setName(""); setAmount(""); } } catch (cause) { onError(messageOf(cause)); } finally { setBusy(false); } }}><label className="sr-only" htmlFor="guest-name">Guest name</label><input id="guest-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Guest name" required maxLength={80} /><label className="sr-only" htmlFor="guest-fee">Fee per session</label><input id="guest-fee" inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="Fee / session" required /><button className="primary-button small-button" disabled={!currency || busy}>Add guest</button></form>{guests.length ? guests.map((guest) => {
    const fee = fees.filter((item) => item.playerUid === guest.id && (!sessionDate || item.effectiveFrom <= sessionDate)).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
    return <GuestRow key={guest.id} guest={guest} members={members} fee={fee} currency={currency} onFee={onFee} onRemove={onRemove} onLink={onLink} onError={onError} />;
  }) : <p className="empty-state">No active guests.</p>}</section>;
}

function GuestRow({ guest, members, fee, currency, onFee, onRemove, onLink, onError }: { guest: Guest; members: Member[]; fee?: Fee; currency?: string; onFee: (guestId: string, amountMinor: number) => Promise<unknown>; onRemove: (guestId: string) => Promise<unknown>; onLink: (guestId: string, playerUid: string) => Promise<unknown>; onError: (message: string) => void }) {
  const [amount, setAmount] = useState(""); const [playerUid, setPlayerUid] = useState(""); const [busy, setBusy] = useState(false);
  return <div className="member-row"><div className="member-heading"><div><strong>{guest.displayName}</strong><span className="muted">{fee && currency ? `${formatAmount(fee.amountMinor, currency)} / session` : "Fee not set"}</span></div><button className="text-button danger-button" disabled={busy} onClick={async () => { if (!window.confirm(`Remove ${guest.displayName} from the guest list? Their attendance and payments will be kept.`)) return; setBusy(true); try { await onRemove(guest.id); } catch (cause) { onError(messageOf(cause)); } finally { setBusy(false); } }}>Remove guest</button></div><form className="inline-form" onSubmit={async (event) => { event.preventDefault(); if (!currency) return; setBusy(true); try { if (await onFee(guest.id, parseAmount(amount, currency))) setAmount(""); } catch (cause) { onError(messageOf(cause)); } finally { setBusy(false); } }}><input aria-label={`Future fee for ${guest.displayName}`} inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="New fee" required /><button className="secondary-button small-button" disabled={!currency || busy}>Set future fee</button></form><form className="inline-form" onSubmit={async (event) => { event.preventDefault(); setBusy(true); try { await onLink(guest.id, playerUid); } catch (cause) { onError(messageOf(cause)); } finally { setBusy(false); } }}><select aria-label={`Link ${guest.displayName} to an account`} value={playerUid} onChange={(event) => setPlayerUid(event.target.value)} required><option value="">Link to approved account…</option>{members.filter((member) => !member.linkedGuestId).map((member) => <option key={member.id} value={member.id}>{member.displayName}</option>)}</select><button className="secondary-button small-button" disabled={busy}>Link history</button></form></div>;
}
