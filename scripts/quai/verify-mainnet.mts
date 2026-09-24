import { readFileSync } from "node:fs";
import { JsonRpcProvider, keccak256 } from "quais";
import { QUAI_SAFE_PROXY_CREATION_CODE, QUAI_SAFE_RUNTIME_HASHES } from "./release/quai-safe-artifacts.mts";
import { SAFE_RUNTIME_HASHES } from "./release/safe-artifacts.mts";
import { Interface } from "ethers";

type Manifest = {
    chainId: "9";
    rpcUrl: string;
    deploymentStatus: "confirmed";
    factory: string;
    factoryCodeHash: string;
    safe: {
        version: "1.4.1";
        profile: "quai-receive-v1";
        singleton: string;
        fallbackHandler: string;
        multiSendCallOnly: string;
    };
};

const manifest = JSON.parse(readFileSync("scripts/quai/release/mainnet.json", "utf8")) as Manifest;
const safeFactoryInterface = new Interface(["function proxyCreationCode() view returns (bytes)"]);
if (
    manifest.chainId !== "9" ||
    manifest.deploymentStatus !== "confirmed" ||
    manifest.safe.version !== "1.4.1" ||
    manifest.safe.profile !== "quai-receive-v1" ||
    manifest.factoryCodeHash !== QUAI_SAFE_RUNTIME_HASHES.QuaiSafeProxyFactory
)
    throw new Error("Unsupported or inconsistent deployment manifest");

const expected = [
    [manifest.factory, QUAI_SAFE_RUNTIME_HASHES.QuaiSafeProxyFactory],
    [manifest.safe.singleton, SAFE_RUNTIME_HASHES.Safe],
    [manifest.safe.fallbackHandler, SAFE_RUNTIME_HASHES.CompatibilityFallbackHandler],
    [manifest.safe.multiSendCallOnly, SAFE_RUNTIME_HASHES.MultiSendCallOnly],
] as const;
const readOnlyCaller = "0x000C890Ba0aaE9B69EBFf8fAd1303391a9954917";
const rpc = new JsonRpcProvider(manifest.rpcUrl ?? "https://rpc.quai.network", undefined, {
    usePathing: true,
});
const timeout = setTimeout(() => {
    rpc.destroy();
    console.error("Mainnet verification timed out");
    process.exit(1);
}, 60_000);

try {
    if ((await rpc.getNetwork()).chainId !== 9n) throw new Error("Quai mainnet chain ID mismatch");
    const rows = await Promise.all(
        expected.map(async ([address, expectedHash]) => {
            const code = await rpc.getCode(address);
            const observedHash = keccak256(code);
            if (code === "0x" || observedHash !== expectedHash) throw new Error(`Runtime mismatch at ${address}`);
            return { address, expectedHash, observedHash };
        }),
    );
    const data = safeFactoryInterface.encodeFunctionData("proxyCreationCode");
    const result = await rpc.call({
        from: readOnlyCaller,
        to: manifest.factory,
        data,
    });
    const [creationCode] = safeFactoryInterface.decodeFunctionResult("proxyCreationCode", result);
    if (typeof creationCode !== "string" || creationCode.toLowerCase() !== QUAI_SAFE_PROXY_CREATION_CODE.toLowerCase())
        throw new Error("Factory proxy creation code mismatch");
    console.log(
        JSON.stringify(
            {
                verified: true,
                chainId: "9",
                profile: manifest.safe.profile,
                contracts: rows,
                proxyCreationHash: keccak256(creationCode),
                proxyRuntimeHash: QUAI_SAFE_RUNTIME_HASHES.QuaiSafeProxy,
            },
            null,
            2,
        ),
    );
} finally {
    clearTimeout(timeout);
    rpc.destroy();
}
