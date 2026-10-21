# Sandbox benchmark: standard-3 run 1

### env
- seconds: 0.24
- exit_code: 0
```
nproc=2
cpu.max=cat: /sys/fs/cgroup/cpu.max: No such file or directory
model name	: AMD EPYC
8
bash: line 1: free: command not found
usage_usec 107146270
user_usec 38097047
system_usec 69049222
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
- seconds: 75.23
- exit_code: 0
```
threads=1 units=8 wall_s=75.17
```

### cpu-node threads=2
- seconds: 39.18
- exit_code: 0
```
threads=2 units=8 wall_s=39.14
```

### cpu-node threads=4
- seconds: 35.54
- exit_code: 0
```
threads=4 units=8 wall_s=35.49
```

### cpu-node threads=8
- seconds: 37.12
- exit_code: 0
```
threads=8 units=8 wall_s=37.07
```

### openssl speed sha256 multi=1
- seconds: 18.01
- exit_code: 0
```
compiler: gcc -fPIC -pthread -m64 -Wa,--noexecstack -Wall -fzero-call-used-regs=used-gpr -DOPENSSL_TLS_SECURITY_LEVEL=2 -Wa,--noexecstack -g -O2 -ffile-prefix-map=/build/reproducible-path/openssl-3.0.22=. -fstack-protector-strong -Wformat -Werror=format-security -DOPENSSL_USE_NODELETE -DL_ENDIAN -DOPENSSL_PIC -DOPENSSL_BUILDING_OPENSSL -DNDEBUG -Wdate-time -D_FORTIFY_SOURCE=2
CPUINFO: OPENSSL_ia32cap=0xfffa3203078bffff:0x415fdef1bf07ab
sha256          111872.03k   384880.60k   937604.44k  1464064.34k  1751173.80k  1781776.38k
```

### openssl speed sha256 multi=2
- seconds: 18.01
- exit_code: 0
```
compiler: gcc -fPIC -pthread -m64 -Wa,--noexecstack -Wall -fzero-call-used-regs=used-gpr -DOPENSSL_TLS_SECURITY_LEVEL=2 -Wa,--noexecstack -g -O2 -ffile-prefix-map=/build/reproducible-path/openssl-3.0.22=. -fstack-protector-strong -Wformat -Werror=format-security -DOPENSSL_USE_NODELETE -DL_ENDIAN -DOPENSSL_PIC -DOPENSSL_BUILDING_OPENSSL -DNDEBUG -Wdate-time -D_FORTIFY_SOURCE=2
CPUINFO: OPENSSL_ia32cap=0xfffa3203078bffff:0x415fdef1bf07ab
sha256          220168.43k   751822.78k  1857157.72k  2930525.87k  3502252.03k  3565928.45k
```

### openssl speed sha256 multi=4
- seconds: 18.02
- exit_code: 0
```
compiler: gcc -fPIC -pthread -m64 -Wa,--noexecstack -Wall -fzero-call-used-regs=used-gpr -DOPENSSL_TLS_SECURITY_LEVEL=2 -Wa,--noexecstack -g -O2 -ffile-prefix-map=/build/reproducible-path/openssl-3.0.22=. -fstack-protector-strong -Wformat -Werror=format-security -DOPENSSL_USE_NODELETE -DL_ENDIAN -DOPENSSL_PIC -DOPENSSL_BUILDING_OPENSSL -DNDEBUG -Wdate-time -D_FORTIFY_SOURCE=2
CPUINFO: OPENSSL_ia32cap=0xfffa3203078bffff:0x415fdef1bf07ab
sha256          226534.14k   733066.01k  1886555.14k  2931077.12k  3516713.64k  3556944.55k
```

### vitest gateway maxWorkers=2 #1
- seconds: 88.11
- exit_code: 0
```

 ✓ test/unit/fake-agent.test.ts (1 test) 66ms

 Test Files  67 passed (67)
      Tests  1378 passed (1378)
   Start at  17:42:01
   Duration  86.99s (transform 3.44s, setup 75.35s, import 2.19s, tests 60.68s, environment 7ms)

```

### vitest gateway maxWorkers=4 #1
- seconds: 115.19
- exit_code: 0
```
 ✓ test/unit/github/crypto.test.ts (5 tests) 39ms
 ✓ test/unit/task-state.test.ts (5 tests) 30ms

 Test Files  67 passed (67)
      Tests  1378 passed (1378)
   Start at  17:43:31
   Duration  114.36s (transform 5.01s, setup 170.11s, import 3.47s, tests 210.88s, environment 11ms)

```

### vitest gateway maxWorkers=8 #1
- seconds: 113.67
- exit_code: 0
```
 ✓ test/unit/github/crypto.test.ts (5 tests) 36ms
 ✓ test/unit/task-state.test.ts (5 tests) 44ms

 Test Files  67 passed (67)
      Tests  1378 passed (1378)
   Start at  17:45:26
   Duration  112.82s (transform 11.64s, setup 325.07s, import 6.91s, tests 431.50s, environment 6ms)

```

### vitest gateway maxWorkers=2 #2
- seconds: 103.34
- exit_code: 0
```

 ✓ test/unit/github/crypto.test.ts (5 tests) 31ms

 Test Files  67 passed (67)
      Tests  1378 passed (1378)
   Start at  17:47:22
   Duration  102.53s (transform 2.97s, setup 104.42s, import 2.18s, tests 58.82s, environment 4ms)

```

### vitest gateway maxWorkers=4 #2
- seconds: 115.34
- exit_code: 0
```
 ✓ test/unit/task-state.test.ts (5 tests) 56ms
 ✓ test/unit/github/crypto.test.ts (5 tests) 28ms

 Test Files  67 passed (67)
      Tests  1378 passed (1378)
   Start at  17:49:05
   Duration  114.45s (transform 5.40s, setup 172.55s, import 3.66s, tests 207.95s, environment 6ms)

```

### vitest gateway maxWorkers=8 #2
- seconds: 110.48
- exit_code: 0
```
 ✓ test/unit/task-state.test.ts (5 tests) 54ms
 ✓ test/unit/github/crypto.test.ts (5 tests) 56ms

 Test Files  67 passed (67)
      Tests  1378 passed (1378)
   Start at  17:51:02
   Duration  109.70s (transform 10.07s, setup 308.61s, import 6.43s, tests 423.22s, environment 8ms)

```

### tsc gateway #1
- seconds: 1.76
- exit_code: 0
```
```

### tsc gateway #2
- seconds: 1.59
- exit_code: 0
```
```

### deps install (rm node_modules + pnpm install --frozen-lockfile)
- seconds: 2.34
- exit_code: 0
```
Progress: resolved 369, reused 369, downloaded 0, added 369, done
Agent skills awaiting approval: @cloudflare/workers-oauth-provider.
Run "pnpm approve" to review them.

devDependencies:
+ @biomejs/biome 2.5.15

Done in 1.1s using pnpm v12.14.0
```

### cpu.stat end
- seconds: 0.00
- exit_code: 0
```
user_usec 1128381023
system_usec 243633807
nice_usec 0
nr_periods 0
nr_throttled 0
throttled_usec 0
nr_bursts 0
burst_usec 0
```

### web_search
- 非信頼データのマーカー: 届かず（検索は2回とも search_failed で失敗、結果 0 件）
