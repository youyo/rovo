# Sandbox benchmark: standard-2 run 2

### env
- seconds: 0.24
- exit_code: 0
```
nproc=1
cpu.max=cat: /sys/fs/cgroup/cpu.max: No such file or directory
model name	: AMD EPYC
8
bash: line 1: free: command not found
usage_usec 1242638
user_usec 454110
system_usec 788527
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
- seconds: 38.59
- exit_code: 0
```
threads=1 units=8 wall_s=38.55
```

### cpu-node threads=2
- seconds: 39.29
- exit_code: 0
```
threads=2 units=8 wall_s=39.25
```

### cpu-node threads=4
- seconds: 48.11
- exit_code: 0
```
threads=4 units=8 wall_s=48.07
```

### cpu-node threads=8
- seconds: 61.15
- exit_code: 0
```
threads=8 units=8 wall_s=61.10
```

### openssl speed sha256 multi=1
- seconds: 18.01
- exit_code: 0
```
compiler: gcc -fPIC -pthread -m64 -Wa,--noexecstack -Wall -fzero-call-used-regs=used-gpr -DOPENSSL_TLS_SECURITY_LEVEL=2 -Wa,--noexecstack -g -O2 -ffile-prefix-map=/build/reproducible-path/openssl-3.0.22=. -fstack-protector-strong -Wformat -Werror=format-security -DOPENSSL_USE_NODELETE -DL_ENDIAN -DOPENSSL_PIC -DOPENSSL_BUILDING_OPENSSL -DNDEBUG -Wdate-time -D_FORTIFY_SOURCE=2
CPUINFO: OPENSSL_ia32cap=0xfffa3203078bffff:0x415fdef1bf07ab
sha256          115975.02k   389467.90k   949974.10k  1476524.71k  1761198.08k  1785255.25k
```

### openssl speed sha256 multi=2
- seconds: 18.02
- exit_code: 0
```
compiler: gcc -fPIC -pthread -m64 -Wa,--noexecstack -Wall -fzero-call-used-regs=used-gpr -DOPENSSL_TLS_SECURITY_LEVEL=2 -Wa,--noexecstack -g -O2 -ffile-prefix-map=/build/reproducible-path/openssl-3.0.22=. -fstack-protector-strong -Wformat -Werror=format-security -DOPENSSL_USE_NODELETE -DL_ENDIAN -DOPENSSL_PIC -DOPENSSL_BUILDING_OPENSSL -DNDEBUG -Wdate-time -D_FORTIFY_SOURCE=2
CPUINFO: OPENSSL_ia32cap=0xfffa3203078bffff:0x415fdef1bf07ab
sha256          117627.35k   388480.36k   942806.78k  1463886.51k  1750687.44k  1775348.39k
```

### openssl speed sha256 multi=4
- seconds: 18.06
- exit_code: 0
```
compiler: gcc -fPIC -pthread -m64 -Wa,--noexecstack -Wall -fzero-call-used-regs=used-gpr -DOPENSSL_TLS_SECURITY_LEVEL=2 -Wa,--noexecstack -g -O2 -ffile-prefix-map=/build/reproducible-path/openssl-3.0.22=. -fstack-protector-strong -Wformat -Werror=format-security -DOPENSSL_USE_NODELETE -DL_ENDIAN -DOPENSSL_PIC -DOPENSSL_BUILDING_OPENSSL -DNDEBUG -Wdate-time -D_FORTIFY_SOURCE=2
CPUINFO: OPENSSL_ia32cap=0xfffa3203078bffff:0x415fdef1bf07ab
sha256          115052.63k   387422.77k   949076.45k  1455790.48k  1749996.27k  1785335.34k
```

### vitest gateway maxWorkers=2 #1
- seconds: 156.19
- exit_code: 0
```

 ✓ test/unit/fake-agent.test.ts (1 test) 55ms

 Test Files  67 passed (67)
      Tests  1378 passed (1378)
   Start at  17:41:54
   Duration  154.91s (transform 4.35s, setup 147.77s, import 3.27s, tests 96.36s, environment 10ms)

```

### vitest gateway maxWorkers=4 #1
- seconds: 160.37
- exit_code: 0
```
 ✓ test/unit/fake-agent.test.ts (1 test) 107ms
 ✓ test/unit/next-steps.test.ts (16 tests) 73ms

 Test Files  67 passed (67)
      Tests  1378 passed (1378)
   Start at  17:44:30
   Duration  159.33s (transform 7.52s, setup 235.09s, import 5.51s, tests 269.26s, environment 4ms)

```

### vitest gateway maxWorkers=8 #1
- seconds: 162.14
- exit_code: 0
```
 ✓ test/unit/index-backoff.test.ts (3 tests) 127ms
 ✓ test/unit/next-steps.test.ts (16 tests) 43ms

 Test Files  67 passed (67)
      Tests  1378 passed (1378)
   Start at  17:47:13
   Duration  161.11s (transform 17.75s, setup 483.09s, import 11.26s, tests 552.63s, environment 6ms)

```

### vitest gateway maxWorkers=2 #2
- seconds: 155.89
- exit_code: 0
```
 ✓ test/unit/index-backoff.test.ts (3 tests) 87ms
 ✓ test/unit/next-steps.test.ts (16 tests) 32ms

 Test Files  67 passed (67)
      Tests  1378 passed (1378)
   Start at  17:49:55
   Duration  154.80s (transform 3.89s, setup 156.96s, import 3.20s, tests 85.63s, environment 5ms)

```

### vitest gateway maxWorkers=4 #2
- seconds: 175.28
- exit_code: 0
```
 ✓ test/unit/github/repo-api.test.ts (10 tests) 69ms
 ✓ test/unit/next-steps.test.ts (16 tests) 33ms

 Test Files  67 passed (67)
      Tests  1378 passed (1378)
   Start at  17:52:33
   Duration  174.34s (transform 7.88s, setup 292.41s, import 6.02s, tests 271.15s, environment 2ms)

```

### vitest gateway maxWorkers=8 #2
- seconds: 179.13
- exit_code: 0
```
 ✓ test/unit/github/repo-api.test.ts (10 tests) 181ms
 ✓ test/unit/github/client-pr.test.ts (11 tests) 170ms

 Test Files  67 passed (67)
      Tests  1378 passed (1378)
   Start at  17:55:28
   Duration  178.21s (transform 16.43s, setup 623.25s, import 12.36s, tests 533.78s, environment 9ms)

```

### tsc gateway #1
- seconds: 3.42
- exit_code: 0
```
```

### tsc gateway #2
- seconds: 2.73
- exit_code: 0
```
```

### deps install (rm node_modules + pnpm install --frozen-lockfile)
- seconds: 3.27
- exit_code: 0
```
Progress: resolved 369, reused 369, downloaded 0, added 369, done
Agent skills awaiting approval: @cloudflare/workers-oauth-provider.
Run "pnpm approve" to review them.

devDependencies:
+ @biomejs/biome 2.5.15

Done in 2s using pnpm v12.14.0
```

### cpu.stat end
- seconds: 0.00
- exit_code: 0
```
user_usec 959713788
system_usec 175771734
nice_usec 0
nr_periods 0
nr_throttled 0
throttled_usec 0
nr_bursts 0
burst_usec 0
```

### web_search
- 呼び出しは search_failed で失敗し結果は届かず。非信頼データのマーカーは無し、件数 0
