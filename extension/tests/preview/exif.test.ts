import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { formatCoordinates, parseExif } from "../../src/media/exif";

const FIXTURES = resolve(__dirname, "../fixtures/media");
const read = (name: string) => new Uint8Array(readFileSync(resolve(FIXTURES, name)));

test("parseExif reads camera, lens, date and GPS from a real JPEG", () => {
  // exif-gps.jpg is written by make-fixtures.swift with macOS ImageIO (big-endian TIFF).
  const exif = parseExif(read("exif-gps.jpg"));
  expect(exif).toEqual({
    make: "Apple",
    model: "iPhone 15 Pro",
    lensModel: "iPhone 15 Pro back triple camera 6.765mm f/1.78",
    dateTimeOriginal: "2024:05:17 14:23:09",
    gps: { latitude: -33.8568, longitude: 151.2153, altitude: 12.5 },
  });
});

test("parseExif accepts an ArrayBuffer and a truncated head of the file", () => {
  const bytes = read("exif-gps.jpg");
  expect(parseExif(bytes.slice().buffer)?.make).toBe("Apple");
  expect(parseExif(bytes.subarray(0, 600))?.gps?.longitude).toBe(151.2153);
});

test("parseExif returns null for a JPEG without EXIF", () => {
  expect(parseExif(read("no-exif.jpg"))).toBeNull();
});

test("parseExif returns null for non-JPEG bytes", () => {
  expect(parseExif(read("http-dir-listing.html"))).toBeNull();
  expect(parseExif(new Uint8Array([0xff, 0xd8]))).toBeNull();
});

test("parseExif survives a corrupt APP1 segment", () => {
  const bytes = read("exif-gps.jpg").slice();
  // Point IFD0 far past the end of the segment.
  const tiff = bytes.indexOf(0x4d, 20); // "MM"
  bytes.set([0x7f, 0xff, 0xff, 0xff], tiff + 4);
  expect(parseExif(bytes)).toBeNull();
});

test("formatCoordinates", () => {
  expect(formatCoordinates(-33.8568, 151.2153)).toBe("33.856800° S, 151.215300° E");
  expect(formatCoordinates(40.7, -74)).toBe("40.700000° N, 74.000000° W");
});
