import { describe, expect, it } from "vitest";
import { reconnectDelayMs } from "./tcp";

describe("reconnectDelayMs", () => {
  it("wächst mit den Versuchen, bleibt aber unter dem Deckel", () => {
    const middle = () => 0.5; // Zufallsfaktor genau 1.0
    expect(reconnectDelayMs(1, middle)).toBe(200);
    expect(reconnectDelayMs(2, middle)).toBe(400);
    expect(reconnectDelayMs(5, middle)).toBe(3000);
    expect(reconnectDelayMs(50, middle)).toBe(3000);
  });

  it("streut um höchstens 25 Prozent", () => {
    expect(reconnectDelayMs(1, () => 0)).toBe(150);
    expect(reconnectDelayMs(1, () => 1)).toBe(250);
  });
});
