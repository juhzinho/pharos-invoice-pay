import { encodeAbiParameters, getAddress, keccak256, parseAbi } from "viem";

// Pharos Pacific Mainnet (chain 1672). Checked on chain (see skill/…/references/contracts.md):
// - USDC: Circle FiatToken v2.2 (EIP-3009; EIP-712 domain {name "USDC", version "2", chainId 1672}); official token registry.
// - WPROS: wrapped PROS (WETH9 layout); official token registry.
// - Chainlink self-managed USDC/USD feed (docs.pharos.xyz → Oracles), 18 decimals: the dollar peg check.

export const CHAIN_ID = 1672;
export const PACIFIC_RPC = "https://rpc.pharos.xyz";
export const EXPLORER = "https://www.pharosscan.xyz";

export const TOKENS = {
  USDC: { symbol: "USDC", address: getAddress("0xc879c018db60520f4355c26ed1a6d572cdac1815"), decimals: 6, eip3009: true, balanceSlot: 9n },
  WPROS: { symbol: "WPROS", address: getAddress("0x52c48d4213107b20bc583832b0d951fb9ca8f0b0"), decimals: 18, eip3009: false, balanceSlot: 3n },
  PROS: { symbol: "PROS", address: null, decimals: 18, native: true },
};
export const FEEDS = { USDC_USD: getAddress("0x3f882C4F2836b1e5C5278ff2B9FccE2502A35C5d") };
export const USDC_DOMAIN = { name: "USDC", version: "2", chainId: CHAIN_ID, verifyingContract: TOKENS.USDC.address };

export const TYPES = {
  TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }],
};

export const ABI = {
  erc20: parseAbi([
    "function balanceOf(address) view returns (uint256)",
    "function transfer(address to, uint256 value) returns (bool)",
    "event Transfer(address indexed from, address indexed to, uint256 value)",
  ]),
  usdc: parseAbi([
    "function isBlacklisted(address) view returns (bool)",
    "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
    "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
    "event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)",
  ]),
  feed: parseAbi(["function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)"]),
};

export const balanceSlot = (token, owner) => keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [owner, token.balanceSlot]));
