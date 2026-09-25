# Fresh Quai mainnet deployment

This deploys four new contracts: Safe 1.4.1, CompatibilityFallbackHandler,
MultiSendCallOnly, and the quai-receive-v1 QuaiSafeProxyFactory. It does not reuse
the committed mainnet addresses. It does not create an owner-configured Safe
account. Run all steps from the repository root in the same terminal.

## 1. Install and verify

Use Node 22.14.0 (already installed through nvm on this machine):

```bash
export PATH="$HOME/.nvm/versions/node/v22.14.0/bin:$PATH"
npm ci --ignore-scripts
npm run typecheck:quai
npm run verify:quai:release
npm run test:quai:deployment
```

Core artifacts are bundled from the integrity-verified official
`@safe-global/safe-contracts@1.4.1` archive. The importer can reproduce them with
`node scripts/quai/import-core-artifacts.mjs /path/to/safe-global-safe-contracts-1.4.1.tgz`.
No top-level Hardhat build or `.env` is required.

## 2. Store the deployer key locally

Use a Cyprus-1 QUAI wallet, with its corresponding address and 32-byte private
key. Do not use a Qi address. Enter the key in the local editor, not in a command
argument or chat. Use a new file; do not overwrite another wallet's key file.

```bash
umask 077
mkdir -p "$HOME/.quai-keys"
chmod 700 "$HOME/.quai-keys"
nano "$HOME/.quai-keys/clean-mainnet.json"
```

Save this JSON with your actual address and private key:

```json
{
  "version": 1,
  "role": "factory-deployer",
  "address": "0xYOUR_CYPRUS_1_QUAI_ADDRESS",
  "privateKey": "0xYOUR_PRIVATE_KEY"
}
```

The role name is retained for compatibility with the existing protected key
format; the same key deploys all four infrastructure contracts.

```bash
chmod 600 "$HOME/.quai-keys/clean-mainnet.json"
export QUAI_KEY_FILE="$HOME/.quai-keys/clean-mainnet.json"
export QUAI_DEPLOY_DIR='deployments/clean-mainnet'
export QUAI_DEPLOYER='0xYOUR_CYPRUS_1_QUAI_ADDRESS'
```

## 3. Fund the deployer and deploy sequentially

Fund the deployer with native QUAI on mainnet. Each plan prints
`maximumTotalFeeQUAI` and `fundingShortfallQUAI`. Before broadcasting, the balance
must cover that transaction's maximum fee. The reviewed live reference plans on
2026-09-25 showed approximately 460.44, 118.96, 18.73, and 71.31 QUAI respectively
in maximum fee allowances (about 669.44 total). These include gas headroom and
are not actual fees or a quote for your deployment. Use your live plan values.

Do not send other transactions from this wallet during deployment. Each
component must confirm before planning the next one, because the nonce changes.

Define this helper in bash or zsh:

```bash
deploy_component() {
  local quai_component="$1"
  local quai_cap

  if [ ! -f "$QUAI_DEPLOY_DIR/$quai_component.journal.json" ]; then
    npm run deploy:quai:clean -- \
      --component "$quai_component" \
      --deployer "$QUAI_DEPLOYER" \
      --directory "$QUAI_DEPLOY_DIR" \
      --replan || return 1
  fi

  printf 'Maximum QUAI fee you approve for %s (decimal amount): ' "$quai_component"
  read -r quai_cap || return 1
  [ -n "$quai_cap" ] || return 1

  npm run deploy:quai:clean -- \
    --component "$quai_component" \
    --directory "$QUAI_DEPLOY_DIR" \
    --key-file "$QUAI_KEY_FILE" \
    --max-fee-quai "$quai_cap" \
    --broadcast
}
```

Run the sequence below. **It broadcasts mainnet transactions after you enter
each fee cap.** Enter a positive decimal QUAI amount at least as large as that
component's printed `maximumTotalFeeQUAI`, only if you accept it. Each cap applies
to one transaction, not the entire four-contract deployment. Press Ctrl-C before
entering a cap to stop and fund the wallet or inspect the plan. Plans are saved
as `COMPONENT.plan.json`; their legacy `predictedFactory` field means that
component's predicted contract address.

```bash
deploy_component Safe &&
deploy_component CompatibilityFallbackHandler &&
deploy_component MultiSendCallOnly &&
deploy_component QuaiSafeProxyFactory
```

The script verifies chain ID 9, grinds native Cyprus-1 CREATE addresses, creates
access lists, simulates each constructor, checks the fee cap and wallet balance,
journals the signed transaction before submission, waits up to ten minutes for
three confirmations (with progress every 30 seconds), and verifies the deployed
runtime. The factory is permissionless and has no
owner. Deploying it does not assign authority over future Safe accounts.

## 4. Verify and export your addresses

After all four commands report `state: confirmed`:

```bash
npm run deploy:quai:clean -- --directory "$QUAI_DEPLOY_DIR" --verify
cat "$QUAI_DEPLOY_DIR/mainnet.json"
```

This verifies the four receipts and live runtime hashes, checks the factory's
proxy creation code, and writes your new addresses and actual fees. It does not
read the private key or send a transaction. Re-running it is supported. The
older `verify:quai:mainnet` command checks the committed release's existing
addresses, so use the command above for your fresh deployment.

## Recovery

- If a component times out, rerun `deploy_component COMPONENT` with a fee cap
  covering its saved plan. If its journal exists, the helper resumes the same
  signed transaction instead of preparing another one. Never delete a journal
  to fix a timeout.
- If fees or nonce changed before signing, rerunning the helper prepares a new
  unsigned plan. Existing signed journals cannot be replanned.
- If a receipt has status 0, stop. Repeating the command will not create a new
  transaction; inspect the failed receipt before deciding on another attempt.
- A hard process kill may leave `lock.json`. Remove only that lock after checking
  the recorded PID is no longer running; keep all plans and journals.
- Keep the directory private and out of Git. `deployments/` is already ignored.
  Back up plans and journals until the entire deployment has been verified.

These additions were checked with TypeScript, offline signing/validation tests,
and read-only mainnet planning and constructor simulation for all four artifacts.
No fresh deployment was broadcast during their development.
