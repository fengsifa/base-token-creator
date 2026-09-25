# Tokenbase 合约扩展性技术评估

> 状态：**仅评估，未改任何代码、未部署任何合约。**
> 评估对象：Base Sepolia 已部署的 `TokenFactory` @ `0xf7606511ac1e18224a21d851b1cfa7258d3ac684`
> 目标：为 Token Creator 增加 Burnable / Mintable / Pausable / Anti Whale / Anti Bot / Blacklist

---

## 0. 结论摘要

| 问题 | 结论 |
| --- | --- |
| 现在能实现这些功能吗？ | 能，OZ 5.6.1 的扩展全都可用 |
| 需要重新部署 Factory 吗？ | **必须重新部署，且无替代方案**（硬约束，见 §4） |
| 为什么不能只改 Token？ | Factory 里**内联**了 Token 的创建字节码；链上的旧 Factory 里只有旧 Token 的代码 |
| 最大的风险是什么？ | 6 个功能里 **5 个必须引入 owner**，与当前「无 owner、无后门」的产品定位直接冲突 |
| 建议方案 | **有限模板集合（3 个左右）**，不是 6 个布尔开关的 64 种组合 |
| 唯一不破坏「无后门」定位的功能 | **Burnable**（不需要 owner 也能安全实现） |
| 前端会不会出现假功能？ | 现有三道防线可复用，但需补 4 条新防线；核心原则见 §6 |
| 字节码预算够吗？ | 实测余量 20,243 字节，约可再容纳 6 个当前规模的变体；功能变体更大，实际约 3–5 个 |

**需要你先做的产品决策**见 §7。

---

## 1. 当前实现方式

### 1.1 文件结构

整个项目**只有一个 Solidity 文件**，里面**两个合约**：

```
contracts/TokenFactory.sol   (120 行)
├── contract CreatedToken is ERC20     ← Token 模板，内联在同一个文件里
└── contract TokenFactory              ← 部署器
```

`CreatedToken` **不是**独立文件——这一点在扩展时很重要，因为它决定了 Factory 能否复用。

### 1.2 CreatedToken（Token 模板）

```solidity
contract CreatedToken is ERC20 {
    uint8 public constant MAX_DECIMALS = 18;
    uint8 private immutable _customDecimals;
    ...
}
```

设计规则（原文写在注释里，是当前"安全故事"的全部）：

- **固定供应量**：构造函数里一次性 `_mint` 给 `recipient_`，之后**永不改变**
- **无 owner、无角色、无管理员**
- **无 `mint`、无 `burn`、无 `pause`、无黑名单、无转账税、无 hook**
- 唯一的非标准行为是 `decimals()`，且是 `immutable`

继承链极简：就一层 `ERC20`。

构造函数 5 个参数：
```solidity
constructor(string name_, string symbol_, uint8 decimals_,
            uint256 initialSupply_, address recipient_)
```
校验：`decimals_ <= 18`、`recipient_ != address(0)`。

### 1.3 TokenFactory（部署器）

```solidity
function createToken(string calldata name_, string calldata symbol_,
                     uint8 decimals_, uint256 supply_)
    external returns (address token)
```

- **无状态**：不持有资金、无 owner、无升级路径、**无手续费**（`createToken` 是 `nonpayable`，会拒收误转的 ETH）
- 部署方式：`new CreatedToken(...)` → 即 **CREATE**，**不是 CREATE2**
- 校验：name 1..32 字节、symbol 1..12 字节、supply > 0、decimals ≤ 18
- 自定义错误：`EmptyName` / `NameTooLong` / `EmptySymbol` / `SymbolTooLong` / `ZeroSupply` / `DecimalsTooHigh`
- 事件：
  ```solidity
  event TokenCreated(address indexed token, address indexed creator, string name, string symbol);
  ```

**因为用 CREATE 而非 CREATE2，地址无法提前预测**——前端因此从链上事件里读地址，而不是本地计算。这是个好设计，扩展时要保持。

### 1.4 Factory 自身的部署方式（两条路，都可用）

| 路径 | 机制 | 是否需要私钥 |
| --- | --- | --- |
| **浏览器（生产在用）** | `/setup` 页 → `useDeployContract` + `lib/tokenfactory-artifact.json` 里的字节码 → 用户钱包签名 | 否 |
| 命令行 | `npm run contracts:build && npm run deploy:factory`，hardhat + `.env.local` 里的 `DEPLOYER_PRIVATE_KEY` | 是 |

已部署实例（本次已链上核实）：

| 项 | 值 |
| --- | --- |
| 地址 | `0xf7606511ac1e18224a21d851b1cfa7258d3ac684` |
| 部署交易 | `0x7c02fd66…ec7db6` |
| 部署者 | `0x75CBA94CDa95866a5294CDFf66C96d8a8B2663EA`（操作者本人钱包） |
| runtime 字节码 | 4,333 字节，与本仓库编译产物**逐字节一致** |

### 1.5 字节码实测数字（本次在沙箱精确编译所得）

```
CreatedToken   creation  3255 bytes   runtime  1882 bytes
TokenFactory   creation  4365 bytes   runtime  4333 bytes

Factory runtime                4333 bytes
其中 CreatedToken 创建码约占    3255 bytes  (75%)
Factory 自身逻辑               1078 bytes
EIP-170 单合约上限            24576 bytes
当前余量                      20243 bytes
按当前规模可再内联变体数          约 6 个
```

**这张表是本次评估里最重要的技术事实**，直接推导出 §4 的结论。

---

## 2. 已实现 / 未实现

### 2.1 已实现

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| ERC-20 标准 | ✅ | OZ 5.6.1 `ERC20` |
| 固定供应量 | ✅ | 构造时一次性 mint，之后不可变 |
| 自定义 decimals | ✅ | 0–18，`immutable` |
| 参数校验 | ✅ | name/symbol 长度、非空、supply > 0、decimals ≤ 18 |
| 地址发现 | ✅ | 从 `TokenCreated` 事件读取，不预测 |
| 无后门 | ✅ | 无 owner / 无 mint / 无 burn / 无 pause / 无黑名单 |

### 2.2 未实现（本次要加的全部 6 项）

| 功能 | 状态 | 备注 |
| --- | --- | --- |
| Burnable | ❌ **完全没有** | 见下方澄清 |
| Mintable | ❌ | |
| Pausable | ❌ | |
| Anti Whale | ❌ | |
| Anti Bot | ❌ | |
| Blacklist | ❌ | |

### 2.3 ⚠️ 一个必须澄清的误解

**当前代币连 `burn` 都没有。** 有人可能以为「把代币转到 `0x000…dEaD` 就是烧」——那只是转账到无人持有的地址，`totalSupply` **不会减少**，链上数据里它仍然存在。

真正的 Burnable 是指 `totalSupply()` 会下降，且区块浏览器能反映这一点。所以 **Burnable 属于"要做"的清单，不是"已经有了"。**

### 2.4 前端目前的处理是诚实的

`components/creator-form.tsx` 里已经有两块**明确标注不可用**的展示：

```tsx
<h2>Token Properties</h2>
<p>Not implemented by TokenFactory. Shown so nobody expects them.</p>
  ◒ Burnable    Unavailable
  ▤ Mintable    Unavailable
  Ⅱ Pausable    Unavailable

<h2>Trading Limits</h2>
<p>Protection features are not implemented in the current factory contract.</p>
  ◈ Anti whale  Unavailable
  ♙ Anti Bot    Unavailable
  ⊘ Blacklist   Unavailable
```

这意味着**目前不存在假功能**：卡片直接写 `Unavailable`，并且有明确的"未实现"说明。扩展时应保留这条原则（见 §6）。

---

## 3. 每个功能需要修改哪些合约

### 3.1 先说架构决策：这些功能是「必选」还是「可选」？

这决定了改动范围，必须先定。三种做法：

| 方案 | 做法 | 优点 | 缺点 | 结论 |
| --- | --- | --- | --- | --- |
| **A. 超级合约 + flag** | 一个 Token 合约含全部功能，构造参数决定启用哪些 | 只需 1 个变体 | ① 每个 token 都带全部代码，部署 gas 固定很高；② **最致命：即便关闭了某功能，代码仍在链上**，flag 判断一旦有 bug 就是真后门；③ 买家无法从字节码判断自己买的代币是否可被增发 | ❌ **不推荐** |
| **B. 64 种组合全枚举** | 每个布尔组合一个合约变体 | 语义最精确 | 64 个变体，字节码预算彻底爆掉 | ❌ 不可行 |
| **C. 有限模板集合** | 归成 3–5 个经过设计的套餐，每个套餐一个独立合约变体 | 字节码可控；「不可用」= 链上无此代码，**用户可在浏览器自行验证**；审计面清晰 | 灵活性不如自由勾选 | ✅ **推荐** |

**推荐 C。** 核心理由是一条原则：

> **「不可用」必须表现为「链上没有这段代码」，而不是「界面上藏起来」或「flag 关掉」。**

只有这样，用户才能自己在 BaseScan 上验证。方案 A 做不到这一点，这也是它最危险的地方。

### 3.2 关于 Burnable 的一个重要发现

**Burnable 是 6 个功能里唯一不需要 owner 的。**

OZ 的 `ERC20Burnable` 提供两个函数：

- `burn(uint256 amount)` —— 任何人烧**自己**的余额，无需授权
- `burnFrom(address account, uint256 amount)` —— 需要该账户的 **allowance**，即账户本人先 `approve`

也就是说：**授权模型沿用 ERC-20 现有的 allowance 机制，不需要引入任何管理员角色。**

这一点很有价值：可以把 Burnable 放进「无 owner 套餐」，从而**保住"无后门"的卖点**。建议这么设计。

其余 5 个功能（Mintable / Pausable / AntiWhale / AntiBot / Blacklist）**全部强依赖 owner 或角色**，因为它们都需要有人持续性地行使权力（增发、暂停、调参数、维护名单）。

### 3.3 逐功能改动清单

| 功能 | 需改 Token？ | 需改 Factory？ | 需要 owner？ | 新增接口（示意） | 复杂度 | 主要风险 |
| --- | --- | --- | --- | --- | --- | --- |
| **Burnable** | ✅ 继承 `ERC20Burnable` | ✅ 模板分发 | ❌ **不需要** | `burn` / `burnFrom` | 低 | 几乎无（授权靠 allowance） |
| **Mintable** | ✅ 继承 `Ownable`+`ERC20` | ✅ 模板分发 + 参数 | ✅ **必须** | `mint(to, amount)` | 中 | **无上限 = 无限通胀**；与"固定供应量"叙事冲突 |
| **Pausable** | ✅ `ERC20Pausable`+`Ownable`，override `_update` | ✅ 模板分发 | ✅ **必须** | `pause` / `unpause` / `paused` | 中 | **冻结所有人的转账**，含 DEX 池 → 事实 rug |
| **Anti Whale** | ✅ 自定义 `_update` 限额 | ✅ 模板分发 + 参数 | ✅ **必须**（调参数） | `setMaxTx` / `setMaxWallet` / 排除名单 | **高** | **未排除 pair/router 会导致交易必 revert**，可能锁死流动性 |
| **Anti Bot** | ✅ 自定义 `_update` 规则 | ✅ 模板分发 + 参数 | ✅ **必须** | `setTradingEnabled` / 冷却参数 | **高** | Base 是 L2，**"每块一笔"语义弱且误伤正常用户** |
| **Blacklist** | ✅ `mapping` + 拦截 | ✅ 模板分发 | ✅ **必须** | `blacklist` / `unblacklist` | 中 | 中心化审查能力，最易被质疑 |

**注意：6 个功能里有 5 个都需要改 Factory**，原因见 §4。

### 3.4 Factory 的具体改动

无论采用哪种方案，`TokenFactory` 都要动，且**必须遵守一条硬规则**：

> **不要修改或删除现有的 `createToken(string,string,uint8,uint256)`。**

理由：已部署的 Factory 上有人用；前端手写 ABI、集成测试、以及可能存在的第三方集成都按这个签名写的。加参数只能**新增函数**：

```solidity
// 保留不动
function createToken(string calldata, string calldata, uint8, uint256) external returns (address);

// 新增（示意）
function createTokenWithOptions(TokenConfig calldata cfg) external returns (address);
```

`TokenConfig` 建议用一个**超集结构体**（各变体只读自己需要的字段），而不是 `bytes` 泛化参数：

```solidity
struct TokenConfig {
    string  name;
    string  symbol;
    uint8   decimals;
    uint256 initialSupply;
    uint8   templateId;        // 选哪个变体
    uint256 maxSupply;         // Mintable：0 表示无上限（不推荐）
    uint256 maxTxAmount;       // AntiWhale
    uint256 maxWalletAmount;   // AntiWhale
    bool    tradingEnabledAtStart; // AntiBot
}
```

**`owner` 不要放进结构体**——直接用 `msg.sender`。若允许指定任意 owner，一个地址打错就会导致控制权永久丢失（或落到错误的人手里）。如确需转让，应在代币部署后通过 `Ownable2Step` 的安全流程完成。

**变体分发用显式分支，不要用「任意字节码」的通用 CREATE**：

```solidity
// ✅ 推荐：白名单式显式分支，字节码里只可能有我们审计过的合约
if (cfg.templateId == 0)      token = address(new TokenStandard(...));
else if (cfg.templateId == 1) token = address(new TokenBurnable(...));
else if (cfg.templateId == 2) token = address(new TokenFull(...));
else revert UnknownTemplate(cfg.templateId);

// ❌ 危险：允许传入 creationCode → 任何人都能从 Factory 地址部署任意合约，
//    看起来像平台背书。若真要走通用路线，必须用 creationCode 的 keccak 白名单。
```

同时要在 Factory 侧对**所有新参数做范围校验**（例如 `maxTxAmount > 0`、`maxTxAmount <= initialSupply`），否则会造出「一转账就 revert」的死代币。

### 3.5 建议的模板划分

```
模板 0  Standard        现状，无 owner                           ← 保留，向后兼容
模板 1  Burnable        + ERC20Burnable（仍无 owner）             ← 守住"无后门"卖点
模板 2  Mintable        + Ownable2Step（要有 maxSupply 上限）
模板 3  Managed         Mintable + Burnable + Pausable + Blacklist
模板 4  Protected       Managed + AntiWhale（+ AntiBot）
```

3–4 个变体在字节码预算内（§1.5），且每个变体都可单独审计、单独在浏览器上验证。

### 3.6 一个明确的建议：不要做可升级（代理）代币

代理模式（UUPS/Transparent）会给运营者**理论上无限的后门能力**，而这恰恰是 Token Creator 用户最怕的，也和「BaseScan 上验证过的固定代码」的信任模型冲突。

需要灵活性就用**更多模板**，不要让代币可升级。

---

## 4. 是否需要重新部署 Factory

### **需要。而且没有替代方案。**

这**不是**"推荐做法"，是**编译期决定的硬约束**：

```solidity
token = address(new CreatedToken(name_, symbol_, decimals_, supply_, msg.sender));
```

Solidity 的 `new X()` 会把 `X` 的**创建字节码（creation code）完整内联**进调用方的 runtime 字节码里。实测数据印证了这一点：

```
CreatedToken   creation  3255 bytes
TokenFactory   runtime   4333 bytes  ← 其中 3255 字节(75%) 就是 CreatedToken 的创建码
```

推论：

1. 链上那个 Factory 的字节码里，**只有旧版 `CreatedToken` 的代码**。
2. 想部署带新功能的代币，**新代币的字节码必须先存在于 Factory 的 runtime 里**——只能靠重新部署 Factory 获得。
3. 已部署的 Factory **无 owner、无升级代理**，无法原地修改。这是（有意的）设计。

### 4.1 但影响面很小

| 项 | 是否会受影响 |
| --- | --- |
| 旧 Factory @ `0xf760…c684` | ❌ 不受影响，可继续用；也可保留作为"Standard 模板"入口 |
| 已创建的旧代币 | ❌ 完全不受影响，链上独立 |
| 前端代码 | 需改（新增模板选择 + 能力表驱动 UI） |
| 环境变量 | 只需替换 `NEXT_PUBLIC_TOKEN_CONTRACT_FACTORY_SEPOLIA` |
| **后端 / 数据库** | ❌ 不受影响 |
| 部署流程 | 复用现有 `/setup` 页与 `hardhat deploy` 脚本，无需新机制 |

**一个现成的便利**：配置是**请求时解析**的，所以换 Factory 地址只需改环境变量 + 重启容器（几秒），**不用重建镜像**。

### 4.2 重新部署的成本

与本次实测一致（`createToken` 会随变体变大而变贵，但 Factory 部署本身只多一点点）：

| 项 | 成本 |
| --- | --- |
| 部署新 Factory | 约 0.000007–0.000012 ETH（Base Sepolia 上基本可忽略） |
| 每次创建代币 | 随变体变大而上升：Standard 约 981k gas；功能型变体预计 1.3M–1.8M gas |

---

## 5. 权限设计与安全风险

### 5.1 权限模型选型

| 模型 | 适用 | 说明 |
| --- | --- | --- |
| **Ownable2Step** | ✅ **推荐作为默认** | 两步转移所有权，防止手滑转错地址导致控制权永久丢失。单一 owner，语义简单，用户看得懂 |
| `AccessControl` | 多角色时 | 例如 minter / pauser / blacklister 分离。更安全但复杂度高，普通用户看不懂"谁是 pauser" |
| `Ownable`（一步） | ❌ | 转错即永久失去控制权 |
| 无 owner + 代理 | ❌ 不推荐 | 见 §3.6 |

**建议**：默认 `Ownable2Step`；只有模板 4（Protected）若确实需要分离职责时才引入 `AccessControl`。

### 5.2 逐功能权限表

| 功能 | 谁有权 | 权力范围 | 可否被滥用 |
| --- | --- | --- | --- |
| Burnable | 任何持币者（烧自己的）；或授权后的第三方（靠 allowance） | 只能减少自己的余额 | 否 |
| Mintable | owner | **增发任意数量**（若无上限） | ⚠️ **是** —— 可无限稀释所有持有人 |
| Pausable | owner | **冻结全网的 transfer** | ⚠️ **是** —— 可让所有人无法卖出 |
| Anti Whale | owner | 调整限额、修改排除名单 | ⚠️ 是 —— 可把限额调到 1 wei 变相冻结 |
| Anti Bot | owner | 开关交易、调冷却、加黑名单 | ⚠️ 是 —— 同上 |
| Blacklist | owner | 任意地址加入黑名单 | ⚠️ **是** —— 中心化审查 |

### 5.3 风险清单（按严重度排序）

**P0 —— 会造成资金或信任实际损失**

1. **Mintable 无上限**：owner 可无限增发，持有人权益被稀释到 0。→ **必须**强制 `maxSupply`，并且在 UI 上展示"上限是多少 / 已铸多少"。
2. **Pausable 冻结 DEX 池**：一旦代币在 DEX 上有流动性，`pause()` 会让池内所有 swap revert，**等于把所有人的资金锁死**。这是行业里最典型的 rug 手法之一。→ 需要产品决策（见 §7），若保留则必须在 UI 上把后果讲清。
3. **AntiWhale 未排除 pair/router**：限额逻辑若未把交易对地址和路由器地址排除，**买入/卖出会必然 revert**，严重时流动性加进去就拿不出来。→ 排除名单必须在构造时写死且经过测试；参数必须有合理下限。

**P1 —— 影响体验或造成不公平**

4. **AntiBot 在 Base 上语义弱**：Base 出块约 2 秒且由 sequencer 批量打包，**"每块一笔"会误伤正常用户**（同一区块内多笔来自同一地址是合法的，比如合约交互）。实际防护效果有限，误伤概率不低。
5. **owner 私钥丢失**：Mintable 变体一旦丢失 owner 私钥，将永远无法再增发；反过来 Blacklist 变体丢失则可被他人接管。
6. **AntiWhale/AntiBot 的参数被 owner 事后改坏**：可以突然把限额设成 1 wei，效果等同于暂停。

**P0（战略级）—— 定位冲突**

7. **最需要你决策的一点：这 5 个功能与产品当前的"无 owner、无后门"定位直接冲突。**
   当前 `/creator` 页面、README、审计报告都在强调「部署后没有人能改变供应量或限制转账，没有后门」。
   一旦引入 owner，这句话就**不再成立**。如果文案不改，就是**货不对板的虚假宣传**——这正是 §6 要防的问题的产品侧版本。

### 5.4 缓解措施建议

- **每个启用 owner 的代币，UI 必须明确展示**：owner 是谁（地址）、owner 能做什么（逐条列出）、这些权力与"无后门"代币的区别
- **Mintable 强制上限**；不允许 `maxSupply == 0` 表示"无限"这种危险默认
- **关键参数加时间锁或一次性设定**：例如 AntiWhale 限额只能在交易开启前设定
- **所有权限操作发事件**（OZ 的 `Ownable2Step` 已有 `OwnershipTransferred`；自定义功能需补 `Blacklisted` / `LimitsUpdated` / `Paused` 等），让链上可追溯
- **提供"放弃所有权"（renounce）入口**，让创建者可以主动兑现"无后门"承诺

---

## 6. 如何保证前端选项与实际合约功能一致，不出现假功能

### 6.1 现有三道防线（已存在，可复用）

| # | 机制 | 防住什么 |
| --- | --- | --- |
| 1 | `lib/contracts.ts` **手写 ABI** + `test/unit/abi-consistency.test.ts` 与编译产物**逐条比对**（并且当 `artifacts/` 存在时还比对新编译结果） | ABI 漂移 —— "前端调用合约里不存在的函数" |
| 2 | `scripts/verify-live-factory.mjs` 断言链上 **runtime bytecode 与本仓库编译产物逐字节一致** | 配错地址 —— 前端指向了另一个合约 |
| 3 | 集成测试用**同一份 ABI** 对**真实字节码**在本地 EVM 上调用，并验证 `mint`/`owner`/`pause` 三个 selector **全部 revert** | 行为不符 —— 函数存在但语义不对 |
| 4 | 冒烟测试（25 项）断言页面在无钱包、无数据库时仍如实反映状态 | UI 撒谎 |

这套机制的质量已经被验证过：第一次冒烟 24/25 失败时，流水线**自动中止、没有污染生产目录**。

### 6.2 新增功能必须补的四条防线

**① 能力表是唯一事实来源（single source of truth）**

不要把"哪个模板支持哪些功能"在合约、前端、文档里各写一遍。定义一份**能力表**，让 UI 完全由它派生：

```ts
// 示意：一份数据，UI 与测试都读它
const TOKEN_TEMPLATES = {
  1: { id: 1, label: "Burnable", capabilities: { burn: true, mint: false, pause: false, ... } },
  2: { id: 2, label: "Mintable", capabilities: { burn: false, mint: true,  pause: false, ... } },
}
```

关键：**这份表必须由测试去校验**，而不是凭手写信任——
对一个模板做真实部署，逐个能力断言"`capabilities.x === true` 时链上确实可用，`false` 时链上确实不可用"。

**② 负向断言：未启用的能力必须"不存在"而不是"不可用"**

这是本项目最重要的一条新防线：

```ts
// 选 Standard 模板部署出来的代币：
expect(tokenHasSelector("mint(address,uint256)")).toBe(false);   // 不是 revert，是不存在
expect(tokenHasSelector("pause()")).toBe(false);
expect(tokenHasSelector("blacklist(address)")).toBe(false);
```

如果实现成"函数存在但 flag 挡住"，那就退化成了 §3.1 的方案 A——**必须让测试直接拦住这种实现**。

**③ For UI：不可用卡片由能力表派生，禁止手写**

目前 `creator-form.tsx` 里的 6 张 `Unavailable` 卡片是**手写的字面量数组**。扩展后必须改成：

```tsx
{ALL_CAPABILITIES.map(cap => {
  const available = template.capabilities[cap.key]
  return <PropertyCard disabled={!available} ... />
})}
```

这样"卡片说支持但合约没有"在结构上就不可能发生。

**④ 冒烟测试加两条对称断言**

```
- 页面标记为可用的功能  → 必须在链上可验证（对该模板部署 + 调用成功）
- 页面标记为不可用的功能 → 链上必须不存在该 selector
```

这两条是对称的，任何一边撒谎都会让构建失败。

### 6.3 还需要一条"人看的"防线

让用户在**不看我们的话**的情况下也能自己核对：

在代币创建成功的页面上，除了代币地址，还应该展示**该模板启用了哪些能力**，并给出**在 BaseScan 上验证的方法**（读合约源码 / 看是否存在某个函数）。

因为模板方案下「不可用 = 链上无代码」这条原则成立，**用户完全可以自行验证**——这才是真正的"不出现假功能"。

---

## 7. 实施方案（待你确认后再开工）

### Phase 0 — 需要你决策（阻塞项）

请先回答这 8 个问题，它们决定合约怎么写：

1. **功能粒度**：用户可自由勾选，还是固定套餐？
   （我的建议：**固定套餐 3–4 个**，理由见 §3.1）
2. **owner 是谁**：创建者本人，还是平台托管？
   （我的建议：**创建者本人**。平台托管会被质疑"平台能随时 rug 用户的币"）
3. **Mintable 是否强制上限**？上限怎么定？
   （我的建议：**强制**，且 UI 必须展示）
4. **Pausable 要不要做**？它对 DEX 流动性的影响是真实的。
   （我的建议：做，但必须在 UI 上明确写出"暂停会导致所有人无法交易/卖出"）
5. **AntiBot 是否值得做**？Base 是 L2，"每块一笔"语义弱、误伤风险高。
   （我的建议：**优先级最低**，或做成"交易开关 + 冷却时间"这种更实用的形式）
6. **AntiWhale 的默认限额**？（例如初始供应的 1%）
7. **旧的 Standard Factory 是否继续保留**运行？（我的建议：**保留**，它仍是"无后门"选项）
8. **是否接受重新部署 + 用户需要重新部署一次 Factory**？（§4 说明这是硬约束）

### Phase 1 — 合约

- 拆出 `contracts/CreatedToken.sol`（独立文件）+ 各模板变体
- 新 `TokenFactory`：保留旧 `createToken`，新增 `createTokenWithOptions(TokenConfig)`
- 每个变体单独编译，**在 CI 里断言 Factory runtime ≤ 24576 字节**
- 合约测试扩展：每个模板 + 每个能力的正向/负向断言（§6.2 ②）
- **不做代理、不做可升级**（§3.6）

### Phase 2 — 前端

- 能力表作为唯一事实来源，UI 由它派生（§6.2 ①③）
- `/setup` 无需改动（仍用同一套 artifact 部署流程）
- 更新不可用卡片的文案与展示逻辑
- 明确展示 owner 权限清单

### Phase 3 — 验证与部署

- 复用现有验证门控流水线：`typecheck / unit / contract / integration / build / smoke` 全过才部署
- 用 `verify-live-factory.mjs` 核验新 Factory 的 runtime 字节码与产物一致
- 你本人在 `/setup` 部署新 Factory（我不代签）
- 换环境变量 + 重启容器（几秒，不用重建镜像）

### 预计影响的文件

| 文件 | 改动 |
| --- | --- |
| `contracts/CreatedToken.sol` | 新增（从 TokenFactory.sol 拆出并扩展） |
| `contracts/templates/*.sol` | 新增（各模板变体） |
| `contracts/TokenFactory.sol` | 改（保留旧函数 + 新增 `createTokenWithOptions`） |
| `lib/contracts.ts` | 改（ABI + 能力表 + 模板枚举） |
| `lib/creator-state.ts` | 改（模板选择纳入状态机） |
| `components/creator-form.tsx` | 改（能力表驱动的 UI，替换手写卡片） |
| `test/contract/*` | 扩展（每模板 × 每能力的正/负向断言） |
| `test/unit/abi-consistency.test.ts` | 扩展（多合约 ABI 比对） |
| `scripts/verify-live-factory.mjs` | 扩展（多模板核验） |
| `README.md` / `docs/` | 改（"无后门"叙述需按模板区分，不能一概而论） |

---

## 8. 我的三条核心建议

1. **用模板，不要用开关。** 「不可用 = 链上无代码」这条原则是整个方案的安全基石——用户能自己验证，而不是只能相信我们。
2. **Burnable 单独成一个无 owner 模板。** 它是唯一不需要引入管理权限的功能，可以保住"无后门"这个卖点。
3. **其余 5 个功能本质上是"把权力交给创建者"。** 这不是技术问题而是产品定位问题：现在的宣传是"没有任何人能改变供应量或限制转账"。加了 owner 之后这句话必须按模板改写，否则就是虚假宣传。**这是本方案最大的风险，且只能由你来决策。**

---

**等待你的确认与 Phase 0 的 8 个决策项后再开始开发。当前未改动任何代码、未部署任何合约。**
