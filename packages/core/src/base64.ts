const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** A host-independent UTF-8 decoder keeps encoded fixtures usable by pure code. */
export function decodeBase64(value: string): string {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("Invalid encoded text");
  }
  let bits = 0;
  let count = 0;
  let escaped = "";
  for (const char of value.replace(/=+$/, "")) {
    bits = (bits << 6) | ALPHABET.indexOf(char);
    count += 6;
    if (count >= 8) {
      count -= 8;
      escaped += `%${((bits >> count) & 255).toString(16).padStart(2, "0")}`;
    }
  }
  try {
    return decodeURIComponent(escaped);
  } catch {
    throw new Error("Invalid encoded UTF-8 text");
  }
}
