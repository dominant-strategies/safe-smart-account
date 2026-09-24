import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { keccak256, toUtf8Bytes } from "ethers";
import bundle from "./release/quai-safe-receive-v1.json" with { type: "json" };

const require = createRequire(import.meta.url);
const solc = require("solc");
const sources = Object.fromEntries(
    bundle.sources.map(({ path, hash }) => {
        const localPath = `scripts/quai/source/${path.split("/").at(-1)}`;
        const content = readFileSync(localPath, "utf8");
        if (keccak256(toUtf8Bytes(content)) !== hash) throw new Error(`Source hash mismatch: ${localPath}`);
        return [path, { content }];
    }),
);
if (keccak256(toUtf8Bytes(bundle.sources.map(({ path }) => sources[path].content).join("\n"))) !== bundle.sourceHash)
    throw new Error("Combined release source hash mismatch");

const output = JSON.parse(
    solc.compile(
        JSON.stringify({
            language: "Solidity",
            sources,
            settings: {
                optimizer: { enabled: false, runs: 200 },
                metadata: { useLiteralContent: true },
                outputSelection: {
                    "*": {
                        "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"],
                    },
                },
            },
        }),
    ),
);
const errors = (output.errors ?? []).filter(({ severity }) => severity === "error");
if (errors.length) throw new Error(errors.map(({ formattedMessage }) => formattedMessage).join("\n"));

for (const name of ["QuaiSafeProxy", "QuaiSafeProxyFactory"]) {
    const source = `contracts/${name}.sol`;
    const compiled = output.contracts[source][name];
    const pinned = bundle.contracts[name];
    const bytecode = `0x${compiled.evm.bytecode.object}`;
    const deployedBytecode = `0x${compiled.evm.deployedBytecode.object}`;
    if (
        bytecode !== pinned.bytecode ||
        deployedBytecode !== pinned.deployedBytecode ||
        keccak256(bytecode) !== pinned.creationHash ||
        keccak256(deployedBytecode) !== pinned.runtimeHash
    )
        throw new Error(`${name} does not match the pinned Quai release`);
}

console.log(
    `Verified ${bundle.profile}: source, compiler output, creation code, and runtime code match the pinned Safe ${bundle.upstreamSafe} release.`,
);
