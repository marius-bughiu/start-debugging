---
title: "O .NET 10 explodiu sua lista de NICs? Filtrando GetAllNetworkInterfaces() sem se enganar"
description: "Como filtrar GetAllNetworkInterfaces() no .NET 10 quando adaptadores virtuais de Hyper-V, Docker, WSL e VPNs lotam a lista. Inclui um filtro em duas etapas com trade-offs explícitos."
pubDate: 2026-01-08
tags:
  - "dotnet"
  - "dotnet-10"
lang: "pt-br"
translationOf: "2026/01/net-10-made-your-nic-list-explode-filtering-getallnetworkinterfaces-without-lying-to-yourself"
translatedBy: "claude"
translationDate: 2026-04-30
---
Se você acabou de migrar uma app de .NET 8 para .NET 10 e de repente `NetworkInterface.GetAllNetworkInterfaces()` retorna 80 adaptadores em vez de 10, não é impressão sua. Isso apareceu em uma thread de 7 de janeiro de 2026, com exatamente o tipo de dor do mundo real que faz mudanças de comportamento "menores" parecerem breaking changes: interfaces virtuais de Hyper-V, Docker, WSL, VPNs, loopback e outros adaptadores do sistema começam a abafar os dispositivos Ethernet e Wi-Fi "reais".

Fonte: [NetworkInterface.GetAllNetworkInterfaces breaking change (r/dotnet)](https://www.reddit.com/r/dotnet/comments/1q6ippd/networkinterfacegetallnetworkinterfaces_breaking/)

## A verdade incômoda: "físico" é heurística

`System.Net.NetworkInformation` não te dá um único booleano oficial do tipo "isso é uma NIC física" no qual dê para confiar entre máquinas, drivers e features do Windows. A estratégia mais segura é **construir um filtro que se ajuste às necessidades do seu produto**, e tornar esse filtro auditável e testável.

Comece com sinais estritos que normalmente correlacionam com "útil para conectividade":

-   `OperationalStatus.Up`
-   tipo de interface (`Ethernet`, `Wireless80211`, etc.)
-   presença de endereços unicast IPv4/IPv6, gateway ou servidores DNS (dependendo do seu caso de uso)

Depois adicione exclusões mais flexíveis e específicas do ambiente (Docker, Hyper-V, WSL, VPN) como segunda etapa.

## Um filtro em duas etapas que é explícito sobre os trade-offs

A thread propôs esta abordagem (cortada e levemente reforçada para legibilidade):

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

É gambiarra? Sim. Mas também é honesto: reconhece que você está codificando uma política.

Para deixar isso menos frágil, evite depender só de strings:

-   Verifique `nic.GetIPProperties().UnicastAddresses` e ignore interfaces sem endereço roteável para o seu cenário.
-   Considere se você exige um gateway padrão (`GatewayAddresses`) ou servidores DNS (`DnsAddresses`).
-   Logue o que você filtrou fora (tipo, descrição, id) para conseguir ajustar quando um driver ou cliente VPN novo aparecer.

## Depure como um incidente de produção, não como curiosidade

Quando a sua contagem de adaptadores muda entre versões do .NET, trate como uma diferença de comportamento observável:

-   Capture um snapshot de antes/depois (tipo, status, descrição, id, propriedades IP).
-   Escreva um pequeno harness em estilo unit test que afirme "esta máquina deve produzir pelo menos um candidato Wi-Fi ou Ethernet".
-   Se o comportamento for uma mudança de plataforma/runtime, procure uma issue existente ou abra uma com um repro mínimo.

O .NET 10 te dá a lista crua. A sua app ainda precisa decidir o que significa "real".
