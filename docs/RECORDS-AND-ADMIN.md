# 创建记录与后台查询（wallet_address 修复 + Token Records）

> 范围：**只做记录与后台**。Factory、CreatedToken、`createToken()`、`TokenCreated` 事件、
> 钱包签名、MetaMask 连接、Base Sepolia 配置、fixed supply 设计 —— **一行都没改**。
> 链上 MVP 保持原样。

---

## 1. 问题现象与根因

用户看到：

```
wallet_address must be a valid EVM address
```

**这条错误其实有两个原因叠在一起，而且 A 是 B 的成因。**

### 根因 A（基础设施）：容器解析不到数据库主机名

```
app 容器内：getaddrinfo ENOTFOUND postgres
```

- `postgres` 容器的网络配置里 **`Aliases: null`**，DNSNames 只有 `tokenbuild-postgres-1`
- `app` 容器则有 `Aliases: ["tokenbuild-app-1", "app"]`
- 也就是：**postgres 容器缺少 compose 服务别名 `postgres`**（该容器创建于 compose 文件声明
  `networks:` 之前，之后一直没被重建过）
- IP 直连 5432 是通的，所以这不是网络不通，纯粹是 DNS 别名缺失

后果：**任何一次写入都必然 503**（`getaddrinfo ENOTFOUND postgres`）。

**修复**：在 `docker-compose.yml` 里把别名显式声明出来，并重建 postgres 容器
（数据在命名卷 `token_creator_postgres_data` 里，不受影响）。

```yaml
  postgres:
    networks:
      token_creator_internal:
        aliases:
          - postgres      # 显式声明，不再依赖 compose 隐式添加
```

### 根因 B（代码）：状态更新走了 POST，而 payload 里没有钱包地址

`components/creator-form.tsx` 原本用**一个** `save()` 处理所有写入，靠客户端状态决定方法：

```ts
fetch(recordId ? `/api/creations/${recordId}` : "/api/creations", ...)
```

而**推进状态的 payload 不含 `wallet_address`**：

```ts
// 成功回调原本发的就是这个形状
{ status: "success", contract_address, deployment_tx_hash }
```

这对 PATCH 是合理的（记录已存在，不需要重复钱包地址）。但当 `recordId` 还是空的时候
——**也就是 A 导致首次创建失败的时候**——这份 payload 走了 POST 分支，而 POST 要求钱包地址：

```
实测复现：POST {"status":"success","contract_address":"0x…dEaD",…}
     → HTTP 400 {"error":"wallet_address must be a valid EVM address."}
```

这正是用户看到的那句话。

**修复**：把"写哪条"变成纯函数（`lib/record-write.ts`），两条规则从结构上杜绝复发：

1. **POST 必须携带完整创建上下文** —— 不完整的 payload 永远没有资格走 POST
2. **PATCH 需要真实的记录 id** —— 没有 id 就改用完整上下文去创建，而不是发半条 payload

另外 `recordId` 从 `useState` 改成 `useRef`：它是在交易上链后由 effect 读取的，
作为 state 会被某一次渲染的闭包捕获，可能读到过期的"还没有 id"。

---

## 1.5 自测中发现并修复的两个缺陷

端到端测试（`tokenbase-e2e-records-test.sh`，打真实线上 API + 真实数据库）**抓到了两个我自己写出来的 bug**。
它们都不会让单元测试失败，只有真的走一遍 API 才会暴露 —— 这是写这个测试的价值所在。

### 缺陷 1：PATCH 校验并核验了合约地址，却从没写进数据库

`app/api/creations/[id]/route.ts` 里：

```ts
const contractAddress = field(body, "token_contract_address", "contract_address");
const transactionHash = field(body, "transaction_hash", "deployment_tx_hash");
// …格式校验、写入前核验、write-once 检查全都用到了它们…
```

**但 `payload` 里从来没有 `payload.token_contract_address = contractAddress`。**

后果（很严重）：
- 成功记录虽然 `status = success`，但**代币合约地址和交易哈希是空的** —— 恰恰是本功能存在的理由
- write-once 保护**永不触发**：`existing.token_contract_address` 永远是 null，
  所以"把记录改指向另一个代币"的检查形同虚设

发现方式：测试断言"re-pointing is refused" 期望 409 却得到 200，同时读到原地址是空的。

**修复**：在 payload 里显式写入这三个字段。
**回归防护**：E2E 断言"成功记录必须带合约地址"与"re-pointing 必须 409"。

### 缺陷 2：`clampInt` 把 `null` 当成 `0`，导致后台查询默认只返回 1 条

```ts
function clampInt(value: string | null, fallback: number, min: number, max: number) {
  const parsed = Number(value);          // Number(null) === 0，不是 NaN
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);   // 0 → 被夹到 min = 1
}
```

**缺省值被变成了一个"存在但错误"的值** —— 少传 `?limit=` 时默认 limit 变成 **1**，
所以搜索虽然返回正确的 `total`，却只带回一行。表现出来就是"按合约地址搜不到"。

**修复**：抽出 `lib/record-query.ts`，显式的"缺失就用默认值"，
并把这类边界逻辑从路由里拿出来以便单测。
**回归防护**：`test/unit/record-query.test.ts` 11 例，第一例就是
"缺失时用默认值，而不是最小值"。

> 一句话教训：**默认值必须是默认值，不能是边界值。**
> 以及"校验了"和"写入了"是两件事，中间那一步很容易漏。

---

## 2. 数据库 migration

**新增 `migrations/002_token_records.sql`**，`001_initial.sql` 保持不动（它是历史）。

| 变更 | 内容 | 数据影响 |
| --- | --- | --- |
| 重命名 | `contract_address` → **`token_contract_address`** | `RENAME` 搬数据，不丢 |
| 重命名 | `deployment_tx_hash` → **`transaction_hash`** | `RENAME` 搬数据，不丢 |
| 保留 | `payment_tx_hash` | 不动（它是可选服务费那笔交易，与创建交易是两回事） |
| 新增 | `chain_verified boolean NOT NULL DEFAULT false` | 旧行默认 false —— 这是诚实的答案：当时没人核验过 |
| 新增 | `verified_at timestamptz` | |
| 新增 | `verification_note text` | 未通过核验的原因 |
| 新增索引 | `tokens_token_contract_idx`、`tokens_tx_hash_idx`、`tokens_wallet_lower_idx`、`tokens_symbol_upper_idx`、`tokens_name_lower_idx` | 查询用，大小写不敏感 |

**安全性设计**：
- 不 DROP 任何列、不 DELETE 任何行
- 每条语句都带守卫（`IF EXISTS` / `IF NOT EXISTS` 和 `DO $$` 块），**重复执行是 no-op**
  —— 迁移不能重跑在故障处理时是个陷阱
- **没有** 对 `wallet_address` 加唯一约束：一个钱包创建多个 Token 是正常关系，不是例外

**已在真实 PostgreSQL 上验证**（`tokenbase-migration-test.sh`）：先按旧列名写入 3 行
（含一个钱包 2 个 Token、一行 `decimals = 0`），再执行 002，逐值比对全部存活；
并验证重复执行、以及空库全新安装。

---

## 3. 记录字段

`tokens` 表按需求保存：

| 需求字段 | 实际列 |
| --- | --- |
| `id` | `id`（uuid，主键） |
| `wallet_address` | `wallet_address`（来自连接的钱包，非手填） |
| `token_name` | `token_name` |
| `token_symbol` | `token_symbol` |
| `token_contract_address` | `token_contract_address` |
| `network` | `network`（如 `Base Sepolia`） |
| `decimals` | `decimals` |
| `total_supply` | `total_supply` |
| `transaction_hash` | `transaction_hash` |
| `created_at` | `created_at` |

关系：`wallet_address` → 多条记录。**没有唯一约束**，并有 `tokens_wallet_lower_idx` 支撑"这个钱包创建过的所有 Token"查询。

---

## 4. 数据来源与一致性

| 需求 | 实现 |
| --- | --- |
| 以链上成功为最终条件 | 成功记录**必须**同时带 `token_contract_address` 与 `transaction_hash`，否则 API 直接 400 |
| 从实际结果取合约地址 | 前端从**已挖出收据**里的 `TokenCreated` 事件解析（原有逻辑，未改） |
| 保存真实交易哈希 | 即 `createToken` 那笔交易的哈希 |
| 钱包地址来自连接钱包 | `useAccount().address`，从不使用手填字段 |
| 不把前端数据当链上事实 | **新增服务端链上核验**（见下） |
| 数据库只是镜像，链上是事实 | 每条记录都带 BaseScan 链接；页面文案也这么写 |

### 新增：服务端链上核验（`lib/chain-verify.ts`）

写入 `status = success` 时，**服务端自己再查一次链**，四种结果严格区分：

| 结果 | 含义 | 处理 |
| --- | --- | --- |
| `verified` | 收据成功，且工厂确实发出过这个代币地址 | 写入，`chain_verified = true` |
| `reverted` | 收据存在且显示交易失败 | **拒绝**（409），不写入成功 |
| `mismatch` | 收据成功，但产出的代币地址与声明不符 | **拒绝**（409） |
| `unverifiable` | RPC 不可达，或交易还看不到 | 写入，但 `chain_verified = false` 并记录原因 |

**为什么 `unverifiable` 不拒绝**：真实的创建因为 RPC 抖动而丢掉记录，是不可接受的；
而不确定性被如实标成"未核验"，也没有把谎话写进库。**任何情况下都不会把"未核验"升级成"已核验"。**

另外两条完整性规则：
- **代币地址与交易哈希是 write-once**：已命名过代币的记录不能被悄悄改指向另一个代币（409）
- `chain_verified` / `verified_at` **从不接受请求里的值**，只有核验步骤能写

### 链上交易失败时

- 不写成功记录
- 不生成假的 `token_contract_address`
- 不生成假的 `transaction_hash`
- 已有记录会被标注为 `failed` / `deployment_cancelled` / `payment_cancelled`，
  失败原因写进 `verification_note`
- **只标注已存在的记录**：一个在钱包里就被拒绝、从未广播的尝试不会凭空生成记录

### 数据库写入失败时

- 不影响链上结果（镜像失败只是 warning）
- 前端提示：`链上结果有效，但历史记录未保存：<原因>`（`dbWarning`）
- 错误同时回到 API 响应与容器日志，便于排查

---

## 5. 后台 Token Records 页面

**地址：`https://openrelays.com/admin/records`**

列表列：创建者钱包地址 / Token Name / Symbol / Token Contract Address / Network /
Total Supply / Transaction Hash / Created At / Status（成功记录附 `verified` / `unverified`）。

支持：

| 能力 | 做法 |
| --- | --- |
| 按 `wallet_address` 查询 | 精确匹配（大小写不敏感） |
| 按 `token_contract_address` 查询 | 精确匹配（大小写不敏感） |
| 按 `token_name` / `symbol` 查询 | 子串匹配（`ILIKE`） |
| 复制钱包地址 | 列表内每个地址旁的复制按钮，详情页也有 |
| 复制 Token 合约地址 | 同上 |
| 点击 Transaction Hash | 新窗口打开 BaseScan 交易页（按记录的 network 选 sepolia/主网） |
| 查看完整记录 | 点击 Token Name 打开详情面板：记录 id、钱包、合约、交易、网络、供应量/精度、状态、核验状态与原因、创建时间 |
| **按钱包聚合视图** | 点任意钱包 → 渲染成树，例如 ① |

① 钱包聚合视图实际渲染：

```
0x75CBA94CDa95866a5294CDFf66C96d8a8B2663EA
├── MTK   →  0x1111111111111111111111111111111111111111
├── ABC   →  0x2222222222222222222222222222222222222222
└── XYZ   →  0x3333333333333333333333333333333333333333
```

页面顶部还有"Wallets with records"列表（钱包 + Token 数 + 最近创建时间），点一下即进入该钱包的聚合视图。

**查询 API**：`GET /api/admin/records?wallet=…&contract=…&q=…&status=…&limit=&offset=&wallets=1`
过滤条件**全部参数化绑定**，请求里的内容不会进入 SQL 文本。

---

## 6. 后台安全

**复用现有认证，没有另建一套**：

- `ADMIN_SECRET` + httpOnly cookie（`tokenbase_admin`，`sameSite=strict`，生产环境 `secure`，8 小时）
- `POST /api/admin/session` 登录、`DELETE` 登出 —— 原有实现
- 新增 `lib/admin-auth.ts` 作为**唯一**的鉴权入口，`/api/admin/data`、`/api/admin/records`、
  `/api/admin/session` 都走它。散布在多个路由里的重复检查发生漂移，正是某个接口意外变成公开的
  常见原因
- 常量时间比较（`timingSafeEqual`）——顺带把 `/api/admin/data` 原先的 `!==` 统一过来
- `ADMIN_SECRET` 未配置时一律返回未授权：漏配只会"什么都不暴露"，不会"全部暴露"

**普通用户拿不到别人的记录**：

| 端点 | 行为 |
| --- | --- |
| `GET /api/admin/records` | 无 cookie → **401**；错误 cookie → **401** |
| `GET /api/admin/data` | 同上 |
| `GET /api/creations` | **405**（只有 POST，没有公开列表） |
| `/admin/records`（页面） | 未登录只渲染登录表单，不渲染任何记录 |

### 一处已知限制（如实说明）

`PATCH /api/creations/:id` **没有用户级认证** —— 项目本身没有用户账号体系，而创建者的浏览器
必须能推进自己那条记录的状态。UUID 不可猜，但拿到 id 的人可以改记录的状态字段。

因此本次加了两道约束来压缩危害：
- 代币地址与交易哈希 write-once；
- 状态变 `success` 时必须通过**服务端链上核验**。

也就是说，即使有人伪造一条成功写入，也只能写下**链上真实发生过**的创建。而链上始终是事实来源，
后台页面每一行都给出 BaseScan 链接，管理员可随时自行核对。

如果要彻底关闭这个口，需要引入用户级会话（例如钱包签名登录并把记录绑定到地址），
那是一次独立的重构，不在本次范围内。

---

## 7. 修改的文件

### 新增

| 文件 | 作用 |
| --- | --- |
| `migrations/002_token_records.sql` | 重命名两列（保数据）+ 核验字段 + 索引 |
| `lib/record-write.ts` | 写入规划纯函数，修根因 B |
| `lib/chain-verify.ts` | 服务端链上核验 success 声明 |
| `lib/record-query.ts` | 后台查询参数解析与边界处理（缺陷 2 的修复） |
| `lib/admin-auth.ts` | 唯一的后台鉴权入口 |
| `app/api/admin/records/route.ts` | 管理员记录查询 API |
| `app/admin/records/page.tsx` | Token Records 页面 |
| `test/unit/record-write.test.ts` | 22 条写入规划与上下文测试（含根因 B 的回归用例） |
| `test/unit/record-query.test.ts` | 11 条查询参数测试（含缺陷 2 的回归用例） |
| `tokenbase-migration-test.sh` | 真实 PostgreSQL 迁移测试 |
| `tokenbase-e2e-records-test.sh` | 线上端到端记录测试（含缺陷 1/2 的回归用例） |

### 修改

| 文件 | 改了什么 | **没有**改什么 |
| --- | --- | --- |
| `docker-compose.yml` | postgres 服务显式声明网络别名 | 端口、卷、镜像、服务拓扑 |
| `lib/database.ts` | 新列名；新增 `searchTokenRecords` / `getRecordsByWallet` / `listWallets`；连接超时 | 表结构、连接串来源 |
| `app/api/creations/route.ts` | 新列名（兼容旧名）；`success` 必须带合约地址与交易哈希 | 原有校验规则 |
| `app/api/creations/[id]/route.ts` | 新列名；链上核验；write-once；服务端独占核验字段 | 允许的状态集合 |
| `app/api/admin/data/route.ts` | 用 `lib/admin-auth` | 返回结构 |
| `app/api/admin/session/route.ts` | 抽出共用的 cookie 名与常量时间比较 | 登录/登出行为 |
| `components/creator-form.tsx` | 记录写入改为 `writer` + 纯函数规划；`recordId` 改 ref；失败时标注状态 | **`deploy()` / `pay()` / `writeContractAsync` / 事件解析 / 链上调用 / 钱包连接** |
| `app/admin/page.tsx` | 列名更新 + 一个指向 `/admin/records` 的入口 | 其余全部 |
| `scripts/smoke-test.mjs` | 新增 10 条断言（后台鉴权、公开 API 不泄露记录、钱包地址必填） | 原有断言 |
| `test/integration/local-chain.test.ts` | 新增 6 条链上核验测试 | 原有 17 条 |
| `README.md` | 记录与后台一节 | — |

**明确未触碰**：`contracts/TokenFactory.sol`、`CreatedToken`、
`createToken()` 调用流程、`TokenCreated` 事件、钱包签名、MetaMask 连接、Base Sepolia 配置、
fixed supply 设计、`lib/network.ts`、`lib/contracts.ts` 的 ABI。

---

## 8. 如何启动与测试

### 启动后台

1. 打开 `https://openrelays.com/admin/records`
2. 输入 `ADMIN_SECRET`（与 `/admin` 同一个，存在服务器 `.env.local`）
3. 登录后即是记录页

### 本地

```bash
npm install
docker compose up -d --build
docker compose exec -T postgres psql -U token_creator -d token_creator < migrations/001_initial.sql
docker compose exec -T postgres psql -U token_creator -d token_creator < migrations/002_token_records.sql
npm run dev            # http://localhost:3000
```

### 验证

```bash
bash tokenbase-migration-test.sh     # 真实 PostgreSQL，验证迁移不丢数据
bash tokenbase-e2e-records-test.sh   # 打线上 API + 真实库，验证记录生命周期
npm run typecheck
npm run test:unit                    # 185 例
npm run test:contract                # 24 例
npm run test:integration             # 23 例，含 6 条链上核验
npm run build
npm run test:smoke                   # 35 项，含后台鉴权与公开 API 断言
```

### 端到端（需要本人钱包）

1. `/creator` 连接 MetaMask，切 Base Sepolia
2. 填参数 → Create Token → 在钱包确认
3. 链上成功后页面显示代币地址与交易哈希
4. 记录写入数据库（顶部若出现"历史记录未保存"提示即为镜像失败，链上结果不受影响）
5. 打开 `/admin/records` 登录
6. 在 Wallet address 里粘贴钱包地址 → Search → 看到该钱包创建的所有 Token
7. 点 Token Name 看完整记录，点交易哈希去 BaseScan 核对
