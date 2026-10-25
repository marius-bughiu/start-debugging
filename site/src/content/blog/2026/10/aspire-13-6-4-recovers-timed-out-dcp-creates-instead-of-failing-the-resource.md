---
title: "Aspire 13.6.4 recovers timed-out DCP creates instead of failing the resource"
description: "Aspire 13.6.4 stops a single timed-out or HTTP 504 DCP create call from sending a resource to FailedToStart, and exposes three DcpPublisher timeouts you can raise on slow CI runners."
pubDate: 2026-10-25
tags:
  - "aspire"
  - "dotnet"
  - "ci"
---

If your Aspire 13.6 AppHost has been randomly failing on CI with a resource stuck in `FailedToStart`, [Aspire 13.6.4](https://github.com/microsoft/aspire/releases/tag/v13.6.4), released on October 24, 2026, is the patch you want. It changes how the AppHost talks to the Developer Control Plane (DCP) when a create call does not come back in time, and it finally lets you tune those timeouts.

## One slow create call was enough to kill a resource

Since 13.6.0, a single `Create` request to DCP's API server that timed out or returned HTTP 504 was not retried. The resource went straight to `FailedToStart`, and everything that `WaitFor`ed it failed with "Stopped waiting for resource ... because it failed to start." The report in [microsoft/aspire#20691](https://github.com/microsoft/aspire/issues/20691) came from GitHub-hosted `macos-15-intel` runners with 2 vCPUs, where the last project in the graph started while its dependencies were still spinning up. The logs showed either a Polly `TimeoutRejectedException` after the 20 second client budget or a `GatewayTimeout` from DCP after about 34 seconds.

The nasty part is that a timeout does not mean the create failed. DCP may have committed the object a moment after the client gave up, so a blind retry is not safe either.

## Confirm first, then retry the same object

The fix in [#20752](https://github.com/microsoft/aspire/pull/20752) (backported in [#20868](https://github.com/microsoft/aspire/pull/20868)) treats a timed-out, 502, 503, 504 or 429 create as ambiguous. Before retrying, the AppHost issues a `GET` for the same named object. If DCP already created it, that object is used and the resource carries on starting. If the `GET` returns 404, the create is retried with jittered backoff capped at 5 seconds. An "already exists" answer on a retry is also accepted, since the earlier attempt may have landed after the confirmation check. The `GET` matters because it bypasses the API server's publication lock that a second `POST` could block behind.

The KubernetesClient package's own 100 second `HttpClientTimeout` is now disabled, so it can no longer cut a configured budget short and surface as an unrelated cancellation.

## Three knobs under DcpPublisher

The budgets are now regular options on the AppHost configuration:

| Key | Default | Purpose |
| --- | --- | --- |
| `DcpPublisher:KubernetesApiTimeout` | 40 s | Per API operation |
| `DcpPublisher:KubernetesInitializationAdditionalTimeout` | 20 s | Added until the first successful operation |
| `DcpPublisher:KubernetesCreateRecoveryTimeout` | 2 min | Total budget for recovering one create |

Each value must be between one second and ten minutes, and the API plus initialization timeouts together cannot exceed ten minutes, otherwise options validation fails at startup. Established watch and log streams are not subject to these limits.

On a constrained runner, raise them in the AppHost's `appsettings.json`:

```json
{
  "DcpPublisher": {
    "KubernetesApiTimeout": "00:01:30",
    "KubernetesInitializationAdditionalTimeout": "00:00:45",
    "KubernetesCreateRecoveryTimeout": "00:05:00"
  }
}
```

Or keep the repo defaults and set them only in the CI workflow, since environment variables bind through `IConfiguration` too:

```yaml
env:
  DcpPublisher__KubernetesApiTimeout: "00:01:30"
  DcpPublisher__KubernetesCreateRecoveryTimeout: "00:05:00"
```

To upgrade, bump the `Aspire.AppHost.Sdk` version and the `Aspire.Hosting.*` packages to `13.6.4`. The same release also restricts CLI diagnostic logs on Unix to `0600` files in a `0700` directory, because those logs can contain dashboard login URLs. If you are catching up on the 13.6 line, the [dashboard run history post](/2026/09/aspire-13-6-dashboard-keeps-your-last-ten-runs/) covers the headline feature of that release.
