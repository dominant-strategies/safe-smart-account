# Safe Smart Account

[![npm version](https://badge.fury.io/js/%40safe-global%2Fsafe-smart-account.svg)](https://badge.fury.io/js/%40safe-global%2Fsafe-smart-account)
[![Build Status](https://github.com/safe-global/safe-smart-account/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/safe-global/safe-smart-account/actions)
[![Coverage Status](https://coveralls.io/repos/github/safe-global/safe-smart-account/badge.svg?branch=main)](https://coveralls.io/github/safe-global/safe-smart-account)

> [!WARNING]
> **This branch contains changes that are under development.** To use the latest audited version, make sure to use the correct commit. The tagged versions that are used by the Safe team can be found in the [releases](https://github.com/safe-global/safe-smart-account/releases).

## Usage

### Install requirements with npm:

```bash
npm i
```

### Testing

To run the tests:

```bash
npm run build
npm run test
```

Optionally, if you want to run the ERC-4337 compatibility test, it uses a live bundler and node, so it contains some prerequisites:

1. Define the environment variables:

```
ERC4337_TEST_BUNDLER_URL=
ERC4337_TEST_NODE_URL=
ERC4337_TEST_SINGLETON_ADDRESS=
ERC4337_TEST_SAFE_FACTORY_ADDRESS=
MNEMONIC=
```

2. Pre-fund the executor account derived from the mnemonic with some Native Token to cover the deployment of an ERC-4337 module and the pre-fund of the Safe for the test operation.

### Deployments

A collection of the different Safe contract deployments and their addresses can be found in the [Safe deployments](https://github.com/safe-global/safe-deployments) repository.

To add support for a new network follow the steps of the `Deploy` section and create a PR in the [Safe deployments](https://github.com/safe-global/safe-deployments) repository.

#### Quai native-receive profile

This fork adds one behavior to `SafeProxy`: empty-calldata native transfers are
accepted by a local `receive()` function that emits the existing
`SafeReceived(address,uint256)` event. Calls with calldata still use the
unchanged proxy fallback and delegate to the Safe singleton.

`SafeProxy` inherits `INativeCurrencyPaymentFallback`, which is the single
source of truth for the event and payable receive ABI. The interface adds no
storage and the receive implementation makes no external call.

Quai transactions carry access lists. Handling an empty-calldata transfer in
the proxy avoids requiring wallets, exchanges, and bridges to include the
singleton and its storage access when they send native QUAI. The receive path
does not read or write storage and makes no external call. It adds no admin,
upgrade, pause, or fund-transfer authority. The tradeoff is that empty-calldata
behavior is fixed in the proxy and will not delegate to a future singleton.

The factory already derives its creation code from `SafeProxy`, so no factory
source change is required. Its CREATE2 addresses and bytecode hashes do change.
Safe's EIP-712 and ERC-1271 behavior remains in the singleton and fallback
handler, and the factory continues to use EIP-1014 CREATE2. This change does not
add ERC-4337 infrastructure.

The first `quai-receive-v1` deployment is live on Quai mainnet, Cyprus-1,
chain ID `9`:

| Component                      | Address                                      |
| ------------------------------ | -------------------------------------------- |
| Safe proxy factory             | `0x00050f801270952BBC9966a911390C8Bf091b539` |
| Safe 1.4.1 singleton           | `0x005c67Bc7603d8e2BC203eC9e61Eb8d9E2Cb4a44` |
| Compatibility fallback handler | `0x002D7a3fd10e7EF5e45fbdd12D41C6f7C195A21D` |
| MultiSendCallOnly              | `0x001426C50C841c012c591E542D0d8162D88B9AE1` |

The factory deployment transaction is
`0x007a004408a738d61a6895d777ffb3500f18a05d3ef5a77bfba161c24adac9c2`.
Its runtime hash is
`0x1fa056fbb78fa885561f63ad90ddefa7f3347a7482ce223e1b58a6f3e28f67b6`;
deployed account proxies have runtime hash
`0x9700e0d224b2a96ebcd150bd8259e72248eaf0a2d2abcdbee3898a36f652e3b1`.

That deployment was built from Safe 1.4.1 commit
`bf943f80fec5ac647159d26161446ac5d716a294` with the same receive behavior.
This branch forward-ports the change onto the 1.5.0 codebase and is therefore
not a byte-for-byte representation of the existing deployment. A deployment
from this branch requires new addresses and published runtime hashes.

### Deploy

> [!WARNING]
> **Make sure to use the correct commit when deploying the contracts.** Any change (even comments) within the contract files will result in different addresses. The tagged versions that are used by the Safe team can be found in the [releases](https://github.com/safe-global/safe-smart-account/releases).

> **Current version:** The latest release is [v1.5.0](https://github.com/safe-global/safe-smart-account/tree/v1.5.0) on the commit [dc437e8](https://github.com/safe-global/safe-smart-account/commit/dc437e8fba8b4805d76bcbd1c668c9fd3d1e83be)

This will deploy the contracts deterministically and verify the contracts on Etherscan using [Solidity 0.7.6](https://github.com/ethereum/solidity/releases/tag/v0.7.6) by default.

Preparation:

- Set `MNEMONIC` in `.env`
- Set `INFURA_KEY` in `.env`

```bash
npm run deploy-all <network>
```

This will perform the following steps

```bash
npm run build
npx hardhat --network <network> deploy
npx hardhat --network <network> sourcify
npx hardhat --network <network> etherscan-verify
npx hardhat --network <network> local-verify
```

#### Custom Networks

It is possible to use the `NODE_URL` env var to connect to any EVM-based network via an RPC endpoint. This connection can then be used with the `custom` network.

E.g. to deploy the Safe contract suite on that network you would run `npm run deploy-all custom`.

The resulting addresses should be the same on all networks.

Note: Addresses will vary if contract code is changed or a different Solidity version is used.

#### Replay protection ([EIP-155](https://eips.ethereum.org/EIPS/eip-155))

Some networks require replay protection, making it incompatible with the default deployment process as it relies on a presigned transaction without replay protection (see <https://github.com/Arachnid/deterministic-deployment-proxy>).

Safe Smart Account contracts use a different deterministic deployment proxy (<https://github.com/safe-global/safe-singleton-factory>). To make sure that the latest version of this package is installed, run `npm i --save-dev @safe-global/safe-singleton-factory` before deployment. For more information, including deploying the factory to a new network, please refer to the factory repository.

Note: This will result in different addresses compared to hardhat's default deterministic deployment process.

### Verify contract

This command will use the deployment artifacts to compile the contracts and compare them to the onchain code

```bash
npx hardhat --network <network> local-verify
```

This command will upload the contract source to Etherscan

```bash
npx hardhat --network <network> etherscan-verify
```

## Documentation

- [Safe developer portal](http://docs.safe.global)
- [Error codes](docs/error_codes.md)
- [Coding guidelines](docs/guidelines.md)

## Audits and Formal Verification

- [for Version 1.5.0 by Certora & Ackee](docs/audit_1_5_0.md)
- [for Version 1.4.0/1.4.1 by Ackee Blockchain](docs/audit_1_4_0.md)
- [for Version 1.3.0 by G0 Group, Certora & Nethermind](docs/audit_1_3_0.md)
- [for Version 1.2.0 by G0 Group](docs/audit_1_2_0.md)
- [for Version 1.1.1 by G0 Group](docs/audit_1_1_1.md)
- [for Version 1.0.0 by Runtime Verification](docs/rv_1_0_0.md)
- [for Version 0.0.1 by Alexey Akhunov](docs/alexey_audit.md)

## Security and Liability

All contracts are WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.

## License

All smart contracts are released under LGPL-3.0
