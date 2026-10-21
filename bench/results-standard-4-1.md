# Sandbox benchmark: standard-4 run 1

### env
- seconds: 0.26
- exit_code: 0
```
nproc=4
cpu.max=cat: /sys/fs/cgroup/cpu.max: No such file or directory
model name	: AMD EPYC
8
bash: line 1: free: command not found
usage_usec 93009141
user_usec 36315776
system_usec 56693365
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
- seconds: 84.05
- exit_code: 0
```
threads=1 units=8 wall_s=83.99
```

### cpu-node threads=2
- seconds: 44.35
- exit_code: 0
```
threads=2 units=8 wall_s=44.30
```

### cpu-node threads=4
- seconds: 25.56
- exit_code: 0
```
threads=4 units=8 wall_s=25.50
```

### cpu-node threads=8
- seconds: 23.93
- exit_code: 0
```
threads=8 units=8 wall_s=23.87
```

### openssl speed sha256 multi=1
- seconds: 18.01
- exit_code: 0
```
compiler: gcc -fPIC -pthread -m64 -Wa,--noexecstack -Wall -fzero-call-used-regs=used-gpr -DOPENSSL_TLS_SECURITY_LEVEL=2 -Wa,--noexecstack -g -O2 -ffile-prefix-map=/build/reproducible-path/openssl-3.0.22=. -fstack-protector-strong -Wformat -Werror=format-security -DOPENSSL_USE_NODELETE -DL_ENDIAN -DOPENSSL_PIC -DOPENSSL_BUILDING_OPENSSL -DNDEBUG -Wdate-time -D_FORTIFY_SOURCE=2
CPUINFO: OPENSSL_ia32cap=0xfffa3203078bffff:0x415fdef1bf07ab
sha256           96928.11k   327627.52k   837762.65k  1364845.57k  1668022.27k  1716251.31k
```

### openssl speed sha256 multi=2
- seconds: 18.01
- exit_code: 0
```
compiler: gcc -fPIC -pthread -m64 -Wa,--noexecstack -Wall -fzero-call-used-regs=used-gpr -DOPENSSL_TLS_SECURITY_LEVEL=2 -Wa,--noexecstack -g -O2 -ffile-prefix-map=/build/reproducible-path/openssl-3.0.22=. -fstack-protector-strong -Wformat -Werror=format-security -DOPENSSL_USE_NODELETE -DL_ENDIAN -DOPENSSL_PIC -DOPENSSL_BUILDING_OPENSSL -DNDEBUG -Wdate-time -D_FORTIFY_SOURCE=2
CPUINFO: OPENSSL_ia32cap=0xfffa3203078bffff:0x415fdef1bf07ab
sha256          195166.14k   681762.28k  1683421.27k  2701343.74k  3320788.31k  3432420.69k
```

### openssl speed sha256 multi=4
- seconds: 18.01
- exit_code: 0
```
compiler: gcc -fPIC -pthread -m64 -Wa,--noexecstack -Wall -fzero-call-used-regs=used-gpr -DOPENSSL_TLS_SECURITY_LEVEL=2 -Wa,--noexecstack -g -O2 -ffile-prefix-map=/build/reproducible-path/openssl-3.0.22=. -fstack-protector-strong -Wformat -Werror=format-security -DOPENSSL_USE_NODELETE -DL_ENDIAN -DOPENSSL_PIC -DOPENSSL_BUILDING_OPENSSL -DNDEBUG -Wdate-time -D_FORTIFY_SOURCE=2
CPUINFO: OPENSSL_ia32cap=0xfffa3203078bffff:0x415fdef1bf07ab
sha256          403903.34k  1269736.90k  3151070.38k  5056431.10k  6079567.19k  6267218.60k
```

### vitest gateway maxWorkers=2 #1
- seconds: 130.34
- exit_code: 0
```

 ✓ test/unit/fake-agent.test.ts (1 test) 92ms

 Test Files  67 passed (67)
      Tests  1378 passed (1378)
   Start at  17:42:14
   Duration  128.92s (transform 4.88s, setup 127.39s, import 3.13s, tests 77.92s, environment 14ms)

```

### vitest gateway maxWorkers=4 #1
- seconds: 96.59
- exit_code: 0
```
 ✓ test/unit/index-backoff.test.ts (3 tests) 42ms
 ✓ test/unit/github/crypto.test.ts (5 tests) 39ms

 Test Files  67 passed (67)
      Tests  1378 passed (1378)
   Start at  17:44:24
   Duration  95.37s (transform 7.46s, setup 127.45s, import 3.23s, tests 182.57s, environment 13ms)

```

### vitest gateway maxWorkers=8 #1
- seconds: 121.18
- exit_code: 1
```
⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed | 66 passed (67)
      Tests  1 failed | 1377 passed (1378)
   Start at  17:46:04
   Duration  120.10s (transform 15.57s, setup 353.57s, import 7.82s, tests 452.50s, environment 16ms)

```

### vitest gateway maxWorkers=2 #2
- seconds: 129.44
- exit_code: 0
```

 ✓ test/unit/github/crypto.test.ts (5 tests) 42ms

 Test Files  67 passed (67)
      Tests  1378 passed (1378)
   Start at  17:48:07
   Duration  128.35s (transform 4.09s, setup 132.42s, import 2.78s, tests 72.34s, environment 12ms)

```

### vitest gateway maxWorkers=4 #2
- seconds: 129.66
- exit_code: 0
```

 ✓ test/unit/next-steps.test.ts (16 tests) 34ms

 Test Files  67 passed (67)
      Tests  1378 passed (1378)
   Start at  17:50:19
   Duration  128.19s (transform 8.13s, setup 211.79s, import 4.53s, tests 210.75s, environment 7ms)

```

### vitest gateway maxWorkers=8 #2
- seconds: 116.32
- exit_code: 0
```
 ✓ test/unit/next-steps.test.ts (16 tests) 67ms
 ✓ test/unit/github/crypto.test.ts (5 tests) 43ms

 Test Files  67 passed (67)
      Tests  1378 passed (1378)
   Start at  17:52:30
   Duration  115.11s (transform 15.37s, setup 325.18s, import 6.19s, tests 436.36s, environment 17ms)

```

### tsc gateway #1
- seconds: 1.63
- exit_code: 0
```
```

### tsc gateway #2
- seconds: 1.48
- exit_code: 0
```
```

### deps install (rm node_modules + pnpm install --frozen-lockfile)
- seconds: 3.07
- exit_code: 0
```
Progress: resolved 369, reused 369, downloaded 0, added 369, done
Agent skills awaiting approval: @cloudflare/workers-oauth-provider.
Run "pnpm approve" to review them.

devDependencies:
+ @biomejs/biome 2.5.15

Done in 1.4s using pnpm v12.14.0
```

### cpu.stat end
- seconds: 0.00
- exit_code: 0
```
user_usec 1603956338
system_usec 341742732
nice_usec 0
nr_periods 0
nr_throttled 0
throttled_usec 0
nr_bursts 0
burst_usec 0
```

### web_search
- web_search 呼び出しは 2 回ともエラー（search_failed）で結果が返らず、非信頼データのマーカーの有無・件数は確認できず（件数 0）
