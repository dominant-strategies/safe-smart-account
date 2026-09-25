import { keccak256 } from "quais";
import { validateDeploymentPlan, validateDeploymentJournal } from "./deployment.mts";
import { SAFE_RUNTIME_HASHES } from "../release/safe-artifacts.mts";
import core from "../release/safe-core-artifacts.json" with { type: "json" };
import quai from "../release/quai-safe-receive-v1.json" with { type: "json" };

export const COMPONENTS = ["Safe", "CompatibilityFallbackHandler", "MultiSendCallOnly", "QuaiSafeProxyFactory"] as const;
export type Component = (typeof COMPONENTS)[number];
export const artifacts = { ...core.contracts, QuaiSafeProxyFactory: quai.contracts.QuaiSafeProxyFactory };
export const UNLIMITED = 2n ** 256n - 1n;

export function deploymentGasLimit(estimate: bigint, blockGasLimit: bigint): bigint {
    if (estimate <= 0n || blockGasLimit <= 0n) throw Error("Invalid gas estimate or block limit");
    const requested = (estimate * 175n + 99n) / 100n + 100000n;
    const limit = [requested, 12000000n, blockGasLimit].reduce((a, b) => (a < b ? a : b));
    if (limit < (estimate * 110n + 99n) / 100n) throw Error("Gas estimate leaves less than 10% headroom within deployment limits");
    return limit;
}

export function verifyArtifacts(): void {
    if (core.package !== "@safe-global/safe-contracts@1.4.1" || quai.profile !== "quai-receive-v1")
        throw Error("Unexpected release profile");
    for (const component of COMPONENTS) {
        const artifact = artifacts[component];
        if (keccak256(artifact.bytecode) !== artifact.creationHash || keccak256(artifact.deployedBytecode) !== artifact.runtimeHash)
            throw Error(`Corrupt artifact: ${component}`);
        if (component !== "QuaiSafeProxyFactory" && artifact.runtimeHash !== SAFE_RUNTIME_HASHES[component])
            throw Error(`Unexpected Safe 1.4.1 runtime: ${component}`);
    }
}

export function validateCleanPlan(input: unknown, component: Component, cap: bigint) {
    const artifact = artifacts[component];
    const plan = validateDeploymentPlan(input, artifact.bytecode, cap);
    if (plan.runtimeHash !== artifact.runtimeHash) throw Error("Plan runtime does not match the selected component");
    return plan;
}

export function validateCleanJournal(input: unknown, planInput: unknown, component: Component, cap: bigint) {
    const plan = validateCleanPlan(planInput, component, cap);
    const journal = validateDeploymentJournal(input, artifacts[component].bytecode, cap);
    if (JSON.stringify(journal.plan) !== JSON.stringify(plan)) throw Error("Journal does not match the reviewed plan");
    return journal;
}
