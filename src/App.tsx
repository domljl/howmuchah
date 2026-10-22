import { useEffect, useMemo, useState } from "react";
import { GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut, type User } from "firebase/auth";
import {
  collection, collectionGroup, doc, onSnapshot, query, where,
  type DocumentData, type QuerySnapshot,
} from "firebase/firestore";
import { calculateLedger, monthlyDueMinor } from "../functions/src/domain.js";
import { DateTime } from "luxon";
import { auth, callFunction, db, firebaseConfigured } from "./firebase.js";
import { formatAmount, parseAmount } from "./money.js";

const groupPath = "groups/main";
type Member = { id: string; displayName: string; role: "owner" | "organizer" | "player"; status: "approved" | "pending"; linkedGuestId?: string; approvedAt?: { toDate: () => Date } };
type Guest = { id: string; displayName: string; status: "active" | "linked"; linkedUid?: string };
type Attendance = { id: string; playerUid: string; guestId?: string; displayName: string; sessionDate: string; status: "active" | "void" };
type Charge = { id: string; playerUid: string; guestId?: string; sessionDate: string; amountMinor: number; status: "active" | "void" };
type Payment = { id: string; playerUid: string; guestId?: string; amountMinor: number; receivedAt: { toDate: () => Date }; note?: string };
type Reversal = { id: string; playerUid: string; guestId?: string; paymentUid: string; amountMinor: number; reversedAt: { toDate: () => Date } };
type Fee = { id: string; playerUid: string; amountMinor: number; effectiveFrom: string };
type Settings = { timeZone?: string; currency?: string; launchSessionDate?: string };
type SessionInfo = {
  configured: boolean;
  sessionDate?: string;
  currentDate?: string;
  isOpen?: boolean;
  opensAt?: string;
  closesAt?: string;
  timeZone?: string;
  currency?: string;
};
type Tab = "home" | "sessions" | "bill" | "manage";

function items<T>(snapshot: QuerySnapshot<DocumentData>): T[] {
  return snapshot.docs.map((entry) => ({ id: entry.id, ...entry.data() }) as T);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message.replace(/^FirebaseError:\s*/i, "") : "Something went wrong. Please try again.";
}

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
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [member, setMember] = useState<Member | null>(null);
  const [memberReady, setMemberReady] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [attendance, setAttendance] = useState<Attendance[]>([]);
  const [monthAttendance, setMonthAttendance] = useState<Attendance[]>([]);
  const [charges, setCharges] = useState<Charge[]>([]);
  const [linkedCharges, setLinkedCharges] = useState<Charge[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [linkedPayments, setLinkedPayments] = useState<Payment[]>([]);
  const [myFees, setMyFees] = useState<Fee[]>([]);
  const [reversals, setReversals] = useState<Reversal[]>([]);
  const [linkedReversals, setLinkedReversals] = useState<Reversal[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [guests, setGuests] = useState<Guest[]>([]);
  const [requests, setRequests] = useState<Member[]>([]);
  const [allCharges, setAllCharges] = useState<Charge[]>([]);
  const [allPayments, setAllPayments] = useState<Payment[]>([]);
  const [allReversals, setAllReversals] = useState<Reversal[]>([]);
  const [fees, setFees] = useState<Fee[]>([]);
  const [tab, setTab] = useState<Tab>("home");
  const [sessionReady, setSessionReady] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (!auth) { setAuthReady(true); return; }
    return onAuthStateChanged(auth, (next) => { setUser(next); setAuthReady(true); });
  }, []);

  useEffect(() => {
    if (!db || !user) { setMember(null); setMemberReady(Boolean(user === null)); return; }
    setMemberReady(false);
    return onSnapshot(doc(db, `${groupPath}/members/${user.uid}`), (snapshot) => {
      setMember(snapshot.exists() ? ({ id: snapshot.id, ...snapshot.data() } as Member) : null);
      setMemberReady(true);
    }, (cause) => { setError(messageOf(cause)); setMemberReady(true); });
  }, [user]);

  useEffect(() => {
    if (!user || member?.status !== "approved") { setSession(null); setSessionReady(true); return; }
    let active = true;
    const refresh = async () => {
      try {
        const next = await callFunction<SessionInfo>("getSessionInfo");
        if (active) setSession(next);
      } catch (cause) { if (active) setError(messageOf(cause)); }
      finally { if (active) setSessionReady(true); }
    };
    setSessionReady(false);
    void refresh();
    const interval = window.setInterval(refresh, 60_000);
    return () => { active = false; window.clearInterval(interval); };
  }, [user, member?.status]);

  useEffect(() => {
    if (!db || !user || member?.status !== "approved") {
      setSettings(null); setAttendance([]); setCharges([]); setPayments([]); setReversals([]);
      setLinkedCharges([]); setLinkedPayments([]); setLinkedReversals([]);
      setMonthAttendance([]); setMyFees([]); setMembers([]); setRequests([]); setAllCharges([]); setAllPayments([]); setAllReversals([]); setFees([]); setGuests([]);
      return;
    }
    setLinkedCharges([]); setLinkedPayments([]); setLinkedReversals([]);
    const unsubs = [
      onSnapshot(doc(db, `${groupPath}/settings/public`), (snap) => setSettings(snap.exists() ? snap.data() as Settings : null), (cause) => setError(messageOf(cause))),
      onSnapshot(collection(db, `${groupPath}/members/${user.uid}/fees`), (snap) => setMyFees(items<Fee>(snap).sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))), (cause) => setError(messageOf(cause))),
      onSnapshot(query(collection(db, `${groupPath}/members`), where("status", "==", "approved")), (snap) => setMembers(items<Member>(snap)), (cause) => setError(messageOf(cause))),
      onSnapshot(query(collection(db, `${groupPath}/charges`), where("playerUid", "==", user.uid)), (snap) => setCharges(items<Charge>(snap)), (cause) => setError(messageOf(cause))),
      onSnapshot(query(collection(db, `${groupPath}/payments`), where("playerUid", "==", user.uid)), (snap) => setPayments(items<Payment>(snap)), (cause) => setError(messageOf(cause))),
      onSnapshot(query(collection(db, `${groupPath}/paymentReversals`), where("playerUid", "==", user.uid)), (snap) => setReversals(items<Reversal>(snap)), (cause) => setError(messageOf(cause))),
    ];
    if (session?.sessionDate) {
      unsubs.push(onSnapshot(query(collection(db, `${groupPath}/attendance`), where("sessionDate", "==", session.sessionDate)), (snap) => setAttendance(items<Attendance>(snap)), (cause) => setError(messageOf(cause))));
    }
    if (session?.currentDate) {
      const monthStart = `${session.currentDate.slice(0, 7)}-01`;
      const nextMonth = DateTime.fromISO(monthStart, { zone: session.timeZone }).plus({ months: 1 }).toISODate()!;
      unsubs.push(onSnapshot(query(collection(db, `${groupPath}/attendance`), where("sessionDate", ">=", monthStart), where("sessionDate", "<", nextMonth)), (snap) => setMonthAttendance(items<Attendance>(snap)), (cause) => setError(messageOf(cause))));
    }
    if (member.role === "owner" || member.role === "organizer") {
      unsubs.push(
        onSnapshot(collection(db, `${groupPath}/guests`), (snap) => setGuests(items<Guest>(snap)), (cause) => setError(messageOf(cause))),
        onSnapshot(collection(db, `${groupPath}/requests`), (snap) => setRequests(items<Member>(snap)), (cause) => setError(messageOf(cause))),
        onSnapshot(collection(db, `${groupPath}/charges`), (snap) => setAllCharges(items<Charge>(snap)), (cause) => setError(messageOf(cause))),
        onSnapshot(collection(db, `${groupPath}/payments`), (snap) => setAllPayments(items<Payment>(snap)), (cause) => setError(messageOf(cause))),
        onSnapshot(collection(db, `${groupPath}/paymentReversals`), (snap) => setAllReversals(items<Reversal>(snap)), (cause) => setError(messageOf(cause))),
        onSnapshot(collectionGroup(db, "fees"), (snap) => setFees(snap.docs.map((entry) => ({
          id: entry.id,
          playerUid: entry.ref.parent.parent?.id ?? "",
          ...entry.data(),
        }) as Fee)), (cause) => setError(messageOf(cause))),
      );
    }
    if (member.linkedGuestId) {
      const guestFilter = where("guestId", "==", member.linkedGuestId);
      unsubs.push(
        onSnapshot(query(collection(db, `${groupPath}/charges`), guestFilter), (snap) => setLinkedCharges(items<Charge>(snap)), (cause) => setError(messageOf(cause))),
        onSnapshot(query(collection(db, `${groupPath}/payments`), guestFilter), (snap) => setLinkedPayments(items<Payment>(snap)), (cause) => setError(messageOf(cause))),
        onSnapshot(query(collection(db, `${groupPath}/paymentReversals`), guestFilter), (snap) => setLinkedReversals(items<Reversal>(snap)), (cause) => setError(messageOf(cause))),
      );
    }
    return () => unsubs.forEach((unsubscribe) => unsubscribe());
  }, [user, member?.status, member?.role, member?.linkedGuestId, session?.sessionDate]);

  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get("invite");
    if (!user || member || !code) return;
    void callFunction<{ status: string }>("joinWithInvite", { code }).then(() => {
      window.history.replaceState({}, "", window.location.pathname);
      setNotice("Your request is with the organisers.");
    }).catch((cause) => setError(messageOf(cause)));
  }, [user, member]);

  const ledger = useMemo(() => calculateLedger(
    [...charges, ...linkedCharges].map((item) => ({ ...item, sessionDate: item.sessionDate, amountMinor: item.amountMinor })),
    [...payments, ...linkedPayments].map((item) => ({ id: item.id, amountMinor: item.amountMinor, receivedAt: item.receivedAt.toDate().toISOString() })),
    [...reversals, ...linkedReversals].map((item) => item.paymentUid),
  ), [charges, linkedCharges, payments, linkedPayments, reversals, linkedReversals]);
  const isOrganizer = member?.role === "owner" || member?.role === "organizer";

  if (!firebaseConfigured) return <SetupPage />;
  if (!authReady) return <LoadingPage label="Connecting securely…" />;
  if (!user) return <SignIn error={error} onSignIn={() => void signInWithPopup(auth!, new GoogleAuthProvider()).catch((cause) => setError(messageOf(cause)))} />;
  if (!memberReady) return <LoadingPage label="Loading your group access…" />;
  if (member?.status === "pending") return <PendingPage name={member.displayName} notice={notice} onSignOut={() => void signOut(auth!)} />;
  if (!member) return <JoinPage error={error} onJoin={(code) => void callFunction("joinWithInvite", { code }).then(() => { setError(""); setNotice("Your request is with the organisers."); }).catch((cause) => setError(messageOf(cause)))} onSignOut={() => void signOut(auth!)} />;

  const currency = settings?.currency ?? session?.currency;
  const actions = {
    error: (value: string) => setError(value),
    notice: (value: string) => setNotice(value),
    clear: () => { setError(""); setNotice(""); },
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#home" onClick={(event) => { event.preventDefault(); setTab("home"); }}>HowMuchAh<span className="brand-dot">.</span></a>
        <div className="account"><span className="account-name">{member.displayName}</span><button className="text-button" onClick={() => void signOut(auth!)}>Sign out</button></div>
      </header>
      <main className="page-content">
        <div className="page-heading"><div><p className="eyebrow">SCHOOL BADMINTON GROUP</p><h1>{tab === "home" ? "Your session" : tab === "bill" ? "Your bill" : tab === "sessions" ? "Sessions" : "Manage group"}</h1></div></div>
        {error && <div className="alert alert-error" role="alert">{error}<button aria-label="Dismiss" onClick={() => setError("")}><CloseIcon /></button></div>}
        {notice && <div className="alert alert-success" role="status">{notice}<button aria-label="Dismiss" onClick={() => setNotice("")}><CloseIcon /></button></div>}
        {tab === "home" && <HomePage
          session={session} sessionReady={sessionReady} member={member}
          attendance={attendance} ledger={ledger} currency={currency}
          fee={myFees.filter((item) => !session?.sessionDate || item.effectiveFrom <= session.sessionDate).at(-1)}
          onCheckIn={async (undo) => {
            actions.clear();
            try {
              await callFunction(undo ? "undoCheckIn" : "checkIn");
              actions.notice(undo ? "Your check-in was undone." : "You’re checked in for this session.");
            } catch (cause) { actions.error(messageOf(cause)); }
          }}
        />}
        {tab === "bill" && <BillPage ledger={ledger} currency={currency} payments={[...payments, ...linkedPayments]} reversals={[...reversals, ...linkedReversals]} />}
        {tab === "sessions" && <SessionsPage attendance={monthAttendance} members={members} currentDate={session?.currentDate} sessionDate={session?.sessionDate} isOpen={session?.isOpen} timeZone={session?.timeZone} launchDate={settings?.launchSessionDate} />}
        {tab === "manage" && isOrganizer && <ManagePage
          actor={member} settings={settings} session={session} members={members} requests={requests}
          charges={allCharges} payments={allPayments} reversals={allReversals} fees={fees} guests={guests}
          actions={actions}
        />}
      </main>
      <nav className="bottom-nav" aria-label="Main navigation">
        <NavButton active={tab === "home"} icon="home" onClick={() => setTab("home")}>Home</NavButton>
        <NavButton active={tab === "sessions"} icon="sessions" onClick={() => setTab("sessions")}>Sessions</NavButton>
        <NavButton active={tab === "bill"} icon="bill" onClick={() => setTab("bill")}>My bill</NavButton>
        {isOrganizer && <NavButton active={tab === "manage"} icon="manage" onClick={() => setTab("manage")}>Manage</NavButton>}
      </nav>
    </div>
  );
}

function SetupPage() {
  return <main className="center-page"><span className="brand">HowMuchAh<span className="brand-dot">.</span></span><section className="plain-card"><p className="eyebrow">LOCAL SETUP</p><h1>Connect a Firebase project</h1><p>Copy <code>.env.example</code> to <code>.env.local</code>, add your Firebase web app settings, then start the local emulators.</p><p>The checked-in project ID is reserved for local testing. No account or group data is connected yet.</p></section></main>;
}

function LoadingPage({ label }: { label: string }) {
  return <main className="center-page" aria-live="polite"><span className="brand">HowMuchAh<span className="brand-dot">.</span></span><p className="muted">{label}</p></main>;
}

function SignIn({ error, onSignIn }: { error: string; onSignIn: () => void }) {
  return <main className="center-page"><span className="brand">HowMuchAh<span className="brand-dot">.</span></span><section className="plain-card"><p className="eyebrow">FRIDAY BADMINTON</p><h1>Keep the game simple.</h1><p className="muted">Check in for the session and keep track of your own shuttle contribution.</p><button className="primary-button" onClick={onSignIn}>Continue with Google</button>{error && <p className="form-error" role="alert">{error}</p>}</section></main>;
}

function PendingPage({ name, notice, onSignOut }: { name: string; notice: string; onSignOut: () => void }) {
  return <main className="center-page"><span className="brand">HowMuchAh<span className="brand-dot">.</span></span><section className="plain-card"><p className="eyebrow">REQUEST RECEIVED</p><h1>You’re in the queue, {name.split(" ")[0]}.</h1><p className="muted">An organiser needs to approve your request and set your fee before group attendance becomes visible.</p>{notice && <p role="status">{notice}</p>}<button className="secondary-button" onClick={onSignOut}>Sign out</button></section></main>;
}

function JoinPage({ error, onJoin, onSignOut }: { error: string; onJoin: (code: string) => void; onSignOut: () => void }) {
  const [code, setCode] = useState("");
  return <main className="center-page"><span className="brand">HowMuchAh<span className="brand-dot">.</span></span><form className="plain-card" onSubmit={(event) => { event.preventDefault(); onJoin(code.trim()); }}><p className="eyebrow">PRIVATE GROUP</p><h1>Join your badminton group</h1><p className="muted">Enter the invite code from an organiser. You won’t see group information until your request is approved.</p><label>Invite code<input value={code} onChange={(event) => setCode(event.target.value)} autoComplete="off" required /></label>{error && <p className="form-error" role="alert">{error}</p>}<button className="primary-button" disabled={!code.trim()}>Request access</button><button type="button" className="text-button signout-link" onClick={onSignOut}>Sign out</button></form></main>;
}

function HomePage({ session, sessionReady, member, attendance, ledger, currency, fee, onCheckIn }: {
  session: SessionInfo | null; sessionReady: boolean; member: Member;
  attendance: Attendance[]; ledger: ReturnType<typeof calculateLedger>; currency?: string;
  fee?: Fee;
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
      <p className="privacy-note">Attendance is shared with the group. Fees and payments are private.</p>
    </section>
  </div>;
}

function BillPage({ ledger, currency, payments, reversals }: { ledger: ReturnType<typeof calculateLedger>; currency?: string; payments: Payment[]; reversals: Reversal[] }) {
  const byMonth = new Map<string, typeof ledger.charges>();
  for (const charge of ledger.charges) {
    const key = charge.sessionDate.slice(0, 7);
    byMonth.set(key, [...(byMonth.get(key) ?? []), charge]);
  }
  const monthTitle = (month: string) => new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${month}-01T12:00:00Z`));
  return <div className="dashboard-stack">
    <section className="balance-card large-balance"><div><p className="eyebrow">CURRENT BALANCE</p><h2>{currency ? (ledger.balanceMinor < 0 ? `${formatAmount(ledger.creditMinor, currency)} credit` : formatAmount(ledger.amountDueMinor, currency)) : "Set up required"}</h2><p className="muted">Based on your attended sessions and recorded payments.</p></div></section>
    {[...byMonth.entries()].sort(([a], [b]) => b.localeCompare(a)).map(([month, entries]) => <section className="plain-card month-card" key={month}><div className="section-heading"><h2>{monthTitle(month)}</h2><span className="muted">{entries.length} session{entries.length === 1 ? "" : "s"}</span></div>{entries.map((entry) => <div className="money-row" key={entry.id}><span>{dateLabel(entry.sessionDate, "UTC")}</span><strong>{currency ? formatAmount(entry.amountMinor, currency) : "—"}</strong></div>)}</section>)}
    <section className="plain-card month-card"><h2>Payments received</h2>{payments.length ? [...payments].sort((a, b) => b.receivedAt.toDate().getTime() - a.receivedAt.toDate().getTime()).map((payment) => <div className="money-row" key={payment.id}><span>{payment.receivedAt.toDate().toLocaleDateString()}{reversals.some((reversal) => reversal.paymentUid === payment.id) && <small className="muted">Reversed</small>}</span><strong>{currency ? formatAmount(payment.amountMinor, currency) : "—"}</strong></div>) : <p className="empty-state">No payments recorded yet.</p>}</section>
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
      const joinedDate = person.approvedAt ? DateTime.fromJSDate(person.approvedAt.toDate(), { zone: timeZone }).toISODate() : undefined;
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
  const [inviteUrl, setInviteUrl] = useState("");
  const action = async (work: () => Promise<unknown>, success: string) => {
    actions.clear();
    try { await work(); actions.notice(success); return true; } catch (cause) { actions.error(messageOf(cause)); return false; }
  };
  const activePayments = payments.filter((payment) => !reversals.some((reversal) => reversal.paymentUid === payment.id));
  const groupBalances = members.map((person) => {
    const guestId = person.linkedGuestId;
    const personReversals = reversals.filter((reversal) => reversal.playerUid === person.id || reversal.guestId === guestId).map((reversal) => reversal.paymentUid);
    const ledger = calculateLedger(
      charges.filter((charge) => charge.playerUid === person.id || charge.guestId === guestId),
      payments.filter((payment) => payment.playerUid === person.id || payment.guestId === guestId).map((payment) => ({ id: payment.id, amountMinor: payment.amountMinor, receivedAt: payment.receivedAt.toDate().toISOString() })),
      personReversals,
    );
    return { person, ledger };
  });
  const unlinkedGuests = guests.filter((guest) => guest.status === "active");
  const guestBalances = unlinkedGuests.map((guest) => ({ guest, ledger: calculateLedger(
    charges.filter((charge) => charge.guestId === guest.id),
    payments.filter((payment) => payment.guestId === guest.id).map((payment) => ({ id: payment.id, amountMinor: payment.amountMinor, receivedAt: payment.receivedAt.toDate().toISOString() })),
    reversals.filter((reversal) => reversal.guestId === guest.id).map((reversal) => reversal.paymentUid),
  ) }));
  return <div className="dashboard-stack manager-stack">
    {actor.role === "owner" && <GroupSettingsForm settings={settings} session={session} onSave={(timeZone, currency) => action(() => callFunction("setGroupSettings", { timeZone, currency }), "Group settings saved.")} />}
    <InviteCard inviteUrl={inviteUrl} onCreate={() => action(async () => {
      const result = await callFunction<{ code: string }>("createInvite");
      const link = new URL(window.location.href); link.search = `?invite=${encodeURIComponent(result.code)}`;
      setInviteUrl(link.toString());
      await navigator.clipboard?.writeText(link.toString());
    }, "Invite link created and copied.")} />
    <section className="plain-card manager-card"><div className="section-heading"><div><p className="eyebrow">ACCESS REQUESTS</p><h2>Waiting for approval</h2></div><span className="count-pill">{requests.length}</span></div>
      {requests.length === 0 ? <p className="empty-state">No one is waiting right now.</p> : requests.map((request) => <ApproveRow key={request.id} request={request} currency={settings?.currency} onError={actions.error} onApprove={(amountMinor) => action(() => callFunction("approveMember", { playerUid: request.id, amountMinor }), `${request.displayName} approved.`)} />)}
    </section>
    <section className="plain-card manager-card"><p className="eyebrow">GROUP MEMBERS</p><h2>Fees and roles</h2>{members.map((person) => {
      const currentFee = fees.filter((fee) => fee.playerUid === person.id && (!session?.sessionDate || fee.effectiveFrom <= session.sessionDate)).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
      return <MemberRow key={person.id} member={person} fee={currentFee} currency={settings?.currency} actorRole={actor.role} onError={actions.error}
        onFee={(amountMinor) => action(() => callFunction("updateMemberFee", { playerUid: person.id, amountMinor }), `Fee updated for ${person.displayName}.`)}
        onRole={(role) => action(() => callFunction("setOrganizerRole", { playerUid: person.id, role }), "Member role updated.")} />;
    })}</section>
    <GuestManagement guests={unlinkedGuests} members={members} fees={fees} currency={settings?.currency} sessionDate={session?.sessionDate} onError={actions.error}
      onCreate={(displayName, amountMinor) => action(() => callFunction("createGuest", { displayName, amountMinor }), "Guest added.")}
      onFee={(guestId, amountMinor) => action(() => callFunction("updateGuestFee", { guestId, amountMinor }), "Guest fee updated for future sessions.")}
      onLink={(guestId, playerUid) => action(() => callFunction("linkGuestAccount", { guestId, playerUid }), "Guest history linked to player account.")} />
    <section className="plain-card manager-card"><p className="eyebrow">RECORD A PAYMENT</p><h2>Log money received</h2><PaymentForm members={members} guests={unlinkedGuests} currency={settings?.currency} onError={actions.error} onSave={(target, amountMinor, note, requestId) => action(() => target.startsWith("guest:") ? callFunction("recordGuestPayment", { guestId: target.slice(6), amountMinor, note, requestId }) : callFunction("recordPayment", { playerUid: target.slice(7), amountMinor, note, requestId }), "Payment recorded.")} /></section>
    <section className="plain-card manager-card"><p className="eyebrow">FIX ATTENDANCE</p><h2>Correct a past session</h2><AttendanceForm members={members} guests={unlinkedGuests} onSave={(target, sessionDate, present) => action(() => target.startsWith("guest:") ? callFunction("recordGuestAttendance", { guestId: target.slice(6), sessionDate, present }) : callFunction("recordAttendance", { playerUid: target.slice(7), sessionDate, present }), "Attendance updated.")} /></section>
    <section className="plain-card manager-card"><p className="eyebrow">PAYMENT HISTORY</p><h2>Recent payments</h2>{activePayments.length ? activePayments.slice().sort((a, b) => b.receivedAt.toDate().getTime() - a.receivedAt.toDate().getTime()).slice(0, 10).map((payment) => {
      const payer = members.find((item) => item.id === payment.playerUid)?.displayName ?? guests.find((item) => item.id === payment.guestId)?.displayName ?? "Player";
      return <div className="payment-row" key={payment.id}><div><strong>{payer}</strong><span className="muted">{payment.receivedAt.toDate().toLocaleDateString()} · {settings?.currency ? formatAmount(payment.amountMinor, settings.currency) : ""}</span></div><button className="text-button danger-button" onClick={() => {
        const reason = window.prompt("Why is this payment being reversed?");
        if (reason?.trim()) void action(() => callFunction("reversePayment", { paymentId: payment.id, reason: reason.trim() }), "Payment reversed; the balance now reflects the correction.");
      }}>Reverse</button></div>;
    }) : <p className="empty-state">No payments recorded yet.</p>}</section>
    <section className="plain-card manager-card"><p className="eyebrow">ORGANISER VIEW</p><h2>Group balances</h2>{groupBalances.map(({ person, ledger }) => <div className="money-row" key={person.id}><span>{person.displayName}</span><strong>{settings?.currency ? (ledger.balanceMinor < 0 ? `${formatAmount(ledger.creditMinor, settings.currency)} credit` : formatAmount(ledger.amountDueMinor, settings.currency)) : "—"}</strong></div>)}{guestBalances.map(({ guest, ledger }) => <div className="money-row" key={guest.id}><span>{guest.displayName} <small className="muted">guest</small></span><strong>{settings?.currency ? (ledger.balanceMinor < 0 ? `${formatAmount(ledger.creditMinor, settings.currency)} credit` : formatAmount(ledger.amountDueMinor, settings.currency)) : "—"}</strong></div>)}</section>
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

function InviteCard({ inviteUrl, onCreate }: { inviteUrl: string; onCreate: () => unknown }) {
  return <section className="plain-card manager-card"><p className="eyebrow">INVITE PLAYERS</p><h2>Share a private invite</h2><p className="muted">Each invite is valid for seven days and can be used by up to 20 players. New players still need approval.</p><button className="secondary-button" onClick={onCreate}>Create invite link</button>{inviteUrl && <label className="invite-output">Invite link<input readOnly value={inviteUrl} onFocus={(event) => event.currentTarget.select()} /></label>}</section>;
}

function ApproveRow({ request, currency, onApprove, onError }: { request: Member; currency?: string; onApprove: (amountMinor: number) => Promise<unknown>; onError: (message: string) => void }) {
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  return <form className="request-row" onSubmit={async (event) => { event.preventDefault(); if (!currency) return; setBusy(true); try { await onApprove(parseAmount(amount, currency)); } catch (cause) { onError(messageOf(cause)); } finally { setBusy(false); } }}>
    <div><strong>{request.displayName}</strong><span className="muted">Joined the request queue</span></div><label className="compact-label">Fee / session<input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder={currency ? formatAmount(0, currency) : "Set currency"} required /></label><button className="primary-button small-button" disabled={!currency || busy}>{busy ? "Saving…" : "Approve"}</button>
  </form>;
}

function MemberRow({ member, fee, currency, actorRole, onFee, onRole, onError }: {
  member: Member; fee?: Fee; currency?: string; actorRole: Member["role"];
  onError: (message: string) => void;
  onFee: (amountMinor: number) => Promise<unknown>; onRole: (role: "organizer" | "player") => Promise<unknown>;
}) {
  const [amount, setAmount] = useState("");
  return <div className="member-row"><div className="member-heading"><div><strong>{member.displayName}</strong><span className="muted">{fee && currency ? `${formatAmount(fee.amountMinor, currency)} / session` : "Fee not set"}</span></div><span className="role-pill">{member.role}</span></div><form className="inline-form" onSubmit={async (event) => { event.preventDefault(); if (!currency) return; try { await onFee(parseAmount(amount, currency)); } catch (cause) { onError(messageOf(cause)); } }}><label className="sr-only" htmlFor={`fee-${member.id}`}>New session fee for {member.displayName}</label><input id={`fee-${member.id}`} inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="New fee" required /><button className="secondary-button small-button" disabled={!currency}>Set future fee</button></form>{actorRole === "owner" && member.role !== "owner" && <select aria-label={`Role for ${member.displayName}`} value={member.role} onChange={(event) => void onRole(event.target.value as "organizer" | "player")}><option value="player">Player</option><option value="organizer">Organiser</option></select>}</div>;
}

function PaymentForm({ members, guests, currency, onSave, onError }: { members: Member[]; guests: Guest[]; currency?: string; onSave: (target: string, amountMinor: number, note: string, requestId: string) => Promise<unknown>; onError: (message: string) => void }) {
  const [target, setTarget] = useState(""); const [amount, setAmount] = useState(""); const [note, setNote] = useState(""); const [busy, setBusy] = useState(false);
  return <form className="form-stack" onSubmit={async (event) => { event.preventDefault(); if (!currency) return; setBusy(true); try { const amountMinor = parseAmount(amount, currency); const { storageKey, requestId } = await paymentRequest(target, amountMinor, note); if (await onSave(target, amountMinor, note, requestId)) { sessionStorage.setItem(storageKey, crypto.randomUUID()); setAmount(""); setNote(""); } } catch (cause) { onError(messageOf(cause)); } finally { setBusy(false); } }}><label>Player<select value={target} onChange={(event) => setTarget(event.target.value)} required><option value="">Choose a player</option><optgroup label="Members">{members.map((member) => <option key={member.id} value={`member:${member.id}`}>{member.displayName}</option>)}</optgroup><optgroup label="Guests">{guests.map((guest) => <option key={guest.id} value={`guest:${guest.id}`}>{guest.displayName} (guest)</option>)}</optgroup></select></label><label>Amount<input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder={currency ? formatAmount(0, currency) : "Set currency first"} required /></label><label>Note <span className="muted">(optional)</span><input value={note} onChange={(event) => setNote(event.target.value)} maxLength={160} /></label><button className="primary-button" disabled={!currency || busy}>{busy ? "Saving…" : "Record payment"}</button></form>;
}

function AttendanceForm({ members, guests, onSave }: { members: Member[]; guests: Guest[]; onSave: (target: string, date: string, present: boolean) => Promise<unknown> }) {
  const [target, setTarget] = useState(""); const [date, setDate] = useState(""); const [present, setPresent] = useState(true); const [busy, setBusy] = useState(false);
  return <form className="form-stack" onSubmit={async (event) => { event.preventDefault(); setBusy(true); try { await onSave(target, date, present); } finally { setBusy(false); } }}><label>Player<select value={target} onChange={(event) => setTarget(event.target.value)} required><option value="">Choose a player</option><optgroup label="Members">{members.map((member) => <option key={member.id} value={`member:${member.id}`}>{member.displayName}</option>)}</optgroup><optgroup label="Guests">{guests.map((guest) => <option key={guest.id} value={`guest:${guest.id}`}>{guest.displayName} (guest)</option>)}</optgroup></select></label><label>Friday session date<input type="date" value={date} onChange={(event) => setDate(event.target.value)} required /></label><label className="checkbox-label"><input type="checkbox" checked={present} onChange={(event) => setPresent(event.target.checked)} /> Player attended</label><button className="secondary-button" disabled={busy}>{busy ? "Saving…" : "Save correction"}</button></form>;
}

function GuestManagement({ guests, members, fees, currency, sessionDate, onCreate, onFee, onLink, onError }: {
  guests: Guest[]; members: Member[]; fees: Fee[]; currency?: string; sessionDate?: string; onError: (message: string) => void;
  onCreate: (name: string, amountMinor: number) => Promise<unknown>;
  onFee: (guestId: string, amountMinor: number) => Promise<unknown>;
  onLink: (guestId: string, playerUid: string) => Promise<unknown>;
}) {
  const [name, setName] = useState(""); const [amount, setAmount] = useState(""); const [busy, setBusy] = useState(false);
  return <section className="plain-card manager-card"><p className="eyebrow">GUEST PLAYERS</p><h2>Add a guest</h2><form className="inline-form" onSubmit={async (event) => { event.preventDefault(); if (!currency) return; setBusy(true); try { if (await onCreate(name.trim(), parseAmount(amount, currency))) { setName(""); setAmount(""); } } catch (cause) { onError(messageOf(cause)); } finally { setBusy(false); } }}><label className="sr-only" htmlFor="guest-name">Guest name</label><input id="guest-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Guest name" required maxLength={80} /><label className="sr-only" htmlFor="guest-fee">Fee per session</label><input id="guest-fee" inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="Fee / session" required /><button className="primary-button small-button" disabled={!currency || busy}>Add guest</button></form>{guests.length ? guests.map((guest) => {
    const fee = fees.filter((item) => item.playerUid === guest.id && (!sessionDate || item.effectiveFrom <= sessionDate)).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
    return <GuestRow key={guest.id} guest={guest} members={members} fee={fee} currency={currency} onFee={onFee} onLink={onLink} onError={onError} />;
  }) : <p className="empty-state">No active guests.</p>}</section>;
}

function GuestRow({ guest, members, fee, currency, onFee, onLink, onError }: { guest: Guest; members: Member[]; fee?: Fee; currency?: string; onFee: (guestId: string, amountMinor: number) => Promise<unknown>; onLink: (guestId: string, playerUid: string) => Promise<unknown>; onError: (message: string) => void }) {
  const [amount, setAmount] = useState(""); const [playerUid, setPlayerUid] = useState(""); const [busy, setBusy] = useState(false);
  return <div className="member-row"><div className="member-heading"><div><strong>{guest.displayName}</strong><span className="muted">{fee && currency ? `${formatAmount(fee.amountMinor, currency)} / session` : "Fee not set"}</span></div></div><form className="inline-form" onSubmit={async (event) => { event.preventDefault(); if (!currency) return; setBusy(true); try { if (await onFee(guest.id, parseAmount(amount, currency))) setAmount(""); } catch (cause) { onError(messageOf(cause)); } finally { setBusy(false); } }}><input aria-label={`Future fee for ${guest.displayName}`} inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="New fee" required /><button className="secondary-button small-button" disabled={!currency || busy}>Set future fee</button></form><form className="inline-form" onSubmit={async (event) => { event.preventDefault(); setBusy(true); try { await onLink(guest.id, playerUid); } catch (cause) { onError(messageOf(cause)); } finally { setBusy(false); } }}><select aria-label={`Link ${guest.displayName} to an account`} value={playerUid} onChange={(event) => setPlayerUid(event.target.value)} required><option value="">Link to approved account…</option>{members.filter((member) => !member.linkedGuestId).map((member) => <option key={member.id} value={member.id}>{member.displayName}</option>)}</select><button className="secondary-button small-button" disabled={busy}>Link history</button></form></div>;
}
