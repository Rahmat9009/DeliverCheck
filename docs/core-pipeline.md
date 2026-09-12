# DeliverCheck core pipeline

Checkpoint 3 connects the deterministic repair engine and independent verifier through an embedded SharedOS authorization boundary. It is a local implementation: it does not call Arena, SharedOS Cloud, an LLM, or any remote service.

## Flow

1. Validate and clone the frozen request contract.
2. Invoke the repair stage through `SharedOSKernel` as `agent:repair.delivercheck`, with an exact grant to the current job's `candidate` resource.
3. Validate the repair output as a proposal. A repair `passed_checks` value is renamed internally to `candidate_proposed` and has no authority to publish a verdict.
4. Invoke the verifier through `SharedOSKernel` as `agent:verifier.delivercheck`, with an exact grant to the current job's `verdict` resource. The complete proposed result is passed to `verifyDeliverCheckResult`.
5. Publish a frozen-contract `DeliverCheckResult` only after verifier acceptance. Public checks come from the verifier; detailed diagnostics remain inside the stage result.
6. Recompute the hash of the cloned candidate selected for delivery and require it to equal the verifier's candidate hash.

The repairer has no verdict grant, and the verifier has no candidate grant. A job key is derived from the request ID and grants use `exact` scope, preventing cross-job access. The existing standalone `npm run sharedos:proof` remains the direct negative-capability proof.

`runWithAudit` returns a discriminated success/failure outcome together with that invocation's immutable sanitized audit snapshot. Cloud export consumes this exact pair. The core keeps no shared “last audit” slot, so concurrent requests cannot retrieve or export another job's audit evidence.

## Failure model

`needs_information` remains a normal result when an explicit fact or interpretation is missing. A justified `cannot_repair` proposal can also remain a normal result after verification.

Invalid requests, unavailable adapters, SharedOS denials, stage exceptions, timeouts, invalid proposals, verifier rejection, and candidate/hash binding failures throw `CorePipelineError`. They are operational or integrity failures and are never converted into `cannot_repair` or successful results.

## Local demonstration

Run `npm run demo:core`. It uses three synthetic inputs to show a successful justified repair, an ambiguous input that needs information, and a forged repair proposal rejected by the verifier. The script is deterministic and performs no network or Cloud operation.

## Deferred work

This checkpoint does not add HTTP, REST, MCP, deployment, payment handling, persistence, CSV parsing, or an LLM. Arena registration, authentication, credit transfer, seller-side payment verification, and required platform endpoints remain blocked on official integration guidance.
