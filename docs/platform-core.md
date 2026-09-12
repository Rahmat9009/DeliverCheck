# DeliverCheck platform core

Checkpoint 2B establishes an embedded SharedOS authorization boundary and public discovery documents. It does not implement repair, independent verification, HTTP serving, MCP serving, authentication, Arena settlement, or deployment.

## Positioning and services

> DeliverCheck makes one agent’s output usable by the next.

| Service | Published price | Current implementation status |
| --- | ---: | --- |
| `diagnose` | Free | Boundary declared; handler deferred. |
| `repair` | 7 Arena credits | Boundary declared; repair port absent. |
| `bridge` | 12 Arena credits | Boundary declared; repair and verifier ports absent. |

The price labels come from the product decision. The payment transport, charging moment, receipt format, and seller verification flow remain unconfirmed and unimplemented.

## SharedOS identities

- Purpose: `service:delivercheck.transform`
- Intake: `agent:intake.delivercheck`
- Repair: `agent:repair.delivercheck`
- Verifier: `agent:verifier.delivercheck`
- Owning service/authority: `service:delivercheck.transform`

The embedded proof gives each agent a separate exact grant over one artifact path in one synthetic job. The service identity owns the resources and issues the grants through a trusted in-memory `GrantSource`.

## Proof matrix

| Attempt | Expected result | Why |
| --- | --- | --- |
| Intake writes the primary job source | Allowed | Exact source-path grant. |
| Repair agent writes the primary job verdict | Denied | Its grant covers only the candidate path. |
| Verifier writes the primary job candidate | Denied | Its grant covers only the verdict path. |
| Repair agent writes another job candidate | Denied | Its grant is exact to the primary job. |

Run `npm run sharedos:proof`. The command exits unsuccessfully if an expected decision changes, a denied call reaches the provider, a grant is not exact, or an authority hash is missing. Its JSON output retains outcomes and authority hashes but excludes raw inputs, outputs, grant IDs, owners, and audit metadata.

## Discovery boundary

`createDiscoveryDocument` produces the body for `/.well-known/agent.json` and `/api/v1/listing`. Both documents say the implementation is a platform boundary. `/api/mcp` is advertised as future and deliberately throws `endpoint_not_implemented` if requested through the generator.

The documents define DeliverCheck’s own versioned discovery format. They do not claim conformance to an Arena, A2A, or MCP registration contract that organizers have not confirmed.

## Coordinator boundary

`RepairAgentPort` and `VerificationAgentPort` define the interfaces that future merged implementations must satisfy. `requireCoordinatorPorts` throws `coordinator_not_ready` and identifies missing ports instead of returning a fabricated repair or verification success.
