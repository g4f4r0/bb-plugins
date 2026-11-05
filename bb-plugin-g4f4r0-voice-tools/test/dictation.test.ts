import { describe, expect, it } from "vitest";
import { Downsampler, int16ToBase64 } from "../src/dictation.js";
import { pcmToWav } from "../src/contract.js";

describe("Downsampler", () => {
  it.each([48_000, 44_100, 16_000])("turns %d Hz into 16 kHz across chunk edges", (rate) => {
    const seconds = 2;
    const tone = new Float32Array(rate * seconds).map((_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / rate));
    const down = new Downsampler(rate);
    let total = 0;
    let peak = 0;
    for (let i = 0; i < tone.length; i += 4096) {
      const out = down.push(tone.subarray(i, i + 4096));
      total += out.length;
      for (const s of out) peak = Math.max(peak, Math.abs(s));
    }
    expect(Math.abs(total - 16_000 * seconds)).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThan(0.4 * 32767);
    expect(peak).toBeLessThanOrEqual(0.5 * 32767 + 1);
  });

  it("clips out-of-range input", () => {
    const out = new Downsampler(16_000).push(new Float32Array([2, -2]));
    expect(Array.from(out)).toEqual([32767, -32768]);
  });
});

describe("encoding", () => {
  it("base64-encodes little-endian int16", () => {
    expect(int16ToBase64(new Int16Array([1, -1]))).toBe(Buffer.from([1, 0, 255, 255]).toString("base64"));
  });

  it("wraps PCM in a 16 kHz mono WAV header", () => {
    const wav = pcmToWav(new Uint8Array(32_000));
    const view = new DataView(wav.buffer);
    expect(Buffer.from(wav.subarray(0, 4)).toString()).toBe("RIFF");
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint32(40, true)).toBe(32_000);
    expect(wav.byteLength).toBe(32_044);
  });
});
