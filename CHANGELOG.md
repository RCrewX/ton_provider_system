# Changelog

All notable changes to this project are documented in this file.

## 0.3.1

### Fixed

- **testnet provider selection** — demote `orbs_testnet` (healthy on liteserver
  get-methods but 403s on the v2 `getTransactions` shape) below `toncenter_testnet`
  in the shipped `rpc.json` (`toncenter_testnet.priority 50 → 5`,
  `orbs_testnet.priority 10 → 90`), mirroring the same fix already applied to
  `createDefaultConfig()` in `src/config/parser.ts` (`toncenter_testnet 100 → 10`,
  `orbs_testnet 50 → 90`). Selection is score-based and priority is the lever
  (lower = higher score), so testnet now prefers the transactions-capable
  Toncenter while Orbs stays enabled as the decentralized fallback for
  non-transaction reads. Added an offline selection/failover regression test
  (`src/selection-failover.test.ts`). **Mainnet providers, priorities, and
  defaults are unchanged.**
