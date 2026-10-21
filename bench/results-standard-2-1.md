# Sandbox benchmark: standard-2 run 1

### env
- seconds: 0.26
- exit_code: 0
```
nproc=1
cpu.max=cat: /sys/fs/cgroup/cpu.max: No such file or directory
model name	: AMD EPYC
8
bash: line 1: free: command not found
usage_usec 182793629
user_usec 80469280
system_usec 102324349
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
- seconds: 40.10
- exit_code: 0
```
threads=1 units=8 wall_s=40.06
```

### cpu-node threads=2
- seconds: 39.36
- exit_code: 0
```
threads=2 units=8 wall_s=39.31
```

### cpu-node threads=4
- seconds: 44.19
- exit_code: 0
```
threads=4 units=8 wall_s=44.14
```

### cpu-node threads=8
- seconds: 55.76
- exit_code: 0
```
threads=8 units=8 wall_s=55.72
```

### openssl speed sha256 multi=1
- seconds: 18.01
- exit_code: 0
```
compiler: gcc -fPIC -pthread -m64 -Wa,--noexecstack -Wall -fzero-call-used-regs=used-gpr -DOPENSSL_TLS_SECURITY_LEVEL=2 -Wa,--noexecstack -g -O2 -ffile-prefix-map=/build/reproducible-path/openssl-3.0.22=. -fstack-protector-strong -Wformat -Werror=format-security -DOPENSSL_USE_NODELETE -DL_ENDIAN -DOPENSSL_PIC -DOPENSSL_BUILDING_OPENSSL -DNDEBUG -Wdate-time -D_FORTIFY_SOURCE=2
CPUINFO: OPENSSL_ia32cap=0xfffa3203078bffff:0x415fdef1bf07ab
sha256          105463.35k   362794.92k   910526.63k  1450873.17k  1749595.48k  1777871.53k
```

### openssl speed sha256 multi=2
- seconds: 18.02
- exit_code: 0
```
compiler: gcc -fPIC -pthread -m64 -Wa,--noexecstack -Wall -fzero-call-used-regs=used-gpr -DOPENSSL_TLS_SECURITY_LEVEL=2 -Wa,--noexecstack -g -O2 -ffile-prefix-map=/build/reproducible-path/openssl-3.0.22=. -fstack-protector-strong -Wformat -Werror=format-security -DOPENSSL_USE_NODELETE -DL_ENDIAN -DOPENSSL_PIC -DOPENSSL_BUILDING_OPENSSL -DNDEBUG -Wdate-time -D_FORTIFY_SOURCE=2
CPUINFO: OPENSSL_ia32cap=0xfffa3203078bffff:0x415fdef1bf07ab
sha256          113422.82k   388567.45k   943015.94k  1461926.57k  1754292.22k  1781551.63k
```

### openssl speed sha256 multi=4
- seconds: 18.06
- exit_code: 0
```
compiler: gcc -fPIC -pthread -m64 -Wa,--noexecstack -Wall -fzero-call-used-regs=used-gpr -DOPENSSL_TLS_SECURITY_LEVEL=2 -Wa,--noexecstack -g -O2 -ffile-prefix-map=/build/reproducible-path/openssl-3.0.22=. -fstack-protector-strong -Wformat -Werror=format-security -DOPENSSL_USE_NODELETE -DL_ENDIAN -DOPENSSL_PIC -DOPENSSL_BUILDING_OPENSSL -DNDEBUG -Wdate-time -D_FORTIFY_SOURCE=2
CPUINFO: OPENSSL_ia32cap=0xfffa3203078bffff:0x415fdef1bf07ab
sha256          130211.59k   400904.29k   940547.88k  1473481.77k  1746488.13k  1769793.08k
```

### vitest gateway maxWorkers=2 #1
- seconds: 157.48
- exit_code: 1
```


 Test Files  67 passed (67)
      Tests  1378 passed (1378)
     Errors  1 error
   Start at  17:39:42
   Duration  156.15s (transform 4.68s, setup 148.47s, import 3.65s, tests 94.84s, environment 5ms)

```

### vitest gateway maxWorkers=4 #1
- seconds: 181.33
- exit_code: 0
```

 ✓ test/unit/fake-agent.test.ts (1 test) 41ms

 Test Files  67 passed (67)
      Tests  1378 passed (1378)
   Start at  17:42:22
   Duration  180.38s (transform 7.55s, setup 303.38s, import 6.07s, tests 282.29s, environment 6ms)

```

### vitest gateway maxWorkers=8 #1
- seconds: 184.02
- exit_code: 0
```
 ✓ test/unit/task-state.test.ts (5 tests) 100ms
 ✓ test/unit/fake-agent.test.ts (1 test) 67ms

 Test Files  67 passed (67)
      Tests  1378 passed (1378)
   Start at  17:45:24
   Duration  183.00s (transform 17.08s, setup 639.58s, import 11.29s, tests 548.33s, environment 10ms)

```

### vitest gateway maxWorkers=2 #2
- seconds: 153.84
- exit_code: 0
```

 ✓ test/unit/fake-agent.test.ts (1 test) 169ms

 Test Files  67 passed (67)
      Tests  1378 passed (1378)
   Start at  17:48:29
   Duration  152.90s (transform 3.92s, setup 152.47s, import 3.22s, tests 86.55s, environment 8ms)

```

### vitest gateway maxWorkers=4 #2
- seconds: 169.01
- exit_code: 0
```
 ✓ test/unit/task-state.test.ts (5 tests) 77ms
 ✓ test/unit/next-steps.test.ts (16 tests) 45ms

 Test Files  67 passed (67)
      Tests  1378 passed (1378)
   Start at  17:51:03
   Duration  168.04s (transform 7.11s, setup 283.56s, import 5.61s, tests 260.80s, environment 1ms)

```

### vitest gateway maxWorkers=8 #2
- seconds: 165.26
- exit_code: 0
```
 ✓ test/unit/index-backoff.test.ts (3 tests) 121ms
 ✓ test/unit/next-steps.test.ts (16 tests) 66ms

 Test Files  67 passed (67)
      Tests  1378 passed (1378)
   Start at  17:53:54
   Duration  164.24s (transform 15.87s, setup 567.12s, import 11.54s, tests 502.49s, environment 3ms)

```

### tsc gateway #1
- seconds: 3.05
- exit_code: 0
```
```

### tsc gateway #2
- seconds: 2.97
- exit_code: 0
```
```

### deps install (rm node_modules + pnpm install --frozen-lockfile)
- seconds: 3.28
- exit_code: 0
```
Progress: resolved 369, reused 369, downloaded 0, added 369, done
Agent skills awaiting approval: @cloudflare/workers-oauth-provider.
Run "pnpm approve" to review them.

devDependencies:
+ @biomejs/biome 2.5.15

Done in 1.9s using pnpm v12.14.0
```

### cpu.stat end
- seconds: 0.00
- exit_code: 0
```
user_usec 1052530310
system_usec 278478649
nice_usec 0
nr_periods 0
nr_throttled 0
throttled_usec 0
nr_bursts 0
burst_usec 0
```

### web_search
- 呼び出しは search_failed エラーで結果なし（非信頼データマーカーの有無・件数: 該当なし、0 件）
