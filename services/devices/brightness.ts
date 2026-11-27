// The camera as a light sensor (the device's "brightness" request). With the exposure the camera chose
// (exposure time in 100 µs units, ISO; Chrome on Android reports them), the light falling on the scene
// in lux, roughly: EV at ISO 100 for an f/1.8 phone lens, moved by how far the frame's mean is from mid
// grey, then lux = 2.5 · 2^EV. Without it (iPhone), only the frame's brightness, which auto exposure
// pulls towards the middle: it can tell dark from lit, little more.
export type Brightness = { level: "dark" | "dim" | "lit" | "bright" | "daylight"; lux?: number; luma: number };
export function brightnessFrom(d: { luma?: number; exposureTime?: number; iso?: number }): Brightness {
  const luma = Math.min(1, Math.max(0, Number(d.luma) || 0));
  if (Number(d.exposureTime) > 0 && Number(d.iso) > 0) {
    const ev100 = Math.log2(1.8 ** 2 / (Number(d.exposureTime) / 10_000)) - Math.log2(Number(d.iso) / 100);
    const lux = Math.round(2.5 * 2 ** (ev100 + Math.log2(Math.max(luma, 0.02) ** 2.2 / 0.18)));
    const level = lux < 10 ? "dark" : lux < 80 ? "dim" : lux < 1000 ? "lit" : lux < 10_000 ? "bright" : "daylight";
    return { level, lux, luma };
  }
  return { level: luma < 0.08 ? "dark" : luma < 0.25 ? "dim" : "lit", luma };
}
