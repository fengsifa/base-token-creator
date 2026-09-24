# Tokenbase 审计 · 修复 · 测试 · 部署报告

日期：2026-09-21（工作跨至 09-22 凌晨）
上游仓库：https://github.com/fengsifa/base-token-creator （main，唯一 commit `e5e4483`）
线上地址：**https://openrelays.com** （`/` 首页、`/creator` 创建页、`/setup` 工厂部署页、`/admin` 后台）

---

## A. 项目原始状态审计

### 技术栈（未改变）

| 层 | 技术 |
| --- | --- |
| 框架 | Next.js 14.2.35 App Router，React 18.3.1，TypeScript 5.7.2 |
| 钱包 | wagmi 2.19.5 + viem ^2.37.0 + @tanstack/react-query 5.59.0 |
| 数据库 | PostgreSQL 16（Docker 内部网络，无对外端口）+ pg 8.23 |
| 部署 | Docker Compose（app + postgres）、Caddy 反向代理 |
| 本轮新增 | Hardhat 2.29 + OpenZeppelin 5 + vitest 2（仅开发期工具链） |

未使用但保留的依赖：`@x402/core`、`@x402/evm`、`@x402/svm`（全仓库无任何 import，推测为后续付费协议预留）。

### 原始仓库规模

全仓库 **400 行**，基本是骨架。`contracts/TokenFactory.sol` 与多数页面被压成单行。

### 关键结论

| 问题 | 结论 |
| --- | --- |
| Token Factory 合约是否存在 | **存在**，但只有 5 行单行压缩代码，且 `import @openzeppelin/contracts` 而该包**不在 package.json 中** |
| 合约是否编译过 | **否**。无 Hardhat / Foundry 配置、无 `test/`、无部署脚本 → 仓库内从未编译成功过 |
| Factory 是否已部署 | **否**。全仓库扫描 `0x[0-9a-fA-F]{40}` **零命中**，`.env.example` 三个工厂地址变量全为空 |
| 前端 ABI 是否匹配 | 类型与顺序一致（调用能编码成功），但参数名与合约不一致、缺少自定义错误定义，无法解码 revert 原因 |
| 只是 UI 没有实现的功能 | "Transaction Fee (%)" 开关、折叠的 "Advanced Options"、Burnable/Mintable/Pausable、Anti whale/Anti Bot/Blacklist（后者已诚实标注 Unavailable） |
| 死代码 | `components/network-selector.tsx` 从未被 import（保留未动） |

### 审计发现并修复的真实缺陷

1. **`decimals = 0` 请求必被拒绝**：`app/api/creations/route.ts` 用 `!body.decimals` 判断必填，`0` 是 falsy → 返回 400。这是用户特别要求检查的场景，确认是真实 Bug。
2. **0 手续费模式整个流程卡死**：`pay()` 要求 `feeEth` 为真值，`deploy()` 要求 `paymentHash`；按钮启用条件 `canPay` 也要求 `feeEth`。手续费为 0 时按钮永远无法点击。
3. **`lib/config.ts` 在客户端失效**：读取 `process.env.BASE_NETWORK`（无 `NEXT_PUBLIC_` 前缀），在浏览器里恒为 `undefined`，只是恰好 fallback 到 sepolia 才没被发现。
4. **改工厂地址必须重建镜像**：`NEXT_PUBLIC_*` 在构建期被内联，换地址要重新 `docker build`。
5. **不校验工厂地址是否真有代码**：错误地址会在钱包弹窗后才失败。
6. **localStorage 恢复过于宽松**：`startsWith("0x")` 即信任，垃圾数据会被当作有效交易哈希。
7. **余额读数取错网络**：`useBalance` 读的是钱包当前链，而非 Base Sepolia。
8. **Logo 上传接受 SVG**：`image/*` 白名单 + 同源静态托管 = 存储型 XSS 面。
9. **管理员密钥用 `!==` 比较**：存在时序侧信道。

---

## B. 修改的文件清单

### 新增

| 文件 | 目的 |
| --- | --- |
| `contracts/TokenFactory.sol`（重写） | 可审计的 ERC-20 工厂：无 owner、无手续费、无后门，补齐 `decimals <= 18`、`supply > 0`、名称/符号字节长度校验，改用自定义错误 |
| `hardhat.config.ts` | Hardhat 2 + OZ，固定 solc 0.8.24、`evmVersion: paris`，localBaseSepolia/mainnet 网络，密钥只从环境变量读 |
| `tsconfig.hardhat.json` | 合约工具链专用的 CommonJS TS 配置（避免污染 Next 的 bundler 模式） |
| `lib/validation.ts` | **纯函数**参数校验 + 单位换算；不依赖 React/wagmi/viem，可被浏览器、API 和测试共用 |
| `lib/creator-state.ts` | **纯函数** UI 状态推导（按钮文案/禁用/阻塞原因/失败回退阶段） |
| `lib/app-config-context.ts` | 配置上下文，取代原先客户端直读环境变量的写法 |
| `components/creator-form.tsx` | 创建流程主体（从原 `app/creator/page.tsx` 拆出并重写） |
| `components/factory-setup.tsx` | **浏览器内一键部署 Factory**，不需要私钥也不需要 CLI |
| `app/setup/page.tsx` | `/setup` 路由 |
| `lib/tokenfactory-artifact.json` | 编译产出的 ABI + 字节码，供浏览器部署与 ABI 漂移检查使用 |
| `test/unit/validation.test.ts` | 参数校验与 Supply/Decimals 换算测试 |
| `test/unit/creator-state.test.ts` | 未连接钱包 / 错误网络 / 手续费 / 交易失败等分支测试 |
| `test/unit/config.test.ts` | 环境变量解析与降级行为测试 |
| `test/unit/abi-consistency.test.ts` | 手写 ABI 与编译产物一致性检查（防止漂移） |
| `test/contract/TokenFactory.test.ts` | 合约行为测试（真实 EVM） |
| `test/integration/local-chain.test.ts` | 用 **viem** 走前端同一条 ABI，对本地 Hardhat 节点做端到端测试 |
| `vitest.config.ts` / `vitest.integration.config.ts` | 单测与集成测试分离的配置 |
| `scripts/export-artifact.mjs` | 把编译产物导出到 `lib/` |
| `scripts/deploy-factory.ts` | CLI 版工厂部署（可选；含主网二次确认保护） |
| `scripts/run-integration-tests.mjs` | 起本地节点 → 跑集成测试 → 自动清理 |
| `scripts/smoke-test.mjs` | 启动构建产物，验证页面在无钱包、无数据库时可用 |

### 修改

| 文件 | 修改目的 |
| --- | --- |
| `app/api/creations/route.ts` | 修 `decimals = 0` 被拒；用同一套校验做服务端二次校验；地址/哈希/状态白名单 |
| `app/api/creations/[id]/route.ts` | UUID 校验、字段白名单校验、404 处理 |
| `app/api/uploads/route.ts` | 只接受 PNG/JPEG/WebP/GIF，拒绝 SVG；空文件校验 |
| `app/api/admin/session/route.ts` | 恒定时间比较密钥 |
| `lib/config.ts` | 纯函数化；地址做校验与 checksum；手续费非法值降级为 0；**低于 0.0001 的非零手续费自动抬升到 0.0001** |
| `lib/contracts.ts` | ABI 与合约逐字对齐，补自定义错误 + 面向用户的错误文案映射 |
| `app/layout.tsx` | 改为**请求时**解析配置（换地址只需重启容器，不必重建镜像） |
| `app/providers.tsx` | 由服务端配置构建 wagmi，两个 Base 网络都注册以支持切链 |
| `app/creator/page.tsx` | 瘦身为路由壳，渲染 `CreatorForm` |
| `app/page.tsx` | 网络与手续费状态按实际配置展示；步骤文案去掉不存在的"付费"步骤 |
| `package.json` | 加入合约/测试脚本与开发依赖 |
| `tsconfig.json` | `target` 由 `ES2017` 提到 `ES2020`（原设置不支持 BigInt 字面量） |
| `.env.example` | 重写为带说明的模板，明确区分免费模式与最低手续费模式 |
| `.gitignore` / `.dockerignore` | 忽略 `artifacts`/`cache`/`*.tsbuildinfo` 等工具链产物 |
| `README.md` | 重写为与实际代码一致的说明与验证步骤 |

---

## C. 已完成的功能（Base Sepolia MVP 12 项）

1. 连接 MetaMask / 注入式钱包 —— 完成
2. 检测当前网络 —— 完成
3. 提示并一键切换到 Base Sepolia —— 完成（按钮直接变成"Switch to Base Sepolia"）
4. Token Name 输入 + 校验 —— 完成
5. Token Symbol 输入 + 校验（自动大写） —— 完成
6. Token Supply 输入 + 校验 —— 完成
7. Token Decimals 输入 + 校验（**0 已正确处理**） —— 完成
8. 创建 ERC-20 —— 完成，真实调用工厂合约
9. 由用户钱包签名确认 —— 完成
10. 显示真实交易状态（待确认/已确认/失败） —— 完成
11. 交易成功后显示**真实**合约地址 —— 完成，取自收据里的 `TokenCreated` 事件
12. 提供区块浏览器入口 —— 完成（代币地址 + 交易哈希双入口）

额外增强（超出 MVP）：

- **链上回读校验**：成功面板会用标准 ERC-20 接口读回 `name/symbol/decimals/totalSupply/balanceOf` 并展示，用链上数据自证
- **提交前校验工厂地址是否真有代码**，错误地址不会走到钱包弹窗
- **基础单位预览**：输入参数下方实时显示 `1000000 MTK · 18 decimals · 1000000000000000000000000 base units`，把小数位错误暴露在签名之前
- **零手续费单笔交易**：手续费为 0 时只签 1 笔（原来是强制 2 笔）
- **`/setup` 浏览器内部署工厂**：无需私钥、无需 CLI
- **数据库不可用时应用仍可用**：链上状态是唯一权威，数据库只是镜像

---

## D. 尚未完成的功能

- Burnable / Mintable / Pausable / Anti-whale / Anti-Bot / Blacklist / 交易税 / Reflection / 通缩（当前合约**故意不实现**，UI 中标注为 Unavailable）
- Base 主网配置（代码已支持 `NEXT_PUBLIC_BASE_NETWORK=mainnet`，但未做任何主网实测）
- WalletConnect（代码已支持，需要填入 `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`）
- Basescan 源码验证（需要额外安装 `@nomicfoundation/hardhat-verify` 并提供 API Key）
- 管理员鉴权加固：目前仍把 `ADMIN_SECRET` 本身存在 cookie 里（已改为恒定时间比较，但更稳的做法是签发一次性会话令牌）
- 前端没有任何浏览器级自动化测试（未引入 Playwright）：UI 分支通过纯函数单测覆盖，页面渲染通过冒烟测试覆盖

---

## E. 实际执行的测试及结果

全部在服务器容器内执行（`node:22-bookworm-slim`），**非本机模拟**。

| # | 测试 | 命令 | 结果 |
| --- | --- | --- | --- |
| 1 | 依赖安装 | `npm install` | ✅ 1141 个包 |
| 2 | TypeScript 检查 | `npm run typecheck` | ✅ 0 error |
| 3 | ESLint | `npm run lint` | ✅ 通过 |
| 4 | 合约编译 | `npx hardhat compile` | ✅ solc 0.8.24，creation bytecode **4365 字节**（EIP-170 上限 24576） |
| 5 | ERC-20 单元测试 | `npm run test:contract` | ✅ **24 passing / 0 failing** |
| 6 | 参数校验测试 | `npm run test:unit` | ✅ **101 passing / 0 failing**（4 个文件） |
| 7 | Supply/Decimals 换算测试 | 含于上项 | ✅ 与 viem `parseUnits` 逐组合交叉验证一致 |
| 8 | 钱包未连接时的页面 | `npm run test:smoke` | ✅ `/creator` 无钱包正常渲染 |
| 9 | 错误网络提示 | 单测 `creator-state.test.ts` | ✅ 未连接/切链/切链中/错误网络各分支 |
| 10 | 交易失败状态处理 | 单测 + 集成测试 | ✅ 失败回退阶段与文案；非法调用在发送前被拒 |
| 11 | 交易等待/成功/失败 | 集成测试 | ✅ 待确认 → 成功（含事件解析）；失败不产生任何成功态 |
| 12 | Next.js 构建 | `npm run build` | ✅ 11 个路由，全部按预期动态渲染 |
| 13 | 构建产物冒烟 | `npm run test:smoke` | ✅ **16/16 checks passed** |
| 14 | 端到端（真实 EVM） | `npm run test:integration` | ✅ **17 passing / 0 failing** |

### 集成测试实际验证了什么（不是 mock）

- 用 `lib/tokenfactory-artifact.json` 里的**真实字节码**部署工厂（即 `/setup` 走的同一条路径）
- 用**前端同一份 ABI** 调用 `createToken`，并用与前端**相同的 `decodeEventLog`** 从收据解析出代币地址
- decimals = 18 / 6 / 0 三种情况、名称 32 字节与符号 12 字节边界、连续创建两个不同合约
- 链上读回 `totalSupply` 与前端校验算出的 base units **逐位相等**
- 用原始 selector 调用 `mint` / `owner` / `pause`，**全部 revert** → 证明代币没有后门函数
- 空名称、decimals=19、supply=0 均被合约拒绝，且错误能被前端文案映射正确解码

---

## F. 未通过的测试和原因

**最终一轮：无失败。** 迭代过程中出现过的失败全部是**测试代码自身的问题**，已修正，如实列出：

| 失败项 | 根本原因 | 处理 |
| --- | --- | --- |
| typecheck 88 个 `TS2737` | `tsconfig.json` 为 `target: ES2017`，不支持 BigInt 字面量（项目原先没有任何 BigInt，所以从未暴露） | 提到 `ES2020` |
| typecheck 残留 29 个同类错误 | `incremental: true` 的 `.tsbuildinfo` 回放了旧诊断 | 清理缓存后重跑，0 error |
| 合约测试 1 例失败 | ethers v6 的 `Interface.getFunction` 找不到时返回 `null`（v5 才抛异常），断言写反 | 改为断言 `null` |
| 集成测试 1 例失败 | viem 会在发送**前**先模拟，非法参数根本不会上链，因此拿不到"已 revert 的收据"——这其实是更好的行为 | 拆成两个用例：① 发送前被拒且区块高度不变（用户不花 gas）；② 绕过模拟的失败交易绝不显示成功 |
| 单测 1 例失败 | 我多断言了 `issues` 为空，但该用例本就没配工厂地址 | 收窄断言范围 |
| 冒烟 1 例失败 | 无钱包时 `/setup` 渲染的是 "Connect Wallet" 按钮，断言却找 "Deploy TokenFactory" | 改为断言页面标题 |
| 本机 `npm install` 失败（10 分钟） | esbuild postinstall 在 Windows 上 spawn `node.exe` 撞 `EBUSY`，导致 `@esbuild/win32-x64` 缺失、hardhat 缺模块、lock 文件未写成 | 按用户要求改到服务器 Linux 环境构建，问题消失 |

已知但**非缺陷**的构建警告：`@metamask/sdk` 引用仅在 React Native 下需要的 `@react-native-async-storage/async-storage`。这是 wagmi 依赖链的既有现象，Web 构建下是受运行时保护的可选导入，**改动前就存在**，不影响功能。

---

## G. 需要手动配置的环境变量

部署环境的 `.env.local`：

| 变量 | 是否必需 | 说明 |
| --- | --- | --- |
| `NEXT_PUBLIC_TOKEN_CONTRACT_FACTORY_SEPOLIA` | **必需** | 工厂地址。**当前仍为空** → 站点如实显示 "Token Factory is not configured yet" |
| `NEXT_PUBLIC_BASE_NETWORK` | 可选 | 默认 `sepolia` |
| `NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL` | 可选 | 默认 `https://sepolia.base.org` |
| `NEXT_PUBLIC_TOKEN_CREATOR_FEE_SEPOLIA` | ✅ 已设为 `0.0001` | 最低手续费模式（两笔交易） |
| `NEXT_PUBLIC_TOKEN_CREATOR_FEE_RECIPIENT_SEPOLIA` | ✅ 已设为 `0x75CBA94CDa95866a5294CDFf66C96d8a8B2663EA` | 收款地址（用户提供的真实钱包） |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | 可选 | 留空则只提供注入式钱包 |
| `DATABASE_URL`、`ADMIN_SECRET`、`POSTGRES_PASSWORD` | 后台需要 | 原有配置，未改动 |

改动后**只需重启容器，不需要重建镜像**：

```bash
docker compose up -d app
```

---

## H. Factory 合约是否已部署

**已部署（由操作者用本人钱包完成）。**

审计阶段的状态是**未部署**：全仓库检索 40 位十六进制地址零命中，`.env.example` 中三个工厂地址变量全为空，
且原仓库根本没有任何编译/部署工具链。我没有编造地址，也没有使用操作者的钱包代为部署。

随后操作者通过 `/setup` 页面用本人 MetaMask 完成了部署。可验证信息如下：

| 项目 | 值 |
| --- | --- |
| 合约地址 | `0xf7606511ac1e18224a21d851b1cfa7258d3ac684` |
| 部署交易 | `0x7c02fd6633d17047837ca89da2f7b7b2702857d392dc05a91a70775a55ec7db6` |
| 区块高度 | 47148470 |
| 部署者 | `0x75CBA94CDa95866a5294CDFf66C96d8a8B2663EA`（操作者钱包） |
| 收据状态 | `0x1`（成功） |
| gasUsed | 986,945 |
| 实际 gas 价格 | 5,940,000 wei |
| 运行时字节码 | 4,333 字节（EIP-170 上限 24,576） |

**地址来源可验证**：不是本地预测值，而是取自链上已挖出收据的 `contractAddress`，
且与 `/setup` 页面显示的地址一致。

**独立核验**（`node scripts/verify-live-factory.mjs 0xf7606511ac1e18224a21d851b1cfa7258d3ac684`，
只读，不签名、不发交易）：

```
PASS  contract code exists  (4333 bytes)
PASS  runtime bytecode matches the compiled artifact
PASS  MAX_DECIMALS == 18
PASS  ABI exposes no privileged function
PASS  createToken simulates (18 decimals / 0 decimals / 6 decimals)
PASS  contract rejects decimals 19 / empty name / zero supply
```

"运行时字节码与编译产物完全一致"这一条说明链上的就是本仓库 `contracts/TokenFactory.sol` 的产物，
不是另一个同名合约；`createToken` 三种精度均模拟成功，说明工厂现在**确实可以创建 Token**。

### 部署成本实测（Base Sepolia）

用只读 RPC 实测，可与上表互相印证：

| 项目 | 数值 |
| --- | --- |
| `eth_estimateGas` | 995,945 gas |
| 实际 gasUsed | 986,945 gas（**估算误差 0.9%**） |
| gas 价格 | 0.006 gwei |
| L2 执行费 | 0.00000598 ETH |
| L1 数据费（链上 `GasPriceOracle.getL1Fee` 精确值） | 0.00000015 ETH |
| **合计** | **≈ 0.00000612 ETH** |

> 我最初按"每 L1 字节 16 gas @ 1 gwei"手算 L1 上界得 0.00007035 ETH，**比实测高约 480 倍**。
> Base 的 L1 费受压缩与 scalar 影响，手算上界毫无意义——要精确值就直接问链上的 `GasPriceOracle`
> （`0x4200…000F`，selector `0x49948e0e`）。

---

## I. 本地启动命令

```bash
npm install
npm run dev            # http://localhost:3000
```

Docker 方式：

```bash
docker compose up -d --build
docker compose exec -T postgres psql -U token_creator -d token_creator < migrations/001_initial.sql
```

完整验证：

```bash
npm run contracts:build   # 编译合约并刷新浏览器用 artifact
npm run typecheck
npm run lint
npm run test:unit         # 152 个纯逻辑用例
npm run test:contract     # 24 个合约用例
npm run test:integration  # 17 个端到端用例（自建本地节点，不消耗测试网资金）
npm run build
npm run test:smoke        # 25 项构建产物与接口检查

# 只读核验一个已部署的工厂（不签名、不发交易）
node scripts/verify-live-factory.mjs 0xf7606511ac1e18224a21d851b1cfa7258d3ac684
```

---

## J. Base Sepolia 测试步骤

工厂**已部署并配置完成**（见 H 节），因此现在只剩用户侧流程：

1. 打开 https://openrelays.com/creator，点 *Connect Wallet*，在 MetaMask 中确认。
2. 页面会**自动**询问切换到 Base Sepolia。若你的钱包还没有这个网络，钱包会提示添加——
   **RPC、Chain ID、币种、区块浏览器全部由应用提供，不需要你输入任何东西**。
   若你拒绝了，页面会显示当前所在链并提供重试按钮。
3. 切换完成后不需要任何额外操作，主按钮即变为 *Create Token*。
4. 确认钱包有测试 ETH（页面会显示 Base Sepolia 上的余额，不足会明确提示）。
5. 填入 Name / Symbol / Decimals / Supply。注意输入框下方会实时显示将要铸造的 base units 总数。
6. 点 *Create Token*（免费模式下这是**唯一**一笔交易），在 MetaMask 中确认。
7. 等待收据。页面随后显示从 `TokenCreated` 事件解析出的代币地址，以及从链上读回的
   `name/symbol/decimals/totalSupply/你持有的余额`。
8. 点 *View on BaseScan* 核对代币存在且参数与输入一致。

> 重新部署工厂（一般不需要）：打开 `/setup`，连接钱包，点 *Deploy TokenFactory*。
> 该合约无 owner、无手续费、不可升级，重复部署只会多花一次 gas。

---

## K. 下一步需要你操作的事项

1. ~~部署工厂~~ **已完成**，地址已写入部署环境变量并上线。
2. **手续费当前为免费模式**（`NEXT_PUBLIC_TOKEN_CREATOR_FEE_SEPOLIA=0`），单笔交易、只付 gas。
   收款地址仍保留在配置里但免费模式下不参与流程，**想恢复收费改一个值即可，不需要重建镜像**。
3. **本地还有 1 个提交未推送**（`fix: explain a missing browser wallet …`）。
   远程 `main` 停在 `93b0bfb`；线上部署不受影响。你说推我再推。

---

## 部署记录

| 项目 | 值 |
| --- | --- |
| 线上地址 | https://openrelays.com （`/`、`/creator`、`/setup`、`/admin` 均返回 200） |
| 部署方式 | Docker Compose 构建 `app` 镜像后重建容器 |
| 停机时间 | 无（先构建新镜像，成功后才重建容器） |
| 构建与验证环境 | Linux 容器（宿主无 Node 运行时），全部用 `node:22-bookworm-slim` 执行 |
| 环境变量生效 | 改动后只需重启容器，**无需重建镜像** |

---

## 上线后的二次修正

**现象**：用户反馈 `/creator` 页面顶部出现**两条内容重复的黄色提示**。

**定位**（在代码中确认）：同一件事被报了两遍。

1. `components/creator-form.tsx` 为"未配置工厂"专门渲染了一条更可操作的提示，带 `Deploy the factory from your wallet →` 链接；
2. `lib/config.ts` 的 `resolveConfig()` 又把同一问题作为通用 issue 输出，被下面的 `config.issues.map()` 再渲染一次。

两条都正确，但重复且第二条没有行动入口。

**修复过程（两步，第二步才是对的）**：

第一步我改成"在页面里按 code 过滤掉重复项"，但验证时发现**字符串仍然出现 2 次**。原因是
Next.js 会把服务端组件传给客户端组件的 props **序列化进 RSC 负载**，
所以 `issues` 里的这条文案即使不渲染，也照样出现在页面 HTML 源码中。

第二步改为**从源头消除**：把"工厂未配置"从 `resolveConfig()` 的 issue 列表里彻底移除。
判断依据是语义——**"尚未配置"是一种状态（由 `factoryAddress === ""` 表达），
不是"配置错了"**；`ConfigIssueCode` 现在只描述"操作者填了值但值是错的"
（`factory-address-invalid`、`fee-invalid`、`fee-below-minimum`、`fee-recipient-missing`、`fee-recipient-invalid`）。
UI 那边那条带 `/setup` 链接的专用提示成为唯一入口，页面与载荷里都只剩一条。

**新增回归防护**：

- 单测：断言未配置工厂时 `factoryAddress === ""` 且 **`issues` 为空**；断言填了非法地址时仍会报 `factory-address-invalid`
- 冒烟测试：断言 `/creator` 页面 HTML **完全不包含** `Token Factory address is not configured for`（同时覆盖渲染与序列化负载）

**同时调整**：服务费切到最低档 `0.0001 ETH`，收款地址设为用户提供的
`0x75CBA94CDa95866a5294CDFf66C96d8a8B2663EA`。

> 注：最初用户给出的是 `0x1234567890abcdef1234567890abcdef12345678`，那是各类文档通用的示例占位地址，
> 其私钥无人持有，费用会变成不可取回的沉没成本。已提醒并替换为真实钱包地址。

### 线上实测结果（部署后）

- 首页：`Base Sepolia`、`ERC-20`、手续费状态标签（当前为最低手续费模式）✅
- `/creator`：`Base Token Creator`、`Connect Wallet`、`Service fee`、`0.0001 ETH + Gas`、`2 (fee, then deploy)`、`Total Fees`，并如实显示 `Token Factory is not configured yet` ✅
- `/setup`：`Deploy the Token Factory` 页面正常 ✅
- `/admin`：`Admin sign-in` 正常 ✅
- API：`decimals = 0` 通过校验（仅因未配 `DATABASE_URL` 返回 503 记录镜像告警）；`decimals = 19` / 空名称 / 非法钱包地址 / 零供应量均返回 400 ✅

---

## 第三次修正：`Provider not found` 报错

**现象**：在 `/setup` 点 *Connect Wallet* 后显示 `Provider not found. Version: @wagmi/core@2.22.1`。

**排查顺序与结论**

1. **版本兼容性（排除）**：`wagmi@2.19.5` 官方声明的依赖就是 `@wagmi/core@2.22.1`，
   `@wagmi/connectors@6.2.0` 的 peer 要求同样是 2.22.1。三者完全匹配，**不存在版本不兼容**。
   （报错里的版本号是 **2.22.1**，不是 2.2.1。）
2. **chain 配置（排除）**：`createConfig({ chains: [baseSepolia, base] })`，
   `baseSepolia.id === 84532`，transport 也已为两个网络都配置。
3. **Provider 注入（命中）**：`Provider not found` 是 wagmi 的 `ProviderNotFoundError`，
   **只在 `window.ethereum` 不存在时抛出**。也就是说：那一次连接发生在**没有注入式钱包的浏览器环境**里
   （典型场景：应用内的预览面板、手机 App 内置浏览器、或未装 MetaMask 的桌面浏览器）。

**代码里真实存在的缺陷（已修）**

`/creator` 页有 `window.ethereum` 检测：缺钱包时会禁用按钮并说明原因。
但 **`/setup` 页没有这层检测**，于是把库的原始报错直接抛给了用户——这是不一致，也是本次要修的点。

改动：

- 新增 `lib/wallet.ts`：`hasInjectedWallet()`（SSR 安全）、`onInjectedWalletAvailable()`
  （监听 `ethereum#initialized` 与 `eip6963:announceProvider`，覆盖"钱包晚于页面注入"的情况），
  以及两条**互不混淆**的说明文案：
  - `NO_WALLET_MESSAGE` —— 浏览器根本没有钱包扩展
  - `PROVIDER_UNRESOLVED_MESSAGE` —— `window.ethereum` 存在但解析不出 provider（扩展锁着/冲突）
- `describeError()` 现在优先识别这类错误并给出可操作文案，**不再把 `@wagmi/core@2.22.x` 这类库内部信息丢给用户**
- `/setup` 页改为三态（`unknown` / `present` / `absent`）：
  `unknown` 起步避免服务端误报；**点击时重新检测**（钱包可能刚装好或刚解锁）；
  `absent` 时显式展示提示与 MetaMask 下载入口，并始终先展示"需要浏览器钱包扩展"的前置说明

**没有做的事**：没有引入 Mock Provider，没有把错误吞掉，也没有伪造连接成功——
真实连接路径原样保留，只是让失败原因说得清楚。

**回归防护**：

- `test/unit/wallet.test.ts`：覆盖两种状态的判定、按 name / 按 message 识别错误、
  以及 `describeError()` **不得**再输出 `@wagmi/core` 原始文本
- 冒烟测试新增两条：`/setup` 必须在前置说明里写明需要浏览器钱包扩展；
  `/creator` 在服务端渲染（无 `window.ethereum`）时就必须说明缺钱包

---

## 第四次修正：钱包网络流程（以普通用户体验为准）

**需求**：普通用户不应该手动填写 Base Sepolia 的 RPC、Chain ID 和区块浏览器。
逐条核对结果与改动如下。

### 逐条核对

| # | 需求 | 审计结论 | 处理 |
| --- | --- | --- | --- |
| 1 | 连接后自动检测 Chain ID | **已满足** | `useChainId()`；`undefined`（未 hydrate）时不误判为错误网络，避免首屏闪错误横幅 |
| 2 | 非 84532 时通过钱包 API 请求切换 | **已满足但不够健壮** | 原有 `switchChain({chainId})`；现改为经统一入口，并把**我们的** RPC/币种/浏览器交给钱包 |
| 3 | 钱包没有该网络时请求添加 | **依赖库的隐式行为，有缺口** | 见下方"发现的问题 1" |
| 4 | 确认后自动回到 Create Token | **已满足** | 状态由 `chainId` 派生，切换成功后横幅自动消失、主按钮回到 *Create Token*；另新增**连接后自动询问一次**，省掉找按钮 |
| 5 | 不要求手动配置 RPC | **已满足** | 全站无任何 RPC/Chain ID 输入框；新增冒烟断言守住这条 |
| 6 | 保留 84532 / sepolia.base.org / ETH | **已满足，且现已显式传给钱包** | 见下方"发现的问题 2" |

### 发现的问题 1：自动添加网络依赖库的内部实现，覆盖不全

`wallet_addEthereumChain` 确实会被调用，但**是 wagmi 的 injected connector 内部在做的**，
触发条件写死为错误码 `4902`（外加 MetaMask Mobile 的 `data.originalError.code === 4902`）。

代码实证（`@wagmi/core/dist/esm/connectors/injected.js:327`）：

```js
if (error.code === 4902 ||
    error?.data?.originalError?.code === 4902) {
  // ... wallet_addEthereumChain
}
```

问题在于**钱包并不统一返回 4902**：有的返回 `-32603`，有的只在 message 里说
`Unrecognized chain ID` / `chain has not been added`。这些情况下库会直接把错误抛给用户，
用户看到一句英文报错，且没有任何自愈路径。

**反面风险同样重要**：用户**主动拒绝**（`4001`）绝不能被误判成"链缺失"——
那会导致第二次弹窗骚扰用户。

### 发现的问题 2：写入钱包的 RPC 不是我们配置的那个

库只用 `chain.rpcUrls.default.http[0]`（viem 内置的 `https://sepolia.base.org`）。
平时看不出差别，但一旦运维把 `NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL` 换成自建节点或付费节点，
**应用连的是新节点、写进用户钱包的却还是公共节点**——配置与用户实际使用的链路不一致。

### 修复

新增 `lib/network.ts`，把网络流程做成可单测的纯逻辑：

- `chainAddParams(config)` —— 生成 `wallet_addEthereumChain` 的完整参数，
  **RPC 取自应用自身配置**（`config.rpcUrl`），`nativeCurrency` 固定为 `{ name: "Ether", symbol: "ETH", decimals: 18 }`，
  `blockExplorerUrls` 取自 `config.explorerBase`。切换与添加两个路径共用同一构造函数，杜绝漂移。
- `addChainOverrides(config)` —— wagmi 接受的子集（不含 `chainId`，由 wagmi 单独传）。
- `isUnknownChainError(error)` —— 遍历 `code` / `cause` / `data` / `data.originalError` 收集错误码与文案，
  识别 4902 及各钱包的文案变体；**用户拒绝（4001 / "User rejected"）优先级最高**，直接判为"不是链缺失"。
  带 `seen` 集合与深度上限，自引用错误不会死循环。
- `ensureTargetChain(...)` —— 先走钱包切换（并交出我们的 RPC/币种/浏览器）；
  若错误确实是"不认识这条链"，则**自己**发起 `wallet_addEthereumChain` + 再次 `wallet_switchEthereumChain`；
  其余错误（含用户拒绝）原样抛出，绝不多弹一次窗。
- `wrongNetworkMessage(currentChainId, targetName)` —— 横幅会说明用户**当前在哪条链**，
  并明确告知"由我们直接向钱包请求，无需手动配置"。

`getProvider()` 在 wagmi 里类型是 `unknown`（各连接器差异很大），
因此在 `lib/network.ts` 内用**运行时形状校验**窄化一次，而不是在组件里散落类型断言。

两个页面（`/creator`、`/setup`）统一改为调用 `switchToTargetChain()`：
横幅按钮、主按钮的 `switch-network` 分支都走同一入口；
并新增"**连接后自动询问一次**"——按账户地址守卫只触发一次，断连后重置，用户拒绝则保留横幅与按钮可重试。

### 没有做的事

- 没有绕过钱包、没有伪造切换成功、没有 Mock Provider
- 没有因为"库已经处理了 4902"就假定所有钱包都合规——但也没有重复弹窗：
  只有在库确实抛错且错误确属"链缺失"时才自行添加
- 没有改变 `84532` / `https://sepolia.base.org` / `ETH` 这三项配置

### 回归防护

- `test/unit/network.test.ts`（27 例）：参数构造（含"使用配置里的 RPC 而非硬编码默认值"、
  mainnet 8453 → `0x2105`）、错误识别的四种嵌套形状与文案变体、
  **拒绝优先于链缺失**、自引用错误不死循环、`ensureTargetChain` 的三条分支
  （库已处理 → 不重复调用；链缺失 → 添加后再切换；拒绝/无关错误 → 原样抛出且不调用 provider）、
  provider 形状不合法时视为无兜底
- `test/unit/creator-state.test.ts`：新增"用户确认切换后回到 *Create Token*"、
  "拒绝后仍保留切换入口而不死锁"、"免费路径下无任何关于 RPC / Chain ID 的阻塞项"
- `test/unit/network.test.ts` 中一条用例直接对 `resolveConfig({})` 断言
  `chainId === 84532`、`rpcUrl === "https://sepolia.base.org"`，并要求 `chainAddParams` 与其一致
- 冒烟测试新增 6 条：服务端下发的配置必须带 `chainId: 84532`、
  `rpcUrl: https://sepolia.base.org`、`explorerBase: https://sepolia.basescan.org`
  （同时检查渲染结果与 **RSC 序列化负载**）；`/setup` 必须写明当前网络；
  两个页面**不得**存在要求填写 RPC / chainId 的输入框，**不得**出现"手动输入 RPC"类指引

