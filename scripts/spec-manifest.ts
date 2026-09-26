import { specManifestWithDigests } from "@procurement/protocol-contracts";

const manifest = specManifestWithDigests();
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
