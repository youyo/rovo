/**
 * テスト用の GitHub App の RSA 鍵ペアを、その場で生成する（リポジトリに秘密鍵は置かない）。
 * WebCrypto だけを使うので、Node（偽 GitHub / E2E）と workerd（Unit）の両方から使える。
 */

function pem(label: string, der: ArrayBuffer): string {
  const bytes = new Uint8Array(der);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  const body = (btoa(s).match(/.{1,64}/g) ?? []).join("\n");
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

export interface AppKeyPair {
  /** PKCS#8（GITHUB_APP_PRIVATE_KEY に入れる形） */
  privatePem: string;
  /** SPKI（偽 GitHub が JWT の署名を検証する） */
  publicPem: string;
}

export async function generateAppKeyPair(): Promise<AppKeyPair> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  return {
    privatePem: pem(
      "PRIVATE KEY",
      (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer,
    ),
    publicPem: pem(
      "PUBLIC KEY",
      (await crypto.subtle.exportKey("spki", pair.publicKey)) as ArrayBuffer,
    ),
  };
}
