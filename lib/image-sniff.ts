export type SniffedImageType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'image/avif'

const ascii = (bytes: Uint8Array, start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end))

// The image type the bytes actually hold, whatever a server or client claims.
// SVG, HTML and anything unrecognized are null.
export function sniffImageType(bytes: Uint8Array): SniffedImageType | null {
  if (bytes.length < 12) return null
  if (bytes[0] === 0x89 && ascii(bytes, 1, 8) === 'PNG\r\n\x1a\n') return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a') return 'image/gif'
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return 'image/webp'
  if (ascii(bytes, 4, 8) === 'ftyp') {
    // An ISO-BMFF file is AVIF when its major or a compatible brand says so.
    const size = Math.min(bytes.length, (bytes[0] << 24 | bytes[1] << 16 | bytes[2] << 8 | bytes[3]) >>> 0)
    for (let offset = 8; offset + 4 <= size; offset += offset === 8 ? 8 : 4) {
      const brand = ascii(bytes, offset, offset + 4)
      if (brand === 'avif' || brand === 'avis') return 'image/avif'
    }
  }
  return null
}
