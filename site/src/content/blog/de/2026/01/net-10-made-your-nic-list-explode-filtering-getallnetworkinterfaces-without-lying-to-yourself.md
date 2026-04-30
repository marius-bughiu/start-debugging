---
title: ".NET 10 hat Ihre NIC-Liste explodieren lassen? GetAllNetworkInterfaces() filtern, ohne sich selbst zu belügen"
description: "Wie Sie GetAllNetworkInterfaces() in .NET 10 filtern, wenn virtuelle Adapter von Hyper-V, Docker, WSL und VPNs die Liste fluten. Inklusive eines zweistufigen Filters mit expliziten Trade-offs."
pubDate: 2026-01-08
tags:
  - "dotnet"
  - "dotnet-10"
lang: "de"
translationOf: "2026/01/net-10-made-your-nic-list-explode-filtering-getallnetworkinterfaces-without-lying-to-yourself"
translatedBy: "claude"
translationDate: 2026-04-30
---
Wenn Sie gerade eine App von .NET 8 nach .NET 10 migriert haben und `NetworkInterface.GetAllNetworkInterfaces()` plötzlich 80 Adapter statt 10 zurückgibt, bilden Sie sich das nicht ein. Das tauchte in einem Thread vom 7. Januar 2026 auf, mit genau der Art von realer Schmerzgrenze, die "kleine" Verhaltensänderungen wie Breaking Changes wirken lässt: virtuelle Schnittstellen von Hyper-V, Docker, WSL, VPNs, Loopback und anderen Systemadaptern beginnen, die "echten" Ethernet- und Wi-Fi-Geräte zu verdrängen.

Quelle: [NetworkInterface.GetAllNetworkInterfaces breaking change (r/dotnet)](https://www.reddit.com/r/dotnet/comments/1q6ippd/networkinterfacegetallnetworkinterfaces_breaking/)

## Die unbequeme Wahrheit: "physisch" ist eine Heuristik

`System.Net.NetworkInformation` liefert Ihnen kein einzelnes, offizielles "das ist eine physische NIC"-Boolean, dem Sie über Maschinen, Treiber und Windows-Features hinweg vertrauen können. Die sicherste Strategie ist, **einen Filter zu bauen, der zu den Anforderungen Ihres Produkts passt**, und diesen Filter prüfbar und testbar zu halten.

Beginnen Sie mit strengen Signalen, die meist mit "nützlich für Konnektivität" korrelieren:

-   `OperationalStatus.Up`
-   Schnittstellentyp (`Ethernet`, `Wireless80211`, etc.)
-   Vorhandensein von IPv4-/IPv6-Unicast-Adressen, Gateway oder DNS-Servern (je nach Anwendungsfall)

Fügen Sie dann weichere, umgebungsspezifische Ausschlüsse (Docker, Hyper-V, WSL, VPN) als zweite Stufe hinzu.

## Ein zweistufiger Filter, der seine Trade-offs offen legt

Der Thread schlug diesen Ansatz vor (zur Lesbarkeit gekürzt und leicht gehärtet):

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

Ist es gehackt? Ja. Aber es ist auch ehrlich: Es räumt ein, dass Sie hier Policy kodieren.

Um es weniger fragil zu machen, verlassen Sie sich nicht nur auf Strings:

-   Prüfen Sie `nic.GetIPProperties().UnicastAddresses` und ignorieren Sie Interfaces ohne routbare Adresse für Ihr Szenario.
-   Überlegen Sie, ob Sie ein Standardgateway (`GatewayAddresses`) oder DNS-Server (`DnsAddresses`) brauchen.
-   Loggen Sie, was Sie herausgefiltert haben (Typ, Beschreibung, ID), damit Sie nachjustieren können, wenn ein neuer Treiber oder VPN-Client auftaucht.

## Debuggen Sie es wie einen Produktionsvorfall, nicht wie eine Kuriosität

Wenn sich Ihre Adapterzahl zwischen .NET-Versionen ändert, behandeln Sie das wie einen beobachtbaren Verhaltensunterschied:

-   Erfassen Sie einen Vorher/Nachher-Snapshot (Typ, Status, Beschreibung, ID, IP-Eigenschaften).
-   Schreiben Sie ein kleines Unit-Test-artiges Gerüst, das prüft: "Diese Maschine sollte mindestens einen Wi-Fi- oder Ethernet-Kandidaten produzieren."
-   Ist das Verhalten eine Plattform-/Runtime-Änderung, suchen Sie nach einem Issue oder eröffnen Sie eines mit einem minimalen Repro.

.NET 10 gibt Ihnen die rohe Liste. Ihre App muss weiterhin entscheiden, was "echt" bedeutet.
