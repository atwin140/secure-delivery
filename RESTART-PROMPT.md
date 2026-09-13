# Restart prompt

Open `~/GIT/secure-delivery` (or a clone of [atwin140/secure-delivery](https://github.com/atwin140/secure-delivery)) as the assistant's working directory. Copy the prompt below, replace the final task line, and provide a kubeconfig separately only if cluster work is needed.

```text
Resume work on Docs signed by Sharkbait from this repository:
https://github.com/atwin140/secure-delivery
The original workstation checkout is ~/GIT/secure-delivery (branch main).

Read AGENTS.md, CONTEXT.md, README.md and docs/rebuild.md first. Inspect
git status and preserve existing changes. Then read the implementation and
the relevant protocol, architecture or operations documents for my task.
Use the checked-in source and lockfile; do not regenerate the application.

The current deployment reference is ACM OpenShift, namespace docs,
https://docs.apps.acm.sharkbait.tech. The Keycloak realm and client are docs;
sender-a and sender-b require the repository-sender client role. On the
original workstation the kubeconfig is ~/acm-kubeconfig. Verify the actual
target and live state before cluster work; historical evidence is not a
current health check. The old secure-delivery-test namespace is separate.

Preserve the Docs branding, browser-only crypto and frozen v1 format,
full verification before plaintext output, verified TLS with cert-manager,
role/ownership enforcement, retention rules and safe restore invalidation.
Keep credentials, kubeconfigs, private keys, data dumps and runtime files
outside Git. Keep email disabled unless I explicitly request enabling it.

Carry my task through implementation and appropriate verification. For
local work, use the local workflow. For a deployment I request, choose the
fresh-install or existing-release procedure from docs/rebuild.md; retain
existing sender credentials unless I ask to reset them. A restore must use
the separate recovery procedure. Do not bootstrap over an existing service.

Update the context and relevant guide if project facts change. Report
changed files, tests actually run, any unverified steps and the next action.

My task: [describe the change, local rebuild, deployment update or recovery]
```

Example task lines:

- `Rebuild and run this checkout locally, then verify the sender/recipient workflow.`
- `Deploy the current source to the existing ACM docs namespace using ~/acm-kubeconfig. Preserve accounts and storage, and verify the new release.`
- `Prepare a fresh ACM docs installation from this checkout. Inspect prerequisites and tell me which protected account or identity backups are available before choosing how to preserve accounts.`

For a completely different cluster, provide its namespace, hostnames, storage classes, cert-manager issuer and kubeconfig location with the task.
