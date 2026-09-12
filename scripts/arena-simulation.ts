import { runArenaSimulation } from "../src/arena/simulation.js";

const result = await runArenaSimulation();
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
