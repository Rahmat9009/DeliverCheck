import { createVercelRouteHandler } from "../../src/deploy/vercel.js";

export const maxDuration = 300;
export const runtime = "nodejs";

export const POST = createVercelRouteHandler("diagnose");
