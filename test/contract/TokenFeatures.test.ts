import { expect } from "chai";
import { ethers } from "hardhat";

/**
 * Behaviour of the Burnable / Mintable / Pausable features and of the service
 * fee, executed against a real EVM (the Hardhat network) — nothing is mocked.
 *
 * Two rules run through every test here:
 *
 *  1. A feature the buyer did not pay for must not EXIST on the token, not merely
 *     be disabled. A flag-guarded implementation would still revert when the
 *     caller lacks permission, so "it reverted" proves nothing — every absence
 *     assertion below first checks the four-byte selector is not in the deployed
 *     bytecode at all. A selector is a hash of the signature; if the compiler
 *     never emitted it, no call can ever reach it.
 *  2. The price the page shows and the price the chain requires must be the same
 *     number. `feeFor()` is the single source of truth and `createToken` demands
 *     exactly it, so the fee tests assert both halves.
 */

// The MVP test prices, in wei. 0.000001 ETH = 1e12 wei.
const BASE_FEE = ethers.parseEther("0.000001");
const BURN_FEE = ethers.parseEther("0.000001");
const MINT_FEE = ethers.parseEther("0.000001");
const PAUSE_FEE = ethers.parseEther("0.000001");

const SUPPLY = ethers.parseUnits("1000000", 18);

type FeatureSet = { burnable: boolean; mintable: boolean; pausable: boolean };
type Signer = Awaited<ReturnType<typeof ethers.getSigners>>[number];
type Factory = Awaited<ReturnType<typeof ethers.deployContract>>;

/**
 * A handle on a token.
 *
 * ethers v6 types a dynamically built `Contract` as `BaseContract`, which has no
 * index signature, so `token.burn(1)` is a type error even though the method
 * exists at runtime. These tests deliberately probe functions that may or may not
 * be present, so an indexable type is the honest description of what they do.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyContract = Record<string, any> & { interface: any };

/** All eight combinations, used to sweep the absence assertions. */
const ALL_FEATURE_SETS: FeatureSet[] = [
  { burnable: false, mintable: false, pausable: false },
  { burnable: false, mintable: true, pausable: false },
  { burnable: false, mintable: false, pausable: true },
  { burnable: false, mintable: true, pausable: true },
  { burnable: true, mintable: false, pausable: false },
  { burnable: true, mintable: true, pausable: false },
  { burnable: true, mintable: false, pausable: true },
  { burnable: true, mintable: true, pausable: true },
];

/** Every capability, with the fragment and the flag that licenses it. */
const CAPABILITIES = [
  { fragment: "function mint(address,uint256)", args: (a: string) => [a, 1n], guard: "mintable" },
  { fragment: "function burn(uint256)", args: () => [1n], guard: "burnable" },
  { fragment: "function burnFrom(address,uint256)", args: (a: string) => [a, 1n], guard: "burnable" },
  { fragment: "function pause()", args: () => [], guard: "pausable" },
  { fragment: "function unpause()", args: () => [], guard: "pausable" },
] as const;

describe("Token features and service fee", () => {
  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  async function deployCore() {
    const [deployer] = await ethers.getSigners();
    const factory = await ethers.deployContract("TokenFactoryCore", [
      BASE_FEE,
      MINT_FEE,
      PAUSE_FEE,
      deployer.address,
    ]);
    await factory.waitForDeployment();
    return factory;
  }

  async function deployBurnable() {
    const [deployer] = await ethers.getSigners();
    const factory = await ethers.deployContract("TokenFactoryBurnable", [
      BASE_FEE,
      BURN_FEE,
      MINT_FEE,
      PAUSE_FEE,
      deployer.address,
    ]);
    await factory.waitForDeployment();
    return factory;
  }

  /**
   * Create a token, paying exactly what `feeFor` quotes.
   *
   * The value is read back from the contract rather than recomputed here on
   * purpose: if the contract's arithmetic were wrong, a test that duplicated the
   * same arithmetic would agree with it and still pass.
   */
  async function createToken(
    factory: Factory,
    features: FeatureSet,
    name = "Feature Token",
    symbol = "FT",
  ) {
    const value: bigint = await factory.feeFor(
      features.burnable,
      features.mintable,
      features.pausable,
    );
    const args = [
      name,
      symbol,
      18,
      SUPPLY,
      features.burnable,
      features.mintable,
      features.pausable,
    ] as const;
    const address: string = await factory.createToken.staticCall(...args, { value });
    await factory.createToken(...args, { value });
    return address;
  }

  const TOKEN_ABI = [
    "function name() view returns (string)",
    "function symbol() view returns (string)",
    "function decimals() view returns (uint8)",
    "function totalSupply() view returns (uint256)",
    "function balanceOf(address) view returns (uint256)",
    "function creator() view returns (address)",
    "function transfer(address,uint256) returns (bool)",
    "function approve(address,uint256) returns (bool)",
    "function allowance(address,address) view returns (uint256)",
    "function burn(uint256)",
    "function burnFrom(address,uint256)",
    "function mint(address,uint256)",
    "function pause()",
    "function unpause()",
    "function paused() view returns (bool)",
    // Errors must be declared for `revertedWithCustomError` to recognise them.
    "error NotCreator(address caller)",
    "error InvalidDecimals(uint8 decimals_)",
    "error InvalidRecipient()",
    "error EnforcedPause()",
    "error ExpectedPause()",
    "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
    "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
  ];

  /**
   * A handle on a deployed token.
   *
   * Falls back to the provider when no signer is given, so read-only assertions
   * work without a wallet; write calls always pass a signer (or `connect`).
   */
  function tokenAt(address: string, signer?: Signer): AnyContract {
    return new ethers.Contract(address, TOKEN_ABI, signer ?? ethers.provider) as unknown as AnyContract;
  }

  /**
   * Assert a capability is genuinely absent from the deployed token.
   *
   * Two independent checks, because either one alone can be fooled:
   *
   *  a) Bytecode: the four-byte selector must not appear anywhere in the deployed
   *     code. This is the decisive one — the compiler either emitted a dispatcher
   *     arm for the function or it did not.
   *  b) Call: with the *creator* as caller, a call must still revert. The creator
   *     is the identity that would succeed if the function existed, so a revert
   *     cannot be explained away as a permission failure.
   */
  async function expectAbsent(
    address: string,
    fragment: string,
    args: unknown[],
    creator: Signer,
  ) {
    const open = fragment.indexOf("(");
    const name = fragment.slice("function ".length, open);
    // First ")" — a fragment may continue with " view returns (address)".
    const params = fragment.slice(open + 1, fragment.indexOf(")"));
    const signature = `${name}(${params})`;

    const code = await ethers.provider.getCode(address);
    const selector = ethers.id(signature).slice(2, 10);
    expect(
      code.includes(selector),
      `${signature} selector ${selector} is present in the deployed bytecode`,
    ).to.equal(false);

    const probe = new ethers.Contract(address, [fragment], creator) as unknown as AnyContract;
    await expect(
      probe[name](...args),
      `${signature} should not be dispatchable`,
    ).to.be.reverted;
  }

  /** Sweep every capability against every combination, both directions. */
  async function assertFeatureMatrix(address: string, features: FeatureSet, creator: Signer) {
    for (const cap of CAPABILITIES) {
      const licensed = features[cap.guard as keyof FeatureSet];
      if (licensed) continue;
      await expectAbsent(address, cap.fragment, cap.args(creator.address), creator);
    }
  }

  // ---------------------------------------------------------------------------
  // The fee table
  // ---------------------------------------------------------------------------

  describe("service fee table", () => {
    it("quotes 0.000001 ETH with no features", async () => {
      const factory = await deployCore();
      expect(await factory.feeFor(false, false, false)).to.equal(BASE_FEE);
    });

    it("quotes 0.000002 ETH for Burnable alone", async () => {
      const factory = await deployBurnable();
      expect(await factory.feeFor(true, false, false)).to.equal(BASE_FEE + BURN_FEE);
    });

    it("quotes 0.000002 ETH for Mintable alone", async () => {
      const factory = await deployCore();
      expect(await factory.feeFor(false, true, false)).to.equal(BASE_FEE + MINT_FEE);
    });

    it("quotes 0.000002 ETH for Pausable alone", async () => {
      const factory = await deployCore();
      expect(await factory.feeFor(false, false, true)).to.equal(BASE_FEE + PAUSE_FEE);
    });

    it("quotes 0.000003 ETH for Burnable + Mintable", async () => {
      const factory = await deployBurnable();
      expect(await factory.feeFor(true, true, false)).to.equal(BASE_FEE + BURN_FEE + MINT_FEE);
    });

    it("quotes 0.000004 ETH for all three", async () => {
      const factory = await deployBurnable();
      expect(await factory.feeFor(true, true, true)).to.equal(
        BASE_FEE + BURN_FEE + MINT_FEE + PAUSE_FEE,
      );
    });

    it("carries the whole fee to the recipient in the same transaction", async () => {
      const [, , recipient] = await ethers.getSigners();
      const factory = await ethers.deployContract("TokenFactoryBurnable", [
        BASE_FEE,
        BURN_FEE,
        MINT_FEE,
        PAUSE_FEE,
        recipient.address,
      ]);
      await factory.waitForDeployment();

      const quoted: bigint = await factory.feeFor(true, true, true);
      const before = await ethers.provider.getBalance(recipient.address);

      await factory.createToken("Paid", "PAID", 18, SUPPLY, true, true, true, { value: quoted });

      expect(await ethers.provider.getBalance(recipient.address)).to.equal(before + quoted);
      // The factory is a pass-through, never a custodian.
      expect(await ethers.provider.getBalance(factory.target)).to.equal(0n);
    });

    it("refuses a payment that is one wei short of the quote", async () => {
      const factory = await deployBurnable();
      const quoted: bigint = await factory.feeFor(true, true, true);
      await expect(
        factory.createToken("Short", "SHT", 18, SUPPLY, true, true, true, { value: quoted - 1n }),
      ).to.be.revertedWithCustomError(factory, "WrongFee");
    });

    it("refuses an overpayment rather than keeping the difference", async () => {
      const factory = await deployCore();
      const quoted: bigint = await factory.feeFor(false, false, false);
      await expect(
        factory.createToken("Over", "OVR", 18, SUPPLY, false, false, false, {
          value: quoted + ethers.parseEther("0.001"),
        }),
      ).to.be.revertedWithCustomError(factory, "WrongFee");
    });

    it("refuses a free creation, unlike the previous factory", async () => {
      const factory = await deployCore();
      await expect(
        factory.createToken("Free", "FRE", 18, SUPPLY, false, false, false),
      ).to.be.revertedWithCustomError(factory, "WrongFee");
    });
  });

  // ---------------------------------------------------------------------------
  // Test 1 — no features selected
  // ---------------------------------------------------------------------------

  describe("Test 1: no features (fixed supply, no backdoor)", () => {
    it("mints the whole supply once and never again", async () => {
      const [creator] = await ethers.getSigners();
      const factory = await deployCore();
      const address = await createToken(factory, {
        burnable: false,
        mintable: false,
        pausable: false,
      });
      const token = tokenAt(address);

      expect(await token.totalSupply()).to.equal(SUPPLY);
      expect(await token.balanceOf(creator.address)).to.equal(SUPPLY);
      expect(await token.decimals()).to.equal(18);
      expect(await token.creator()).to.equal(creator.address);
    });

    it("has no mint, burn, pause or owner function at all", async () => {
      const [creator] = await ethers.getSigners();
      const factory = await deployCore();
      const address = await createToken(factory, {
        burnable: false,
        mintable: false,
        pausable: false,
      });

      await assertFeatureMatrix(
        address,
        { burnable: false, mintable: false, pausable: false },
        creator,
      );

      const asOwnable = new ethers.Contract(
        address,
        ["function owner() external view returns (address)"],
        creator,
      );
      await expect(asOwnable.owner()).to.be.reverted;
    });

    it("still transfers normally", async () => {
      const [creator, other] = await ethers.getSigners();
      const factory = await deployCore();
      const address = await createToken(factory, {
        burnable: false,
        mintable: false,
        pausable: false,
      });
      const token = tokenAt(address, creator);

      await token.transfer(other.address, 1000n);
      expect(await token.balanceOf(other.address)).to.equal(1000n);
    });
  });

  // ---------------------------------------------------------------------------
  // Test 2 — Burnable
  // ---------------------------------------------------------------------------

  describe("Test 2: Burnable", () => {
    it("lets a holder burn their own tokens, reducing balance and total supply", async () => {
      const [creator] = await ethers.getSigners();
      const factory = await deployBurnable();
      const address = await createToken(factory, {
        burnable: true,
        mintable: false,
        pausable: false,
      });
      const token = tokenAt(address, creator);

      await token.burn(400n);

      expect(await token.balanceOf(creator.address)).to.equal(SUPPLY - 400n);
      expect(await token.totalSupply()).to.equal(SUPPLY - 400n);
    });

    it("cannot burn somebody else's tokens", async () => {
      const [creator, stranger] = await ethers.getSigners();
      const factory = await deployBurnable();
      const address = await createToken(factory, {
        burnable: true,
        mintable: false,
        pausable: false,
      });
      const token = tokenAt(address);

      // `burn` always acts on msg.sender, so a stranger calling it touches only
      // their own empty balance and fails — the creator's supply is untouched.
      await expect(token.connect(stranger).burn(1n)).to.be.reverted;
      expect(await token.totalSupply()).to.equal(SUPPLY);

      // `burnFrom` needs an allowance, which nobody granted.
      await expect(token.connect(stranger).burnFrom(creator.address, 1n)).to.be.reverted;
      expect(await token.totalSupply()).to.equal(SUPPLY);
      expect(await token.balanceOf(creator.address)).to.equal(SUPPLY);
    });

    it("allows burnFrom once an allowance is granted", async () => {
      const [creator, spender] = await ethers.getSigners();
      const factory = await deployBurnable();
      const address = await createToken(factory, {
        burnable: true,
        mintable: false,
        pausable: false,
      });
      const token = tokenAt(address);

      await token.connect(creator).approve(spender.address, 500n);
      await token.connect(spender).burnFrom(creator.address, 500n);

      expect(await token.totalSupply()).to.equal(SUPPLY - 500n);
    });
  });

  // ---------------------------------------------------------------------------
  // Test 3 — Mintable
  // ---------------------------------------------------------------------------

  describe("Test 3: Mintable", () => {
    it("lets the creator mint, raising total supply and the target balance", async () => {
      const [creator, holder] = await ethers.getSigners();
      const factory = await deployCore();
      const address = await createToken(factory, {
        burnable: false,
        mintable: true,
        pausable: false,
      });
      const token = tokenAt(address, creator);

      await token.mint(holder.address, 250n);

      expect(await token.totalSupply()).to.equal(SUPPLY + 250n);
      expect(await token.balanceOf(holder.address)).to.equal(250n);
    });

    it("refuses a second wallet: mint is creator-only on chain", async () => {
      const [creator, stranger] = await ethers.getSigners();
      const factory = await deployCore();
      const address = await createToken(factory, {
        burnable: false,
        mintable: true,
        pausable: false,
      });
      const token = tokenAt(address);

      await expect(token.connect(stranger).mint(stranger.address, 1n))
        .to.be.revertedWithCustomError(token, "NotCreator")
        .withArgs(stranger.address);

      expect(await token.totalSupply()).to.equal(SUPPLY);
      expect(await token.creator()).to.equal(creator.address);
    });

    it("is uncapped by product decision, and the creator is the only minter", async () => {
      const [creator] = await ethers.getSigners();
      const factory = await deployCore();
      const address = await createToken(factory, {
        burnable: false,
        mintable: true,
        pausable: false,
      });
      const token = tokenAt(address, creator);

      // No ceiling is enforced. This test records that it is a decision rather
      // than an oversight, and pins the behaviour so it cannot change silently.
      await token.mint(creator.address, SUPPLY * 10n);
      expect(await token.totalSupply()).to.equal(SUPPLY * 11n);
    });

    it("does not let the creator seize anyone's balance", async () => {
      const [creator, holder] = await ethers.getSigners();
      const factory = await deployCore();
      const address = await createToken(factory, {
        burnable: false,
        mintable: true,
        pausable: false,
      });
      const token = tokenAt(address, creator);

      await token.transfer(holder.address, 500n);
      // The creator's power is to mint into existence, never to move other
      // people's tokens: no burn, no transferFrom without allowance.
      await expect(token.connect(creator).burnFrom(holder.address, 500n)).to.be.reverted;
      expect(await token.balanceOf(holder.address)).to.equal(500n);
    });
  });

  // ---------------------------------------------------------------------------
  // Test 4 — Pausable
  // ---------------------------------------------------------------------------

  describe("Test 4: Pausable", () => {
    it("freezes transfers while paused and restores them on unpause", async () => {
      const [creator, other] = await ethers.getSigners();
      const factory = await deployCore();
      const address = await createToken(factory, {
        burnable: false,
        mintable: false,
        pausable: true,
      });
      const token = tokenAt(address, creator);

      expect(await token.paused()).to.equal(false);

      await token.pause();
      expect(await token.paused()).to.equal(true);
      await expect(token.transfer(other.address, 1n)).to.be.revertedWithCustomError(
        token,
        "EnforcedPause",
      );

      await token.unpause();
      expect(await token.paused()).to.equal(false);
      await token.transfer(other.address, 1n);
      expect(await token.balanceOf(other.address)).to.equal(1n);
    });

    it("refuses a second wallet: pause is creator-only on chain", async () => {
      const [creator, stranger] = await ethers.getSigners();
      const factory = await deployCore();
      const address = await createToken(factory, {
        burnable: false,
        mintable: false,
        pausable: true,
      });
      const token = tokenAt(address);

      await expect(token.connect(stranger).pause())
        .to.be.revertedWithCustomError(token, "NotCreator")
        .withArgs(stranger.address);
      await expect(token.connect(stranger).unpause()).to.be.reverted;

      expect(await token.paused()).to.equal(false);
      expect(await token.creator()).to.equal(creator.address);
    });

    it("blocks transferFrom too, not just transfer", async () => {
      const [creator, spender, other] = await ethers.getSigners();
      const factory = await deployCore();
      const address = await createToken(factory, {
        burnable: false,
        mintable: false,
        pausable: true,
      });
      const token = tokenAt(address, creator);

      await token.approve(spender.address, 100n);
      await token.pause();

      const withTransferFrom = new ethers.Contract(
        address,
        ["function transferFrom(address,address,uint256) returns (bool)"],
        spender,
      );
      await expect(
        withTransferFrom.transferFrom(creator.address, other.address, 100n),
      ).to.be.revertedWithCustomError(token, "EnforcedPause");
    });

    it("documents that pause stops mint and burn as well", async () => {
      // Follows OpenZeppelin's design: the gate sits on `_update`, the single
      // funnel every balance change goes through, so supply changes stop too.
      // Recorded because it is a real, user-visible consequence.
      const [creator] = await ethers.getSigners();
      const factory = await deployBurnable();
      const address = await createToken(factory, {
        burnable: true,
        mintable: true,
        pausable: true,
      });
      const token = tokenAt(address, creator);

      await token.pause();
      await expect(token.burn(1n)).to.be.revertedWithCustomError(token, "EnforcedPause");
      await expect(token.mint(creator.address, 1n)).to.be.revertedWithCustomError(
        token,
        "EnforcedPause",
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Test 5 — all three
  // ---------------------------------------------------------------------------

  describe("Test 5: all three features together", () => {
    it("supports mint, burn, pause, unpause and transfer in one token", async () => {
      const [creator, holder] = await ethers.getSigners();
      const factory = await deployBurnable();
      const address = await createToken(factory, {
        burnable: true,
        mintable: true,
        pausable: true,
      });
      const token = tokenAt(address, creator);

      await token.mint(holder.address, 1_000n);
      expect(await token.balanceOf(holder.address)).to.equal(1_000n);

      await token.connect(holder).burn(400n);
      expect(await token.balanceOf(holder.address)).to.equal(600n);

      await token.transfer(holder.address, 100n);
      expect(await token.balanceOf(holder.address)).to.equal(700n);

      await token.pause();
      await expect(token.transfer(holder.address, 1n)).to.be.revertedWithCustomError(
        token,
        "EnforcedPause",
      );

      await token.unpause();
      await token.transfer(holder.address, 1n);

      expect(await token.totalSupply()).to.equal(SUPPLY + 1_000n - 400n);
      expect(await token.creator()).to.equal(creator.address);
    });
  });

  // ---------------------------------------------------------------------------
  // The rule that matters most: unpaid features must be absent, not disabled
  // ---------------------------------------------------------------------------

  describe("unpaid features do not exist on the token", () => {
    it("holds for all eight combinations, capability by capability", async () => {
      const [creator] = await ethers.getSigners();
      const core = await deployCore();
      const burn = await deployBurnable();

      for (const features of ALL_FEATURE_SETS) {
        const factory = features.burnable ? burn : core;
        const address = await createToken(
          factory,
          features,
          `T${features.burnable ? 1 : 0}${features.mintable ? 1 : 0}${features.pausable ? 1 : 0}`,
          "PRB",
        );
        await assertFeatureMatrix(address, features, creator);
      }
    });

    it("never exposes an owner, a proxy or a fee setter", async () => {
      const [creator] = await ethers.getSigners();
      const core = await deployCore();
      const burn = await deployBurnable();

      for (const features of ALL_FEATURE_SETS) {
        const factory = features.burnable ? burn : core;
        const address = await createToken(factory, features, "Probe", "PRB");
        const code = await ethers.provider.getCode(address);

        // A minimal proxy (EIP-1167) is 45 bytes and delegates elsewhere; a real
        // token here is several kilobytes carrying its own implementation.
        // Keeping the size honest is what makes "no proxy, no upgrade path" true.
        expect(
          code.length,
          `proxy-sized code for ${JSON.stringify(features)}`,
        ).to.be.greaterThan(2 + 45 * 2);

        for (const fn of ["owner", "transferOwnership", "upgradeTo", "setFee", "implementation"]) {
          await expectAbsent(address, `function ${fn}() view returns (address)`, [], creator);
        }
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Routing between the two factories
  // ---------------------------------------------------------------------------

  describe("factory routing", () => {
    it("the core factory refuses to create a burnable token", async () => {
      const factory = await deployCore();
      const value: bigint = await factory.feeFor(true, false, false);
      await expect(
        factory.createToken("Wrong", "WRG", 18, SUPPLY, true, false, false, { value }),
      ).to.be.revertedWithCustomError(factory, "FeatureNotSupportedHere");
    });

    it("the burnable factory refuses to create a non-burnable token", async () => {
      const factory = await deployBurnable();
      const value: bigint = await factory.feeFor(false, true, false);
      await expect(
        factory.createToken("Wrong", "WRG", 18, SUPPLY, false, true, false, { value }),
      ).to.be.revertedWithCustomError(factory, "FeatureNotSupportedHere");
    });

    it("both factories publish the same createToken signature", async () => {
      const core = await deployCore();
      const burn = await deployBurnable();
      const types = (f: Factory) =>
        f.interface.getFunction("createToken")?.inputs.map(i => i.type);
      expect(JSON.stringify(types(core))).to.equal(JSON.stringify(types(burn)));
    });

    it("emits the three feature flags so a record can be built from chain data", async () => {
      const [creator] = await ethers.getSigners();
      const factory = await deployBurnable();
      const value: bigint = await factory.feeFor(true, true, false);
      const args = ["Evented", "EVT", 18, SUPPLY, true, true, false] as const;

      const predicted: string = await factory.createToken.staticCall(...args, { value });

      await expect(factory.createToken(...args, { value }))
        .to.emit(factory, "TokenCreated")
        .withArgs(predicted, creator.address, "Evented", "EVT", true, true, false);
    });
  });

  // ---------------------------------------------------------------------------
  // Input validation still applies
  // ---------------------------------------------------------------------------

  describe("validation", () => {
    it("rejects invalid input before charging anything", async () => {
      const factory = await deployCore();
      const value: bigint = await factory.feeFor(false, false, false);
      const cases = [
        ["", "SYM", 18, SUPPLY, "EmptyName"],
        ["x".repeat(33), "SYM", 18, SUPPLY, "NameTooLong"],
        ["Name", "", 18, SUPPLY, "EmptySymbol"],
        ["Name", "y".repeat(13), 18, SUPPLY, "SymbolTooLong"],
        ["Name", "SYM", 18, 0n, "ZeroSupply"],
        ["Name", "SYM", 19, SUPPLY, "DecimalsTooHigh"],
      ] as const;

      for (const [name, symbol, decimals, supply, error] of cases) {
        await expect(
          factory.createToken(name, symbol, decimals, supply, false, false, false, { value }),
        ).to.be.revertedWithCustomError(factory, error);
      }
    });

    it("refuses a factory with a zero fee recipient", async () => {
      const core = await ethers.getContractFactory("TokenFactoryCore");
      await expect(
        core.deploy(BASE_FEE, MINT_FEE, PAUSE_FEE, ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(core, "InvalidFeeRecipient");
    });

    it("keeps decimals = 0 working", async () => {
      const factory = await deployCore();
      const value: bigint = await factory.feeFor(false, false, false);
      const address: string = await factory.createToken.staticCall(
        "Whole Only",
        "WHOLE",
        0,
        1000n,
        false,
        false,
        false,
        { value },
      );
      await factory.createToken("Whole Only", "WHOLE", 0, 1000n, false, false, false, { value });
      expect(await tokenAt(address).decimals()).to.equal(0);
    });
  });
});
