// Reproduce the core bundle from the integrity-pinned official npm release.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { keccak256 } from "ethers";

const archive = process.argv[2];
if (!archive) throw Error("Usage: node scripts/quai/import-core-artifacts.mjs /path/to/safe-global-safe-contracts-1.4.1.tgz");
const integrity = "sha512-fP1jewywSwsIniM04NsqPyVRFKPMAuirC3ftA/TA4X3Zc5EnwQp/UCJUU2PL/37/z/jMo8UUaJ+pnFNWmMU7dQ==";
if (`sha512-${createHash("sha512").update(readFileSync(archive)).digest("base64")}` !== integrity)
    throw Error("Official Safe 1.4.1 archive integrity mismatch");
const paths = {
    Safe: "Safe.sol/Safe.json",
    CompatibilityFallbackHandler: "handler/CompatibilityFallbackHandler.sol/CompatibilityFallbackHandler.json",
    MultiSendCallOnly: "libraries/MultiSendCallOnly.sol/MultiSendCallOnly.json",
};
const contracts = Object.fromEntries(
    Object.entries(paths).map(([name, path]) => {
        const artifact = JSON.parse(
            execFileSync("tar", ["-xOf", archive, `package/build/artifacts/contracts/${path}`], { encoding: "utf8" }),
        );
        if (Object.keys(artifact.linkReferences).length || Object.keys(artifact.deployedLinkReferences).length)
            throw Error(`Unexpected link references in ${name}`);
        return [
            name,
            {
                bytecode: artifact.bytecode,
                deployedBytecode: artifact.deployedBytecode,
                creationHash: keccak256(artifact.bytecode),
                runtimeHash: keccak256(artifact.deployedBytecode),
            },
        ];
    }),
);
writeFileSync(
    new URL("./release/safe-core-artifacts.json", import.meta.url),
    JSON.stringify(
        {
            package: "@safe-global/safe-contracts@1.4.1",
            archiveUrl: "https://registry.npmjs.org/@safe-global/safe-contracts/-/safe-contracts-1.4.1.tgz",
            integrity,
            license: "LGPL-3.0-only",
            source: "https://github.com/safe-global/safe-smart-account/tree/v1.4.1/contracts",
            contracts,
        },
        null,
        2,
    ) + "\n",
);
console.log("Imported three core artifacts from the integrity-verified Safe 1.4.1 release.");
