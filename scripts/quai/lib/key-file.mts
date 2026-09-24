import { constants, openSync, fstatSync, readFileSync, closeSync } from "node:fs";
import { Wallet } from "ethers";
import { isCyprus1Quai } from "./safe-types.mts";

/** Read local operator data without following symlinks or accepting shared permissions. */
export function readProtectedJson(path: string): unknown {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.() || stat.size > 1024 * 1024)
            throw new Error("Operator file must be owned by this user, mode 0600, and a regular file");
        return JSON.parse(readFileSync(fd, "utf8"));
    } finally {
        closeSync(fd);
    }
}

export function readProtectedKey(path: string, role: "factory-deployer" | "relay"): { address: string; privateKey: string } {
    const key = readProtectedJson(path) as Record<string, unknown>;
    if (!key || key.version !== 1 || key.role !== role || typeof key.privateKey !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(key.privateKey))
        throw new Error("Invalid operator key file or role");
    const wallet = new Wallet(key.privateKey);
    if (typeof key.address !== "string" || wallet.address.toLowerCase() !== key.address.toLowerCase() || !isCyprus1Quai(wallet.address))
        throw new Error("Operator key does not match its native address");
    return { address: wallet.address, privateKey: key.privateKey };
}
