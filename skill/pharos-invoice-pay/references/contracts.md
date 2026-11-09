# Contracts (Pharos Pacific Mainnet, chain 1672)

| Role | Address | How it was confirmed |
|---|---|---|
| USDC (Circle FiatToken v2.2) | `0xC879C018dB60520F4355C26eD1a6D572cdAC1815` | official token registry (Pacific section); `decimals()` = 6; `version()` = "2"; EIP-712 domain {name "USDC", version "2", chainId 1672}; EIP-3009 `transferWithAuthorization`, `authorizationState` |
| WPROS | `0x52C48d4213107b20bC583832b0d951FB9CA8F0B0` | official token registry; `decimals()` = 18 |
| USDC/USD feed (Chainlink self-managed) | `0x3f882C4F2836b1e5C5278ff2B9FccE2502A35C5d` | docs.pharos.xyz → Oracles; 18 decimals — the peg check for USD invoices |

## Trailing calldata (the memo)

Checked on Pacific with `eth_call` and `eth_estimateGas`: USDC `transfer` and `transferWithAuthorization`, and WPROS
`transfer`, accept bytes appended after their ABI arguments (the ABI decoder ignores them); a PROS transfer to an
EOA accepts any `data`. Cost: about +258 gas for a 13-byte memo (58,863 vs 58,605 for a USDC transfer).

## Selectors

`transfer(address,uint256)` = `0xa9059cbb` (4 + 64 bytes of arguments) ·
`transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)` = `0xe3ee160e`
(4 + 288 bytes) — `verify` splits the memo off after these.
