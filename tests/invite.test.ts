import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { InviteCard } from "../src/App.js";

describe("organizer invite", () => {
  it("shows a shareable code and tells players to enter it on the site", () => {
    const code = "a1b2c3";
    const html = renderToStaticMarkup(createElement(InviteCard, { inviteCode: code, onCreate: vi.fn(), onCopy: vi.fn(), onRevoke: vi.fn() }));

    expect(html).toContain("Invite code");
    expect(html).toContain(`value="${code}"`);
    expect(html).toContain("visit the website");
    expect(html).toContain("stays active until you revoke it");
    expect(html).toContain("Revoke code");
    expect(html).not.toContain("Create invite code");
    expect(html).toContain("Copy code");
  });

  it("offers creation when no active code exists", () => {
    const html = renderToStaticMarkup(createElement(InviteCard, { inviteCode: "", onCreate: vi.fn(), onCopy: vi.fn(), onRevoke: vi.fn() }));
    expect(html).toContain("Create invite code");
    expect(html).not.toContain("Revoke code");
  });
});
