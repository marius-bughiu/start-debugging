---
title: ".NET 10 en Ubuntu 26.04: tags de contenedor resolute y Native AOT en el archive"
description: "Ubuntu 26.04 Resolute Raccoon incluye .NET 10 en el archive, introduce los tags de contenedor -resolute para reemplazar -noble, y empaqueta el herramental de Native AOT vía dotnet-sdk-aot-10.0."
pubDate: 2026-04-24
tags:
  - "dotnet"
  - "dotnet-10"
  - "ubuntu"
  - "containers"
  - "native-aot"
  - "linux"
lang: "es"
translationOf: "2026/04/dotnet-10-ubuntu-2604-resolute-container-tags"
translatedBy: "claude"
translationDate: 2026-04-24
---

Ubuntu 26.04 "Resolute Raccoon" llegó a disponibilidad general el 23 de abril de 2026, y el equipo de Microsoft .NET publicó la entrada de blog acompañante el mismo día. Lo destacado es que .NET 10 está en el archive de la distro desde el día uno, el nombrado de tags de contenedor rotó, y Native AOT finalmente obtiene un paquete apt propio. Si corres .NET en Linux, esta es la release que cambia cómo se ven tus líneas `FROM` durante los próximos dos años.

## Resolute reemplaza a noble en los tags de contenedor

A partir de .NET 10, los tags de contenedor por defecto referencian imágenes de Ubuntu en lugar de Debian. Con 26.04 disponible, Microsoft agregó una nueva variante basada en Ubuntu 26.04 bajo el tag `resolute`. La migración es mecánica:

```dockerfile
# Before
FROM mcr.microsoft.com/dotnet/aspnet:10.0-noble

# After
FROM mcr.microsoft.com/dotnet/aspnet:10.0-resolute
```

Las imágenes `noble` siguen existiendo y continúan recibiendo actualizaciones base de 24.04, así que no hay un corte forzado. Las variantes `chiseled` avanzan al unísono: `10.0-resolute-chiseled` se publica junto a la imagen completa. Si ya estabas sobre imágenes chiseled noble para despliegues estilo distroless, la actualización es un swap de tag y un rebuild.

## Instalar .NET 10 desde el archive

No se necesita ningún feed de paquetes de Microsoft en 26.04. El archive de Ubuntu trae el SDK directamente:

```bash
sudo apt update
sudo apt install dotnet-sdk-10.0
```

.NET 10 es LTS, así que la versión del archive recibe servicing de seguridad a través de Ubuntu hasta el fin de vida de la distro. Eso importa para entornos endurecidos que bloquean fuentes apt de terceros.

## Native AOT como paquete apt de primera clase

Este es el cambio silencioso pero importante. Hasta 26.04, compilar con Native AOT en Ubuntu significaba instalar `clang`, `zlib1g-dev`, y las piezas de toolchain correctas por tu cuenta. El archive de 26.04 ahora incluye `dotnet-sdk-aot-10.0`, que trae las piezas del linker que el target `PublishAot` del SDK espera.

```bash
sudo apt install -y dotnet-sdk-aot-10.0 clang
dotnet publish -c Release -r linux-x64
```

Microsoft cita un binario de 1.4 MB para una app hello-world con un arranque en frío de 3 ms, y un binario self-contained de 13 MB para un servicio web mínimo. Las cifras de tamaño y arranque son familiares para quien haya usado AOT desde .NET 8, pero que salgan de un único `apt install` sobre un LTS estándar es nuevo.

## .NET 8 y 9 vía dotnet-backports

Si aún no estás listo para reconstruir sobre 10, la PPA `dotnet-backports` es el camino soportado para versiones más viejas todavía en soporte sobre 26.04:

```bash
sudo apt install -y software-properties-common
sudo add-apt-repository ppa:dotnet/backports
sudo apt install dotnet-sdk-9.0
```

Microsoft llama a esto soporte best-effort, así que trátalo como un puente más que como un plan de largo plazo. Que Ubuntu 26.04 tuviera .NET 10 listo el día del lanzamiento vino de correr CI de `dotnet/runtime` contra Ubuntu 26.04 desde finales de 2025. Si quieres seguir la mecánica, la [entrada oficial del blog de .NET](https://devblogs.microsoft.com/dotnet/whats-new-for-dotnet-in-ubuntu-2604/) tiene la historia completa.
