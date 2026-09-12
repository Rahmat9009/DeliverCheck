import { runSharedOSProof } from "../src/sharedos/proof.js";

const proof = await runSharedOSProof();
process.stdout.write(`${JSON.stringify(proof, null, 2)}\n`);
