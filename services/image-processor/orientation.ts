// Normalize EXIF ourselves: Images does not auto-orient all accepted formats consistently.
export function takeOrientation(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const word = (offset: number) =>
    String.fromCharCode(...bytes.subarray(offset, offset + 4));
  let orientation = 1;
  function tiff(start: number, end: number) {
    if (end - start < 8) return false;
    if (word(start) === "Exif") start += 6;
    if (end - start < 8) return false;
    const little = bytes[start] === 0x49 && bytes[start + 1] === 0x49;
    if (!little && !(bytes[start] === 0x4d && bytes[start + 1] === 0x4d))
      return false;
    if (view.getUint16(start + 2, little) !== 42) return false;
    const directory = start + view.getUint32(start + 4, little);
    if (directory < start + 8 || directory + 2 > end) return false;
    const count = view.getUint16(directory, little);
    if (directory + 2 + count * 12 > end) return false;
    for (let i = 0; i < count; i++) {
      const at = directory + 2 + i * 12;
      if (
        view.getUint16(at, little) !== 0x112 ||
        view.getUint16(at + 2, little) !== 3 ||
        view.getUint32(at + 4, little) !== 1
      )
        continue;
      const value = view.getUint16(at + 8, little);
      if (value >= 1 && value <= 8) {
        orientation = value;
        view.setUint16(at + 8, 1, little);
        return true;
      }
    }
    return false;
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    for (let at = 2; at + 4 <= bytes.length;) {
      if (bytes[at] !== 0xff || bytes[at + 1] === 0xda) break;
      const end = at + 2 + view.getUint16(at + 2);
      if (end <= at + 3 || end > bytes.length) break;
      if (
        bytes[at + 1] === 0xe1 &&
        word(at + 4) === "Exif" &&
        tiff(at + 4, end)
      )
        break;
      at = end;
    }
  } else if (word(0) === "\x89PNG") {
    for (let at = 8; at + 12 <= bytes.length;) {
      const end = at + 8 + view.getUint32(at);
      if (end + 4 > bytes.length) break;
      if (word(at + 4) === "eXIf" && tiff(at + 8, end)) {
        let crc = 0xffffffff;
        for (let i = at + 4; i < end; i++) {
          crc ^= bytes[i];
          for (let bit = 0; bit < 8; bit++)
            crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
        }
        view.setUint32(end, (crc ^ 0xffffffff) >>> 0);
        break;
      }
      at = end + 4;
    }
  } else if (word(0) === "RIFF" && word(8) === "WEBP") {
    for (let at = 12; at + 8 <= bytes.length;) {
      const length = view.getUint32(at + 4, true),
        end = at + 8 + length;
      if (end > bytes.length) break;
      if (word(at) === "EXIF" && tiff(at + 8, end)) break;
      at = end + (length & 1);
    }
  }
  return orientation;
}
