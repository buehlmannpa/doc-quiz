import { afterEach, describe, expect, it, vi } from "vitest";
import { percentile, spikeGuard } from "./guard";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("spikeGuard", () => {
  it("sperrt ohne SPIKE_ENABLED", () => {
    vi.stubEnv("SPIKE_ENABLED", "");
    expect(spikeGuard()?.status).toBe(404);
  });

  it("gibt in Preview und lokal frei, wenn SPIKE_ENABLED=1 gesetzt ist", () => {
    vi.stubEnv("SPIKE_ENABLED", "1");
    vi.stubEnv("VERCEL_ENV", "preview");
    expect(spikeGuard()).toBeNull();
    vi.stubEnv("VERCEL_ENV", "");
    expect(spikeGuard()).toBeNull();
  });

  it("sperrt in der Produktion, auch wenn SPIKE_ENABLED=1 gesetzt ist", () => {
    vi.stubEnv("SPIKE_ENABLED", "1");
    vi.stubEnv("VERCEL_ENV", "production");
    expect(spikeGuard()?.status).toBe(404);
  });
});

describe("percentile", () => {
  it("liefert null für eine leere Liste", () => {
    expect(percentile([], 50)).toBeNull();
  });

  it("berechnet Perzentile nach dem Nearest Rank Verfahren", () => {
    const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(values, 50)).toBe(50);
    expect(percentile(values, 95)).toBe(100);
    expect(percentile(values, 100)).toBe(100);
    expect(percentile(values, 0)).toBe(10);
  });

  it("sortiert unsortierte Eingaben und verändert sie nicht", () => {
    const values = [5, 1, 3];
    expect(percentile(values, 50)).toBe(3);
    expect(values).toEqual([5, 1, 3]);
  });
});
