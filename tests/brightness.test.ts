import { expect, test } from "bun:test";
import { brightnessFrom } from "../services/devices/brightness";

test("with the camera's exposure: lux, roughly, and a level", () => {
  // An evening living room: 1/30 s at ISO 800 with a mid-grey frame, about 30 lux.
  const room = brightnessFrom({ luma: 0.46, exposureTime: 333, iso: 800 });
  expect(room.level).toBe("dim");
  expect(room.lux).toBeGreaterThan(15);
  expect(room.lux).toBeLessThan(60);
  // Daylight by a window: 1/1000 s at ISO 50.
  expect(brightnessFrom({ luma: 0.5, exposureTime: 10, iso: 50 }).level).toBe("daylight");
  // Lights off: 1/10 s at ISO 3200 and still a dark frame.
  expect(brightnessFrom({ luma: 0.05, exposureTime: 1000, iso: 3200 }).level).toBe("dark");
});

test("without it (iPhone): only dark, dim or lit, from the frame", () => {
  expect(brightnessFrom({ luma: 0.03 })).toEqual({ level: "dark", luma: 0.03 });
  expect(brightnessFrom({ luma: 0.15 }).level).toBe("dim");
  expect(brightnessFrom({ luma: 0.5 }).level).toBe("lit");
  expect(brightnessFrom({}).level).toBe("dark");
});
