---
title: "¿.NET 10 hizo explotar tu lista de NICs? Filtrar GetAllNetworkInterfaces() sin engañarte a ti mismo"
description: "Cómo filtrar GetAllNetworkInterfaces() en .NET 10 cuando los adaptadores virtuales de Hyper-V, Docker, WSL y VPNs inundan la lista. Incluye un filtro en dos etapas con compensaciones explícitas."
pubDate: 2026-01-08
tags:
  - "dotnet"
  - "dotnet-10"
lang: "es"
translationOf: "2026/01/net-10-made-your-nic-list-explode-filtering-getallnetworkinterfaces-without-lying-to-yourself"
translatedBy: "claude"
translationDate: 2026-04-30
---
Si acabas de migrar una app de .NET 8 a .NET 10 y de pronto `NetworkInterface.GetAllNetworkInterfaces()` devuelve 80 adaptadores en vez de 10, no lo estás imaginando. Esto apareció en un hilo del 7 de enero de 2026, con exactamente el tipo de dolor del mundo real que hace que cambios de comportamiento "menores" se sientan como cambios disruptivos: interfaces virtuales de Hyper-V, Docker, WSL, VPNs, loopback y otros adaptadores del sistema empiezan a desplazar a los dispositivos Ethernet y Wi-Fi "reales".

Fuente: [NetworkInterface.GetAllNetworkInterfaces breaking change (r/dotnet)](https://www.reddit.com/r/dotnet/comments/1q6ippd/networkinterfacegetallnetworkinterfaces_breaking/)

## La verdad incómoda: "físico" es una heurística

`System.Net.NetworkInformation` no te da un único booleano oficial del estilo "esto es una NIC física" en el que puedas confiar entre máquinas, drivers y características de Windows. La estrategia más segura es **construir un filtro que se ajuste a las necesidades de tu producto**, y hacer ese filtro auditable y testeable.

Empieza con señales estrictas que normalmente correlacionan con "útil para conectividad":

-   `OperationalStatus.Up`
-   tipo de interfaz (`Ethernet`, `Wireless80211`, etc.)
-   presencia de direcciones unicast IPv4/IPv6, gateway o servidores DNS (según tu caso de uso)

Luego agrega exclusiones más blandas y específicas del entorno (Docker, Hyper-V, WSL, VPN) como segunda etapa.

## Un filtro en dos etapas que es explícito sobre las compensaciones

El hilo propuso este enfoque (recortado y algo endurecido por legibilidad):

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

¿Es chapucero? Sí. Pero también es honesto: reconoce que estás codificando una política.

Para hacerlo menos frágil, evita depender solo de strings:

-   Revisa `nic.GetIPProperties().UnicastAddresses` e ignora interfaces sin dirección enrutable para tu escenario.
-   Considera si requieres un gateway por defecto (`GatewayAddresses`) o servidores DNS (`DnsAddresses`).
-   Registra lo que filtraste (tipo, descripción, id) para poder ajustar cuando aparezca un driver o cliente de VPN nuevo.

## Depúralo como un incidente de producción, no como una curiosidad

Cuando tu conteo de adaptadores cambia entre versiones de .NET, trátalo como una diferencia de comportamiento observable:

-   Captura una instantánea de antes/después (tipo, estado, descripción, id, propiedades IP).
-   Escribe un pequeño arnés tipo unit test que afirme "esta máquina debería producir al menos un candidato Wi-Fi o Ethernet".
-   Si el comportamiento es un cambio de plataforma/runtime, busca una issue existente o abre una con un repro mínimo.

.NET 10 te da la lista cruda. Tu app sigue teniendo que decidir qué significa "real".
