// apps/gateway/src/github/crypto.ts と同じ実装（アプリ間で import できないため複製。変更するときは両方そろえる）。
const IV_BYTES = 12;

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64encode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** base64 の 32 バイト鍵（TOKEN_ENC_KEY）から AES-GCM 鍵を作る。 */
export async function importEncryptionKey(base64Key: string): Promise<CryptoKey> {
  const raw = b64decode(base64Key.trim());
  if (raw.length !== 32) {
    throw new Error("TOKEN_ENC_KEY must be base64 of exactly 32 bytes");
  }
  return crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

/** `aad` は用途ごとのラベル（access / refresh）。別用途の暗号文を差し替えても復号できなくする。 */
export async function encryptString(key: CryptoKey, plain: string, aad: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) },
      key,
      new TextEncoder().encode(plain),
    ),
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return b64encode(out);
}

export async function decryptString(key: CryptoKey, encoded: string, aad: string): Promise<string> {
  const data = b64decode(encoded);
  const iv = data.slice(0, IV_BYTES);
  const ct = data.slice(IV_BYTES);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) },
    key,
    ct,
  );
  return new TextDecoder().decode(plain);
}
