---
title: "Spam de solicitudes “become owner” en NuGet: qué hacer (y qué cerrar) en .NET 9/.NET 10"
description: "Defiende tus paquetes .NET contra el spam de solicitudes de propiedad en NuGet. Lock files, Package Source Mapping y prácticas de Central Package Management para .NET 9 y .NET 10."
pubDate: 2026-01-23
tags:
  - "dotnet"
lang: "es"
translationOf: "2026/01/nuget-become-owner-request-spam-what-to-do-and-what-to-lock-down-in-net-9-net-10"
translatedBy: "claude"
translationDate: 2026-04-29
---
Un hilo de las últimas 48 horas advierte sobre solicitudes sospechosas de "become owner" en NuGet.org, supuestamente enviadas a gran escala a mantenedores de paquetes: [https://www.reddit.com/r/dotnet/comments/1qf9lnp/nuget\_gallery\_supply\_chain\_attack/](https://www.reddit.com/r/dotnet/comments/1qf9lnp/nuget_gallery_supply_chain_attack/).

Incluso si los detalles cambian para mañana, la checklist defensiva es estable. La meta es simple: reducir la chance de que un cambio inesperado de propiedad se convierta en una dependencia comprometida en tus apps de .NET 9/.NET 10.

## Trata las solicitudes de propiedad como un evento de seguridad, no como una notificación

Si mantienes paquetes:

-   **No aceptes** invitaciones inesperadas a co-propiedad, aunque el remitente parezca "legítimo".
-   **Verifica fuera de banda**: si reconoces a la persona u organización, contáctalos por un canal conocido (no por el mensaje de la invitación).
-   **Reporta** la actividad sospechosa al soporte de NuGet.org con marcas de tiempo e IDs de paquete.

Si consumes paquetes, asume que los errores pasan y haz que tu build sea resistente a sorpresas upstream.

## Bloquea el grafo de dependencias para que las "actualizaciones sorpresa" no entren solas

Si no estás usando lock files, deberías. Los lock files hacen que los restores sean deterministas, que es lo que quieres cuando un ecosistema de dependencias está ruidoso.

Habilita los lock files en tu repo (funciona con `dotnet restore`):

```xml
<!-- Directory.Build.props -->
<Project>
  <PropertyGroup>
    <RestorePackagesWithLockFile>true</RestorePackagesWithLockFile>
    <!-- Optional: make CI fail if the lock file would change -->
    <RestoreLockedMode Condition="'$(CI)' == 'true'">true</RestoreLockedMode>
  </PropertyGroup>
</Project>
```

Luego genera el `packages.lock.json` inicial una vez por proyecto (localmente), commitéalo y deja que CI lo haga cumplir.

## Reduce la dispersión de fuentes con Package Source Mapping

Un footgun común es tener "cualquier fuente NuGet que esté configurada" en juego. Package Source Mapping fuerza a que cada patrón de ID de paquete venga de un feed específico.

Ejemplo mínimo de `nuget.config`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <add key="nuget.org" value="https://api.nuget.org/v3/index.json" />
    <add key="ContosoInternal" value="https://pkgs.dev.azure.com/contoso/_packaging/contoso/nuget/v3/index.json" />
  </packageSources>

  <packageSourceMapping>
    <packageSource key="nuget.org">
      <package pattern="Microsoft.*" />
      <package pattern="System.*" />
      <package pattern="Newtonsoft.Json" />
    </packageSource>
    <packageSource key="ContosoInternal">
      <package pattern="Contoso.*" />
    </packageSource>
  </packageSourceMapping>
</configuration>
```

Ahora un atacante no puede "ganar" colando un paquete con el mismo nombre en un feed distinto que olvidaste que existía.

## Haz que las actualizaciones sean intencionales

Para bases de código en .NET 9 y .NET 10, la mejor postura "del día a día" es aburrida:

-   Fija versiones (o usa Central Package Management) y actualiza vía PRs.
-   Revisa los diffs de dependencias como diffs de código.
-   Evita versiones flotantes en apps de producción salvo que tengas una razón fuerte y monitoreo fuerte.

El hilo original de discusión está aquí: [https://www.reddit.com/r/dotnet/comments/1qf9lnp/nuget\_gallery\_supply\_chain\_attack/](https://www.reddit.com/r/dotnet/comments/1qf9lnp/nuget_gallery_supply_chain_attack/). Si mantienes paquetes, vale la pena revisar las notificaciones de tu cuenta de NuGet y auditar cualquier cambio reciente de propiedad hoy mismo.
