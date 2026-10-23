import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { InviteCard } from "../src/App.js";

describe("organizer invite", () => {
  it("shows a shareable code and tells players to enter it on the site", () => {
    const code = "abc123-example-code";
    const html = renderToStaticMarkup(createElement(InviteCard, { inviteCode: code, onCreate: vi.fn(), onCopy: vi.fn() }));

    expect(html).toContain("Invite code");
    expect(html).toContain(`value="${code}"`);
    expect(html).toContain("visit the website");
    expect(html).not.toContain("Create invite link");
    expect(html).toContain("Copy code");
  });
});
