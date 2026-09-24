# Quai deployment tooling

These scripts reproduce and verify the budget-capped factory deployment used
for the `quai-receive-v1` Safe 1.4.1 backport on Quai mainnet. They are kept in
a separate commit from the `SafeProxy` forward-port so reviewers can assess the
runtime change independently from the operational tooling.

The pinned release under [`release/`](release/) is the active production build.
Its singleton, compatibility fallback handler, and `MultiSendCallOnly` are
unchanged Safe 1.4.1 artifacts. Its proxy adds only the empty-calldata native
receive path, and its factory preserves SafeProxyFactory 1.4.1 logic while
embedding that proxy creation code. The exact release source is under
[`source/`](source/).

Public receipt, runtime-hash, empty-access-list deposit, and owner-authorized
spend results are recorded under [`release/evidence/`](release/evidence/). Signed
transaction journals and keys are deliberately excluded.

The repository's top-level contracts are the same change forward-ported to the
1.5 development branch. They are intentionally not byte-for-byte identical to
the pinned 1.4.1 mainnet release. Deploying the top-level Hardhat artifact would
create a different release and different addresses.

## Verify the release

```bash
npm run verify:quai:release
npm run verify:quai:mainnet
```

The first command recompiles the pinned source with Solidity 0.7.6, Istanbul,
the optimizer disabled, and literal metadata, then compares both creation and
runtime bytecode. The second checks all four live runtime hashes and verifies
that the factory returns the pinned proxy creation code.

## Prepare a factory deployment

Planning is read-only. It checks chain ID 9, verifies the shared Safe core,
grinds a Cyprus-1 contract address, builds an access list, simulates the
constructor, estimates gas, and writes exclusive plan files:

```bash
npm run deploy:quai:factory -- \
  --deployer 0xYOUR_CYPRUS_1_ADDRESS \
  --directory deployments/work/quai-receive \
  --shared-manifest scripts/quai/release/safe-core-mainnet.json \
  --manifest deployments/work/mainnet.json \
  --max-fee-quai YOUR_APPROVED_CAP
```

Review the predicted address, code hashes, access list, gas limit, gas price,
and maximum fee before broadcasting.

## Broadcast the reviewed plan

Use a protected key file owned by the current user with mode `0600`:

```json
{
    "version": 1,
    "role": "factory-deployer",
    "address": "0xYOUR_CYPRUS_1_ADDRESS",
    "privateKey": "0xYOUR_PRIVATE_KEY"
}
```

```bash
npm run deploy:quai:factory -- \
  --directory deployments/work/quai-receive \
  --shared-manifest scripts/quai/release/safe-core-mainnet.json \
  --manifest deployments/work/mainnet.json \
  --max-fee-quai YOUR_APPROVED_CAP \
  --broadcast \
  --key-file /protected/path/factory-deployer.json
```

Broadcast revalidates nonce, balance, gas price, address occupancy, constructor
output, gas estimate, artifact provenance, and the fee cap before reading the
key. It writes the signed transaction journal before network submission, tracks
an uncertain response by the saved hash, requires three confirmations, verifies
the deployed runtime, and only then writes the confirmed manifest.

Never commit plans, signed journals, keys, or private runtime state. The public
release manifest contains addresses and hashes only. The factory is
permissionless, adminless, and non-upgradeable; its deployer has no account
authority after deployment.
