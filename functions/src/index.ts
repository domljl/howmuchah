import { createHash, randomBytes } from "node:crypto";
import { initializeApp } from "firebase-admin/app";
import { FieldValue, Timestamp, getFirestore, type DocumentData, type Transaction } from "firebase-admin/firestore";
import { setGlobalOptions } from "firebase-functions/v2";
import { HttpsError, onCall, type CallableRequest } from "firebase-functions/v2/https";
import { DateTime } from "luxon";
import { getSessionWindow, nextFeeEffectiveSessionDate } from "./domain.js";

initializeApp();
setGlobalOptions({ region: "asia-southeast1", maxInstances: 5 });

const db = getFirestore();
const group = db.collection("groups").doc("main");
const settingsRef = group.collection("settings").doc("public");
const now = () => new Date();

function fail(code: ConstructorParameters<typeof HttpsError>[0], message: string): never {
  throw new HttpsError(code, message);
}

function uidOf(request: CallableRequest<unknown>): string {
  if (!request.auth) fail("unauthenticated", "Sign in with Google to continue.");
  return request.auth.uid;
}

function text(value: unknown, name: string, maximum = 100): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) {
    fail("invalid-argument", `Enter a valid ${name}.`);
  }
  return value.trim();
}

function minorUnits(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 100_000_000) {
    fail("invalid-argument", "Enter a valid whole amount in the currency's minor unit.");
  }
  return value as number;
}

async function member(uid: string) {
  const snapshot = await group.collection("members").doc(uid).get();
  if (!snapshot.exists) fail("permission-denied", "You have not joined this group.");
  return { ref: snapshot.ref, data: snapshot.data()! };
}

async function approved(uid: string) {
  const result = await member(uid);
  if (result.data.status !== "approved") fail("permission-denied", "An organiser must approve your request first.");
  return result;
}

async function organizer(uid: string) {
  const result = await approved(uid);
  if (!(["owner", "organizer"] as unknown[]).includes(result.data.role)) {
    fail("permission-denied", "Only an organiser can do that.");
  }
  return result;
}

async function owner(uid: string) {
  const result = await organizer(uid);
  if (result.data.role !== "owner") fail("permission-denied", "Only the group owner can change this setting.");
  return result;
}

function timeZoneFrom(data: DocumentData | undefined): string {
  const timeZone = data?.timeZone;
  if (typeof timeZone !== "string" || !DateTime.now().setZone(timeZone).isValid) {
    fail("failed-precondition", "An organiser must configure the group time zone before check-in.");
  }
  return timeZone;
}

function currencyFrom(data: DocumentData | undefined): string {
  const currency = data?.currency;
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) {
    fail("failed-precondition", "The group owner must configure a currency before using fees or payments.");
  }
  return currency;
}

function feeQuery(uid: string, sessionDate: string) {
  return group.collection("members").doc(uid).collection("fees")
    .where("effectiveFrom", "<=", sessionDate).orderBy("effectiveFrom", "desc").limit(1);
}

function guestFeeQuery(guestId: string, sessionDate: string) {
  return group.collection("guests").doc(guestId).collection("fees")
    .where("effectiveFrom", "<=", sessionDate).orderBy("effectiveFrom", "desc").limit(1);
}

function attendanceId(sessionDate: string, uid: string) {
  return `${sessionDate}--${uid}`;
}

function fridayDate(value: unknown, timeZone: string): string {
  const date = text(value, "Friday session date", 10);
  const parsed = DateTime.fromISO(date, { zone: timeZone });
  if (!parsed.isValid || parsed.toISODate() !== date || parsed.weekday !== 5) {
    fail("invalid-argument", "Choose a valid Friday session date.");
  }
  return date;
}

function recordAudit(tx: Transaction, action: string, actorUid: string, subject: string, at: Date) {
  const ref = group.collection("audit").doc();
  tx.create(ref, { action, actorUid, subject, createdAt: Timestamp.fromDate(at) });
}

export const setGroupSettings = onCall(async (request) => {
  const actorUid = uidOf(request);
  await owner(actorUid);
  const timeZone = text(request.data?.timeZone, "time zone", 80);
  const currency = text(request.data?.currency, "currency", 3).toUpperCase();
  if (!DateTime.now().setZone(timeZone).isValid) fail("invalid-argument", "Choose a valid IANA time zone.");
  try {
    new Intl.NumberFormat("en", { style: "currency", currency }).format(0);
  } catch {
    fail("invalid-argument", "Choose a valid three-letter currency code.");
  }
  const at = now();
  const current = getSessionWindow(at, timeZone);
  await db.runTransaction(async (tx) => {
    const existing = await tx.get(settingsRef);
    const records = await Promise.all([
      tx.get(group.collection("attendance").limit(1)),
      tx.get(group.collection("charges").limit(1)),
      tx.get(group.collection("payments").limit(1)),
      tx.get(group.collection("guests").limit(1)),
      tx.get(db.collectionGroup("fees").limit(1)),
    ]);
    const changed = existing.exists && (existing.get("timeZone") !== timeZone || existing.get("currency") !== currency);
    if (changed && records.some((snapshot) => !snapshot.empty)) {
      fail("failed-precondition", "Time zone and currency cannot change after group records exist.");
    }
    tx.set(settingsRef, {
      timeZone,
      currency,
      launchSessionDate: changed || !existing.exists
        ? current.sessionDate
        : existing.get("launchSessionDate") ?? current.sessionDate,
      updatedAt: Timestamp.fromDate(at),
      updatedBy: actorUid,
    }, { merge: true });
  });
  return { timeZone, currency };
});

export const createInvite = onCall(async (request) => {
  const actorUid = uidOf(request);
  await organizer(actorUid);
  const code = randomBytes(24).toString("base64url");
  const inviteRef = group.collection("invites").doc(createHash("sha256").update(code).digest("hex"));
  const expiresAt = new Date(now().getTime() + 7 * 24 * 60 * 60 * 1000);
  await inviteRef.create({
    remainingUses: 20,
    createdBy: actorUid,
    createdAt: Timestamp.now(),
    expiresAt: Timestamp.fromDate(expiresAt),
  });
  return { code, expiresAt: expiresAt.toISOString() };
});

export const joinWithInvite = onCall(async (request) => {
  const uid = uidOf(request);
  const code = text(request.data?.code, "invite code", 100);
  const name = text(request.auth!.token.name, "Google display name", 80);
  const inviteRef = group.collection("invites").doc(createHash("sha256").update(code).digest("hex"));
  const memberRef = group.collection("members").doc(uid);
  const requestRef = group.collection("requests").doc(uid);
  return db.runTransaction(async (tx) => {
    const [invite, existing] = await Promise.all([tx.get(inviteRef), tx.get(memberRef)]);
    if (existing.exists && ["pending", "approved"].includes(existing.get("status"))) {
      return { status: existing.get("status") as string };
    }
    if (!invite.exists || invite.get("remainingUses") < 1 || invite.get("expiresAt").toDate() <= now()) {
      fail("not-found", "This invite is invalid or expired. Ask an organiser for a new one.");
    }
    const at = Timestamp.now();
    tx.update(inviteRef, { remainingUses: FieldValue.increment(-1) });
    tx.set(memberRef, { displayName: name, role: "player", status: "pending", requestedAt: at });
    tx.set(requestRef, { displayName: name, requestedAt: at });
    return { status: "pending" };
  });
});

export const approveMember = onCall(async (request) => {
  const actorUid = uidOf(request);
  await organizer(actorUid);
  const uid = text(request.data?.playerUid, "player", 128);
  const amountMinor = minorUnits(request.data?.amountMinor);
  const memberRef = group.collection("members").doc(uid);
  const requestRef = group.collection("requests").doc(uid);
  const settings = await settingsRef.get();
  const timeZone = timeZoneFrom(settings.data());
  currencyFrom(settings.data());
  const effectiveFrom = getSessionWindow(now(), timeZone).sessionDate;
  const feeRef = memberRef.collection("fees").doc(effectiveFrom);
  const at = Timestamp.now();
  await db.runTransaction(async (tx) => {
    const [player, pending] = await Promise.all([tx.get(memberRef), tx.get(requestRef)]);
    if (!player.exists || player.get("status") !== "pending" || !pending.exists) {
      fail("failed-precondition", "This player no longer has a pending request.");
    }
    tx.update(memberRef, { status: "approved", approvedAt: at, approvedBy: actorUid });
    tx.create(feeRef, { amountMinor, effectiveFrom, createdAt: at, createdBy: actorUid });
    tx.delete(requestRef);
    recordAudit(tx, "member-approved", actorUid, uid, at.toDate());
  });
  return { playerUid: uid, effectiveFrom };
});

export const updateMemberFee = onCall(async (request) => {
  const actorUid = uidOf(request);
  await organizer(actorUid);
  const uid = text(request.data?.playerUid, "player", 128);
  const amountMinor = minorUnits(request.data?.amountMinor);
  const settings = await settingsRef.get();
  const timeZone = timeZoneFrom(settings.data());
  currencyFrom(settings.data());
  const effectiveFrom = nextFeeEffectiveSessionDate(now(), timeZone);
  const memberRef = group.collection("members").doc(uid);
  const feeRef = memberRef.collection("fees").doc(effectiveFrom);
  const at = Timestamp.now();
  await db.runTransaction(async (tx) => {
    const player = await tx.get(memberRef);
    if (!player.exists || player.get("status") !== "approved") fail("not-found", "Approved player not found.");
    tx.set(feeRef, { amountMinor, effectiveFrom, createdAt: at, createdBy: actorUid });
    recordAudit(tx, "fee-updated", actorUid, uid, at.toDate());
  });
  return { playerUid: uid, amountMinor, effectiveFrom };
});

export const setOrganizerRole = onCall(async (request) => {
  const actorUid = uidOf(request);
  await owner(actorUid);
  const uid = text(request.data?.playerUid, "player", 128);
  const role = request.data?.role;
  if (role !== "organizer" && role !== "player") fail("invalid-argument", "Role must be organizer or player.");
  const targetRef = group.collection("members").doc(uid);
  const at = Timestamp.now();
  await db.runTransaction(async (tx) => {
    const target = await tx.get(targetRef);
    if (!target.exists || target.get("status") !== "approved") fail("not-found", "Approved player not found.");
    if (target.get("role") === "owner") fail("failed-precondition", "The owner role cannot be changed here.");
    tx.update(targetRef, { role, roleUpdatedAt: at, roleUpdatedBy: actorUid });
    recordAudit(tx, "role-updated", actorUid, uid, at.toDate());
  });
  return { playerUid: uid, role };
});

export const getSessionInfo = onCall(async (request) => {
  const uid = uidOf(request);
  await approved(uid);
  const settings = await settingsRef.get();
  const data = settings.data();
  if (!data || typeof data.timeZone !== "string" || typeof data.currency !== "string") {
    return { configured: false };
  }
  const session = getSessionWindow(now(), timeZoneFrom(data));
  return {
    configured: true,
    sessionDate: session.sessionDate,
    currentDate: DateTime.fromJSDate(now(), { zone: "utc" }).setZone(data.timeZone).toISODate(),
    isOpen: session.isOpen,
    opensAt: session.opensAt,
    closesAt: session.closesAt,
    timeZone: data.timeZone,
    currency: currencyFrom(data),
  };
});

export const checkIn = onCall(async (request) => {
  const uid = uidOf(request);
  const at = now();
  const settings = await settingsRef.get();
  const timeZone = timeZoneFrom(settings.data());
  currencyFrom(settings.data());
  const session = getSessionWindow(at, timeZone);
  if (!session.isOpen) fail("failed-precondition", "Check-in is open Friday at 7 PM until Saturday at 5 PM.");
  const memberRef = group.collection("members").doc(uid);
  const attendanceRef = group.collection("attendance").doc(attendanceId(session.sessionDate, uid));
  const chargeRef = group.collection("charges").doc(attendanceId(session.sessionDate, uid));
  const auditTime = Timestamp.fromDate(at);
  return db.runTransaction(async (tx) => {
    const [player, attendance, charge, fees] = await Promise.all([
      tx.get(memberRef), tx.get(attendanceRef), tx.get(chargeRef), tx.get(feeQuery(uid, session.sessionDate)),
    ]);
    if (!player.exists || player.get("status") !== "approved") fail("permission-denied", "An organiser must approve your request first.");
    const linkedGuestId = player.get("linkedGuestId");
    if (typeof linkedGuestId === "string") {
      const linkedId = attendanceId(session.sessionDate, `guest-${linkedGuestId}`);
      const [linkedAttendance, linkedCharge] = await Promise.all([
        tx.get(group.collection("attendance").doc(linkedId)), tx.get(group.collection("charges").doc(linkedId)),
      ]);
      if (linkedAttendance.exists !== linkedCharge.exists) fail("data-loss", "Linked guest records do not match. Ask an organiser to review them.");
      if (linkedAttendance.exists && linkedAttendance.get("status") === "active") {
        if (linkedCharge.get("status") !== "active") fail("data-loss", "Linked guest records do not match. Ask an organiser to review them.");
        return { status: "checked-in", sessionDate: session.sessionDate };
      }
    }
    if (attendance.exists && attendance.get("status") === "active") {
      if (!charge.exists || charge.get("status") !== "active") fail("data-loss", "The attendance record is incomplete. Ask an organiser to review it.");
      return { status: "checked-in", sessionDate: session.sessionDate };
    }
    if (attendance.exists) {
      if (!charge.exists) fail("data-loss", "The attendance record is incomplete. Ask an organiser to review it.");
      tx.update(attendanceRef, { status: "active", checkedInAt: auditTime, updatedAt: auditTime });
      tx.update(chargeRef, { status: "active", updatedAt: auditTime });
    } else {
      if (fees.empty) fail("failed-precondition", "An organiser must set your session fee first.");
      const fee = fees.docs[0];
      const amountMinor = minorUnits(fee.get("amountMinor"));
      tx.create(attendanceRef, {
        playerUid: uid,
        displayName: player.get("displayName"),
        sessionDate: session.sessionDate,
        status: "active",
        checkedInAt: auditTime,
        checkedInBy: uid,
      });
      tx.create(chargeRef, {
        playerUid: uid,
        attendanceId: attendanceRef.id,
        sessionDate: session.sessionDate,
        amountMinor,
        feeId: fee.id,
        status: "active",
        createdAt: auditTime,
      });
    }
    recordAudit(tx, "player-checked-in", uid, session.sessionDate, at);
    return { status: "checked-in", sessionDate: session.sessionDate };
  });
});

export const undoCheckIn = onCall(async (request) => {
  const uid = uidOf(request);
  await approved(uid);
  const settings = await settingsRef.get();
  const session = getSessionWindow(now(), timeZoneFrom(settings.data()));
  if (!session.isOpen) fail("failed-precondition", "Your check-in can only be undone before Saturday at 5 PM.");
  const attendanceRef = group.collection("attendance").doc(attendanceId(session.sessionDate, uid));
  const chargeRef = group.collection("charges").doc(attendanceId(session.sessionDate, uid));
  const at = Timestamp.now();
  await db.runTransaction(async (tx) => {
    const attendance = await tx.get(attendanceRef);
    if (!attendance.exists || attendance.get("status") !== "active") fail("failed-precondition", "There is no check-in to undo.");
    const charge = await tx.get(chargeRef);
    if (!charge.exists || charge.get("status") !== "active") fail("data-loss", "The attendance record is incomplete. Ask an organiser to review it.");
    tx.update(attendanceRef, { status: "void", updatedAt: at, correctedBy: uid });
    tx.update(chargeRef, { status: "void", updatedAt: at });
    recordAudit(tx, "player-undid-check-in", uid, session.sessionDate, at.toDate());
  });
  return { status: "undone", sessionDate: session.sessionDate };
});

export const recordAttendance = onCall(async (request) => {
  const actorUid = uidOf(request);
  await organizer(actorUid);
  const uid = text(request.data?.playerUid, "player", 128);
  const settings = await settingsRef.get();
  const settingsData = settings.data();
  const timeZone = timeZoneFrom(settingsData);
  currencyFrom(settingsData);
  const sessionDate = fridayDate(request.data?.sessionDate, timeZone);
  const atDate = now();
  const window = getSessionWindow(atDate, timeZone);
  const latestAllowed = window.isOpen
    ? window.sessionDate
    : DateTime.fromISO(window.sessionDate, { zone: timeZone }).minus({ days: 7 }).toISODate()!;
  if (sessionDate > latestAllowed || sessionDate < settingsData!.launchSessionDate) {
    fail("failed-precondition", "Attendance can only be corrected for sessions since the group started.");
  }
  const memberRef = group.collection("members").doc(uid);
  const attendanceRef = group.collection("attendance").doc(attendanceId(sessionDate, uid));
  const chargeRef = group.collection("charges").doc(attendanceId(sessionDate, uid));
  if (typeof request.data?.present !== "boolean") fail("invalid-argument", "Attendance must be marked present or absent.");
  const markedPresent = request.data.present;
  const at = Timestamp.fromDate(atDate);
  await db.runTransaction(async (tx) => {
    const [player, attendance, charge, fees] = await Promise.all([
      tx.get(memberRef), tx.get(attendanceRef), tx.get(chargeRef), tx.get(feeQuery(uid, sessionDate)),
    ]);
    if (!player.exists || player.get("status") !== "approved") fail("not-found", "Approved player not found.");
    if (attendance.exists !== charge.exists) fail("data-loss", "Attendance and charge records do not match. Ask an organiser to review them.");
    const linkedGuestId = player.get("linkedGuestId");
    if (typeof linkedGuestId === "string") {
      const linkedId = attendanceId(sessionDate, `guest-${linkedGuestId}`);
      const linkedAttendanceRef = group.collection("attendance").doc(linkedId);
      const linkedChargeRef = group.collection("charges").doc(linkedId);
      const [linkedAttendance, linkedCharge] = await Promise.all([
        tx.get(linkedAttendanceRef), tx.get(linkedChargeRef),
      ]);
      if (linkedAttendance.exists !== linkedCharge.exists) fail("data-loss", "Linked guest records do not match. Ask an organiser to review them.");
      if (linkedAttendance.exists && (
        !["active", "void"].includes(linkedAttendance.get("status")) ||
        linkedAttendance.get("status") !== linkedCharge.get("status")
      )) fail("data-loss", "Linked guest attendance and charge statuses do not match. Ask an organiser to review them.");
      if (attendance.exists && attendance.get("status") === "active" && linkedAttendance.exists && linkedAttendance.get("status") === "active") {
        fail("data-loss", "This player has duplicate attendance for the session.");
      }
      if (linkedAttendance.exists) {
        const guestActive = linkedAttendance.get("status") === "active";
        const memberActive = attendance.exists && attendance.get("status") === "active";
        if (guestActive && memberActive) fail("data-loss", "This player has duplicate attendance for the session.");
        if (guestActive && markedPresent) return;
        if (guestActive) {
          tx.update(linkedAttendanceRef, { status: "void", updatedAt: at, correctedBy: actorUid });
          tx.update(linkedChargeRef, { status: "void", updatedAt: at });
          recordAudit(tx, "organizer-removed-attendance", actorUid, `${sessionDate}:${uid}`, at.toDate());
          return;
        }
        if (markedPresent && !memberActive) {
          tx.update(linkedAttendanceRef, { status: "active", updatedAt: at, correctedBy: actorUid });
          tx.update(linkedChargeRef, { status: "active", updatedAt: at });
          recordAudit(tx, "organizer-added-attendance", actorUid, `${sessionDate}:${uid}`, at.toDate());
          return;
        }
      }
      if (markedPresent && !attendance.exists) {
        const [guest, guestFees] = await Promise.all([
          tx.get(group.collection("guests").doc(linkedGuestId)),
          tx.get(guestFeeQuery(linkedGuestId, sessionDate)),
        ]);
        if (guest.exists && guest.get("linkedUid") === uid && !guestFees.empty) {
          const fee = guestFees.docs[0];
          tx.create(linkedAttendanceRef, {
            playerUid: `guest:${linkedGuestId}`, guestId: linkedGuestId, displayName: guest.get("displayName"), sessionDate,
            status: "active", checkedInAt: at, checkedInBy: actorUid, correctedBy: actorUid,
          });
          tx.create(linkedChargeRef, {
            playerUid: `guest:${linkedGuestId}`, guestId: linkedGuestId, attendanceId: linkedAttendanceRef.id, sessionDate,
            amountMinor: minorUnits(fee.get("amountMinor")), feeId: fee.id, status: "active", createdAt: at,
          });
          recordAudit(tx, "organizer-added-attendance", actorUid, `${sessionDate}:${uid}`, at.toDate());
          return;
        }
      }
    }
    if (!markedPresent) {
      if (attendance.exists && attendance.get("status") === "active") {
        if (!charge.exists) fail("data-loss", "The attendance record is incomplete.");
        tx.update(attendanceRef, { status: "void", updatedAt: at, correctedBy: actorUid });
        tx.update(chargeRef, { status: "void", updatedAt: at });
      } else if (!attendance.exists && charge.exists) {
        fail("data-loss", "A charge exists without attendance. Ask an organiser to review it.");
      }
    } else if (attendance.exists && attendance.get("status") === "active") {
      if (charge.get("status") !== "active") fail("data-loss", "Attendance and charge records do not match. Ask an organiser to review them.");
      return;
    } else if (attendance.exists) {
      if (!charge.exists) fail("data-loss", "The attendance record is incomplete.");
      tx.update(attendanceRef, { status: "active", updatedAt: at, correctedBy: actorUid });
      tx.update(chargeRef, { status: "active", updatedAt: at });
    } else {
      if (charge.exists) fail("data-loss", "A charge exists without attendance. Ask an organiser to review it.");
      if (fees.empty) fail("failed-precondition", "Set a session fee before recording attendance.");
      const fee = fees.docs[0];
      tx.create(attendanceRef, {
        playerUid: uid, displayName: player.get("displayName"), sessionDate,
        status: "active", checkedInAt: at, checkedInBy: actorUid, correctedBy: actorUid,
      });
      tx.create(chargeRef, {
        playerUid: uid, attendanceId: attendanceRef.id, sessionDate,
        amountMinor: minorUnits(fee.get("amountMinor")), feeId: fee.id, status: "active", createdAt: at,
      });
    }
    recordAudit(tx, markedPresent ? "organizer-added-attendance" : "organizer-removed-attendance", actorUid, `${sessionDate}:${uid}`, at.toDate());
  });
  return { sessionDate, playerUid: uid, present: markedPresent };
});

export const createGuest = onCall(async (request) => {
  const actorUid = uidOf(request);
  await organizer(actorUid);
  const displayName = text(request.data?.displayName, "guest name", 80);
  const amountMinor = minorUnits(request.data?.amountMinor);
  const settings = await settingsRef.get();
  const settingsData = settings.data();
  const timeZone = timeZoneFrom(settingsData);
  currencyFrom(settingsData);
  const effectiveFrom = fridayDate(settingsData?.launchSessionDate, timeZone);
  const guestRef = group.collection("guests").doc();
  const at = Timestamp.now();
  await db.runTransaction(async (tx) => {
    tx.create(guestRef, { displayName, status: "active", createdAt: at, createdBy: actorUid });
    tx.create(guestRef.collection("fees").doc(effectiveFrom), { amountMinor, effectiveFrom, createdAt: at, createdBy: actorUid });
    recordAudit(tx, "guest-created", actorUid, guestRef.id, at.toDate());
  });
  return { guestId: guestRef.id, effectiveFrom };
});

export const updateGuestFee = onCall(async (request) => {
  const actorUid = uidOf(request);
  await organizer(actorUid);
  const guestId = text(request.data?.guestId, "guest", 128);
  const amountMinor = minorUnits(request.data?.amountMinor);
  const settings = await settingsRef.get();
  const effectiveFrom = nextFeeEffectiveSessionDate(now(), timeZoneFrom(settings.data()));
  currencyFrom(settings.data());
  const guestRef = group.collection("guests").doc(guestId);
  const at = Timestamp.now();
  await db.runTransaction(async (tx) => {
    const guest = await tx.get(guestRef);
    if (!guest.exists || guest.get("status") !== "active") fail("not-found", "Active guest not found.");
    tx.set(guestRef.collection("fees").doc(effectiveFrom), { amountMinor, effectiveFrom, createdAt: at, createdBy: actorUid });
    recordAudit(tx, "guest-fee-updated", actorUid, guestId, at.toDate());
  });
  return { guestId, amountMinor, effectiveFrom };
});

export const linkGuestAccount = onCall(async (request) => {
  const actorUid = uidOf(request);
  await organizer(actorUid);
  const guestId = text(request.data?.guestId, "guest", 128);
  const uid = text(request.data?.playerUid, "player", 128);
  const guestRef = group.collection("guests").doc(guestId);
  const memberRef = group.collection("members").doc(uid);
  const at = Timestamp.now();
  await db.runTransaction(async (tx) => {
    const [guest, player, memberAttendance, guestAttendance] = await Promise.all([
      tx.get(guestRef), tx.get(memberRef),
      tx.get(group.collection("attendance").where("playerUid", "==", uid)),
      tx.get(group.collection("attendance").where("guestId", "==", guestId)),
    ]);
    if (!guest.exists || guest.get("status") !== "active" || guest.get("linkedUid")) fail("failed-precondition", "This guest has already been linked or is unavailable.");
    if (!player.exists || player.get("status") !== "approved" || player.get("linkedGuestId")) fail("failed-precondition", "Choose an approved player without a linked guest account.");
    const activeMemberSessions = new Set(memberAttendance.docs.filter((entry) => entry.get("status") === "active").map((entry) => entry.get("sessionDate")));
    if (guestAttendance.docs.some((entry) => entry.get("status") === "active" && activeMemberSessions.has(entry.get("sessionDate")))) {
      fail("failed-precondition", "These records include the same session twice. Correct the duplicate attendance before linking.");
    }
    tx.update(guestRef, { status: "linked", linkedUid: uid, linkedAt: at, linkedBy: actorUid });
    tx.update(memberRef, { linkedGuestId: guestId });
    recordAudit(tx, "guest-account-linked", actorUid, `${guestId}:${uid}`, at.toDate());
  });
  return { guestId, playerUid: uid };
});

export const recordGuestAttendance = onCall(async (request) => {
  const actorUid = uidOf(request);
  await organizer(actorUid);
  const guestId = text(request.data?.guestId, "guest", 128);
  const settings = await settingsRef.get();
  const data = settings.data();
  const timeZone = timeZoneFrom(data);
  currencyFrom(data);
  const sessionDate = fridayDate(request.data?.sessionDate, timeZone);
  const atDate = now();
  const window = getSessionWindow(atDate, timeZone);
  const latestAllowed = window.isOpen ? window.sessionDate : DateTime.fromISO(window.sessionDate, { zone: timeZone }).minus({ days: 7 }).toISODate()!;
  if (sessionDate > latestAllowed || sessionDate < data!.launchSessionDate) fail("failed-precondition", "Attendance can only be corrected for sessions since the group started.");
  const guestRef = group.collection("guests").doc(guestId);
  const id = attendanceId(sessionDate, `guest-${guestId}`);
  const attendanceRef = group.collection("attendance").doc(id);
  const chargeRef = group.collection("charges").doc(id);
  if (typeof request.data?.present !== "boolean") fail("invalid-argument", "Attendance must be marked present or absent.");
  const present = request.data.present;
  const at = Timestamp.fromDate(atDate);
  await db.runTransaction(async (tx) => {
    const [guest, attendance, charge, fees] = await Promise.all([
      tx.get(guestRef), tx.get(attendanceRef), tx.get(chargeRef), tx.get(guestFeeQuery(guestId, sessionDate)),
    ]);
    if (!guest.exists || guest.get("status") !== "active") fail("not-found", "Active guest not found.");
    if (attendance.exists !== charge.exists) fail("data-loss", "Attendance and charge records do not match. Ask an organiser to review them.");
    if (!present) {
      if (attendance.exists && attendance.get("status") === "active") {
        if (!charge.exists) fail("data-loss", "The attendance record is incomplete.");
        tx.update(attendanceRef, { status: "void", updatedAt: at, correctedBy: actorUid });
        tx.update(chargeRef, { status: "void", updatedAt: at });
      }
    } else if (attendance.exists && attendance.get("status") === "active") {
      if (!charge.exists || charge.get("status") !== "active") fail("data-loss", "The attendance record is incomplete.");
      return;
    } else if (attendance.exists) {
      if (!charge.exists) fail("data-loss", "The attendance record is incomplete.");
      tx.update(attendanceRef, { status: "active", updatedAt: at, correctedBy: actorUid });
      tx.update(chargeRef, { status: "active", updatedAt: at });
    } else {
      if (charge.exists) fail("data-loss", "A charge exists without attendance.");
      if (fees.empty) fail("failed-precondition", "Set a guest fee before recording attendance.");
      const fee = fees.docs[0];
      tx.create(attendanceRef, { playerUid: `guest:${guestId}`, guestId, displayName: guest.get("displayName"), sessionDate, status: "active", checkedInAt: at, checkedInBy: actorUid, correctedBy: actorUid });
      tx.create(chargeRef, { playerUid: `guest:${guestId}`, guestId, attendanceId: id, sessionDate, amountMinor: minorUnits(fee.get("amountMinor")), feeId: fee.id, status: "active", createdAt: at });
    }
    recordAudit(tx, present ? "guest-attendance-added" : "guest-attendance-removed", actorUid, `${sessionDate}:${guestId}`, at.toDate());
  });
  return { guestId, sessionDate, present };
});

export const recordGuestPayment = onCall(async (request) => {
  const actorUid = uidOf(request);
  await organizer(actorUid);
  const guestId = text(request.data?.guestId, "guest", 128);
  const amountMinor = minorUnits(request.data?.amountMinor);
  if (amountMinor < 1) fail("invalid-argument", "Enter a payment greater than zero.");
  currencyFrom((await settingsRef.get()).data());
  const requestId = text(request.data?.requestId, "payment request ID", 64);
  if (!/^[a-zA-Z0-9_-]+$/.test(requestId)) fail("invalid-argument", "Invalid payment request ID.");
  const paymentRef = group.collection("payments").doc(`guest-${guestId}--${requestId}`);
  const guestRef = group.collection("guests").doc(guestId);
  const at = Timestamp.now();
  await db.runTransaction(async (tx) => {
    const [guest, existing] = await Promise.all([tx.get(guestRef), tx.get(paymentRef)]);
    if (!guest.exists || guest.get("status") !== "active") fail("not-found", "Active guest not found.");
    if (existing.exists) {
      if (existing.get("amountMinor") !== amountMinor) fail("already-exists", "This payment request ID was already used.");
      return;
    }
    tx.create(paymentRef, { playerUid: `guest:${guestId}`, guestId, amountMinor, receivedAt: at, enteredBy: actorUid, note: typeof request.data?.note === "string" ? request.data.note.slice(0, 160) : "" });
    recordAudit(tx, "guest-payment-recorded", actorUid, paymentRef.id, at.toDate());
  });
  return { paymentId: paymentRef.id, amountMinor };
});

export const recordPayment = onCall(async (request) => {
  const actorUid = uidOf(request);
  await organizer(actorUid);
  const uid = text(request.data?.playerUid, "player", 128);
  const amountMinor = minorUnits(request.data?.amountMinor);
  if (amountMinor < 1) fail("invalid-argument", "Enter a payment greater than zero.");
  currencyFrom((await settingsRef.get()).data());
  const requestId = text(request.data?.requestId, "payment request ID", 64);
  if (!/^[a-zA-Z0-9_-]+$/.test(requestId)) fail("invalid-argument", "Invalid payment request ID.");
  const paymentRef = group.collection("payments").doc(`${uid}--${requestId}`);
  const at = Timestamp.now();
  await db.runTransaction(async (tx) => {
    const [player, existing] = await Promise.all([
      tx.get(group.collection("members").doc(uid)), tx.get(paymentRef),
    ]);
    if (!player.exists || player.get("status") !== "approved") fail("not-found", "Approved player not found.");
    if (existing.exists) {
      if (existing.get("amountMinor") !== amountMinor) fail("already-exists", "This payment request ID was already used.");
      return;
    }
    tx.create(paymentRef, {
      playerUid: uid, amountMinor, receivedAt: at, enteredBy: actorUid,
      note: typeof request.data?.note === "string" ? request.data.note.slice(0, 160) : "",
    });
    recordAudit(tx, "payment-recorded", actorUid, paymentRef.id, at.toDate());
  });
  return { paymentId: paymentRef.id, amountMinor };
});

export const reversePayment = onCall(async (request) => {
  const actorUid = uidOf(request);
  await organizer(actorUid);
  const paymentId = text(request.data?.paymentId, "payment", 180);
  const reason = text(request.data?.reason, "reversal reason", 160);
  const paymentRef = group.collection("payments").doc(paymentId);
  const reversalRef = group.collection("paymentReversals").doc(paymentId);
  const at = Timestamp.now();
  await db.runTransaction(async (tx) => {
    const [payment, reversal] = await Promise.all([tx.get(paymentRef), tx.get(reversalRef)]);
    if (!payment.exists) fail("not-found", "Payment not found.");
    if (reversal.exists) return;
    tx.create(reversalRef, {
      paymentUid: paymentId, playerUid: payment.get("playerUid"), guestId: payment.get("guestId") ?? null, amountMinor: payment.get("amountMinor"),
      reason, reversedBy: actorUid, reversedAt: at,
    });
    recordAudit(tx, "payment-reversed", actorUid, paymentId, at.toDate());
  });
  return { paymentId, reversed: true };
});
