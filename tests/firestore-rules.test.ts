import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, doc, getDoc, getDocs, query, setDoc, where } from "firebase/firestore";

const projectId = "demo-howmuchah";
const group = `groups/${"main"}`;
let environment: RulesTestEnvironment;

beforeAll(async () => {
  environment = await initializeTestEnvironment({
    projectId,
    firestore: { host: "127.0.0.1", port: 8080, rules: readFileSync("firestore.rules", "utf8") },
  });
});

beforeEach(async () => {
  await environment.clearFirestore();
  await environment.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, `${group}/members/player-a`), { status: "approved", role: "player", displayName: "Player A" });
    await setDoc(doc(db, `${group}/members/player-b`), { status: "approved", role: "player", displayName: "Player B" });
    await setDoc(doc(db, `${group}/members/player-a/fees/2026-10-23`), { amountMinor: 200, effectiveFrom: "2026-10-23" });
    await setDoc(doc(db, `${group}/members/player-b/fees/2026-10-23`), { amountMinor: 500, effectiveFrom: "2026-10-23" });
    await setDoc(doc(db, `${group}/members/pending`), { status: "pending", role: "player", displayName: "Pending" });
    await setDoc(doc(db, `${group}/members/organizer`), { status: "approved", role: "organizer", displayName: "Organizer" });
    await setDoc(doc(db, `${group}/guests/linked-guest`), { status: "linked", linkedUid: "player-a", displayName: "Guest A" });
    await setDoc(doc(db, `${group}/guests/other-guest`), { status: "linked", linkedUid: "player-b", displayName: "Guest B" });
    await setDoc(doc(db, `${group}/attendance/2026-10-23_player-a`), { playerUid: "player-a", displayName: "Player A", sessionDate: "2026-10-23" });
    await setDoc(doc(db, `${group}/charges/2026-10-23_player-a`), { playerUid: "player-a", amountMinor: 200, sessionDate: "2026-10-23" });
    await setDoc(doc(db, `${group}/charges/2026-10-23_player-b`), { playerUid: "player-b", amountMinor: 500, sessionDate: "2026-10-23" });
    await setDoc(doc(db, `${group}/charges/2026-10-23_linked-guest`), { playerUid: "guest:linked-guest", guestId: "linked-guest", amountMinor: 300, sessionDate: "2026-10-23" });
    await setDoc(doc(db, `${group}/payments/payment-a`), { playerUid: "player-a", amountMinor: 100, receivedAt: new Date() });
    await setDoc(doc(db, `${group}/payments/payment-b`), { playerUid: "player-b", amountMinor: 250, receivedAt: new Date() });
    await setDoc(doc(db, `${group}/requests/pending`), { displayName: "Pending" });
  });
});

afterAll(async () => environment.cleanup());

describe("Firestore access boundaries", () => {
  it("keeps all group data private from signed-out and pending users", async () => {
    const signedOut = environment.unauthenticatedContext().firestore();
    const pending = environment.authenticatedContext("pending").firestore();
    await assertFails(getDoc(doc(signedOut, `${group}/attendance/2026-10-23_player-a`)));
    await assertFails(getDoc(doc(pending, `${group}/attendance/2026-10-23_player-a`)));
    await assertFails(getDoc(doc(pending, `${group}/charges/2026-10-23_player-a`)));
    await assertSucceeds(getDoc(doc(pending, `${group}/members/pending`)));
  });

  it("shares attendance but restricts fees, charges, and payments to self or organisers", async () => {
    const player = environment.authenticatedContext("player-a").firestore();
    const organizer = environment.authenticatedContext("organizer").firestore();
    await assertSucceeds(getDoc(doc(player, `${group}/attendance/2026-10-23_player-a`)));
    await assertSucceeds(getDoc(doc(player, `${group}/charges/2026-10-23_player-a`)));
    await assertFails(getDoc(doc(player, `${group}/charges/2026-10-23_player-b`)));
    await assertSucceeds(getDoc(doc(player, `${group}/payments/payment-a`)));
    await assertFails(getDoc(doc(player, `${group}/payments/payment-b`)));
    await assertSucceeds(getDoc(doc(player, `${group}/members/player-a/fees/2026-10-23`)));
    await assertFails(getDoc(doc(player, `${group}/members/player-b/fees/2026-10-23`)));
    await assertSucceeds(getDoc(doc(organizer, `${group}/charges/2026-10-23_player-b`)));
    await assertSucceeds(getDoc(doc(player, `${group}/charges/2026-10-23_linked-guest`)));
    await assertSucceeds(getDocs(query(collection(player, `${group}/charges`), where("guestId", "==", "linked-guest"))));
    const otherPlayer = environment.authenticatedContext("player-b").firestore();
    await assertFails(getDoc(doc(otherPlayer, `${group}/charges/2026-10-23_linked-guest`)));
  });

  it("prevents clients from writing role, attendance, and finance records", async () => {
    const player = environment.authenticatedContext("player-a").firestore();
    await assertFails(setDoc(doc(player, `${group}/attendance/new`), { playerUid: "player-a" }));
    await assertFails(setDoc(doc(player, `${group}/charges/new`), { playerUid: "player-a", amountMinor: 1 }));
    await assertFails(setDoc(doc(player, `${group}/members/player-a`), { status: "approved", role: "owner" }));
  });

  it("allows organisers to list pending requests while players cannot", async () => {
    const player = environment.authenticatedContext("player-a").firestore();
    const organizer = environment.authenticatedContext("organizer").firestore();
    await assertFails(getDocs(collection(player, `${group}/requests`)));
    await assertSucceeds(getDocs(collection(organizer, `${group}/requests`)));
  });

  it("lets approved players list approved public member profiles", async () => {
    const player = environment.authenticatedContext("player-a").firestore();
    await assertSucceeds(getDocs(query(collection(player, `${group}/members`), where("status", "==", "approved"))));
  });
});
