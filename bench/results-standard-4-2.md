# Sandbox benchmark: standard-4 run 2

### env
- seconds: 0.25
- exit_code: 0
```
nproc=4
cpu.max=cat: /sys/fs/cgroup/cpu.max: No such file or directory
model name	: AMD EPYC
8
bash: line 1: free: command not found
usage_usec 129102334
user_usec 48635957
system_usec 80466377
nice_usec 0
nr_periods 0
nr_throttled 0
node: v24.22.0
pnpm: 12.14.0
cargo: missing
python3: Python 3.11.2
make: missing
go: missing
openssl: OpenSSL 3.0.22 25 Aug 2026 (Library: OpenSSL 3.0.22 25 Aug 2026)
```

### cpu-node threads=1
- seconds: 76.10
- exit_code: 0
```
threads=1 units=8 wall_s=76.04
```

### cpu-node threads=2
- seconds: 44.63
- exit_code: 0
```
threads=2 units=8 wall_s=44.58
```

### cpu-node threads=4
- seconds: 30.09
- exit_code: 0
```
threads=4 units=8 wall_s=30.03
```

### cpu-node threads=8
- seconds: 26.14
- exit_code: 0
```
threads=8 units=8 wall_s=26.08
```

### openssl speed sha256 multi=1
- seconds: 18.01
- exit_code: 0
```
compiler: gcc -fPIC -pthread -m64 -Wa,--noexecstack -Wall -fzero-call-used-regs=used-gpr -DOPENSSL_TLS_SECURITY_LEVEL=2 -Wa,--noexecstack -g -O2 -ffile-prefix-map=/build/reproducible-path/openssl-3.0.22=. -fstack-protector-strong -Wformat -Werror=format-security -DOPENSSL_USE_NODELETE -DL_ENDIAN -DOPENSSL_PIC -DOPENSSL_BUILDING_OPENSSL -DNDEBUG -Wdate-time -D_FORTIFY_SOURCE=2
CPUINFO: OPENSSL_ia32cap=0xfffa3203078bffff:0x415fdef1bf07ab
sha256          113149.75k   365196.80k   892197.03k  1419426.96k  1731690.50k  1759029.93k
```

### openssl speed sha256 multi=2
- seconds: 18.01
- exit_code: 0
```
compiler: gcc -fPIC -pthread -m64 -Wa,--noexecstack -Wall -fzero-call-used-regs=used-gpr -DOPENSSL_TLS_SECURITY_LEVEL=2 -Wa,--noexecstack -g -O2 -ffile-prefix-map=/build/reproducible-path/openssl-3.0.22=. -fstack-protector-strong -Wformat -Werror=format-security -DOPENSSL_USE_NODELETE -DL_ENDIAN -DOPENSSL_PIC -DOPENSSL_BUILDING_OPENSSL -DNDEBUG -Wdate-time -D_FORTIFY_SOURCE=2
CPUINFO: OPENSSL_ia32cap=0xfffa3203078bffff:0x415fdef1bf07ab
sha256          201828.27k   647548.78k  1719205.46k  2788920.66k  3414346.41k  3447298.33k
```

### openssl speed sha256 multi=4
- seconds: 18.01
- exit_code: 0
```
compiler: gcc -fPIC -pthread -m64 -Wa,--noexecstack -Wall -fzero-call-used-regs=used-gpr -DOPENSSL_TLS_SECURITY_LEVEL=2 -Wa,--noexecstack -g -O2 -ffile-prefix-map=/build/reproducible-path/openssl-3.0.22=. -fstack-protector-strong -Wformat -Werror=format-security -DOPENSSL_USE_NODELETE -DL_ENDIAN -DOPENSSL_PIC -DOPENSSL_BUILDING_OPENSSL -DNDEBUG -Wdate-time -D_FORTIFY_SOURCE=2
CPUINFO: OPENSSL_ia32cap=0xfffa3203078bffff:0x415fdef1bf07ab
sha256          439868.85k  1379734.63k  3371286.02k  5586008.41k  6821325.48k  6934599.00k
```

### vitest gateway maxWorkers=2 #1
- seconds: 123.45
- exit_code: 0
```

 ✓ test/unit/fake-agent.test.ts (1 test) 68ms

 Test Files  67 passed (67)
      Tests  1378 passed (1378)
   Start at  17:42:19
   Duration  122.02s (transform 4.53s, setup 122.97s, import 2.61s, tests 72.80s, environment 10ms)

```

### vitest gateway maxWorkers=4 #1
- seconds: 104.47
- exit_code: 0
```
 ✓ test/unit/index-backoff.test.ts (3 tests) 61ms
 ✓ test/unit/web-tools.test.ts (24 tests) 50ms

 Test Files  67 passed (67)
      Tests  1378 passed (1378)
   Start at  17:44:24
   Duration  103.37s (transform 6.84s, setup 134.61s, import 3.58s, tests 204.09s, environment 13ms)

```

### vitest gateway maxWorkers=8 #1
- seconds: 114.50
- exit_code: 0
```
 ✓ test/unit/web-tools.test.ts (24 tests) 63ms
 ✓ test/unit/github/client-pr.test.ts (11 tests) 59ms

 Test Files  67 passed (67)
      Tests  1378 passed (1378)
   Start at  17:46:09
   Duration  113.40s (transform 12.59s, setup 305.50s, import 6.72s, tests 451.96s, environment 10ms)

```

### vitest gateway maxWorkers=2 #2
- seconds: 127.16
- exit_code: 0
```

 ✓ test/unit/next-steps.test.ts (16 tests) 48ms

 Test Files  67 passed (67)
      Tests  1378 passed (1378)
   Start at  17:48:05
   Duration  126.16s (transform 4.06s, setup 126.63s, import 2.63s, tests 73.17s, environment 7ms)

```

### vitest gateway maxWorkers=4 #2
- seconds: 107.01
- exit_code: 0
```
 ✓ test/unit/task-state.test.ts (5 tests) 50ms
 ✓ test/unit/index-backoff.test.ts (3 tests) 38ms

 Test Files  67 passed (67)
      Tests  1378 passed (1378)
   Start at  17:50:12
   Duration  105.80s (transform 7.54s, setup 142.47s, import 3.23s, tests 204.51s, environment 14ms)

```

### vitest gateway maxWorkers=8 #2
- seconds: 125.47
- exit_code: 0
```
 ✓ test/unit/task-state.test.ts (5 tests) 43ms
 ✓ test/unit/index-backoff.test.ts (3 tests) 54ms

 Test Files  67 passed (67)
      Tests  1378 passed (1378)
   Start at  17:52:01
   Duration  124.03s (transform 16.30s, setup 372.78s, import 7.60s, tests 452.31s, environment 14ms)

```

### tsc gateway #1
- seconds: 1.66
- exit_code: 0
```
```

### tsc gateway #2
- seconds: 1.45
- exit_code: 0
```
```

### deps install (rm node_modules + pnpm install --frozen-lockfile)
- seconds: 3.22
- exit_code: 0
```
Progress: resolved 369, reused 369, downloaded 0, added 369, done
Agent skills awaiting approval: @cloudflare/workers-oauth-provider.
Run "pnpm approve" to review them.

devDependencies:
+ @biomejs/biome 2.5.15

Done in 1.3s using pnpm v12.14.0
```

### cpu.stat end
- seconds: 0.00
- exit_code: 0
```
user_usec 1614274702
system_usec 365977489
nice_usec 0
nr_periods 0
nr_throttled 0
throttled_usec 0
nr_bursts 0
burst_usec 0
```

### web_search
- マーカー: 無し / 件数: 0 件（検索サービスがエラー search_failed を返し、結果は届かず）
