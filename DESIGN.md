---
name: HowMuchAh
description: A calm weekly dashboard for badminton attendance and shuttle contributions.
colors:
  primary: "#b62768"
  primary-hover: "#941b51"
  focus: "#7b1749"
  accent-soft: "#f9e9f0"
  neutral-bg: "#f2f3f5"
  surface: "#ffffff"
  surface-muted: "#f6f6f7"
  ink: "#29313b"
  muted: "#626b74"
  border: "#dfe1e4"
  success: "#3e8a68"
  success-soft: "#e9f4ee"
  error: "#922334"
  success-ink: "#285e47"
  success-border: "#c7dfd1"
  open-ink: "#8d1f52"
  neutral-strong: "#535d67"
  text-secondary: "#424b54"
  border-strong: "#c9cdd2"
  danger: "#9b1c30"
  danger-soft: "#fff0f1"
  danger-border: "#e7b5bb"
  danger-action: "#a02c39"
  topbar-border: "#e8e9eb"
  nav-border: "#e7e9eb"
  away: "#c8ccd1"
typography:
  display:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "28px"
    fontWeight: 700
    lineHeight: 1.14
    letterSpacing: "-0.8px"
  compact-title:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "25px"
    fontWeight: 700
    lineHeight: 1.2
  section:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "18px"
    fontWeight: 700
    lineHeight: 1.3
  brand:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "19px"
    fontWeight: 700
    lineHeight: 1.3
  balance:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "24px"
    fontWeight: 700
    lineHeight: 1.2
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  row:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "12px"
    fontWeight: 600
    lineHeight: 1.5
  caption:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "11px"
    fontWeight: 600
    lineHeight: 1.4
  brand-compact:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "17px"
    fontWeight: 700
    lineHeight: 1.3
  title-compact:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "22px"
    fontWeight: 700
    lineHeight: 1.2
rounded:
  xs: "4px"
  input: "7px"
  sm: "8px"
  md: "12px"
  pill: "99px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.surface}"
    rounded: "{rounded.sm}"
    height: "46px"
  card:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.md}"
    padding: "16px"
---

# Design System: HowMuchAh

## Overview

**Creative North Star: “The Friday Club Ledger”**

Keep the weekly badminton task familiar and quick to scan. The interface is a practical mobile dashboard with a soft light canvas, charcoal text, and a restrained magenta accent. The selected direction uses the layered-record sketch's colors while keeping its simple dashboard layout.

Google Calendar, Apple Wallet, and Splitwise are polish references for clear states, tidy information, and familiar controls. Product facts and visibility rules live in `PRODUCT.md`.

## Colors

The magenta accent carries the primary action and open state. Green is reserved for confirmed attendance and success. Neutral surfaces, charcoal text, and muted labels carry the rest of the hierarchy. Every state also has a text label; color never carries meaning by itself.

## Typography

Use the system sans-serif stack throughout. Page titles are compact and firm; section titles and labels step down clearly. Keep body text comfortable to scan and secondary notes visibly quieter without reducing legibility.

## Layout

Lead with the current Friday session and check-in action, place the player's monthly balance next, and show group attendance below. Keep the content in a narrow reading column on phones and center it on wider screens. Organiser tools follow the same check-in-first order.

## Elevation & Depth

Use flat surfaces and subtle borders to separate cards. The hierarchy comes from spacing and tonal surfaces, not shadows.

## Shapes

Cards use gently rounded corners; controls use slightly tighter corners. Inputs have a clear border and visible focus ring. Preserve generous touch targets and keep dense management forms easy to scan.

## Components

Primary buttons use the magenta accent with high-contrast text and a full-width treatment for the main check-in action. Secondary actions use a white surface and magenta text. State pills use pale tinted fills and concise labels. Attendance rows use a small green marker plus a name and text state.

## Do's and Don'ts

- Keep check-in first for players and organisers.
- Show group attendance and current-month paid/unpaid status without exposing another player's fee, payment history, or balance.
- Use magenta for the main action and green for confirmed attendance.
- Keep keyboard focus visible and motion reduced when the user requests it.
- Do not add decorative icons made from Unicode glyphs; use the established inline SVG icon style.
