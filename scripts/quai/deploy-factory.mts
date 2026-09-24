import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { JsonRpcProvider, QuaiTransaction, Wallet, Zone, formatQuai, keccak256, parseQuai, toUtf8Bytes } from "quais";
import { nativeFactoryData, validateDeploymentJournal, validateDeploymentPlan, writeDeploymentFile } from "./lib/deployment.mts";
import { readProtectedJson, readProtectedKey } from "./lib/key-file.mts";
import { SAFE_RUNTIME_HASHES } from "./release/safe-artifacts.mts";
import bundle from "./release/quai-safe-receive-v1.json" with { type: "json" };

const { values } = parseArgs({
    options: {
        deployer: { type: "string" },
        directory: {
            type: "string",
            default: "deployments/work/quai-receive",
        },
        manifest: {
            type: "string",
            default: "deployments/work/mainnet.json",
        },
        "shared-manifest": {
            type: "string",
            default: "scripts/quai/release/safe-core-mainnet.json",
        },
        "max-fee-quai": { type: "string" },
        "gas-price-buffer-percent": { type: "string", default: "5" },
        "key-file": { type: "string" },
        broadcast: { type: "boolean", default: false },
    },
});
const cap = values["max-fee-quai"] ? parseQuai(values["max-fee-quai"]) : undefined,
    buffer = Number(values["gas-price-buffer-percent"]),
    directory = resolve(values.directory),
    manifestPath = resolve(values.manifest),
    planPath = `${directory}/QuaiSafeProxyFactory.plan.json`,
    journalPath = `${directory}/QuaiSafeProxyFactory.journal.json`,
    artifact = bundle.contracts.QuaiSafeProxyFactory,
    shared = JSON.parse(readFileSync(values["shared-manifest"], "utf8"));
if (!Number.isInteger(buffer) || buffer < 0 || buffer > 50) throw Error("Gas price buffer must be an integer from 0 to 50 percent");
if (values.broadcast && (!cap || cap <= 0n || !values["key-file"]))
    throw Error("Broadcast requires a protected key and positive approved cap");
if (
    bundle.profile !== "quai-receive-v1" ||
    bundle.upstreamSafe !== "1.4.1" ||
    keccak256(artifact.bytecode) !== artifact.creationHash ||
    keccak256(artifact.deployedBytecode) !== artifact.runtimeHash ||
    bundle.sources.some(({ path, hash }) => {
        const source = `scripts/quai/source/${path.split("/").at(-1)}`;
        return keccak256(toUtf8Bytes(readFileSync(source, "utf8"))) !== hash;
    }) ||
    keccak256(
        toUtf8Bytes(bundle.sources.map(({ path }) => readFileSync(`scripts/quai/source/${path.split("/").at(-1)}`, "utf8")).join("\n")),
    ) !== bundle.sourceHash
)
    throw Error("Quai Safe artifact provenance mismatch");
if (shared.deploymentStatus !== "confirmed" || shared.safe?.version !== "1.4.1")
    throw Error("Confirmed Safe 1.4.1 shared deployment required");

mkdirSync(directory, { recursive: true, mode: 0o700 });
const rpc = new JsonRpcProvider("https://rpc.quai.network", undefined, {
    usePathing: true,
});
const timeout = setTimeout(() => {
    console.error("RPC timeout; preserve the plan and journal");
    rpc.destroy();
    process.exit(1);
}, 300000);
let locked = false;
try {
    if ((await rpc.getNetwork()).chainId !== 9n) throw Error("Quai mainnet required");
    for (const [target, hash] of [
        [shared.safe.singleton, SAFE_RUNTIME_HASHES.Safe],
        [shared.safe.fallbackHandler, SAFE_RUNTIME_HASHES.CompatibilityFallbackHandler],
        [shared.safe.multiSendCallOnly, SAFE_RUNTIME_HASHES.MultiSendCallOnly],
    ] as const)
        if (keccak256(await rpc.getCode(target)) !== hash) throw Error("Existing shared Safe runtime mismatch");

    if (!values.broadcast) {
        if (existsSync(planPath) || existsSync(journalPath)) throw Error("Deployment files exist; review or use a new directory");
        const deployer = values.deployer ?? JSON.parse(readFileSync("deployments/deployer.public.json", "utf8")).address;
        const [pending, latest, balance, fees] = await Promise.all([
            rpc.getTransactionCount(deployer, "pending"),
            rpc.getTransactionCount(deployer, "latest"),
            rpc.getBalance(deployer),
            rpc.getFeeData(Zone.Cyprus1),
        ]);
        if (pending !== latest || !fees.gasPrice || fees.gasPrice <= 0n)
            throw Error("Pending deployer transaction or unavailable gas price");
        const gasPrice = (fees.gasPrice * BigInt(100 + buffer) + 99n) / 100n;
        const { data, predictedFactory } = nativeFactoryData(artifact.bytecode, deployer, pending);
        if ((await rpc.getCode(predictedFactory)) !== "0x") throw Error("Planned factory address occupied");
        const base = {
            type: 0 as const,
            chainId: 9n,
            from: deployer,
            nonce: pending,
            data,
            value: 0n,
            gasPrice: 0n,
        };
        const accessList = await rpc.createAccessList(base);
        if (!accessList.some((entry) => entry.address.toLowerCase() === predictedFactory.toLowerCase()))
            accessList.push({ address: predictedFactory, storageKeys: [] });
        const estimate = await rpc.estimateGas({ ...base, accessList }),
            gasLimit = (estimate * 175n + 99n) / 100n + 100000n;
        if ((await rpc.call({ ...base, accessList, gasLimit })).toLowerCase() !== artifact.deployedBytecode.toLowerCase())
            throw Error("Native constructor runtime mismatch");
        const plan = validateDeploymentPlan(
            {
                version: 1,
                chainId: "9",
                rpcUrl: "https://rpc.quai.network",
                createdAt: new Date().toISOString(),
                deployer,
                predictedFactory,
                creationCodeHash: artifact.creationHash,
                runtimeHash: artifact.runtimeHash,
                transaction: {
                    ...base,
                    chainId: "9",
                    value: "0",
                    gasLimit: String(gasLimit),
                    gasPrice: String(gasPrice),
                    accessList,
                },
            },
            artifact.bytecode,
            cap ?? 2n ** 256n - 1n,
        );
        writeDeploymentFile(planPath, plan);
        writeDeploymentFile(`${directory}/release.review.json`, {
            profile: bundle.profile,
            sourceHash: bundle.sourceHash,
            factory: predictedFactory,
            factoryRuntimeHash: artifact.runtimeHash,
            proxyRuntimeHash: bundle.contracts.QuaiSafeProxy.runtimeHash,
            maximumFeeWei: String(gasLimit * gasPrice),
        });
        console.log(
            JSON.stringify(
                {
                    state: "prepared",
                    deployer,
                    factory: predictedFactory,
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
        writeDeploymentFile(`${directory}/lock.json`, {
            pid: process.pid,
            createdAt: new Date().toISOString(),
        });
        locked = true;
        const plan = validateDeploymentPlan(readProtectedJson(planPath), artifact.bytecode, cap!);
        let journal;
        if (existsSync(journalPath)) journal = validateDeploymentJournal(readProtectedJson(journalPath), artifact.bytecode, cap!);
        else {
            const tx = plan.transaction;
            const [pending, latest, balance, fees] = await Promise.all([
                rpc.getTransactionCount(plan.deployer, "pending"),
                rpc.getTransactionCount(plan.deployer, "latest"),
                rpc.getBalance(plan.deployer),
                rpc.getFeeData(Zone.Cyprus1),
            ]);
            if (
                pending !== tx.nonce ||
                latest !== tx.nonce ||
                !fees.gasPrice ||
                fees.gasPrice > BigInt(tx.gasPrice) ||
                balance < BigInt(tx.gasLimit) * BigInt(tx.gasPrice) ||
                (await rpc.getCode(plan.predictedFactory)) !== "0x"
            )
                throw Error("Deployer or fee state changed; prepare a replacement plan");
            const current = { ...tx, chainId: 9n, value: 0n, gasPrice: 0n };
            if (keccak256(await rpc.call(current)) !== artifact.runtimeHash || (await rpc.estimateGas(current)) > BigInt(tx.gasLimit))
                throw Error("Deployment execution or estimate changed");
            const key = readProtectedKey(values["key-file"]!, "factory-deployer");
            if (key.address.toLowerCase() !== plan.deployer.toLowerCase()) throw Error("Deployer key mismatch");
            const raw = await new Wallet(key.privateKey).signTransaction({
                ...tx,
                chainId: 9n,
            });
            journal = validateDeploymentJournal({ version: 1, plan, raw, hash: QuaiTransaction.from(raw).hash }, artifact.bytecode, cap!);
            writeDeploymentFile(journalPath, journal);
        }
        let receipt = await rpc.getTransactionReceipt(journal.hash);
        if (!receipt) {
            try {
                await rpc.broadcastTransaction(Zone.Cyprus1, journal.raw);
            } catch {
                console.error("Broadcast response uncertain; tracking saved hash");
            }
            receipt = await rpc.waitForTransaction(journal.hash, 3, 60000);
        } else if ((await receipt.confirmations()) < 3) receipt = await rpc.waitForTransaction(journal.hash, 3, 60000);
        const stable = await rpc.getTransactionReceipt(journal.hash);
        if (
            !receipt ||
            !stable ||
            stable.status !== 1 ||
            stable.blockHash !== receipt.blockHash ||
            (await stable.confirmations()) < 3 ||
            stable.contractAddress?.toLowerCase() !== plan.predictedFactory.toLowerCase() ||
            keccak256(await rpc.getCode(plan.predictedFactory)) !== artifact.runtimeHash
        )
            throw Error("Deployment receipt or runtime verification failed");
        const manifest = {
            version: 5,
            mode: "quai-mainnet",
            chainId: "9",
            rpcUrl: "https://rpc.quai.network",
            deploymentStatus: "confirmed",
            factory: plan.predictedFactory,
            factoryCodeHash: artifact.runtimeHash,
            safe: {
                version: "1.4.1",
                profile: bundle.profile,
                singleton: shared.safe.singleton,
                fallbackHandler: shared.safe.fallbackHandler,
                multiSendCallOnly: shared.safe.multiSendCallOnly,
            },
        };
        if (existsSync(manifestPath)) throw Error("Manifest path already exists; refusing overwrite");
        writeDeploymentFile(manifestPath, manifest);
        console.log(
            JSON.stringify({
                state: "confirmed",
                hash: journal.hash,
                factory: plan.predictedFactory,
                feeQUAI: formatQuai(stable.fee),
                manifest: manifestPath,
            }),
        );
    }
} finally {
    if (locked) unlinkSync(`${directory}/lock.json`);
    clearTimeout(timeout);
    rpc.destroy();
}
