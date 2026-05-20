---
title: "El recorte de paquetes NuGet está activado por defecto en .NET 10"
description: "El recorte de paquetes NuGet llegó activado por defecto para proyectos net10.0, reduciendo los reportes de vulnerabilidades transitivas en un 70% y los tiempos de restore hasta en un 50%."
pubDate: 2026-05-20
tags:
  - "dotnet"
  - "dotnet-10"
  - "nuget"
  - "security"
lang: "es"
translationOf: "2026/05/nuget-package-pruning-default-net-10"
translatedBy: "claude"
translationDate: 2026-05-20
---

Nikolche Kolev [anunció](https://devblogs.microsoft.com/dotnet/nuget-package-pruning-in-dotnet-10/) que el recorte de paquetes NuGet está habilitado por defecto para cualquier proyecto que tenga como destino `net10.0` o posterior. El cambio se envía en el SDK de .NET 10 y restablece un valor por defecto que ha estado causando silenciosamente una salida ruidosa de `dotnet list package --vulnerable` durante años: las bibliotecas del runtime ya están en el framework compartido, así que listarlas otra vez como dependencias de NuGet solo crea CVE fantasma.

## Qué elimina realmente el recorte

El SDK de .NET incluye un manifiesto por target framework de los paquetes que el runtime ya proporciona, junto con la versión más alta que suministra cada framework. Durante el restore, NuGet descarta cualquier paquete transitivo cuya versión esté igual o por debajo de la del runtime. Las referencias directas no se eliminan, pero se reescriben con `PrivateAssets='all'` e `IncludeAssets='none'` para que gane la copia del runtime, y NuGet emite la nueva advertencia **NU1510** cuando la referencia es completamente redundante.

El blog cita dos cifras concretas: 70% menos reportes de vulnerabilidades transitivas para proyectos con los nuevos valores por defecto, y hasta un 50% menos de tiempo de restore por proyecto una vez que el grafo deja de perseguir paquetes que el runtime ya posee.

## Qué está activado por defecto

En un proyecto `net10.0`, el SDK ahora se comporta como si hubieras escrito:

```xml
<PropertyGroup>
  <RestoreEnablePackagePruning>true</RestoreEnablePackagePruning>
  <NuGetAuditMode>all</NuGetAuditMode>
</PropertyGroup>
```

`NuGetAuditMode=all` también cambia de `direct` a `all`, así que el conjunto transitivo restante sigue siendo auditado. El recorte y la auditoría están diseñados para componerse: el recorte reduce el grafo a lo que realmente se envía sobre el runtime, y la auditoría se ejecuta sobre ese grafo más pequeño.

En un proyecto multi-target, si algún TFM es `net10.0` o posterior, el recorte se aplica a cada TFM del proyecto. Esto evita la sorpresa de que una cabeza haga restore de forma distinta a otra silenciosamente.

## Un antes / después concreto

Un patrón común es una aplicación de consola que trae `Microsoft.Extensions.AI` y `NuGet.Protocol`. En .NET 9 verías aparecer `System.Formats.Asn1 6.0.0` en la salida de auditoría a través de una ruta transitiva profunda, aunque `net10.0` envía un `System.Formats.Asn1` más nuevo en el framework compartido. Después de actualizar el TFM:

```xml
<TargetFramework>net10.0</TargetFramework>
```

`System.Formats.Asn1`, `System.Diagnostics.DiagnosticSource`, `System.Text.Json` y `System.Threading.Channels` desaparecen del grafo resuelto. Sus entradas de CVE dejan de aparecer en `dotnet list package --vulnerable` porque, en primer lugar, nunca se iban a cargar en tiempo de ejecución.

## Desactivarlo

Existen las dos vías de escape:

```xml
<PropertyGroup>
  <RestoreEnablePackagePruning>false</RestoreEnablePackagePruning>
  <NuGetAuditMode>direct</NuGetAuditMode>
</PropertyGroup>
```

Harías eso en una biblioteca que genuinamente necesita enviar su propio `System.Text.Json` para consumidores de versiones anteriores, o en un job de CI que todavía tiene herramientas ancladas a un SDK previo a la versión 10 que lee el lock file.

Si has estado cargando con `<NoWarn>NU1903;NU1904</NoWarn>` para silenciar advertencias de vulnerabilidades transitivas en paquetes del framework compartido, esta es la versión donde toca borrarlo. Sube el TFM, ejecuta restore una vez y revisa si el reporte de auditoría se redujo.
