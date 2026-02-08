---
title: ".NET 10 made your NIC list explode? Filtering GetAllNetworkInterfaces() without lying to yourself"
description: "If you just migrated an app from .NET 8 to .NET 10 and suddenly NetworkInterface.GetAllNetworkInterfaces() returns 80 adapters instead of 10, you are not imagining it. This popped up in a Jan 7, 2026 thread, with exactly the kind of real-world pain that makes “minor” behavior changes feel like breaking changes: virtual interfaces from Hyper-V,…"
pubDate: 2026-01-08
tags:
  - "net"
  - "net-10"
---
If you just migrated an app from .NET 8 to .NET 10 and suddenly `NetworkInterface.GetAllNetworkInterfaces()` returns 80 adapters instead of 10, you are not imagining it. This popped up in a Jan 7, 2026 thread, with exactly the kind of real-world pain that makes “minor” behavior changes feel like breaking changes: virtual interfaces from Hyper-V, Docker, WSL, VPNs, loopback, and other system adapters start crowding out the “real” Ethernet and Wi-Fi devices.

Source: [NetworkInterface.GetAllNetworkInterfaces breaking change (r/dotnet)](https://www.reddit.com/r/dotnet/comments/1q6ippd/networkinterfacegetallnetworkinterfaces_breaking/)

### The uncomfortable truth: “physical” is a heuristic

`System.Net.NetworkInformation` does not give you a single, official “this is a physical NIC” boolean you can trust across machines, drivers, and Windows features. The safest strategy is to **build a filter that matches your product needs**, and to make that filter auditable and testable.

Start with strict signals that usually correlate with “useful for connectivity”:

-   `OperationalStatus.Up`
-   interface type (`Ethernet`, `Wireless80211`, etc.)
-   presence of IPv4/IPv6 unicast addresses, gateway, or DNS servers (depending on your use case)

Then add softer, environment-specific exclusions (Docker, Hyper-V, WSL, VPN) as a second stage.

### A two-stage filter that is explicit about tradeoffs

The thread proposed this approach (trimmed and slightly hardened for readability):

```cs
using System.Net.NetworkInformation;

var candidates = NetworkInterface.GetAllNetworkInterfaces()
    .Where(nic => nic.OperationalStatus == OperationalStatus.Up)
    .Where(nic => nic.NetworkInterfaceType is
        NetworkInterfaceType.Ethernet or
        NetworkInterfaceType.Wireless80211 or
        NetworkInterfaceType.GigabitEthernet)
    .Where(nic => !LooksVirtual(nic))
    .ToArray();

static bool LooksVirtual(NetworkInterface nic)
{
    var desc = (nic.Description ?? "").ToLowerInvariant();
    var name = (nic.Name ?? "").ToLowerInvariant();

    string[] keywords =
    {
        "virtual", "hyper-v", "vmware", "virtualbox",
        "docker", "vpn", "tap-", "wsl", "pseudo"
    };

    return keywords.Any(k => desc.Contains(k) || name.Contains(k));
}
```

Is it hacky? Yes. But it is also honest: it acknowledges that you are encoding policy.

If you want to make it less fragile, avoid relying only on strings:

-   Check `nic.GetIPProperties().UnicastAddresses` and ignore interfaces with no routable address for your scenario.
-   Consider whether you require a default gateway (`GatewayAddresses`) or DNS servers (`DnsAddresses`).
-   Log what you filtered out (type, description, id) so you can adjust when a new driver or VPN client shows up.

### Debug it like a production incident, not a curiosity

When your adapter count changes across .NET versions, treat it like an observable behavior difference:

-   Capture a before/after snapshot (type, status, description, id, IP properties).
-   Write a small unit-test-like harness that asserts “this machine should produce at least one Wi-Fi or Ethernet candidate”.
-   If the behavior is a platform/runtime change, search for an issue or file one with a minimal repro.

.NET 10 gives you the raw list. Your app still has to decide what “real” means.
