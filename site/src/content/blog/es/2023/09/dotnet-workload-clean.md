---
title: "dotnet workload clean"
description: "Usa el comando `dotnet workload clean` para eliminar packs de workload de .NET sobrantes tras una actualización del SDK o de Visual Studio: cuándo usarlo, qué elimina y aspectos a tener en cuenta."
pubDate: 2023-09-04
tags:
  - "dotnet"
  - "dotnet-8"
lang: "es"
translationOf: "2023/09/dotnet-workload-clean"
translatedBy: "claude"
translationDate: 2026-05-01
---
Nota: este comando solo está disponible a partir de .NET 8.

Este comando limpia packs de workload que pueden quedar tras una actualización del SDK de .NET o de Visual Studio. Puede ser útil cuando aparecen problemas al gestionar workloads.

`dotnet workload clean` eliminará packs huérfanos resultantes de desinstalar SDKs de .NET. El comando no tocará los workloads instalados por Visual Studio, pero te proporcionará una lista de workloads que deberías limpiar a mano.

Los workloads de dotnet se encuentran en: `{DOTNET ROOT}/metadata/workloads/installedpacks/v1/{pack-id}/{pack-version}/`. Un archivo `{sdk-band}` dentro de la carpeta de registro de instalación lleva un contador de referencia, de modo que cuando no hay un archivo sdk-band bajo la carpeta de un workload, sabemos que el paquete del workload no está en uso y se puede eliminar del disco con seguridad.

## dotnet workload clean --all

Aunque en su configuración por defecto el comando solo elimina los workloads huérfanos, al pasar el argumento `--all` le indicamos que limpie todos los packs de la máquina, excepto los instalados por Visual Studio. También eliminará todos los registros de instalación de workloads.
