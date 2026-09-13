# Security policy

## Responsible disclosure

Report security vulnerabilities privately through GitHub private vulnerability reporting when it is available. If it is unavailable, contact [Rahmat9009](https://github.com/Rahmat9009) without including exploit details and arrange a private reporting channel. Allow reasonable time for investigation and remediation before public disclosure.

Do not place credentials, tokens, customer payloads, private schemas, exploit details, or other secrets in a public issue, discussion, pull request, or test case.

## Supported runtime

The supported application runtime is Node.js 24. The service, tests, build, and Arena simulation support Linux, Ubuntu WSL, and native Windows. Live SharedNet execution is supported only on Linux or Ubuntu WSL and fails closed on native Windows before starting a process.

Security fixes are applied to the current `main` branch. Older snapshots are not maintained as separate supported versions.

## Boundaries and non-goals

DeliverCheck treats JSON payloads, schemas, explicit rules, headers, caller identity claims, and marketplace metadata as untrusted. It enforces bounded input and schema complexity, blocks remote and cyclic references, prevents unsafe JSON Pointer assignment, uses exact SharedOS grants, independently verifies declared changes and canonical hashes, and sanitizes public failures.

DeliverCheck verifies structural compatibility with caller-supplied requirements. It does not prove factual truth, authenticate identity from request data, execute customer code, fetch customer URLs, enforce Arena billing, verify payment in the public service, or provide a general malware sandbox. SharedOS Cloud audit ingestion, official seller registration, and organizer ranking integration are not enabled.
