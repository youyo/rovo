import { describe, expect, it } from "vitest";
import { checkUrl, isForbiddenHost } from "../../src/url-policy";

describe("checkUrl: スキーム・userinfo・ポート", () => {
  it("https / http の公開 URL は通り、正規化した URL を返す", () => {
    const r = checkUrl("https://Example.com/a?b=1#frag");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.url.hostname).toBe("example.com");
    expect(checkUrl("http://example.com/").ok).toBe(true);
  });

  it.each([
    "ftp://example.com/",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "data:text/html,hi",
    "gopher://example.com/",
    "ws://example.com/",
  ])("https / http 以外のスキームは拒否する: %s", (u) => {
    const r = checkUrl(u);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("scheme");
  });

  it.each([
    "https://user@example.com/",
    "https://user:pass@example.com/",
    "https://:pass@example.com/",
  ])("userinfo を含む URL は拒否する: %s", (u) => {
    const r = checkUrl(u);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("userinfo");
  });

  it.each(["https://example.com:8443/", "http://example.com:8080/", "https://example.com:22/"])(
    "80 / 443 以外のポートは拒否する: %s",
    (u) => {
      const r = checkUrl(u);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("port");
    },
  );

  it.each(["https://example.com:443/", "http://example.com:80/", "https://example.com:80/"])(
    "80 / 443 は明示しても通る: %s",
    (u) => {
      expect(checkUrl(u).ok).toBe(true);
    },
  );

  it("壊れた URL・長すぎる URL は拒否する", () => {
    const bad = checkUrl("not a url");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toBe("invalid_url");
    const long = checkUrl(`https://example.com/${"a".repeat(2100)}`);
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.reason).toBe("too_long");
  });
});

describe("checkUrl: 内部アドレス", () => {
  it.each([
    // loopback / private / link-local / CGNAT / 予約
    "http://127.0.0.1/",
    "http://127.1.2.3/",
    "http://10.0.0.1/",
    "http://172.16.0.1/",
    "http://172.31.255.255/",
    "http://192.168.1.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://169.254.0.1/",
    "http://100.64.0.1/",
    "http://100.127.255.255/",
    "http://0.0.0.0/",
    "http://224.0.0.1/",
    "http://255.255.255.255/",
    // IPv6
    "http://[::1]/",
    "http://[::]/",
    "http://[fe80::1]/",
    "http://[fc00::1]/",
    "http://[fd12:3456:789a::1]/",
    "http://[fd00:ec2::254]/",
    // IPv4-mapped IPv6
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:7f00:1]/",
    "http://[::ffff:10.0.0.1]/",
    "http://[::ffff:169.254.169.254]/",
    "http://[::ffff:a9fe:a9fe]/",
    // 名前
    "http://localhost/",
    "http://LOCALHOST/",
    "http://localhost./",
    "http://foo.localhost/",
    "http://metadata.google.internal/",
    "http://service.internal/",
    "http://printer.local/",
    "http://my-nas.local./",
  ])("拒否する: %s", (u) => {
    const r = checkUrl(u);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("private_host");
  });

  it.each([
    // IP の表記ゆれ（URL パーサが 127.0.0.1 等に正規化する or 不正な数値ホストとして拒否される）
    "http://2130706433/", // 10進
    "http://0x7f000001/", // 16進
    "http://0x7f.0.0.1/",
    "http://0177.0.0.1/", // 8進
    "http://017700000001/", // 8進（全体）
    "http://127.1/", // 短縮
    "http://127.0.1/",
    "http://0/", // 0.0.0.0
    "http://169.254.43518/", // 169.254.169.254 の短縮
    "http://2852039166/", // 169.254.169.254 の10進
    "http://0xa9fea9fe/", // 169.254.169.254 の16進
    "http://0251.0376.0251.0376/", // 169.254.169.254 の8進
    "http://0xA9.0xFE.0xA9.0xFE/",
    "http://10.1/", // 10.0.0.1 の短縮
    "http://3232235777/", // 192.168.1.1
  ])("IP の表記ゆれでも拒否する: %s", (u) => {
    expect(checkUrl(u).ok).toBe(false);
  });

  it.each([
    "https://example.com/",
    "https://1.1.1.1/",
    "https://8.8.8.8/",
    "https://100.63.255.255/", // CGNAT の手前
    "https://100.128.0.1/", // CGNAT の次
    "https://172.15.0.1/",
    "https://172.32.0.1/",
    "https://[2606:4700:4700::1111]/",
    "https://internal.example.com/", // .internal で終わらない
    "https://locally.example.com/",
    "https://xn--n8jhz.example/",
  ])("公開アドレス・公開ホストは通す: %s", (u) => {
    expect(checkUrl(u).ok).toBe(true);
  });
});

describe("isForbiddenHost", () => {
  it("hostname 単体でも判定できる（DoH で解決したアドレスの検査に使う）", () => {
    expect(isForbiddenHost("10.0.0.1")).toBe(true);
    expect(isForbiddenHost("[fd00::1]")).toBe(true);
    expect(isForbiddenHost("fd00::1")).toBe(true);
    expect(isForbiddenHost("::ffff:7f00:1")).toBe(true);
    expect(isForbiddenHost("93.184.216.34")).toBe(false);
    expect(isForbiddenHost("2606:4700::1111")).toBe(false);
  });
});
