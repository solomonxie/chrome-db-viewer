// A small EXIF reader for JPEG APP1 segments: camera, lens, date and GPS. No dependencies.
// Reads only the tags the info panel shows; everything else is skipped.

export interface ExifData {
  make?: string;
  model?: string;
  lensModel?: string;
  /** "YYYY:MM:DD HH:MM:SS" as stored. */
  dateTimeOriginal?: string;
  /** 1-8 (TIFF Orientation). */
  orientation?: number;
  gps?: { latitude: number; longitude: number; altitude?: number };
}

const TAG_MAKE = 0x010f;
const TAG_MODEL = 0x0110;
const TAG_ORIENTATION = 0x0112;
const TAG_EXIF_IFD = 0x8769;
const TAG_GPS_IFD = 0x8825;
const TAG_DATETIME_ORIGINAL = 0x9003;
const TAG_LENS_MODEL = 0xa434;
const GPS_LAT_REF = 0x0001;
const GPS_LAT = 0x0002;
const GPS_LON_REF = 0x0003;
const GPS_LON = 0x0004;
const GPS_ALT_REF = 0x0005;
const GPS_ALT = 0x0006;

const TYPE_SIZES: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

type Value = string | number | number[];

class Tiff {
  constructor(private view: DataView, private start: number, private little: boolean) {}

  get length(): number {
    return this.view.byteLength - this.start;
  }

  u16(off: number): number {
    return this.view.getUint16(this.start + off, this.little);
  }

  u32(off: number): number {
    return this.view.getUint32(this.start + off, this.little);
  }

  inRange(off: number, len: number): boolean {
    return off >= 0 && off + len <= this.length;
  }

  /** Reads one IFD into tag -> value. Bounded so a corrupt file can't loop or overrun. */
  readIfd(off: number): Map<number, Value> {
    const out = new Map<number, Value>();
    if (!this.inRange(off, 2)) return out;
    const count = Math.min(this.u16(off), 512);
    for (let i = 0; i < count; i++) {
      const entry = off + 2 + i * 12;
      if (!this.inRange(entry, 12)) break;
      const tag = this.u16(entry);
      const type = this.u16(entry + 2);
      const n = this.u32(entry + 4);
      const size = TYPE_SIZES[type];
      if (!size || n > 1 << 16) continue;
      const bytes = size * n;
      const valueOff = bytes <= 4 ? entry + 8 : this.u32(entry + 8);
      if (!this.inRange(valueOff, bytes)) continue;
      const v = this.readValue(type, n, valueOff);
      if (v !== undefined) out.set(tag, v);
    }
    return out;
  }

  private readValue(type: number, n: number, off: number): Value | undefined {
    switch (type) {
      case 2: {
        let s = "";
        for (let i = 0; i < n; i++) {
          const c = this.view.getUint8(this.start + off + i);
          if (c === 0) break;
          s += String.fromCharCode(c);
        }
        return s.trim();
      }
      case 1:
      case 7:
        return n === 1 ? this.view.getUint8(this.start + off) : undefined;
      case 3:
        return n === 1 ? this.u16(off) : Array.from({ length: n }, (_, i) => this.u16(off + i * 2));
      case 4:
        return n === 1 ? this.u32(off) : Array.from({ length: n }, (_, i) => this.u32(off + i * 4));
      case 9:
        return this.view.getInt32(this.start + off, this.little);
      case 5:
      case 10: {
        const vals: number[] = [];
        for (let i = 0; i < n; i++) {
          const num = type === 5 ? this.u32(off + i * 8) : this.view.getInt32(this.start + off + i * 8, this.little);
          const den = type === 5 ? this.u32(off + i * 8 + 4) : this.view.getInt32(this.start + off + i * 8 + 4, this.little);
          vals.push(den === 0 ? 0 : num / den);
        }
        return n === 1 ? (vals[0] ?? 0) : vals;
      }
      default:
        return undefined;
    }
  }
}

function str(v: Value | undefined): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function dmsToDecimal(v: Value | undefined, ref: Value | undefined): number | undefined {
  const parts = Array.isArray(v) ? v : typeof v === "number" ? [v] : null;
  if (!parts || parts.length === 0) return undefined;
  const [d = 0, m = 0, s = 0] = parts;
  let dec = d + m / 60 + s / 3600;
  if (ref === "S" || ref === "W") dec = -dec;
  return Math.round(dec * 1e6) / 1e6;
}

/** Parses a TIFF/EXIF block ("Exif\0\0" already stripped) at `start` in `view`. */
export function parseTiff(view: DataView, start: number): ExifData | null {
  if (view.byteLength - start < 8) return null;
  const order = view.getUint16(start, false);
  if (order !== 0x4949 && order !== 0x4d4d) return null;
  const tiff = new Tiff(view, start, order === 0x4949);
  if (tiff.u16(2) !== 42) return null;
  const ifd0 = tiff.readIfd(tiff.u32(4));
  const out: ExifData = {};
  out.make = str(ifd0.get(TAG_MAKE));
  out.model = str(ifd0.get(TAG_MODEL));
  const orientation = ifd0.get(TAG_ORIENTATION);
  if (typeof orientation === "number") out.orientation = orientation;

  const exifOff = ifd0.get(TAG_EXIF_IFD);
  if (typeof exifOff === "number") {
    const exif = tiff.readIfd(exifOff);
    out.dateTimeOriginal = str(exif.get(TAG_DATETIME_ORIGINAL));
    out.lensModel = str(exif.get(TAG_LENS_MODEL));
  }

  const gpsOff = ifd0.get(TAG_GPS_IFD);
  if (typeof gpsOff === "number") {
    const gps = tiff.readIfd(gpsOff);
    const latitude = dmsToDecimal(gps.get(GPS_LAT), gps.get(GPS_LAT_REF));
    const longitude = dmsToDecimal(gps.get(GPS_LON), gps.get(GPS_LON_REF));
    if (latitude !== undefined && longitude !== undefined) {
      out.gps = { latitude, longitude };
      const alt = gps.get(GPS_ALT);
      if (typeof alt === "number") out.gps.altitude = gps.get(GPS_ALT_REF) === 1 ? -alt : alt;
    }
  }

  for (const k of Object.keys(out) as (keyof ExifData)[]) if (out[k] === undefined) delete out[k];
  return Object.keys(out).length > 0 ? out : null;
}

/** Reads EXIF from JPEG bytes. Returns null for non-JPEGs and JPEGs without EXIF. */
export function parseExif(input: ArrayBuffer | Uint8Array): ExifData | null {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return null;
  let off = 2;
  while (off + 4 <= view.byteLength) {
    if (view.getUint8(off) !== 0xff) return null;
    const marker = view.getUint8(off + 1);
    if (marker === 0xff) {
      off += 1; // fill byte
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // end of image / start of scan: no EXIF before the pixels
    if (marker >= 0xd0 && marker <= 0xd7) {
      off += 2;
      continue;
    }
    const len = view.getUint16(off + 2);
    if (len < 2) return null;
    if (marker === 0xe1 && off + 10 <= view.byteLength) {
      // "Exif\0\0"
      if (view.getUint32(off + 4) === 0x45786966 && view.getUint16(off + 8) === 0) {
        const end = Math.min(off + 2 + len, view.byteLength);
        const segment = new DataView(bytes.buffer, bytes.byteOffset + off + 10, end - off - 10);
        return parseTiff(segment, 0);
      }
    }
    off += 2 + len;
  }
  return null;
}

/** "33.856800° S, 151.215300° E" */
export function formatCoordinates(lat: number, lon: number): string {
  const ns = lat < 0 ? "S" : "N";
  const ew = lon < 0 ? "W" : "E";
  return `${Math.abs(lat).toFixed(6)}° ${ns}, ${Math.abs(lon).toFixed(6)}° ${ew}`;
}
