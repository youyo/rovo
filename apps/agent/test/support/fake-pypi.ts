import { createHash } from "node:crypto";
import type { ServerResponse } from "node:http";
import { crc32 } from "node:zlib";

// 偽の PyPI（pypi.org の simple API と files.pythonhosted.org の wheel）。Python の依存の導入の E2E 用。
// wheel は 1 つのモジュールだけを持つ最小のもの（zip を自前で組む。圧縮なし）。

export const FAKE_PYPI_INDEX_HOST = "pypi.org";
export const FAKE_PYPI_FILES_HOST = "files.pythonhosted.org";

/** requirements.txt の経路（uv pip install -r）で入れるパッケージ。import 名は rovo_e2e_req、VALUE = 1 */
export const FAKE_PYPI_REQ = { name: "rovo-e2e-req", module: "rovo_e2e_req", version: "1.0.0" };
/** uv lock / uv sync --active --frozen の経路で入れるパッケージ。import 名は rovo_e2e_lock、VALUE = 2 */
export const FAKE_PYPI_LOCK = { name: "rovo-e2e-lock", module: "rovo_e2e_lock", version: "1.0.0" };

interface FakeWheel {
  filename: string;
  file: Buffer;
  sha256: string;
}

function zip(entries: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const nameBuf = Buffer.from(name);
    const data = Buffer.from(text);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // 展開に必要な版
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

function buildWheel(pkg: typeof FAKE_PYPI_REQ, value: number): FakeWheel {
  const dist = `${pkg.module}-${pkg.version}`;
  const file = zip({
    [`${pkg.module}.py`]: `VALUE = ${value}\n`,
    [`${dist}.dist-info/METADATA`]: `Metadata-Version: 2.1\nName: ${pkg.name}\nVersion: ${pkg.version}\nRequires-Python: >=3.8\n`,
    [`${dist}.dist-info/WHEEL`]:
      "Wheel-Version: 1.0\nGenerator: rovo-e2e\nRoot-Is-Purelib: true\nTag: py3-none-any\n",
    [`${dist}.dist-info/RECORD`]: "",
  });
  return {
    filename: `${dist}-py3-none-any.whl`,
    file,
    sha256: createHash("sha256").update(file).digest("hex"),
  };
}

export function buildFakePypi() {
  const wheels = new Map<string, FakeWheel>([
    [FAKE_PYPI_REQ.name, buildWheel(FAKE_PYPI_REQ, 1)],
    [FAKE_PYPI_LOCK.name, buildWheel(FAKE_PYPI_LOCK, 2)],
  ]);
  const byFile = new Map([...wheels.values()].map((w) => [w.filename, w]));
  return {
    /** 処理したら true（応答も書く）。host / path は x-original-host と URL のパス */
    handle(host: string, path: string, res: ServerResponse): boolean {
      if (host === FAKE_PYPI_INDEX_HOST) {
        const m = /^\/simple\/([^/]+)\/?$/.exec(path.split("?")[0] ?? "");
        const name = (m?.[1] ?? "").toLowerCase().replace(/[-_.]+/g, "-");
        const w = wheels.get(name);
        if (!w) {
          res.writeHead(404);
          res.end("fake pypi: not found");
          return true;
        }
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(
          `<!DOCTYPE html><html><body><a href="https://${FAKE_PYPI_FILES_HOST}/packages/py3/${w.filename}#sha256=${w.sha256}">${w.filename}</a></body></html>\n`,
        );
        return true;
      }
      if (host === FAKE_PYPI_FILES_HOST) {
        const w = byFile.get((path.split("?")[0] ?? "").replace(/^\/packages\/py3\//, ""));
        if (!w) {
          res.writeHead(404);
          res.end("fake pypi: not found");
          return true;
        }
        res.setHeader("content-type", "application/octet-stream");
        res.end(w.file);
        return true;
      }
      return false;
    },
  };
}
