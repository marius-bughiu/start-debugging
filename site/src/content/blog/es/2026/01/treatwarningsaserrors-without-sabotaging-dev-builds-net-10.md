---
title: "TreatWarningsAsErrors sin sabotear las compilaciones de dev (.NET 10)"
description: "Cómo aplicar TreatWarningsAsErrors en compilaciones Release y CI manteniendo Debug flexible para el desarrollo local en .NET 10, usando Directory.Build.props."
pubDate: 2026-01-23
tags:
  - "dotnet"
  - "dotnet-10"
lang: "es"
translationOf: "2026/01/treatwarningsaserrors-without-sabotaging-dev-builds-net-10"
translatedBy: "claude"
translationDate: 2026-04-29
---
Si alguna vez activaste `TreatWarningsAsErrors` a `true` y te arrepentiste de inmediato, no eres el único. Un hilo reciente en r/dotnet que está dando vueltas sugiere un ajuste simple: forzar código sin warnings en Release (y en CI), pero dejar Debug flexible para exploración local: [https://www.reddit.com/r/dotnet/comments/1qjum3h/treating_warnings_as_errors_in_dotnet_the_right/](https://www.reddit.com/r/dotnet/comments/1qjum3h/treating_warnings_as_errors_in_dotnet_the_right/)

## Aplicarlo solo en Release es una política, no un interruptor

Lo que en realidad estás intentando lograr es un flujo de trabajo:

-   Los desarrolladores pueden experimentar localmente sin pelearse con el ruido del analizador.
-   Los pull requests fallan si se cuelan nuevos warnings.
-   Aún tienes un camino para ir subiendo el nivel de estrictez con el tiempo.

En repositorios de .NET 10, el lugar más limpio para centralizar esto es `Directory.Build.props`. Eso hace que la regla aplique a cada proyecto, incluyendo los de tests, sin copy/paste.

Aquí va un patrón mínimo:

```xml
<!-- Directory.Build.props -->
<Project>
  <PropertyGroup Condition="'$(Configuration)' == 'Release'">
    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
  </PropertyGroup>
</Project>
```

Esto coincide con lo que la mayoría de pipelines de CI compilan de todos modos (Release). Si tu CI compila Debug, cámbialo a Release primero. Así tu listón de "sin warnings" coincide con los binarios que entregas.

## Ser estricto no significa ser ciego

Hay dos perillas que importan una vez que activas el interruptor grande:

-   `WarningsAsErrors`: escalar solo IDs de warning específicos.
-   `NoWarn`: suprimir IDs de warning específicos (idealmente con un comentario y un enlace de seguimiento).

Ejemplo para apretar un warning dejando el resto como warnings:

```xml
<Project>
  <PropertyGroup Condition="'$(Configuration)' == 'Release'">
    <TreatWarningsAsErrors>false</TreatWarningsAsErrors>
    <WarningsAsErrors>$(WarningsAsErrors);CS8602</WarningsAsErrors>
  </PropertyGroup>
</Project>
```

Y si necesitas suprimir temporalmente un analizador ruidoso en un proyecto:

```xml
<Project>
  <PropertyGroup Condition="'$(Configuration)' == 'Release'">
    <NoWarn>$(NoWarn);CA2007</NoWarn>
  </PropertyGroup>
</Project>
```

Si usas analizadores Roslyn (común en soluciones modernas de .NET 10), considera también `.editorconfig` para controlar la severidad, porque es descubrible y mantiene la política cerca del código:

```ini
# .editorconfig
[*.cs]
dotnet_diagnostic.CA2007.severity = warning
```

## El beneficio práctico para los PRs

La verdadera ganancia es feedback predecible en PRs. Los desarrolladores aprenden rápido que los warnings no son "trabajo futuro", son parte de la definition of done de Release. Debug se queda rápido y permisivo, Release se queda estricto y entregable.

Si quieres el disparador original de este patrón (y el pequeño snippet que arrancó la discusión), mira el hilo aquí: [https://www.reddit.com/r/dotnet/comments/1qjum3h/treating_warnings_as_errors_in_dotnet_the_right/](https://www.reddit.com/r/dotnet/comments/1qjum3h/treating_warnings_as_errors_in_dotnet_the_right/)
