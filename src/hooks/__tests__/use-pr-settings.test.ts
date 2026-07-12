import { describe, it, expect } from "vitest";

import { parseStoredSettings } from "../use-pr-settings";

describe("parseStoredSettings — enabled flag", () => {
  it("defaults enabled to false when nothing is stored", () => {
    const settings = parseStoredSettings(null);
    expect(settings.enabled).toBe(false);
  });

  it("defaults enabled to false when stored JSON omits the field", () => {
    const settings = parseStoredSettings(JSON.stringify({ pollingInterval: 45 }));
    expect(settings.enabled).toBe(false);
    // Other fields still parse normally.
    expect(settings.pollingInterval).toBe(45);
  });

  it("persists enabled=true when stored", () => {
    const settings = parseStoredSettings(JSON.stringify({ enabled: true }));
    expect(settings.enabled).toBe(true);
  });

  it("persists enabled=false when explicitly stored", () => {
    const settings = parseStoredSettings(JSON.stringify({ enabled: false }));
    expect(settings.enabled).toBe(false);
  });

  it("falls back to false when enabled is not a boolean", () => {
    const settings = parseStoredSettings(JSON.stringify({ enabled: "yes" }));
    expect(settings.enabled).toBe(false);
  });

  it("falls back to defaults (enabled false) on malformed JSON", () => {
    const settings = parseStoredSettings("{not valid json");
    expect(settings.enabled).toBe(false);
  });
});
