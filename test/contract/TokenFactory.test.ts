import { expect } from "chai";
import { ethers } from "hardhat";

/**
 * On-chain behaviour of the Token Factory and the tokens it creates.
 *
 * The Hardhat network is a real EVM, so these are real executions — nothing here
 * is mocked. No wallet, key or funds of the operator are involved: Hardhat's
 * local accounts are used and they only exist inside the in-process chain.
 */
const MAX_DECIMALS = 18n;
const MAX_NAME_BYTES = 32n;
const MAX_SYMBOL_BYTES = 12n;

describe("TokenFactory", () => {
  async function deployFactory() {
    const factory = await ethers.deployContract("TokenFactory");
    await factory.waitForDeployment();
    return factory;
  }

  async function createToken(
    factory: Awaited<ReturnType<typeof deployFactory>>,
    name: string,
    symbol: string,
    decimals: number | bigint,
    supply: bigint,
  ) {
    const tokenAddress: string = await factory.createToken.staticCall(
      name,
      symbol,
      decimals,
      supply,
    );
    await factory.createToken(name, symbol, decimals, supply);
    return tokenAddress;
  }

  describe("configuration constants", () => {
    it("exposes the limits the frontend validates against", async () => {
      const factory = await deployFactory();
      expect(await factory.MAX_NAME_BYTES()).to.equal(MAX_NAME_BYTES);
      expect(await factory.MAX_SYMBOL_BYTES()).to.equal(MAX_SYMBOL_BYTES);
      expect(await factory.MAX_DECIMALS()).to.equal(MAX_DECIMALS);
    });

    it("exposes only the creation entry point and its read-only constants", async () => {
      const factory = await deployFactory();
      const names: string[] = [];
      factory.interface.forEachFunction(fragment => {
        names.push(fragment.name);
      });
      expect(names.sort()).to.deep.equal([
        "MAX_DECIMALS",
        "MAX_NAME_BYTES",
        "MAX_SYMBOL_BYTES",
        "createToken",
      ]);
    });

    it("has no owner, withdrawal, mint, pause or fee setter", async () => {
      const factory = await deployFactory();
      // ethers v6 returns null for an unknown fragment (v5 threw).
      expect(factory.interface.getFunction("createToken")).to.not.equal(null);
      for (const name of [
        "owner",
        "transferOwnership",
        "withdraw",
        "mint",
        "pause",
        "setFee",
        "upgradeTo",
      ]) {
        expect(factory.interface.getFunction(name), `unexpected function ${name}`).to.equal(null);
      }
    });
  });

  describe("createToken", () => {
    it("deploys a token and mints the whole supply to the caller", async () => {
      const [creator] = await ethers.getSigners();
      const factory = await deployFactory();
      const supply = ethers.parseUnits("1000000", 18);

      const tokenAddress = await createToken(factory, "My Token", "MTK", 18, supply);

      const token = await ethers.getContractAt("CreatedToken", tokenAddress);
      expect(await token.name()).to.equal("My Token");
      expect(await token.symbol()).to.equal("MTK");
      expect(await token.decimals()).to.equal(18);
      expect(await token.totalSupply()).to.equal(supply);
      expect(await token.balanceOf(creator.address)).to.equal(supply);
    });

    it("emits TokenCreated with the token address, creator, name and symbol", async () => {
      const [creator] = await ethers.getSigners();
      const factory = await deployFactory();
      const supply = ethers.parseUnits("1000", 18);

      const tokenAddress = await factory.createToken.staticCall("Emission", "EMI", 18, supply);

      await expect(factory.createToken("Emission", "EMI", 18, supply))
        .to.emit(factory, "TokenCreated")
        .withArgs(tokenAddress, creator.address, "Emission", "EMI");
    });

    // decimals = 0 is the case that breaks truthiness based checks. It must work.
    it("supports decimals = 0 and mints whole units", async () => {
      const [creator] = await ethers.getSigners();
      const factory = await deployFactory();
      const tokenAddress = await createToken(factory, "Whole Only", "WHOLE", 0, 1000n);

      const token = await ethers.getContractAt("CreatedToken", tokenAddress);
      expect(await token.decimals()).to.equal(0);
      expect(await token.totalSupply()).to.equal(1000n);
      expect(await token.balanceOf(creator.address)).to.equal(1000n);
    });

    it("supports the maximum decimals value", async () => {
      const factory = await deployFactory();
      const tokenAddress = await createToken(factory, "Max Decimals", "MAXD", 18, 1n);
      const token = await ethers.getContractAt("CreatedToken", tokenAddress);
      expect(await token.decimals()).to.equal(18);
    });

    it("supports a low non-zero decimals value", async () => {
      const factory = await deployFactory();
      const tokenAddress = await createToken(factory, "Cents", "CNT", 2, 12345n);
      const token = await ethers.getContractAt("CreatedToken", tokenAddress);
      expect(await token.decimals()).to.equal(2);
      expect(await token.totalSupply()).to.equal(12345n);
    });

    it("accepts name and symbol exactly at the length limits", async () => {
      const factory = await deployFactory();
      const name = "a".repeat(Number(MAX_NAME_BYTES));
      const symbol = "b".repeat(Number(MAX_SYMBOL_BYTES));

      const tokenAddress = await createToken(factory, name, symbol, 18, 1n);
      const token = await ethers.getContractAt("CreatedToken", tokenAddress);
      expect(await token.name()).to.equal(name);
      expect(await token.symbol()).to.equal(symbol);
    });

    it("creates a distinct contract on every call", async () => {
      const factory = await deployFactory();
      const first = await createToken(factory, "One", "ONE", 18, 1n);
      const second = await createToken(factory, "Two", "TWO", 18, 1n);
      expect(first).to.not.equal(second);
      for (const address of [first, second]) {
        expect(await ethers.provider.getCode(address)).to.not.equal("0x");
      }
    });

    it("lets the creator transfer the minted supply", async () => {
      const [creator, recipient] = await ethers.getSigners();
      const factory = await deployFactory();
      const tokenAddress = await createToken(factory, "Transferable", "TRF", 18, 1_000n);
      const token = await ethers.getContractAt("CreatedToken", tokenAddress);

      await token.transfer(recipient.address, 400n);

      expect(await token.balanceOf(recipient.address)).to.equal(400n);
      expect(await token.balanceOf(creator.address)).to.equal(600n);
    });
  });

  describe("created tokens have no backdoor", () => {
    it("has no mint function even for the creator", async () => {
      const [creator] = await ethers.getSigners();
      const factory = await deployFactory();
      const tokenAddress = await createToken(factory, "Fixed Supply", "FIX", 18, 1_000n);

      // Declaring the signature by hand proves the selector is absent on-chain:
      // CreatedToken has no fallback, so an unknown selector reverts.
      const asMintable = new ethers.Contract(
        tokenAddress,
        ["function mint(address to, uint256 amount) external"],
        creator,
      );
      await expect(asMintable.mint(creator.address, 1n)).to.be.reverted;
    });

    it("has no owner function", async () => {
      const [creator] = await ethers.getSigners();
      const factory = await deployFactory();
      const tokenAddress = await createToken(factory, "Unowned", "UNO", 18, 1_000n);

      const asOwnable = new ethers.Contract(
        tokenAddress,
        ["function owner() external view returns (address)"],
        creator,
      );
      await expect(asOwnable.owner()).to.be.reverted;
    });

    it("has no pause function", async () => {
      const [creator] = await ethers.getSigners();
      const factory = await deployFactory();
      const tokenAddress = await createToken(factory, "Unpausable", "UNP", 18, 1_000n);

      const asPausable = new ethers.Contract(
        tokenAddress,
        ["function pause() external"],
        creator,
      );
      await expect(asPausable.pause()).to.be.reverted;
    });

    it("exposes the full ERC-20 approval surface", async () => {
      const [creator, spender] = await ethers.getSigners();
      const factory = await deployFactory();
      const tokenAddress = await createToken(factory, "Approvable", "APR", 18, 1_000n);
      const token = await ethers.getContractAt("CreatedToken", tokenAddress);

      await token.approve(spender.address, 250n);
      expect(await token.allowance(creator.address, spender.address)).to.equal(250n);

      // connect() is typed as BaseContract in ethers v6 without typechain, so
      // re-assert the contract type to keep the call typed.
      const tokenAsSpender = token.connect(spender) as unknown as typeof token;
      await tokenAsSpender.transferFrom(creator.address, spender.address, 250n);
      expect(await token.balanceOf(spender.address)).to.equal(250n);
    });
  });

  describe("reverts", () => {
    it("rejects an empty name", async () => {
      const factory = await deployFactory();
      await expect(factory.createToken("", "SYM", 18, 1n)).to.be.revertedWithCustomError(
        factory,
        "EmptyName",
      );
    });

    it("rejects a name longer than 32 bytes", async () => {
      const factory = await deployFactory();
      await expect(
        factory.createToken("x".repeat(33), "SYM", 18, 1n),
      ).to.be.revertedWithCustomError(factory, "NameTooLong");
    });

    it("rejects an empty symbol", async () => {
      const factory = await deployFactory();
      await expect(factory.createToken("Name", "", 18, 1n)).to.be.revertedWithCustomError(
        factory,
        "EmptySymbol",
      );
    });

    it("rejects a symbol longer than 12 bytes", async () => {
      const factory = await deployFactory();
      await expect(
        factory.createToken("Name", "y".repeat(13), 18, 1n),
      ).to.be.revertedWithCustomError(factory, "SymbolTooLong");
    });

    it("rejects a zero supply", async () => {
      const factory = await deployFactory();
      await expect(factory.createToken("Name", "SYM", 18, 0n)).to.be.revertedWithCustomError(
        factory,
        "ZeroSupply",
      );
    });

    it("rejects decimals above 18", async () => {
      const factory = await deployFactory();
      await expect(factory.createToken("Name", "SYM", 19, 1n)).to.be.revertedWithCustomError(
        factory,
        "DecimalsTooHigh",
      );
    });

    it("rejects stray ETH because there is no service fee", async () => {
      const factory = await deployFactory();
      await expect(
        factory.createToken("Name", "SYM", 18, 1n, { value: 1n }),
      ).to.be.reverted;
    });

    it("refuses to deploy a token with decimals above 18 directly", async () => {
      const [creator] = await ethers.getSigners();
      const createdToken = await ethers.getContractFactory("CreatedToken");
      await expect(
        createdToken.deploy("Name", "SYM", 19, 1n, creator.address),
      ).to.be.revertedWithCustomError(createdToken, "InvalidDecimals");
    });

    it("refuses a zero recipient when deploying a token directly", async () => {
      const createdToken = await ethers.getContractFactory("CreatedToken");
      await expect(
        createdToken.deploy("Name", "SYM", 18, 1n, ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(createdToken, "InvalidRecipient");
    });
  });
});
