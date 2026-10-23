import { afterEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createApp } from "../server/src/app.js";

const apps: Awaited<ReturnType<typeof createApp>>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

function pool(rowsFor: (sql: string) => unknown[] = () => []) {
  const query = async (sql: string) => ({ rows: rowsFor(sql) });
  const client = { query, release() {} };
  return { query, connect: async () => client } as unknown as Pool;
}

describe("API access boundary", () => {
  it("lets a player update only their own validated group nickname", async () => {
    const sql: Array<{ statement: string; values?: unknown[] }> = [];
    const mockPool = {
      query: async () => ({ rows: [] }),
      connect: async () => ({
        query: async (statement: string, values?: unknown[]) => {
          sql.push({ statement, values });
          return { rows: [], rowCount: statement.startsWith("UPDATE members") ? 1 : 0 };
        },
        release() {},
      }),
    } as unknown as Pool;
    const app = await createApp({ pool: mockPool, verify: async () => ({ sub: "player-1" }) });
    apps.push(app);
    const headers = { authorization: "Bearer valid" };
    const response = await app.inject({ method: "POST", url: "/api/actions/updateMyNickname", headers, payload: { nickname: "Rally" } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ nickname: "Rally" });
    expect(sql.find(({ statement }) => statement.startsWith("UPDATE members"))?.values).toEqual(["player-1", "Rally"]);

    const invalid = await app.inject({ method: "POST", url: "/api/actions/updateMyNickname", headers, payload: { nickname: "  " } });
    expect(invalid.statusCode).toBe(400);
  });

  it("keeps health public and requires sign-in for app data", async () => {
    const app = await createApp({ pool: pool(), env: { APP_ORIGINS: "http://localhost:5173" } });
    apps.push(app);
    expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/bootstrap" })).statusCode).toBe(401);
  });

  it("keeps an invite code active until an organiser revokes it", async () => {
    const owner = { uid: "owner-1", role: "owner", status: "approved" };
    let activeCode: string | null = null;
    let inserts = 0;
    const mockPool = {
      query: async () => ({ rows: [] }),
      connect: async () => ({
        query: async (statement: string, values?: unknown[]) => {
          if (statement === "SELECT * FROM members WHERE uid = $1") return { rows: [owner] };
          if (statement.startsWith("SELECT code FROM invites")) return { rows: activeCode ? [{ code: activeCode }] : [] };
          if (statement.startsWith("INSERT INTO invites")) {
            inserts++;
            activeCode = String(values?.[1]);
            expect(statement).toContain("VALUES ($1, $2, NULL, $3, NULL)");
            return { rows: [{ code: activeCode }], rowCount: 1 };
          }
          if (statement.startsWith("UPDATE invites SET revoked_at")) {
            const wasActive = activeCode !== null;
            activeCode = null;
            return { rows: wasActive ? [{ token_hash: "hash" }] : [], rowCount: wasActive ? 1 : 0 };
          }
          return { rows: [], rowCount: 1 };
        },
        release() {},
      }),
    } as unknown as Pool;
    const app = await createApp({ pool: mockPool, verify: async () => ({ sub: "owner-1" }) });
    apps.push(app);

    const headers = { authorization: "Bearer valid" };
    const create = () => app.inject({ method: "POST", url: "/api/actions/createInvite", headers, payload: {} });
    const first = await create();
    const code = first.json().code as string;
    const second = await create();

    expect(first.statusCode).toBe(200);
    expect(code).toMatch(/^[A-Za-z0-9_-]{6}$/);
    expect(second.json().code).toBe(code);
    expect(inserts).toBe(1);

    const revoked = await app.inject({ method: "POST", url: "/api/actions/revokeInvite", headers, payload: {} });
    expect(revoked.statusCode).toBe(200);
    expect(activeCode).toBeNull();
    expect((await create()).statusCode).toBe(200);
    expect(inserts).toBe(2);
  });

  it("returns the active invite only to organisers", async () => {
    const activeCode = "a1b2c3";
    const getBootstrap = async (role: string) => {
      let queriedInvite = false;
      const app = await createApp({
        pool: pool((statement) => {
          if (statement.startsWith("SELECT count(*)")) return [{ count: 1 }];
          if (statement === "SELECT * FROM members WHERE uid = $1") return [{ uid: "user-1", display_name: "Player", role, status: "approved" }];
          if (statement.includes("FROM group_settings")) return [];
          if (statement.includes("FROM invites")) { queriedInvite = true; return [{ code: activeCode }]; }
          return [];
        }),
        verify: async () => ({ sub: "user-1" }),
      });
      apps.push(app);
      const response = await app.inject({ method: "GET", url: "/api/bootstrap", headers: { authorization: "Bearer valid" } });
      return { body: response.json(), queriedInvite };
    };

    const organizer = await getBootstrap("organizer");
    const player = await getBootstrap("player");
    expect(organizer.body.inviteCode).toBe(activeCode);
    expect(player.body.inviteCode).toBeUndefined();
    expect(player.queriedInvite).toBe(false);
  });

  it("accepts persistent invite codes without consuming uses", async () => {
    const statements: string[] = [];
    const invite = { token_hash: "hash", remaining_uses: null, expires_at: null, revoked_at: null };
    let uid = 0;
    const mockPool = {
      query: async () => ({ rows: [] }),
      connect: async () => ({
        query: async (statement: string) => {
          statements.push(statement);
          if (statement === "SELECT status FROM members WHERE uid = $1") return { rows: [] };
          if (statement.startsWith("SELECT * FROM invites")) return { rows: [invite] };
          return { rows: [], rowCount: 1 };
        },
        release() {},
      }),
    } as unknown as Pool;
    const app = await createApp({
      pool: mockPool,
      verify: async () => ({ sub: `player-${++uid}` }),
      userProfile: async (playerUid) => ({ name: playerUid, verified: true }),
    });
    apps.push(app);

    for (let i = 0; i < 2; i++) {
      const response = await app.inject({ method: "POST", url: "/api/actions/joinWithInvite", headers: { authorization: "Bearer valid" }, payload: { code: "a1b2c3" } });
      expect(response.statusCode).toBe(200);
      expect(response.json().status).toBe("pending");
    }
    expect(statements.some((statement) => statement.includes("remaining_uses = remaining_uses - 1"))).toBe(false);
  });

  it("rejects a revoked persistent invite", async () => {
    const invite = { token_hash: "hash", remaining_uses: null, expires_at: null, revoked_at: new Date() };
    let memberCreated = false;
    const mockPool = {
      query: async () => ({ rows: [] }),
      connect: async () => ({
        query: async (statement: string) => {
          if (statement === "SELECT status FROM members WHERE uid = $1") return { rows: [] };
          if (statement.startsWith("SELECT * FROM invites")) return { rows: [invite] };
          if (statement.startsWith("INSERT INTO members")) memberCreated = true;
          return { rows: [], rowCount: 1 };
        },
        release() {},
      }),
    } as unknown as Pool;
    const app = await createApp({
      pool: mockPool,
      verify: async () => ({ sub: "player-1" }),
      userProfile: async () => ({ name: "Player", verified: true }),
    });
    apps.push(app);

    const response = await app.inject({ method: "POST", url: "/api/actions/joinWithInvite", headers: { authorization: "Bearer valid" }, payload: { code: "a1b2c3" } });

    expect(response.statusCode).toBe(404);
    expect(memberCreated).toBe(false);
  });

  it("reports unavailable when PostgreSQL cannot be reached", async () => {
    const unavailablePool = { query: async () => { throw new Error("connection refused"); } } as unknown as Pool;
    const app = await createApp({ pool: unavailablePool });
    apps.push(app);
    const response = await app.inject({ method: "GET", url: "/api/health" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ ok: false });
  });

  it("rejects invalid Clerk tokens before reaching the database", async () => {
    const app = await createApp({ pool: pool(), verify: async () => { throw new Error("invalid token"); } });
    apps.push(app);
    const response = await app.inject({ method: "POST", url: "/api/actions/checkIn", headers: { authorization: "Bearer invalid" }, payload: {} });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "Your sign-in has expired. Sign in again." });
  });

  it("removes a guest from active use without deleting their history", async () => {
    const sql: string[] = [];
    const owner = { uid: "owner-1", role: "owner", status: "approved" };
    const mockPool = pool((statement) => {
      sql.push(statement);
      if (statement === "SELECT * FROM members WHERE uid = $1") return [owner];
      if (statement.includes("FROM guests WHERE id = $1") && statement.includes("FOR UPDATE")) return [{ id: "guest-1" }];
      return [];
    });
    const app = await createApp({ pool: mockPool, verify: async () => ({ sub: "owner-1" }) });
    apps.push(app);
    const response = await app.inject({ method: "POST", url: "/api/actions/removeGuest", headers: { authorization: "Bearer valid" }, payload: { guestId: "guest-1" } });
    expect(response.statusCode).toBe(200);
    expect(sql.some((statement) => statement.includes("UPDATE guests SET removed_at = now()"))).toBe(true);
    expect(sql.some((statement) => statement.includes("DELETE FROM guests"))).toBe(false);
  });

  it("removes an approved player from group access without deleting their history", async () => {
    const sql: string[] = [];
    const organizer = { uid: "organizer-1", role: "organizer", status: "approved" };
    const mockPool = {
      query: async (statement: string) => ({ rows: statement === "SELECT * FROM members WHERE uid = $1" ? [organizer] : [] }),
      connect: async () => ({
        query: async (statement: string) => {
          sql.push(statement);
          if (statement === "SELECT * FROM members WHERE uid = $1") return { rows: [organizer] };
          if (statement.includes("UPDATE members SET removed_at")) return { rows: [{ uid: "player-1" }], rowCount: 1 };
          return { rows: [], rowCount: 1 };
        },
        release() {},
      }),
    } as unknown as Pool;
    const app = await createApp({ pool: mockPool, verify: async () => ({ sub: "organizer-1" }) });
    apps.push(app);
    const response = await app.inject({ method: "POST", url: "/api/actions/removeMember", headers: { authorization: "Bearer valid" }, payload: { playerUid: "player-1" } });
    expect(response.statusCode).toBe(200);
    expect(sql.some((statement) => statement.includes("UPDATE members SET removed_at = now()"))).toBe(true);
    expect(sql.some((statement) => statement.includes("DELETE FROM members"))).toBe(false);
  });

  it("returns no group record for a signed-in user who has not joined", async () => {
    const app = await createApp({ pool: pool((sql) => sql.startsWith("SELECT count(*)") ? [{ count: 1 }] : []), verify: async () => ({ sub: "user-1" }) });
    apps.push(app);
    const response = await app.inject({ method: "GET", url: "/api/bootstrap", headers: { authorization: "Bearer valid" } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ member: null });
  });

  it("shares paid status without returning another player's fee or charges", async () => {
    const players = [
      { uid: "user-1", display_name: "Player One", role: "player", status: "approved", approved_at: new Date("2026-01-01T00:00:00Z") },
      { uid: "user-2", display_name: "Player Two", role: "player", status: "approved", approved_at: new Date("2026-01-01T00:00:00Z") },
    ];
    const settings = { time_zone: "Asia/Singapore", currency: "SGD", launch_session_date: "2026-01-02" };
    const chargeRows = [
      { id: "own-charge", session_date: "2026-10-16", subject_type: "member", subject_id: "user-1", player_uid: "user-1", amount_minor: 200, status: "active" },
      { id: "private-charge", session_date: "2026-10-16", subject_type: "member", subject_id: "user-2", player_uid: "user-2", amount_minor: 900, status: "active" },
    ];
    const mockPool = pool((sql) => {
      if (sql.startsWith("SELECT count(*)")) return [{ count: 2 }];
      if (sql === "SELECT * FROM members WHERE uid = $1") return [players[0]];
      if (sql.includes("FROM group_settings")) return [settings];
      if (sql.includes("FROM members WHERE status = 'approved'")) return players;
      if (sql.includes("FROM charges")) return chargeRows;
      if (sql.includes("FROM fee_versions")) return [{ subject_type: "member", subject_id: "user-1", effective_from: "2026-01-02", amount_minor: 200 }];
      return [];
    });
    const app = await createApp({ pool: mockPool, env: { APP_ORIGINS: "http://localhost:5173" }, verify: async () => ({ sub: "user-1" }), now: () => new Date("2026-10-23T11:00:00Z") });
    apps.push(app);
    const response = await app.inject({ method: "GET", url: "/api/bootstrap", headers: { authorization: "Bearer valid" } });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.members.map((member: { paymentStatus: string }) => member.paymentStatus)).toEqual(["unpaid", "unpaid"]);
    expect(body.charges.map((charge: { id: string }) => charge.id)).toEqual(["own-charge"]);
    expect(JSON.stringify(body)).not.toContain("private-charge");
    expect(JSON.stringify(body)).not.toContain("900");
  });
});
