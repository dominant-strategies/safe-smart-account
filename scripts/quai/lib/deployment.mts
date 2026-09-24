import { closeSync, fsyncSync, openSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { concat, keccak256, toBeHex } from "ethers";
import { getCreateAddress, QuaiTransaction } from "quais";
import { z } from "zod";
import { address, isCyprus1Quai } from "./safe-types.mts";

const hex = z.string().regex(/^0x(?:[0-9a-fA-F]{2})+$/);
const integer = z.string().regex(/^(0|[1-9][0-9]*)$/);
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
export const deploymentPlanSchema = z.strictObject({
    version: z.literal(1),
    chainId: z.literal("9"),
    rpcUrl: z.literal("https://rpc.quai.network"),
    createdAt: z.string().datetime(),
    deployer: z.string(),
    predictedFactory: z.string(),
    creationCodeHash: hash,
    runtimeHash: hash,
    transaction: z.strictObject({
        type: z.literal(0),
        chainId: z.literal("9"),
        from: z.string(),
        nonce: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        data: hex,
        value: z.literal("0"),
        gasLimit: integer,
        gasPrice: integer,
        accessList: z.array(z.strictObject({ address: z.string(), storageKeys: z.array(hash) })),
    }),
});
export type DeploymentPlan = z.infer<typeof deploymentPlanSchema>;
/** Failed receipts consume the same release budget; duplicate hashes count once. */
export function remainingDeploymentBudget(cap: bigint, receipts: readonly { hash: string; fee: bigint }[]): bigint {
    if (cap <= 0n) throw new Error("Invalid deployment budget");
    const fees = new Map<string, bigint>();
    for (const receipt of receipts) {
        if (!/^0x[0-9a-fA-F]{64}$/.test(receipt.hash) || receipt.fee < 0n) throw new Error("Invalid deployment receipt fee");
        const key = receipt.hash.toLowerCase();
        if (fees.has(key) && fees.get(key) !== receipt.fee) throw new Error("Conflicting deployment receipt fees");
        fees.set(key, receipt.fee);
    }
    const remaining = cap - [...fees.values()].reduce((sum, fee) => sum + fee, 0n);
    if (remaining < 0n) throw new Error("Deployment budget already exceeded");
    return remaining;
}
export const deploymentJournalSchema = z.strictObject({
    version: z.literal(1),
    plan: deploymentPlanSchema,
    raw: hex,
    hash,
});

export function nativeFactoryData(bytecode: string, deployer: string, nonce: number) {
    if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(bytecode) || !isCyprus1Quai(deployer) || !Number.isSafeInteger(nonce) || nonce < 0)
        throw new Error("Invalid native deployment inputs");
    for (let attempt = 0; attempt < 20000; attempt++) {
        const data = concat([bytecode, toBeHex(attempt, 4)]);
        const predictedFactory = getCreateAddress({ from: deployer, nonce, data });
        if (isCyprus1Quai(predictedFactory)) return { data, predictedFactory };
    }
    throw new Error("Native factory address search exhausted");
}

export function validateDeploymentPlan(input: unknown, bytecode: string, maxFee: bigint): DeploymentPlan {
    const plan = deploymentPlanSchema.parse(input);
    const tx = plan.transaction;
    const gas = BigInt(tx.gasLimit),
        price = BigInt(tx.gasPrice);
    if (gas <= 0n || gas > 12000000n || price <= 0n || maxFee <= 0n || gas * price > maxFee)
        throw new Error("Deployment exceeds the supplied QUAI gas cap");
    if (
        !isCyprus1Quai(plan.deployer) ||
        !isCyprus1Quai(plan.predictedFactory) ||
        address(tx.from) !== address(plan.deployer) ||
        keccak256(bytecode) !== plan.creationCodeHash ||
        tx.data.slice(0, -8).toLowerCase() !== bytecode.toLowerCase() ||
        tx.data.length !== bytecode.length + 8 ||
        getCreateAddress({
            from: plan.deployer,
            nonce: tx.nonce,
            data: tx.data,
        }).toLowerCase() !== plan.predictedFactory.toLowerCase()
    )
        throw new Error("Deployment plan does not match the build or native address");
    for (const entry of tx.accessList) address(entry.address);
    return plan;
}

export function validateDeploymentJournal(input: unknown, bytecode: string, maxFee: bigint) {
    const journal = deploymentJournalSchema.parse(input);
    const plan = validateDeploymentPlan(journal.plan, bytecode, maxFee);
    const signed = QuaiTransaction.from(journal.raw);
    const tx = plan.transaction;
    if (
        !signed.hash ||
        signed.hash !== journal.hash ||
        signed.from?.toLowerCase() !== plan.deployer.toLowerCase() ||
        signed.to !== null ||
        signed.chainId !== 9n ||
        signed.type !== 0 ||
        signed.value !== 0n ||
        signed.nonce !== tx.nonce ||
        signed.data.toLowerCase() !== tx.data.toLowerCase() ||
        signed.gasLimit !== BigInt(tx.gasLimit) ||
        signed.gasPrice !== BigInt(tx.gasPrice) ||
        JSON.stringify(signed.accessList).toLowerCase() !== JSON.stringify(tx.accessList).toLowerCase()
    )
        throw new Error("Saved native transaction does not match the approved deployment plan");
    return { ...journal, plan };
}

/** Exclusive durable creation: never overwrite a plan, signed journal or manifest. */
export function writeDeploymentFile(path: string, value: unknown): void {
    const fd = openSync(path, "wx", 0o600);
    try {
        writeFileSync(fd, JSON.stringify(value, (_, item) => (typeof item === "bigint" ? item.toString() : item), 2) + "\n");
        fsyncSync(fd);
    } finally {
        closeSync(fd);
    }
    const directory = openSync(dirname(path), "r");
    try {
        fsyncSync(directory);
    } finally {
        closeSync(directory);
    }
}
