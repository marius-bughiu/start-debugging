---
title: "Rider 2026.3 EAP: dotCover por fin mide la cobertura de TUnit"
description: "El Early Access Program de Rider 2026.3 abrió el 7 de septiembre de 2026. Debajo de los corchetes de colores está la línea que de verdad cambia una compilación: dotCover ya reporta cobertura para pruebas TUnit, con Microsoft.Testing.Platform 2.3.0 y una referencia de paquete."
pubDate: 2026-09-08
tags:
  - "dotnet"
  - "testing"
  - "rider"
  - "code-coverage"
  - "tooling"
lang: "es"
translationOf: "2026/09/rider-2026-3-eap-dotcover-measures-tunit-coverage"
translatedBy: "claude"
translationDate: 2026-09-08
---

JetBrains abrió el [Early Access Program de Rider 2026.3](https://blog.jetbrains.com/dotnet/2026/09/07/rider-2026-3-eap/) el 7 de septiembre de 2026. Las características de portada son las que quedan bien en una captura: corchetes de colores (desactivados por defecto, en Settings | Editor | General | Appearance), una barra de filtros en el popup de autocompletado y una categoría dedicada de plugins de Game Development. El cambio que de verdad desbloquea un repositorio está dos frases más abajo: la integración de dotCover en Rider ya mide la cobertura de las pruebas unitarias escritas con TUnit.

## Por qué los proyectos TUnit no reportaban nada

TUnit es un framework de pruebas nativo de Microsoft.Testing.Platform. No tiene adaptador de VSTest, y esa es justamente la idea: el proyecto de pruebas compila un ejecutable que controla su propio punto de entrada y habla el protocolo MTP, en vez de estar hospedado por `vstest.console`. Es el mismo cambio de arquitectura detrás de [la migración de VSTest a Microsoft.Testing.Platform en .NET 11](/es/2026/09/migrate-from-vstest-to-microsoft-testing-platform-in-dotnet-11/).

El runner de cobertura de dotCover dentro del IDE se enganchaba al host de VSTest. Sin host de VSTest en la ecuación, "Cover Unit Tests" sobre un proyecto TUnit producía un reporte vacío o se negaba a arrancar, y JetBrains lo registró como [DCVR-12871](https://youtrack.jetbrains.com/projects/DCVR/issues/DCVR-12871). Los equipos que querían números recurrían a `dotnet test --coverage` con `Microsoft.Testing.Extensions.CodeCoverage` y leían un archivo Cobertura, algo que funciona bien en CI y es inútil cuando quieres ver verde y rojo en el margen junto a la línea que estás editando.

## Cómo activarlo

La cobertura no se activa sola al actualizar. Hay dos requisitos, ambos explícitos en el anuncio del EAP.

Primero, el proyecto de pruebas necesita el paquete del framework de profiling:

```xml
<ItemGroup>
  <PackageReference Include="TUnit" />
  <PackageReference Include="JetBrains.dotCover.Framework" />
</ItemGroup>
```

Segundo, el piso de la plataforma es `Microsoft.Testing.Platform` 2.3.0 o posterior. Es el mismo 2.3.0 que trajo [TRX en streaming y anotaciones de GitHub Actions](/es/2026/08/microsoft-testing-platform-2-3-github-actions-annotations/) en julio de 2026, así que la mayoría de los repositorios con un TUnit actual ya están por encima de la línea. Revisa lo que realmente restauraste, no lo que declaraste:

```bash
dotnet list package --include-transitive | grep Microsoft.Testing.Platform
```

Después asegúrate de que Rider esté usando MTP: Settings | Build, Execution, Deployment | Unit Testing | Testing Platform, y marca "Enable Test Platform support". Sin esa casilla, Rider sigue pasando por su runner heredado y vuelves al reporte vacío.

## La otra novedad que justifica el riesgo del EAP

Los data breakpoints dejaron de ser un ritual de la ventana Watches. Puedes hacer clic derecho sobre una variable en el editor y configurarlo ahí mismo, o crearlo directamente desde la ventana Breakpoints escribiendo una dirección de memoria y un tamaño de región. Soporta acceso de lectura y escritura, condiciones y logging. Para perseguir un campo que otro hilo está pisando, ese camino es notablemente más corto que el flujo anterior.

Las compilaciones EAP son gratuitas mientras dura el programa y caducan, así que tómalo como una forma de desbloquear ya la cobertura de un repositorio TUnit, no como la máquina desde la que publicas.
