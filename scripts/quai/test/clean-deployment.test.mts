import assert from "node:assert/strict";
import test from "node:test";
import { Wallet, QuaiTransaction, keccak256, toUtf8Bytes } from "quais";
import { isCyprus1Quai } from "../lib/safe-types.mts";
import { nativeFactoryData } from "../lib/deployment.mts";
import { artifacts, deploymentGasLimit, validateCleanPlan, validateCleanJournal, verifyArtifacts } from "../lib/clean-release.mts";

// Public deterministic test-only key, generated locally; never used on-chain.
let wallet: Wallet;
for (let i = 0; ; i++) {
    wallet = new Wallet(keccak256(toUtf8Bytes(`quai-clean-deployment-unit-test-${i}`)));
    if (isCyprus1Quai(wallet.address)) break;
}
const artifact = artifacts.QuaiSafeProxyFactory;
const { data, predictedFactory } = nativeFactoryData(artifact.bytecode, wallet.address, 0);
const cap = 2000000n;
const plan = {
    version: 1,
    chainId: "9",
    rpcUrl: "https://rpc.quai.network",
    createdAt: "2026-09-25T00:00:00.000Z",
    deployer: wallet.address,
    predictedFactory,
    creationCodeHash: artifact.creationHash,
    runtimeHash: artifact.runtimeHash,
    transaction: {
        type: 0,
        chainId: "9",
        from: wallet.address,
        nonce: 0,
        data,
        value: "0",
        gasLimit: "1000000",
        gasPrice: "1",
        accessList: [{ address: predictedFactory, storageKeys: [] }],
    },
};

test("core release artifacts match the previously pinned runtime hashes", () => verifyArtifacts());
test("singleton gas headroom fits the hard ceiling and rejects insufficient block capacity", () => {
    assert.equal(deploymentGasLimit(6876590n, 30000000n), 12000000n);
    assert.equal(deploymentGasLimit(6876590n, 10000000n), 10000000n);
    assert.throws(() => deploymentGasLimit(6876590n, 7000000n), /headroom/);
    assert.throws(() => deploymentGasLimit(12000000n, 30000000n), /headroom/);
});
test("plans reject a different component, tampered runtime, and insufficient fee cap", () => {
    assert.equal(validateCleanPlan(plan, "QuaiSafeProxyFactory", cap).predictedFactory, predictedFactory);
    assert.throws(() => validateCleanPlan(plan, "Safe", cap));
    assert.throws(() => validateCleanPlan({ ...plan, runtimeHash: artifacts.Safe.runtimeHash }, "QuaiSafeProxyFactory", cap));
    assert.throws(() => validateCleanPlan(plan, "QuaiSafeProxyFactory", 999999n));
});
test("journal retry accepts only the signed transaction for the exact reviewed plan", async () => {
    const tx = validateCleanPlan(plan, "QuaiSafeProxyFactory", cap).transaction;
    const raw = await wallet.signTransaction({ ...tx, chainId: 9n });
    const journal = { version: 1, plan, raw, hash: QuaiTransaction.from(raw).hash };
    assert.equal(validateCleanJournal(journal, plan, "QuaiSafeProxyFactory", cap).raw, raw);
    const otherPlan = { ...plan, transaction: { ...plan.transaction, gasPrice: "2" } };
    assert.throws(() => validateCleanJournal(journal, otherPlan, "QuaiSafeProxyFactory", cap), /reviewed plan/);
    assert.throws(() => validateCleanJournal({ ...journal, plan: otherPlan }, otherPlan, "QuaiSafeProxyFactory", cap));
});
test("native CREATE grinding rejects an address outside the Cyprus-1 QUAI ledger", () => {
    assert.throws(() => nativeFactoryData(artifact.bytecode, "0x8000000000000000000000000000000000000001", 0));
});
