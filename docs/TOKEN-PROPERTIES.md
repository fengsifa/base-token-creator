# Token Properties：Burnable / Mintable / Pausable

> 范围：为 Token Creator 增加三个**可选**功能与对应的服务费。
> 已实现并本地验证；**尚未部署到 Base Sepolia**。

---

## 1. 三条不可动摇的规则

1. **没买的功能必须"不存在"，而不是"被关掉"。**
   一个含全部功能、用三个 boolean 开关控制的合约能通过功能测试，却违背这条规则：代码就在链上，只有
   一个 flag 挡在陌生人和 `mint()` 之间，买家从字节码里看不出区别。
   所以**每一种组合都是独立合约**，没选 Mintable 的代币**真的没有 `mint` selector**，
   任何人都能在 BaseScan 上自行确认，而不必相信这份文档。

2. **权限属于创建者的钱包，且只有所需的那部分。**
   没有 OpenZeppelin 意义上的 owner，只有一个 `immutable creator` 地址。它不可转移、不可放弃、
   没有 `transferOwnership`，因此也不存在"以后被夺走"的路径。
   需要权限的变体才带 `onlyCreator` 检查（modifier 在未被使用时零成本）。

3. **后端只记录，不控制。**
   数据库里的 `burnable/mintable/pausable` 只是"当时买了什么"的记录。
   没有任何后台接口能 mint、burn、pause 或改权限；链上合约是唯一权威。

---

## 2. 八个变体

| 组合 | 合约 | burn | mint | pause | 由哪个工厂部署 |
| --- | --- | :-: | :-: | :-: | --- |
| 无 | `TokenStandard` | ✗ | ✗ | ✗ | Core |
| Burnable | `TokenBurnable` | ✓ | ✗ | ✗ | Burnable |
| Mintable | `TokenMintable` | ✗ | ✓ | ✗ | Core |
| Pausable | `TokenPausable` | ✗ | ✗ | ✓ | Core |
| B+M | `TokenBurnableMintable` | ✓ | ✓ | ✗ | Burnable |
| B+P | `TokenBurnablePausable` | ✓ | ✗ | ✓ | Burnable |
| M+P | `TokenMintablePausable` | ✗ | ✓ | ✓ | Core |
| 全部 | `TokenFull` | ✓ | ✓ | ✓ | Burnable |

分组依据是 **Burnable**：它是唯一不需要创建者权限的功能，所以"用哪个工厂"与"这个代币有没有管理员"
正好对齐。

### Burnable 的实现

`burn(amount)` 任何人都能调，但只能销毁**调用者自己**的余额；
`burnFrom(account, amount)` 走标准 ERC-20 allowance，需要账户本人先 approve。
**不需要任何管理员角色** —— 这是唯一一个完全保留"无后门"承诺的功能。

没有继承 OZ 的 `ERC20Burnable`：它会再次继承 `ERC20`，构成菱形继承，迫使每个派生变体重新声明
`decimals()`。在当前字节码预算下，这几行样板加上多出的字节是负担不起的。

### Mintable 的实现

`mint(to, amount)` 仅 `creator` 可调。**无上限**，这是明确的产品决定：创建者为这项能力付费，
创建页也直说了。其他变体不携带该函数。

创建者**不能**动用别人的余额 —— 没有 owner 版的 `transferFrom`，`burnFrom` 仍需 allowance。

### Pausable 的实现

`pause()` / `unpause()` 仅 `creator` 可调。冻结作用在 `_update` 上 —— 所有余额变化的唯一出口。
因此暂停期间的行为是：

| 操作 | 暂停时 |
| --- | --- |
| `transfer` | **失败**（`EnforcedPause`） |
| `transferFrom` | **失败** |
| `mint` | **失败** |
| `burn` | **失败** |

这与 OpenZeppelin `ERC20Pausable` 的行为一致（它同样把门放在 `_update` 上），是刻意选择的标准做法：
"暂停"意味着这个代币**任何**余额变动都停下，而不是只拦一部分 —— 后者会让"暂停"的含义变得可疑。
代价是创建者也无法在暂停期间增发或销毁，这一点在创建页写明了。

未继承 `ERC20Pausable`（同样的菱形原因），而是用不继承 `ERC20` 的 `Pausable` + 一个 `_update` 闸门。

---

## 3. 为什么是两个工厂

`new TokenX()` 会把 TokenX 的**创建字节码完整内联**进部署者的 runtime。实测（本仓库编译设置）：

```
TokenStandard            3361        TokenBurnable            3556
TokenMintable            3543        TokenPausable            3936
TokenBurnableMintable    3748        TokenBurnablePausable    4114
TokenMintablePausable    4116        TokenFull                4290
                                     ────────────────────────────────
                                     合计                    30664 字节
EIP-170 单合约上限                                           24576 字节
```

**超出 6088 字节，而且无法通过聪明写法绕开**：每个变体都必须携带完整的 ERC-20 实现，
编译器不会在它们之间共享代码。于是拆成两个工厂，各自 4 个变体：

| 合约 | runtime | 余量 |
| --- | --- | --- |
| `TokenFactoryCore` | 17384 | 7192 |
| `TokenFactoryBurnable` | 18135 | 6441 |

两者 `createToken` 签名完全相同，只有构造函数参数个数不同（core 没有 burn 价格可传）。

**被否掉的方案：EIP-1167 最小代理。** 每次创建的 gas 更低，但会让每个代币变成"真正的代码在别处"
的代理合约 —— 正是本产品要诚实回答的那个问题。现阶段一个普通、可验证的合约比省下的 gas 值钱。

---

## 4. 服务费

| 项 | 值（Base Sepolia，测试阶段） |
| --- | --- |
| Base Token Creation | 0.000001 ETH |
| Burnable | +0.000001 ETH |
| Mintable | +0.000001 ETH |
| Pausable | +0.000001 ETH |

全部选择 = **0.000004 ETH**。**Gas 永远单独计算，不并入服务费。**

### 收费是真的上链

工厂是 `payable`，在 `createToken` 内部按功能组合计算价格、校验 `msg.value`，并**在同一笔交易里**
把费用转给收款地址。因此：

- **一笔交易完成**（此前是"先付费、再部署"两笔，若第二笔失败钱已经花掉）；
- 工厂只是过路财神，余额恒为 0；
- 金额要求**严格相等**：少一 wei 或多一 wei 都会 `WrongFee` —— 页面显示多少，链上就要求多少。

### 价格从哪来

- **链上**：价格在工厂部署时由构造函数写入，`feeFor(burnable, mintable, pausable)` 是唯一权威。
- **前端**：页面**直接读 `feeFor()`** 来显示总价、读 `baseFee/burnFee/mintFee/pauseFee` 来显示
  每个勾选项旁边的单价。所以屏幕上那个数字**就是**链上那个数字，不存在两份会漂移的配置。
- **环境变量**：`NEXT_PUBLIC_*_FEE_*` 决定工厂**部署时**写进去的价格，并在工厂尚未配置时作为回退显示。

> ⚠️ 本版本移除了此前的"最低费率地板"（曾把低于 0.0001 ETH 的非零价格抬到 0.0001）。
> 它会把 0.000001 这样的测试价直接改写掉，造成"页面显示一个数、链上要求另一个数"，
> 正是要避免的情况。`test/unit/config.test.ts` 有一条测试专门守住这件事。

---

## 5. 自己验证（不需要相信本文档）

1. 在 BaseScan 打开代币合约 → **Contract → Read Contract**：
   - 选了 Mintable：能看到 `mint`；没选：**这个函数不存在**
   - 选了 Pausable：能看到 `pause` / `unpause` 和 `paused`
   - 选了 Burnable：能看到 `burn` / `burnFrom`
   - `creator()` 永远是创建者的钱包地址
2. 任何人都没有 `owner()`、`transferOwnership`、`upgradeTo`。
3. 直接调用未启用功能的 selector 会**无法派发而 revert** —— 不是"权限不足"，是**不存在**。
   `test/contract/TokenFeatures.test.ts` 对全部 8 种组合逐个断言这一点，并且是**在部署的字节码里
   搜索该 selector**，而不是只发起一次调用（调用返回 revert 也可能只是权限不够）。

---

## 6. 已知限制

- **Mintable 无上限**（产品决定，见 §2）。
- **暂停会冻结所有人**，包括 DEX 池 —— 如果代币已上流动性，暂停等于锁死交易。创建页写明了。
- 两个工厂都必须部署，创建页才能提供全部 8 种组合；只配一个，另一半功能会不可用。
- 旧 Factory（`0xF760…C684`）与两个旧代币**未受任何影响**，它们仍在链上、仍可用。
  新代码不与其交互，`scripts/verify-live-factory.mjs` 继续核验它的字节码。
