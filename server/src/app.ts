import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createClerkClient, verifyToken } from "@clerk/backend";
import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import { DateTime } from "luxon";
import { Pool, type PoolClient } from "pg";
import { calculateLedger, getSessionWindow, monthlyDueMinor, nextFeeEffectiveSessionDate } from "../../shared/domain.js";

type Actor = { uid: string; email?: string };
type Input = Record<string, unknown>;
type Dependencies = {
  pool?: Pool;
  env?: NodeJS.ProcessEnv;
  verify?: (token: string) => Promise<{ sub: string; email?: string }>;
  userProfile?: (uid: string) => Promise<{ name: string; email?: string; verified: boolean }>;
  now?: () => Date;
};

declare module "fastify" {
  interface FastifyRequest { actor: Actor | null }
}

class ApiError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}

const fail = (status: number, message: string): never => { throw new ApiError(status, message); };
const text = (value: unknown, label: string, max = 100) => {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) fail(400, `Enter a valid ${label}.`);
  return (value as string).trim();
};
const amount = (value: unknown) => {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 100_000_000) fail(400, "Enter a valid whole amount in the currency's minor unit.");
  return value as number;
};
const isOrganizer = (actor: Actor, client: PoolClient) => approved(actor, client).then((row) => {
  if (row.role !== "owner" && row.role !== "organizer") fail(403, "Only an organiser can do that.");
  return row;
});
const approved = async (actor: Actor, client: PoolClient) => {
  const { rows } = await client.query("SELECT * FROM members WHERE uid = $1", [actor.uid]);
  if (!rows[0] || rows[0].status !== "approved" || rows[0].removed_at) fail(403, "An organiser must approve your request first.");
  return rows[0] as Record<string, any>;
};
const owner = async (actor: Actor, client: PoolClient) => {
  const row = await isOrganizer(actor, client);
  if (row.role !== "owner") fail(403, "Only the group owner can change this setting.");
  return row;
};
const settingsRow = async (client: PoolClient) => (await client.query("SELECT * FROM group_settings WHERE id = true")).rows[0] as Record<string, any> | undefined;
const settingsZone = (settings: Record<string, any> | undefined) => {
  const value = settings?.time_zone;
  if (typeof value !== "string" || !DateTime.now().setZone(value).isValid) fail(412, "An organiser must configure the group time zone before check-in.");
  return value;
};
const settingsCurrency = (settings: Record<string, any> | undefined) => {
  const value = settings?.currency;
  if (typeof value !== "string" || !/^[A-Z]{3}$/.test(value)) fail(412, "The group owner must configure a currency before using fees or payments.");
  return value;
};
const fridayDate = (value: unknown, timeZone: string) => {
  const date = text(value, "Friday session date", 10);
  const parsed = DateTime.fromISO(date, { zone: timeZone });
  if (!parsed.isValid || parsed.toISODate() !== date || parsed.weekday !== 5) fail(400, "Choose a valid Friday session date.");
  return date;
};
const audit = (client: PoolClient, action: string, actor: Actor, subject: string) => client.query(
  "INSERT INTO audit_log (action, actor_uid, subject) VALUES ($1, $2, $3)", [action, actor.uid, subject],
);
const dateString = (value: Date | string) => value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
const timestampString = (value: Date | string | null) => value ? new Date(value).toISOString() : undefined;
const subjectFor = (type: "member" | "guest", id: string) => `${type}-${id}`;
const actorSubject = (row: Record<string, any>) => row.linked_guest_id
  ? { type: "guest" as const, id: row.linked_guest_id }
  : { type: "member" as const, id: row.uid };

async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query("BEGIN"); const result = await work(client); await client.query("COMMIT"); return result; }
  catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

function mapAttendance(row: Record<string, any>) {
  const id = `${dateString(row.session_date)}--${row.subject_type === "guest" ? `guest-${row.subject_id}` : row.subject_id}`;
  return { id, playerUid: row.player_uid ?? `guest:${row.subject_id}`, guestId: row.guest_id ?? undefined, displayName: row.display_name, sessionDate: dateString(row.session_date), status: row.status };
}
function mapCharge(row: Record<string, any>) {
  return { id: row.id, playerUid: row.player_uid ?? `guest:${row.subject_id}`, guestId: row.guest_id ?? undefined, sessionDate: dateString(row.session_date), amountMinor: row.amount_minor, status: row.status };
}
function mapPayment(row: Record<string, any>) {
  return { id: row.id, playerUid: row.player_uid ?? `guest:${row.subject_id}`, guestId: row.guest_id ?? undefined, amountMinor: row.amount_minor, receivedAt: timestampString(row.received_at), note: row.note };
}
function mapReversal(row: Record<string, any>) {
  return { id: row.payment_id, playerUid: row.player_uid ?? `guest:${row.subject_id}`, guestId: row.guest_id ?? undefined, paymentUid: row.payment_id, amountMinor: row.amount_minor, reason: row.reason, reversedAt: timestampString(row.reversed_at) };
}
function mapFee(row: Record<string, any>) {
  return { id: `${row.subject_type}-${row.subject_id}-${dateString(row.effective_from)}`, playerUid: row.subject_id, amountMinor: row.amount_minor, effectiveFrom: dateString(row.effective_from) };
}
function mapMember(row: Record<string, any>, paymentStatus?: string, sessionsBilled?: number) {
  return { id: row.uid, displayName: row.display_name, role: row.role, status: row.status, linkedGuestId: row.linked_guest_id ?? undefined, approvedAt: timestampString(row.approved_at), paymentStatus, sessionsBilled };
}

export async function createApp(deps: Dependencies = {}): Promise<FastifyInstance> {
  const env = deps.env ?? process.env;
  const pool = deps.pool ?? new Pool({ connectionString: env.DATABASE_URL, max: 8, ssl: env.DATABASE_SSL === "true" ? { rejectUnauthorized: true } : undefined });
  const now = deps.now ?? (() => new Date());
  const app = Fastify({ logger: true, bodyLimit: 3 * 1024 * 1024 });
  app.decorateRequest("actor", null);
  const origins = (env.APP_ORIGINS ?? "http://localhost:5173").split(",").map((item) => item.trim()).filter(Boolean);
  await app.register(cors, { origin: (origin, callback) => callback(null, !origin || origins.includes(origin)), methods: ["GET", "POST", "OPTIONS"], allowedHeaders: ["Content-Type", "Authorization"] });
  const clerkClient = env.CLERK_SECRET_KEY ? createClerkClient({ secretKey: env.CLERK_SECRET_KEY }) : null;
  const verify: NonNullable<Dependencies["verify"]> = deps.verify ?? (async (token: string) => {
    if (!env.CLERK_SECRET_KEY) fail(503, "The API is missing its Clerk secret key.");
    const result = await verifyToken(token, { secretKey: env.CLERK_SECRET_KEY, authorizedParties: origins });
    if (!result.sub) fail(401, "Sign in to continue.");
    return { sub: result.sub };
  });
  const userProfile = deps.userProfile ?? (async (uid: string) => {
    const client = clerkClient;
    if (!client) throw new ApiError(503, "The API is missing its Clerk secret key.");
    const user = await client.users.getUser(uid);
    const primary = user.primaryEmailAddress;
    return { name: user.fullName || user.username || primary?.emailAddress || "Player", email: primary?.emailAddress, verified: primary?.verification?.status === "verified" };
  });

  app.get("/api/health", async (_request, reply) => {
    try { await pool.query("SELECT 1"); return { ok: true }; }
    catch { return reply.code(503).send({ ok: false }); }
  });
  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/api/") || request.url === "/api/health") return;
    const token = request.headers.authorization?.match(/^Bearer (.+)$/i)?.[1];
    if (!token) return reply.code(401).send({ error: "Sign in to continue." });
    try {
      const identity = await verify(token);
      request.actor = { uid: identity.sub, email: identity.email };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      return reply.code(401).send({ error: "Your sign-in has expired. Sign in again." });
    }
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) return reply.code(error.statusCode).send({ error: error.message });
    app.log.error(error);
    return reply.code(500).send({ error: "Something went wrong. Please try again." });
  });

  async function ensureOwner(actor: Actor) {
    const { rows } = await pool.query("SELECT count(*)::int AS count FROM members");
    if (rows[0].count !== 0 || !env.INITIAL_OWNER_EMAIL) return;
    const profile = await userProfile(actor.uid);
    if (profile.verified && profile.email?.toLowerCase() === env.INITIAL_OWNER_EMAIL.toLowerCase()) {
      await pool.query("INSERT INTO members (uid, display_name, email, role, status, approved_at) VALUES ($1, $2, $3, 'owner', 'approved', now()) ON CONFLICT (uid) DO NOTHING", [actor.uid, profile.name.slice(0, 80), profile.email]);
    }
  }

  async function bootstrap(actor: Actor) {
    await ensureOwner(actor);
    const memberResult = await pool.query("SELECT * FROM members WHERE uid = $1", [actor.uid]);
    const memberRow = memberResult.rows[0];
    if (!memberRow) return { member: null };
    const member = mapMember(memberRow);
    if (memberRow.removed_at) return { member: { ...member, status: "removed" } };
    if (memberRow.status !== "approved") return { member };
    const settingsResult = await pool.query("SELECT * FROM group_settings WHERE id = true");
    const settings = settingsResult.rows[0] as Record<string, any> | undefined;
    const publicSettings = settings ? {
      timeZone: settings.time_zone ?? undefined,
      currency: settings.currency ?? undefined,
      launchSessionDate: settings.launch_session_date ? dateString(settings.launch_session_date) : undefined,
      paymentQrDataUrl: settings.payment_qr_data && settings.payment_qr_mime_type
        ? `data:${settings.payment_qr_mime_type};base64,${Buffer.from(settings.payment_qr_data).toString("base64")}` : undefined,
    } : null;
    const configured = Boolean(settings?.time_zone && settings?.currency);
    const session = configured ? (() => {
      const timeZone = settingsZone(settings);
      const current = now();
      const window = getSessionWindow(current, timeZone);
      return { configured: true, sessionDate: window.sessionDate, currentDate: DateTime.fromJSDate(current, { zone: "utc" }).setZone(timeZone).toISODate()!, isOpen: window.isOpen, opensAt: window.opensAt, closesAt: window.closesAt, timeZone, currency: settingsCurrency(settings) };
    })() : { configured: false };
    if (!configured) return { member, settings: publicSettings, session };
    const timezone = settingsZone(settings);
    const { sessionDate, currentDate } = session as { sessionDate: string; currentDate: string };
    const monthStart = `${currentDate.slice(0, 7)}-01`;
    const monthEnd = DateTime.fromISO(monthStart, { zone: timezone }).plus({ months: 1 }).toISODate()!;
    const manager = memberRow.role === "owner" || memberRow.role === "organizer";
    const [publicMembersResult, sessionsResult, monthResult, allChargesResult, allPaymentsResult, allReversalsResult, allFeesResult, guestsResult, publicGuestsResult] = await Promise.all([
      pool.query("SELECT * FROM members WHERE status = 'approved' AND removed_at IS NULL ORDER BY display_name"),
      pool.query("SELECT * FROM attendance WHERE session_date = $1 ORDER BY display_name", [sessionDate]),
      pool.query("SELECT * FROM attendance WHERE session_date >= $1 AND session_date < $2 ORDER BY session_date DESC, display_name", [monthStart, monthEnd]),
      pool.query("SELECT * FROM charges ORDER BY session_date, id"),
      pool.query("SELECT * FROM payments ORDER BY received_at"),
      pool.query("SELECT * FROM payment_reversals"),
      pool.query("SELECT * FROM fee_versions ORDER BY effective_from"),
      manager ? pool.query("SELECT * FROM guests ORDER BY display_name") : Promise.resolve({ rows: [] }),
      pool.query("SELECT * FROM guests WHERE status = 'active' AND removed_at IS NULL ORDER BY display_name"),
    ]);
    const allCharges = allChargesResult.rows.map(mapCharge);
    const allPayments = allPaymentsResult.rows.map(mapPayment);
    const allReversals = allReversalsResult.rows.map(mapReversal);
    const allFees = allFeesResult.rows.map(mapFee);
    const people = publicMembersResult.rows.map((row) => {
      const linked = row.linked_guest_id;
      const personCharges = allCharges.filter((entry) => entry.playerUid === row.uid || (linked && entry.guestId === linked));
      const personPayments = allPayments.filter((entry) => entry.playerUid === row.uid || (linked && entry.guestId === linked));
      const reversalIds = allReversals.filter((entry) => entry.playerUid === row.uid || (linked && entry.guestId === linked)).map((entry) => entry.paymentUid);
      const ledger = calculateLedger(personCharges, personPayments.map((entry) => ({ id: entry.id, amountMinor: entry.amountMinor, receivedAt: entry.receivedAt! })), reversalIds);
      const billedCount = personCharges.filter((entry) => entry.status === "active" && entry.sessionDate.startsWith(currentDate.slice(0, 7))).length;
      return mapMember(row, billedCount === 0 ? "none" : monthlyDueMinor(ledger.charges, currentDate.slice(0, 7)) === 0 ? "paid" : "unpaid", billedCount);
    });
    const guestPaymentStatuses = publicGuestsResult.rows.map((row) => {
      const guestCharges = allCharges.filter((entry) => entry.guestId === row.id);
      const guestPayments = allPayments.filter((entry) => entry.guestId === row.id);
      const reversedIds = allReversals.filter((entry) => entry.guestId === row.id).map((entry) => entry.paymentUid);
      const ledger = calculateLedger(guestCharges, guestPayments.map((entry) => ({ id: entry.id, amountMinor: entry.amountMinor, receivedAt: entry.receivedAt! })), reversedIds);
      const billedCount = guestCharges.filter((entry) => entry.status === "active" && entry.sessionDate.startsWith(currentDate.slice(0, 7))).length;
      return { id: `guest:${row.id}`, displayName: row.display_name, isGuest: true, paymentStatus: billedCount === 0 ? "none" : monthlyDueMinor(ledger.charges, currentDate.slice(0, 7)) === 0 ? "paid" : "unpaid" };
    });
    const mySubjectIds = [actor.uid, ...(memberRow.linked_guest_id ? [memberRow.linked_guest_id] : [])];
    const isMine = (entry: { playerUid: string; guestId?: string }) => entry.playerUid === actor.uid || Boolean(memberRow.linked_guest_id && entry.guestId === memberRow.linked_guest_id);
    const requestRows = manager ? (await pool.query("SELECT * FROM members WHERE status = 'pending' ORDER BY requested_at")).rows.map((row) => mapMember(row)) : [];
    const adminCharges = manager ? allCharges : [];
    const adminPayments = manager ? allPayments : [];
    const adminReversals = manager ? allReversals : [];
    const personalCharges = manager ? [] : allCharges.filter(isMine);
    const personalPayments = manager ? [] : allPayments.filter(isMine);
    const personalReversals = manager ? [] : allReversals.filter(isMine);
    const myFees = allFees.filter((fee) => mySubjectIds.includes(fee.playerUid));
    return {
      member: { ...member, paymentStatus: people.find((person) => person.id === actor.uid)?.paymentStatus, sessionsBilled: people.find((person) => person.id === actor.uid)?.sessionsBilled },
      settings: publicSettings,
      session,
      attendance: sessionsResult.rows.map(mapAttendance),
      monthAttendance: monthResult.rows.map(mapAttendance),
      charges: personalCharges,
      linkedCharges: manager ? [] : personalCharges.filter((entry) => entry.guestId),
      payments: personalPayments.filter((entry) => !entry.guestId),
      linkedPayments: manager ? [] : personalPayments.filter((entry) => entry.guestId),
      myFees,
      reversals: personalReversals.filter((entry) => !entry.guestId),
      linkedReversals: manager ? [] : personalReversals.filter((entry) => entry.guestId),
      members: people,
      paymentStatuses: [...people.map((person) => ({ id: person.id, displayName: person.displayName, isGuest: false, paymentStatus: person.paymentStatus })), ...guestPaymentStatuses],
      requests: requestRows,
      allCharges: adminCharges,
      allPayments: adminPayments,
      allReversals: adminReversals,
      fees: manager ? allFees : [],
      guests: guestsResult.rows.map((row: Record<string, any>) => ({ id: row.id, displayName: row.display_name, status: row.status, linkedUid: row.linked_uid ?? undefined, removedAt: timestampString(row.removed_at) })),
    };
  }

  app.get("/api/bootstrap", async (request) => bootstrap(request.actor!));

  const handlers: Record<string, (actor: Actor, data: Input) => Promise<unknown>> = {
    getBootstrap: async (actor) => bootstrap(actor),
    getSessionInfo: async (actor) => {
      const client = await pool.connect();
      try { await approved(actor, client); const settings = await settingsRow(client); if (!settings?.time_zone || !settings.currency) return { configured: false };
        const current = now(); const window = getSessionWindow(current, settingsZone(settings));
        return { configured: true, sessionDate: window.sessionDate, currentDate: DateTime.fromJSDate(current, { zone: "utc" }).setZone(settings.time_zone).toISODate(), isOpen: window.isOpen, opensAt: window.opensAt, closesAt: window.closesAt, timeZone: settings.time_zone, currency: settingsCurrency(settings) };
      } finally { client.release(); }
    },
    setGroupSettings: async (actor, data) => transaction(pool, async (client) => {
      await owner(actor, client);
      const timeZone = text(data.timeZone, "time zone", 80);
      const currency = text(data.currency, "currency", 3).toUpperCase();
      if (!DateTime.now().setZone(timeZone).isValid) fail(400, "Choose a valid IANA time zone.");
      try { new Intl.NumberFormat("en", { style: "currency", currency }).format(0); } catch { fail(400, "Choose a valid three-letter currency code."); }
      const existing = await settingsRow(client);
      const { rows } = await client.query("SELECT EXISTS(SELECT 1 FROM attendance) OR EXISTS(SELECT 1 FROM charges) OR EXISTS(SELECT 1 FROM payments) OR EXISTS(SELECT 1 FROM guests) OR EXISTS(SELECT 1 FROM fee_versions) AS has_records");
      if (existing && (existing.time_zone !== timeZone || existing.currency !== currency) && rows[0].has_records) fail(412, "Time zone and currency cannot change after group records exist.");
      const launchDate = existing?.launch_session_date && !(existing.time_zone !== timeZone || existing.currency !== currency)
        ? dateString(existing.launch_session_date) : getSessionWindow(now(), timeZone).sessionDate;
      await client.query("INSERT INTO group_settings (id, time_zone, currency, launch_session_date, updated_at, updated_by) VALUES (true, $1, $2, $3, now(), $4) ON CONFLICT (id) DO UPDATE SET time_zone = EXCLUDED.time_zone, currency = EXCLUDED.currency, launch_session_date = EXCLUDED.launch_session_date, updated_at = now(), updated_by = EXCLUDED.updated_by", [timeZone, currency, launchDate, actor.uid]);
      return { timeZone, currency, launchSessionDate: launchDate };
    }),
    createInvite: async (actor, _data) => transaction(pool, async (client) => {
      await isOrganizer(actor, client);
      const code = randomBytes(6).toString("base64url").slice(0, 6); const expiresAt = new Date(now().getTime() + 7 * 24 * 60 * 60 * 1000);
      await client.query("INSERT INTO invites (token_hash, remaining_uses, created_by, expires_at) VALUES ($1, 20, $2, $3)", [createHash("sha256").update(code).digest("hex"), actor.uid, expiresAt]);
      return { code, expiresAt: expiresAt.toISOString() };
    }),
    joinWithInvite: async (actor, data) => {
      const code = text(data.code, "invite code", 100);
      const profile = await userProfile(actor.uid);
      const displayName = text(profile.name, "Google display name", 80);
      return transaction(pool, async (client) => {
        const existing = await client.query("SELECT status FROM members WHERE uid = $1", [actor.uid]);
        if (existing.rows[0]?.status) return { status: existing.rows[0].status };
        const invite = await client.query("SELECT * FROM invites WHERE token_hash = $1 FOR UPDATE", [createHash("sha256").update(code).digest("hex")]);
        if (!invite.rows[0] || invite.rows[0].remaining_uses < 1 || new Date(invite.rows[0].expires_at) <= now()) fail(404, "This invite is invalid or expired. Ask an organiser for a new one.");
        await client.query("UPDATE invites SET remaining_uses = remaining_uses - 1 WHERE token_hash = $1", [invite.rows[0].token_hash]);
        await client.query("INSERT INTO members (uid, display_name, email, role, status) VALUES ($1, $2, $3, 'player', 'pending')", [actor.uid, displayName, profile.email ?? null]);
        await audit(client, "member-requested", actor, actor.uid);
        return { status: "pending" };
      });
    },
    approveMember: async (actor, data) => transaction(pool, async (client) => {
      await isOrganizer(actor, client); const uid = text(data.playerUid, "player", 128); const fee = amount(data.amountMinor);
      const settings = await settingsRow(client); const timeZone = settingsZone(settings); settingsCurrency(settings);
      const effectiveFrom = getSessionWindow(now(), timeZone).sessionDate;
      const result = await client.query("UPDATE members SET status = 'approved', approved_at = now(), approved_by = $2 WHERE uid = $1 AND status = 'pending' RETURNING uid", [uid, actor.uid]);
      if (!result.rowCount) fail(412, "This player no longer has a pending request.");
      await client.query("INSERT INTO fee_versions (subject_type, subject_id, amount_minor, effective_from, created_by) VALUES ('member', $1, $2, $3, $4)", [uid, fee, effectiveFrom, actor.uid]);
      await audit(client, "member-approved", actor, uid); return { playerUid: uid, effectiveFrom };
    }),
    updateMemberFee: async (actor, data) => transaction(pool, async (client) => {
      await isOrganizer(actor, client); const uid = text(data.playerUid, "player", 128); const fee = amount(data.amountMinor);
      const settings = await settingsRow(client); const timeZone = settingsZone(settings); settingsCurrency(settings);
      const effectiveFrom = nextFeeEffectiveSessionDate(now(), timeZone);
      const player = await client.query("SELECT uid FROM members WHERE uid = $1 AND status = 'approved'", [uid]); if (!player.rows[0]) fail(404, "Approved player not found.");
      await client.query("INSERT INTO fee_versions (subject_type, subject_id, amount_minor, effective_from, created_by) VALUES ('member', $1, $2, $3, $4) ON CONFLICT (subject_type, subject_id, effective_from) DO UPDATE SET amount_minor = EXCLUDED.amount_minor, created_at = now(), created_by = EXCLUDED.created_by", [uid, fee, effectiveFrom, actor.uid]);
      await audit(client, "fee-updated", actor, uid); return { playerUid: uid, amountMinor: fee, effectiveFrom };
    }),
    setOrganizerRole: async (actor, data) => transaction(pool, async (client) => {
      await owner(actor, client); const uid = text(data.playerUid, "player", 128); const role = data.role;
      if (role !== "organizer" && role !== "player") fail(400, "Role must be organizer or player.");
      const result = await client.query("UPDATE members SET role = $2 WHERE uid = $1 AND status = 'approved' AND role <> 'owner' RETURNING uid", [uid, role]);
      if (!result.rowCount) fail(412, "Approved player not found, or the owner role cannot be changed here.");
      await audit(client, "role-updated", actor, uid); return { playerUid: uid, role };
    }),
    removeMember: async (actor, data) => transaction(pool, async (client) => {
      await isOrganizer(actor, client); const uid = text(data.playerUid, "player", 128);
      const result = await client.query("UPDATE members SET removed_at = now() WHERE uid = $1 AND status = 'approved' AND removed_at IS NULL AND role <> 'owner' RETURNING uid", [uid]);
      if (!result.rowCount) fail(412, "Approved player not found, or the owner cannot be removed.");
      await audit(client, "member-removed", actor, uid); return { playerUid: uid };
    }),
    checkIn: async (actor) => transaction(pool, async (client) => {
      await approved(actor, client); const settings = await settingsRow(client); const timeZone = settingsZone(settings); settingsCurrency(settings);
      const at = now(); const session = getSessionWindow(at, timeZone); if (!session.isOpen) fail(412, "Check-in is open Friday at 7 PM until Saturday at 5 PM.");
      const locked = await client.query("SELECT * FROM members WHERE uid = $1 FOR UPDATE", [actor.uid]);
      const subject = actorSubject(locked.rows[0]);
      await writeAttendance(client, subject, actor.uid, session.sessionDate, locked.rows[0].display_name, actor.uid, at, false);
      await audit(client, "player-checked-in", actor, session.sessionDate); return { status: "checked-in", sessionDate: session.sessionDate };
    }),
    undoCheckIn: async (actor) => transaction(pool, async (client) => {
      const player = await approved(actor, client); const settings = await settingsRow(client); const timeZone = settingsZone(settings);
      const session = getSessionWindow(now(), timeZone); if (!session.isOpen) fail(412, "Your check-in can only be undone before Saturday at 5 PM.");
      const subject = actorSubject(player);
      const current = await client.query("SELECT status FROM attendance WHERE session_date = $1 AND subject_type = $2 AND subject_id = $3 FOR UPDATE", [session.sessionDate, subject.type, subject.id]);
      if (!current.rows[0] || current.rows[0].status !== "active") fail(412, "There is no check-in to undo.");
      await client.query("UPDATE attendance SET status = 'void', updated_at = $4, corrected_by = $5 WHERE session_date = $1 AND subject_type = $2 AND subject_id = $3", [session.sessionDate, subject.type, subject.id, now(), actor.uid]);
      await client.query("UPDATE charges SET status = 'void', updated_at = now() WHERE session_date = $1 AND subject_type = $2 AND subject_id = $3", [session.sessionDate, subject.type, subject.id]);
      await audit(client, "player-undid-check-in", actor, session.sessionDate); return { status: "undone", sessionDate: session.sessionDate };
    }),
    recordAttendance: async (actor, data) => changeMemberAttendance(actor, data, false),
    recordGuestAttendance: async (actor, data) => changeMemberAttendance(actor, data, true),
    createGuest: async (actor, data) => transaction(pool, async (client) => {
      await isOrganizer(actor, client); const displayName = text(data.displayName, "guest name", 80); const fee = amount(data.amountMinor);
      const settings = await settingsRow(client); const timeZone = settingsZone(settings); settingsCurrency(settings); const effectiveFrom = fridayDate(settings?.launch_session_date && dateString(settings.launch_session_date), timeZone);
      const id = randomUUID();
      await client.query("INSERT INTO guests (id, display_name, status, created_by) VALUES ($1, $2, 'active', $3)", [id, displayName, actor.uid]);
      await client.query("INSERT INTO fee_versions (subject_type, subject_id, amount_minor, effective_from, created_by) VALUES ('guest', $1, $2, $3, $4)", [id, fee, effectiveFrom, actor.uid]);
      await audit(client, "guest-created", actor, id); return { guestId: id, effectiveFrom };
    }),
    removeGuest: async (actor, data) => transaction(pool, async (client) => {
      await isOrganizer(actor, client); const id = text(data.guestId, "guest", 128);
      const guest = await client.query("SELECT id FROM guests WHERE id = $1 AND status = 'active' AND removed_at IS NULL FOR UPDATE", [id]);
      if (!guest.rows[0]) fail(404, "Active guest not found.");
      await client.query("UPDATE guests SET removed_at = now() WHERE id = $1", [id]);
      await audit(client, "guest-removed", actor, id); return { guestId: id, removed: true };
    }),
    updateGuestFee: async (actor, data) => transaction(pool, async (client) => {
      await isOrganizer(actor, client); const id = text(data.guestId, "guest", 128); const fee = amount(data.amountMinor);
      const settings = await settingsRow(client); const effectiveFrom = nextFeeEffectiveSessionDate(now(), settingsZone(settings)); settingsCurrency(settings);
      const guest = await client.query("SELECT id FROM guests WHERE id = $1 AND status = 'active' AND removed_at IS NULL", [id]); if (!guest.rows[0]) fail(404, "Active guest not found.");
      await client.query("INSERT INTO fee_versions (subject_type, subject_id, amount_minor, effective_from, created_by) VALUES ('guest', $1, $2, $3, $4) ON CONFLICT (subject_type, subject_id, effective_from) DO UPDATE SET amount_minor = EXCLUDED.amount_minor, created_at = now(), created_by = EXCLUDED.created_by", [id, fee, effectiveFrom, actor.uid]);
      await audit(client, "guest-fee-updated", actor, id); return { guestId: id, amountMinor: fee, effectiveFrom };
    }),
    linkGuestAccount: async (actor, data) => transaction(pool, async (client) => {
      await isOrganizer(actor, client); const guestId = text(data.guestId, "guest", 128); const uid = text(data.playerUid, "player", 128);
      const guest = await client.query("SELECT * FROM guests WHERE id = $1 FOR UPDATE", [guestId]); const player = await client.query("SELECT * FROM members WHERE uid = $1 FOR UPDATE", [uid]);
      if (!guest.rows[0] || guest.rows[0].status !== "active" || guest.rows[0].linked_uid || guest.rows[0].removed_at) fail(412, "This guest has already been linked or is unavailable.");
      if (!player.rows[0] || player.rows[0].status !== "approved" || player.rows[0].linked_guest_id) fail(412, "Choose an approved player without a linked guest account.");
      const duplicates = await client.query("SELECT 1 FROM attendance m JOIN attendance g ON m.session_date = g.session_date WHERE m.subject_type = 'member' AND m.subject_id = $1 AND m.status = 'active' AND g.subject_type = 'guest' AND g.subject_id = $2 AND g.status = 'active' LIMIT 1", [uid, guestId]);
      if (duplicates.rows[0]) fail(412, "These records include the same session twice. Correct the duplicate attendance before linking.");
      await client.query("UPDATE guests SET status = 'linked', linked_uid = $2, linked_at = now(), linked_by = $3 WHERE id = $1", [guestId, uid, actor.uid]);
      await client.query("UPDATE members SET linked_guest_id = $2 WHERE uid = $1", [uid, guestId]);
      await audit(client, "guest-account-linked", actor, `${guestId}:${uid}`); return { guestId, playerUid: uid };
    }),
    recordPayment: async (actor, data) => recordPayment(actor, data, false),
    recordGuestPayment: async (actor, data) => recordPayment(actor, data, true),
    reversePayment: async (actor, data) => transaction(pool, async (client) => {
      await isOrganizer(actor, client); const id = text(data.paymentId, "payment", 180); const reason = text(data.reason, "reversal reason", 160);
      const payment = await client.query("SELECT * FROM payments WHERE id = $1 FOR UPDATE", [id]); if (!payment.rows[0]) fail(404, "Payment not found.");
      await client.query("INSERT INTO payment_reversals (payment_id, subject_type, subject_id, player_uid, guest_id, amount_minor, reason, reversed_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (payment_id) DO NOTHING", [id, payment.rows[0].subject_type, payment.rows[0].subject_id, payment.rows[0].player_uid, payment.rows[0].guest_id, payment.rows[0].amount_minor, reason, actor.uid]);
      await audit(client, "payment-reversed", actor, id); return { paymentId: id, reversed: true };
    }),
    setPaynowQr: async (actor, data) => transaction(pool, async (client) => {
      await isOrganizer(actor, client);
      const mimeType = data.mimeType;
      if (data.data === null) {
        await client.query("UPDATE group_settings SET payment_qr_mime_type = NULL, payment_qr_data = NULL, updated_at = now(), updated_by = $1 WHERE id = true", [actor.uid]);
      } else {
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(String(mimeType))) fail(400, "Use a PNG, JPEG, or WebP image.");
        const raw = text(data.data, "PayNow QR image", 2_800_000);
        const bytes = Buffer.from(raw, "base64");
        if (!bytes.length || bytes.length > 2_000_000 || bytes.toString("base64").replace(/=+$/, "") !== raw.replace(/=+$/, "")) fail(400, "Choose a valid image under 2 MB.");
        await client.query("UPDATE group_settings SET payment_qr_mime_type = $1, payment_qr_data = $2, updated_at = now(), updated_by = $3 WHERE id = true", [mimeType, bytes, actor.uid]);
      }
      await audit(client, "paynow-qr-updated", actor, "group"); return { saved: data.data !== null };
    }),
  };

  async function latestFee(client: PoolClient, subject: { type: string; id: string }, date: string) {
    const result = await client.query("SELECT * FROM fee_versions WHERE subject_type = $1 AND subject_id = $2 AND effective_from <= $3 ORDER BY effective_from DESC LIMIT 1", [subject.type, subject.id, date]);
    if (!result.rows[0]) fail(412, "An organiser must set your session fee first.");
    return result.rows[0];
  }

  async function writeAttendance(client: PoolClient, subject: { type: "member" | "guest"; id: string }, playerUid: string, sessionDate: string, displayName: string, actorUid: string, at: Date, correction: boolean) {
    const existing = await client.query("SELECT status FROM attendance WHERE session_date = $1 AND subject_type = $2 AND subject_id = $3 FOR UPDATE", [sessionDate, subject.type, subject.id]);
    if (existing.rows[0]?.status === "active") return;
    if (existing.rows[0]) {
      const charge = await client.query("SELECT id FROM charges WHERE session_date = $1 AND subject_type = $2 AND subject_id = $3 FOR UPDATE", [sessionDate, subject.type, subject.id]);
      if (!charge.rows[0]) fail(500, "Attendance record is incomplete. Ask an organiser to review it.");
      await client.query("UPDATE attendance SET status = 'active', updated_at = $4, corrected_by = $5 WHERE session_date = $1 AND subject_type = $2 AND subject_id = $3", [sessionDate, subject.type, subject.id, at, actorUid]);
      await client.query("UPDATE charges SET status = 'active', updated_at = $4 WHERE session_date = $1 AND subject_type = $2 AND subject_id = $3", [sessionDate, subject.type, subject.id, at]);
      return;
    }
    const fee = await latestFee(client, subject, sessionDate);
    const guestId = subject.type === "guest" ? subject.id : null;
    const id = `${sessionDate}--${subject.type === "guest" ? `guest-${subject.id}` : subject.id}`;
    await client.query("INSERT INTO attendance (session_date, subject_type, subject_id, player_uid, guest_id, display_name, status, checked_in_at, checked_in_by, corrected_by) VALUES ($1,$2,$3,$4,$5,$6,'active',$7,$8,$9)", [sessionDate, subject.type, subject.id, playerUid, guestId, displayName, at, actorUid, correction ? actorUid : null]);
    await client.query("INSERT INTO charges (id, session_date, subject_type, subject_id, player_uid, guest_id, amount_minor, fee_effective_from, status, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active',$9)", [id, sessionDate, subject.type, subject.id, playerUid, guestId, amount(fee.amount_minor), dateString(fee.effective_from), at]);
  }

  async function changeMemberAttendance(actor: Actor, data: Input, guest: boolean) {
    return transaction(pool, async (client) => {
      await isOrganizer(actor, client);
      const settings = await settingsRow(client); const timeZone = settingsZone(settings); settingsCurrency(settings);
      const sessionDate = fridayDate(data.sessionDate, timeZone); const current = getSessionWindow(now(), timeZone);
      const latest = current.isOpen ? current.sessionDate : DateTime.fromISO(current.sessionDate, { zone: timeZone }).minus({ days: 7 }).toISODate()!;
      if (sessionDate > latest || !settings?.launch_session_date || sessionDate < dateString(settings.launch_session_date)) fail(412, "Attendance can only be corrected for sessions since the group started.");
      if (typeof data.present !== "boolean") fail(400, "Attendance must be marked present or absent.");
      const id = text(guest ? data.guestId : data.playerUid, guest ? "guest" : "player", 128);
      const record = guest
        ? (await client.query("SELECT * FROM guests WHERE id = $1", [id])).rows[0]
        : (await client.query("SELECT * FROM members WHERE uid = $1 AND status = 'approved'", [id])).rows[0];
      if (!record || (guest && record.status !== "active")) fail(404, guest ? "Active guest not found." : "Approved player not found.");
      const subject = guest ? { type: "guest" as const, id } : actorSubject(record);
      const existing = await client.query("SELECT status FROM attendance WHERE session_date = $1 AND subject_type = $2 AND subject_id = $3 FOR UPDATE", [sessionDate, subject.type, subject.id]);
      const target = Boolean(data.present);
      if (!target && existing.rows[0]?.status === "active") {
        await client.query("UPDATE attendance SET status = 'void', updated_at = now(), corrected_by = $4 WHERE session_date = $1 AND subject_type = $2 AND subject_id = $3", [sessionDate, subject.type, subject.id, actor.uid]);
        await client.query("UPDATE charges SET status = 'void', updated_at = now() WHERE session_date = $1 AND subject_type = $2 AND subject_id = $3", [sessionDate, subject.type, subject.id]);
      } else if (target) {
        await writeAttendance(client, subject, guest ? `guest:${id}` : id, sessionDate, record.display_name, actor.uid, now(), true);
      }
      await audit(client, target ? (guest ? "guest-attendance-added" : "organizer-added-attendance") : (guest ? "guest-attendance-removed" : "organizer-removed-attendance"), actor, `${sessionDate}:${id}`);
      return { sessionDate, ...(guest ? { guestId: id } : { playerUid: id }), present: target };
    });
  }

  async function recordPayment(actor: Actor, data: Input, guest: boolean) {
    return transaction(pool, async (client) => {
      await isOrganizer(actor, client); const id = text(guest ? data.guestId : data.playerUid, guest ? "guest" : "player", 128);
      const amountMinor = amount(data.amountMinor); if (amountMinor < 1) fail(400, "Enter a payment greater than zero.");
      const settings = await settingsRow(client); settingsCurrency(settings);
      const requestId = text(data.requestId, "payment request ID", 64); if (!/^[a-zA-Z0-9_-]+$/.test(requestId)) fail(400, "Invalid payment request ID.");
      const target = guest
        ? (await client.query("SELECT id FROM guests WHERE id = $1 AND status = 'active'", [id])).rows[0]
        : (await client.query("SELECT uid FROM members WHERE uid = $1 AND status = 'approved'", [id])).rows[0];
      if (!target) fail(404, guest ? "Active guest not found." : "Approved player not found.");
      const type = guest ? "guest" : "member"; const paymentId = `${subjectFor(type, id)}--${requestId}`;
      const inserted = await client.query("INSERT INTO payments (id, subject_type, subject_id, player_uid, guest_id, amount_minor, entered_by, note, request_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (subject_type, subject_id, request_id) DO NOTHING RETURNING id", [paymentId, type, id, guest ? null : id, guest ? id : null, amountMinor, actor.uid, typeof data.note === "string" ? data.note.slice(0, 160) : "", requestId]);
      if (!inserted.rowCount) {
        const previous = await client.query("SELECT amount_minor FROM payments WHERE subject_type = $1 AND subject_id = $2 AND request_id = $3", [type, id, requestId]);
        if (previous.rows[0]?.amount_minor !== amountMinor) fail(409, "This payment request ID was already used.");
      } else await audit(client, guest ? "guest-payment-recorded" : "payment-recorded", actor, paymentId);
      return { paymentId, amountMinor };
    });
  }

  app.post<{ Params: { name: string }; Body: Input }>("/api/actions/:name", async (request, reply) => {
    const handler = handlers[request.params.name];
    if (!handler) return reply.code(404).send({ error: "Unknown action." });
    return handler(request.actor!, request.body ?? {});
  });
  return app;
}
