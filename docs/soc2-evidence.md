# SOC 2 control-to-evidence preparation

This is an engineering mapping, not a certification, attestation, complete control framework or conclusion about operating effectiveness. Criteria references use the [AICPA Trust Services Criteria](https://www.aicpa-cima.com/resources/download/2017-trust-services-criteria-with-revised-points-of-focus-2022). The associations below are implementation interpretations; organizational policy and sustained operational evidence remain necessary.

| Criteria            | Application evidence                                                                                            | Operational evidence required                                                                    |
| ------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| CC6.1, CC6.2, CC6.3 | BFF sessions, role/audience validation, ownership/CSRF tests, Secret references                                 | Access approvals, periodic access reviews, role/credential lifecycle records                     |
| CC6.6, CC6.7        | TLS-only production config, re-encrypt Route, network policies, client encryption and data-flow specification   | Actual TLS/egress tests, ingress logging review, transmission controls and provider scope review |
| CC6.8               | Locally bundled assets, CSP, no previews, immutable package validation, pinned dependencies/SBOM                | Image scanning, endpoint controls, dependency response process                                   |
| CC7.2, CC7.3        | Allowlisted audit, cleanup metrics/alerts, negative tests and fixed error handling                              | Working alert routes, event review records, canary/log inspection results                        |
| CC7.4, CC7.5        | Emergency retrieval fence, revocation, cleanup and safe-restore procedures                                      | Incident exercises, response approvals, measured recovery/reconciliation evidence                |
| CC8.1               | Protocol-first decisions, lockfiles, golden fixtures, CI example and test reports                               | Reviewed changes, protected release process, artifact provenance and authorized deployments      |
| A1.1, A1.2, A1.3    | Explicit size limits, benchmarks, resource limits, daily logical backup and restore invalidation tests          | Capacity/SLO measurements, backup success/retention, native restore RTO/RPO drills               |
| C1.1, C1.2          | Sensitivity inventory, ciphertext-only storage, no persistent addresses/keys, deletion/retention implementation | Classification ownership, backing-store backup exclusions, verified retention/deletion outcomes  |

Evidence should retain its collection time, software/image version, environment, operator, test scope and limitations. Source/tests alone do not demonstrate a control operated over an audit period. Recipient transfers must never be represented as proof that a document was read.
