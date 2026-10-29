// Regenerates the media fixtures with macOS ImageIO:
//   swift tests/fixtures/media/make-fixtures.swift tests/fixtures/media
// exif-gps.jpg: 64x48 gradient with TIFF Make/Model, EXIF LensModel/DateTimeOriginal and GPS (south/west).
// no-exif.jpg:  the same pixels with no metadata.
import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

let outDir = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "."
let w = 64, h = 48
let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                    space: CGColorSpace(name: CGColorSpace.sRGB)!,
                    bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
for y in 0..<h { for x in 0..<w {
  ctx.setFillColor(red: CGFloat(x) / CGFloat(w), green: CGFloat(y) / CGFloat(h), blue: 0.5, alpha: 1)
  ctx.fill(CGRect(x: x, y: y, width: 1, height: 1))
} }
let image = ctx.makeImage()!

func write(_ name: String, _ props: [CFString: Any]) {
  let url = URL(fileURLWithPath: outDir).appendingPathComponent(name) as CFURL
  let dest = CGImageDestinationCreateWithURL(url, UTType.jpeg.identifier as CFString, 1, nil)!
  CGImageDestinationAddImage(dest, image, props as CFDictionary)
  precondition(CGImageDestinationFinalize(dest))
}

write("exif-gps.jpg", [
  kCGImageDestinationLossyCompressionQuality: 0.8,
  kCGImagePropertyTIFFDictionary: [
    kCGImagePropertyTIFFMake: "Apple",
    kCGImagePropertyTIFFModel: "iPhone 15 Pro",
  ],
  kCGImagePropertyExifDictionary: [
    kCGImagePropertyExifLensModel: "iPhone 15 Pro back triple camera 6.765mm f/1.78",
    kCGImagePropertyExifDateTimeOriginal: "2024:05:17 14:23:09",
  ],
  kCGImagePropertyGPSDictionary: [
    kCGImagePropertyGPSLatitude: 33.8568,
    kCGImagePropertyGPSLatitudeRef: "S",
    kCGImagePropertyGPSLongitude: 151.2153,
    kCGImagePropertyGPSLongitudeRef: "E",
    kCGImagePropertyGPSAltitude: 12.5,
    kCGImagePropertyGPSAltitudeRef: 0,
  ],
])
write("no-exif.jpg", [kCGImageDestinationLossyCompressionQuality: 0.8])
