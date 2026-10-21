# Sandbox benchmark: standard-3 run 2

### env
- seconds: 0.26
- exit_code: 0
```
nproc=2
cpu.max=cat: /sys/fs/cgroup/cpu.max: No such file or directory
model name	: AMD EPYC
8
bash: line 1: free: command not found
usage_usec 424807348
user_usec 214774760
system_usec 210032587
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
- seconds: 99.98
- exit_code: 0
```
threads=1 units=8 wall_s=99.92
```

### cpu-node threads=2
- seconds: 42.14
- exit_code: 0
```
threads=2 units=8 wall_s=42.08
```

### cpu-node threads=4
- seconds: 40.64
- exit_code: 0
```
threads=4 units=8 wall_s=40.59
```

### cpu-node threads=8
- seconds: 51.09
- exit_code: 0
```
threads=8 units=8 wall_s=51.02
```

### openssl speed sha256 multi=1
- seconds: 18.01
- exit_code: 0
```
compiler: gcc -fPIC -pthread -m64 -Wa,--noexecstack -Wall -fzero-call-used-regs=used-gpr -DOPENSSL_TLS_SECURITY_LEVEL=2 -Wa,--noexecstack -g -O2 -ffile-prefix-map=/build/reproducible-path/openssl-3.0.22=. -fstack-protector-strong -Wformat -Werror=format-security -DOPENSSL_USE_NODELETE -DL_ENDIAN -DOPENSSL_PIC -DOPENSSL_BUILDING_OPENSSL -DNDEBUG -Wdate-time -D_FORTIFY_SOURCE=2
CPUINFO: OPENSSL_ia32cap=0xfffa3203078bffff:0x415fdef1bf07ab
sha256          106562.44k   343123.16k   881066.58k  1387393.02k  1672850.09k  1695214.25k
```

### openssl speed sha256 multi=2
- seconds: 18.01
- exit_code: 0
```
compiler: gcc -fPIC -pthread -m64 -Wa,--noexecstack -Wall -fzero-call-used-regs=used-gpr -DOPENSSL_TLS_SECURITY_LEVEL=2 -Wa,--noexecstack -g -O2 -ffile-prefix-map=/build/reproducible-path/openssl-3.0.22=. -fstack-protector-strong -Wformat -Werror=format-security -DOPENSSL_USE_NODELETE -DL_ENDIAN -DOPENSSL_PIC -DOPENSSL_BUILDING_OPENSSL -DNDEBUG -Wdate-time -D_FORTIFY_SOURCE=2
CPUINFO: OPENSSL_ia32cap=0xfffa3203078bffff:0x415fdef1bf07ab
sha256          180696.54k   589795.48k  1701144.83k  2733947.90k  3393596.07k  3476105.90k
```

### openssl speed sha256 multi=4
- seconds: 18.02
- exit_code: 0
```
compiler: gcc -fPIC -pthread -m64 -Wa,--noexecstack -Wall -fzero-call-used-regs=used-gpr -DOPENSSL_TLS_SECURITY_LEVEL=2 -Wa,--noexecstack -g -O2 -ffile-prefix-map=/build/reproducible-path/openssl-3.0.22=. -fstack-protector-strong -Wformat -Werror=format-security -DOPENSSL_USE_NODELETE -DL_ENDIAN -DOPENSSL_PIC -DOPENSSL_BUILDING_OPENSSL -DNDEBUG -Wdate-time -D_FORTIFY_SOURCE=2
CPUINFO: OPENSSL_ia32cap=0xfffa3203078bffff:0x415fdef1bf07ab
sha256          201178.73k   719237.59k  1486209.45k  2406832.81k  2932025.75k  3370429.10k
```

### vitest gateway maxWorkers=2 #1
- seconds: 116.54
- exit_code: 0
```

 ✓ test/unit/fake-agent.test.ts (1 test) 81ms

 Test Files  67 passed (67)
      Tests  1378 passed (1378)
   Start at  17:43:06
   Duration  115.14s (transform 4.33s, setup 103.64s, import 2.88s, tests 75.31s, environment 9ms)

```

### vitest gateway maxWorkers=4 #1
- seconds: 152.21
- exit_code: 1
```


 Test Files  67 passed (67)
      Tests  1378 passed (1378)
     Errors  1 error
   Start at  17:45:03
   Duration  150.63s (transform 8.27s, setup 245.84s, import 5.27s, tests 252.08s, environment 12ms)

```

### vitest gateway maxWorkers=8 #1
- seconds: 119.99
- exit_code: 0
```

 ✓ test/unit/web-tools.test.ts (24 tests) 43ms

 Test Files  67 passed (67)
      Tests  1378 passed (1378)
   Start at  17:47:36
   Duration  118.93s (transform 15.22s, setup 287.44s, import 6.13s, tests 505.63s, environment 8ms)

```

### vitest gateway maxWorkers=2 #2
- seconds: 119.48
- exit_code: 0
```

 ✓ test/unit/web-tools.test.ts (24 tests) 45ms

 Test Files  67 passed (67)
      Tests  1378 passed (1378)
   Start at  17:49:36
   Duration  118.48s (transform 3.77s, setup 107.09s, import 2.56s, tests 76.17s, environment 7ms)

```

### vitest gateway maxWorkers=4 #2
- seconds: 149.56
- exit_code: 0
```

 ✓ test/unit/web-tools.test.ts (24 tests) 44ms

 Test Files  67 passed (67)
      Tests  1378 passed (1378)
   Start at  17:51:39
   Duration  148.50s (transform 7.17s, setup 241.82s, import 4.74s, tests 251.42s, environment 12ms)

```

### vitest gateway maxWorkers=8 #2
- seconds: 173.34
- exit_code: 0
```
 ✓ test/unit/github/config.test.ts (10 tests) 115ms
 ✓ test/unit/web-tools.test.ts (24 tests) 65ms

 Test Files  67 passed (67)
      Tests  1378 passed (1378)
   Start at  17:54:08
   Duration  172.21s (transform 16.52s, setup 601.67s, import 10.77s, tests 545.18s, environment 15ms)

```

### tsc gateway #1
- seconds: 3.01
- exit_code: 0
```
```

### tsc gateway #2
- seconds: 2.74
- exit_code: 0
```
```

### deps install (rm node_modules + pnpm install --frozen-lockfile)
- seconds: 3.56
- exit_code: 0
```
Progress: resolved 369, reused 369, downloaded 0, added 369, done
Agent skills awaiting approval: @cloudflare/workers-oauth-provider.
Run "pnpm approve" to review them.

devDependencies:
+ @biomejs/biome 2.5.15

Done in 1.7s using pnpm v12.14.0
```

### cpu.stat end
- seconds: 0.00
- exit_code: 0
```
user_usec 1610337959
system_usec 459399264
nice_usec 0
nr_periods 0
nr_throttled 0
throttled_usec 0
nr_bursts 0
burst_usec 0
```

### web_search
- web_search は 2 回ともエラー（search_failed）で結果が届かず、非信頼データのマーカーの有無・件数は確認不能（0 件扱いではない）
