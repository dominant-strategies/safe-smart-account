// Fresh Safe 1.4.1 infrastructure. Each component is planned and confirmed separately.
import { existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { Interface } from "ethers";
import { JsonRpcProvider, QuaiTransaction, Wallet, Zone, Shard, formatQuai, keccak256, parseQuai } from "quais";
import { nativeFactoryData, writeDeploymentFile, type DeploymentPlan } from "./lib/deployment.mts";
import { readProtectedJson, readProtectedKey } from "./lib/key-file.mts";
import {
    artifacts,
    COMPONENTS,
    UNLIMITED,
    deploymentGasLimit,
    validateCleanJournal,
    validateCleanPlan,
    verifyArtifacts,
    type Component,
} from "./lib/clean-release.mts";
import { QUAI_SAFE_PROXY_CREATION_CODE } from "./release/quai-safe-artifacts.mts";
// Recompile and verify the pinned proxy/factory sources before any network operation.
import "./verify-release.mjs";

const { values } = parseArgs({
    options: {
        component: { type: "string" },
        directory: { type: "string", default: "deployments/clean-mainnet" },
        deployer: { type: "string" },
        "key-file": { type: "string" },
        "max-fee-quai": { type: "string" },
        broadcast: { type: "boolean", default: false },
        replan: { type: "boolean", default: false },
        verify: { type: "boolean", default: false },
    },
});
if (values.verify && (values.broadcast || values.replan || values.component)) throw Error("Use --verify by itself with --directory");
if (values.broadcast && values.replan) throw Error("Replanning and broadcasting must be separate commands");
if (!values.verify && !COMPONENTS.includes(values.component as Component)) throw Error(`Supply --component ${COMPONENTS.join(" | ")}`);
const component = values.component as Component;
const cap = values["max-fee-quai"] ? parseQuai(values["max-fee-quai"]) : UNLIMITED;
if (cap <= 0n) throw Error("Fee cap must be positive");
if (values.broadcast && (!values["max-fee-quai"] || !values["key-file"]))
    throw Error("Broadcast requires --max-fee-quai (for this transaction) and --key-file");
verifyArtifacts();
const directory = resolve(values.directory);
mkdirSync(directory, { recursive: true, mode: 0o700 });
const lockPath = `${directory}/lock.json`;
const planPath = `${directory}/${component}.plan.json`;
const journalPath = `${directory}/${component}.journal.json`;
const rpc = new JsonRpcProvider("https://rpc.quai.network", undefined, { usePathing: true });
let locked = false;
const timeout = setTimeout(
    () => {
        console.error("RPC timeout. Preserve plans and journals; rerun the same command.");
        rpc.destroy();
        if (locked) unlinkSync(lockPath);
        process.exit(1);
    },
    values.broadcast ? 720_000 : 180_000,
);

async function waitForConfirmations(hash: string) {
    const startedAt = Date.now();
    console.log(`Waiting up to 10 minutes for three confirmations: ${hash}`);
    const progress = setInterval(() => {
        console.log(`Still waiting for confirmations (${Math.floor((Date.now() - startedAt) / 1000)} seconds): ${hash}`);
    }, 30_000);
    try {
        return await rpc.waitForTransaction(hash, 3, 600_000);
    } catch (error) {
        if ((error as { code?: string } | null)?.code === "TIMEOUT")
            throw Error(
                `Confirmation wait expired for ${hash}. The transaction may still confirm; preserve the journal and rerun this same component.`,
            );
        throw error;
    } finally {
        clearInterval(progress);
    }
}

async function verifyReceipt(name: Component, plan: DeploymentPlan, hash: string) {
    const receipt = await rpc.getTransactionReceipt(hash);
    if (
        !receipt ||
        receipt.status !== 1 ||
        (await receipt.confirmations()) < 3 ||
        receipt.contractAddress?.toLowerCase() !== plan.predictedFactory.toLowerCase() ||
        keccak256(await rpc.getCode(plan.predictedFactory)) !== artifacts[name].runtimeHash
    )
        throw Error(`${name}: receipt, confirmations or deployed runtime verification failed; preserve the journal`);
    return receipt;
}

try {
    writeDeploymentFile(lockPath, { pid: process.pid, createdAt: new Date().toISOString() });
    locked = true;
    if ((await rpc.getNetwork()).chainId !== 9n) throw Error("Quai mainnet chain ID 9 required");
    if (values.verify) {
        const addresses = {} as Record<Component, string>;
        const transactions = {} as Record<Component, { hash: string; feeQUAI: string }>;
        let deployer: string | undefined;
        let totalFee = 0n;
        for (const name of COMPONENTS) {
            const plan = validateCleanPlan(readProtectedJson(`${directory}/${name}.plan.json`), name, UNLIMITED);
            const journal = validateCleanJournal(readProtectedJson(`${directory}/${name}.journal.json`), plan, name, UNLIMITED);
            if (deployer && deployer.toLowerCase() !== plan.deployer.toLowerCase()) throw Error("Mixed deployers in deployment directory");
            deployer = plan.deployer;
            const receipt = await verifyReceipt(name, plan, journal.hash);
            addresses[name] = plan.predictedFactory;
            transactions[name] = { hash: journal.hash, feeQUAI: formatQuai(receipt.fee) };
            totalFee += receipt.fee;
        }
        if (!deployer) throw Error("Missing confirmed deployer");
        const abi = new Interface(["function proxyCreationCode() view returns (bytes)"]);
        const result = await rpc.call({
            from: deployer,
            to: addresses.QuaiSafeProxyFactory,
            data: abi.encodeFunctionData("proxyCreationCode"),
        });
        if (String(abi.decodeFunctionResult("proxyCreationCode", result)[0]).toLowerCase() !== QUAI_SAFE_PROXY_CREATION_CODE.toLowerCase())
            throw Error("Factory proxy creation code mismatch");
        const manifest = {
            version: 5,
            mode: "quai-mainnet",
            chainId: "9",
            rpcUrl: "https://rpc.quai.network",
            deploymentStatus: "confirmed",
            factory: addresses.QuaiSafeProxyFactory,
            factoryCodeHash: artifacts.QuaiSafeProxyFactory.runtimeHash,
            safe: {
                version: "1.4.1",
                profile: "quai-receive-v1",
                singleton: addresses.Safe,
                fallbackHandler: addresses.CompatibilityFallbackHandler,
                multiSendCallOnly: addresses.MultiSendCallOnly,
            },
            deployer,
            transactions,
            totalFeeQUAI: formatQuai(totalFee),
        };
        const manifestPath = `${directory}/mainnet.json`;
        if (existsSync(manifestPath)) {
            if (JSON.stringify(readProtectedJson(manifestPath)) !== JSON.stringify(manifest))
                throw Error("Existing manifest differs; refusing overwrite");
        } else writeDeploymentFile(manifestPath, manifest);
        console.log(JSON.stringify({ verified: true, manifest: manifestPath, ...manifest }, null, 2));
    } else if (!values.broadcast) {
        if (!values.deployer) throw Error("Planning requires --deployer (public Cyprus-1 QUAI address)");
        if (existsSync(journalPath)) throw Error("Signed journal exists; resume the same broadcast, do not replan");
        if (existsSync(planPath) && !values.replan) throw Error("Plan exists. Review it, or use --replan only if it has never been signed");
        const deployer = values.deployer;
        const [pending, latest, balance, fees] = await Promise.all([
            rpc.getTransactionCount(deployer, "pending"),
            rpc.getTransactionCount(deployer, "latest"),
            rpc.getBalance(deployer),
            rpc.getFeeData(Zone.Cyprus1),
        ]);
        if (pending !== latest || !fees.gasPrice || fees.gasPrice <= 0n) throw Error("Pending transaction or unavailable gas price");
        const artifact = artifacts[component];
        // The existing native address helper/plan schema names its generic CREATE destination predictedFactory.
        const { data, predictedFactory } = nativeFactoryData(artifact.bytecode, deployer, pending);
        if ((await rpc.getCode(predictedFactory)) !== "0x") throw Error("Predicted address is occupied");
        const base = { type: 0 as const, chainId: 9n, from: deployer, nonce: pending, data, value: 0n, gasPrice: 0n };
        const accessList = await rpc.createAccessList(base);
        if (!accessList.some((entry) => entry.address.toLowerCase() === predictedFactory.toLowerCase()))
            accessList.push({ address: predictedFactory, storageKeys: [] });
        const estimate = await rpc.estimateGas({ ...base, accessList });
        const block = await rpc.getBlock(Shard.Cyprus1, "latest");
        if (!block || block.header.gasLimit <= 0n) throw Error("Cannot read current block gas limit");
        const gasLimit = deploymentGasLimit(estimate, block.header.gasLimit);
        const gasPrice = (fees.gasPrice * 105n + 99n) / 100n;
        console.log(JSON.stringify({ component, estimatedGas: String(estimate), plannedGasLimit: String(gasLimit) }));
        if ((await rpc.call({ ...base, accessList, gasLimit })).toLowerCase() !== artifact.deployedBytecode.toLowerCase())
            throw Error("Constructor simulation did not return the pinned runtime");
        const plan = validateCleanPlan(
            {
                version: 1,
                chainId: "9",
                rpcUrl: "https://rpc.quai.network",
                createdAt: new Date().toISOString(),
                deployer,
                predictedFactory,
                creationCodeHash: artifact.creationHash,
                runtimeHash: artifact.runtimeHash,
                transaction: { ...base, chainId: "9", value: "0", gasLimit: String(gasLimit), gasPrice: String(gasPrice), accessList },
            },
            component,
            cap,
        );
        if (values.replan) {
            const replacement = `${planPath}.${randomUUID()}.tmp`;
            writeDeploymentFile(replacement, plan);
            renameSync(replacement, planPath);
        } else writeDeploymentFile(planPath, plan);
        console.log(
            JSON.stringify(
                {
                    state: "prepared",
                    component,
                    deployer,
                    address: predictedFactory,
                    plan: planPath,
                    balanceQUAI: formatQuai(balance),
                    maximumTotalFeeQUAI: formatQuai(gasLimit * gasPrice),
                    fundingShortfallQUAI: formatQuai(balance < gasLimit * gasPrice ? gasLimit * gasPrice - balance : 0n),
                    broadcast: false,
                },
                null,
                2,
            ),
        );
    } else {
        const artifact = artifacts[component];
        const plan = validateCleanPlan(readProtectedJson(planPath), component, cap);
        let journal;
        if (existsSync(journalPath)) journal = validateCleanJournal(readProtectedJson(journalPath), plan, component, cap);
        else {
            const tx = plan.transaction;
            const [pending, latest, balance, fees, block] = await Promise.all([
                rpc.getTransactionCount(plan.deployer, "pending"),
                rpc.getTransactionCount(plan.deployer, "latest"),
                rpc.getBalance(plan.deployer),
                rpc.getFeeData(Zone.Cyprus1),
                rpc.getBlock(Shard.Cyprus1, "latest"),
            ]);
            if (
                pending !== tx.nonce ||
                latest !== tx.nonce ||
                !fees.gasPrice ||
                fees.gasPrice > BigInt(tx.gasPrice) ||
                !block ||
                BigInt(tx.gasLimit) > block.header.gasLimit ||
                balance < BigInt(tx.gasLimit) * BigInt(tx.gasPrice) ||
                (await rpc.getCode(plan.predictedFactory)) !== "0x"
            )
                throw Error("Nonce, fees, balance or address changed. Fund the deployer or run planning with --replan before signing");
            const current = { ...tx, chainId: 9n, value: 0n, gasPrice: 0n };
            if (keccak256(await rpc.call(current)) !== artifact.runtimeHash || (await rpc.estimateGas(current)) > BigInt(tx.gasLimit))
                throw Error("Deployment simulation or gas estimate changed; replan before signing");
            const key = readProtectedKey(values["key-file"]!, "factory-deployer");
            if (key.address.toLowerCase() !== plan.deployer.toLowerCase()) throw Error("Private key does not match planned deployer");
            const raw = await new Wallet(key.privateKey).signTransaction({ ...tx, chainId: 9n });
            journal = validateCleanJournal({ version: 1, plan, raw, hash: QuaiTransaction.from(raw).hash }, plan, component, cap);
            writeDeploymentFile(journalPath, journal);
        }
        let receipt = await rpc.getTransactionReceipt(journal.hash);
        if (!receipt) {
            try {
                await rpc.broadcastTransaction(Zone.Cyprus1, journal.raw);
            } catch {
                console.error(`Submission response uncertain; tracking saved transaction ${journal.hash}`);
            }
            receipt = await waitForConfirmations(journal.hash);
        } else if ((await receipt.confirmations()) < 3) receipt = await waitForConfirmations(journal.hash);
        if (!receipt) throw Error("Receipt not confirmed yet. Preserve the journal and rerun this exact broadcast command");
        const stable = await verifyReceipt(component, plan, journal.hash);
        if (stable.blockHash !== receipt.blockHash) throw Error("Receipt block changed; rerun verification");
        console.log(
            JSON.stringify(
                { state: "confirmed", component, address: plan.predictedFactory, hash: journal.hash, feeQUAI: formatQuai(stable.fee) },
                null,
                2,
            ),
        );
    }
} finally {
    if (locked) unlinkSync(lockPath);
    clearTimeout(timeout);
    rpc.destroy();
}
