---
title: "SBOM para .NET en Docker: deja de obligar a una sola herramienta a verlo todo"
description: "Cómo rastrear las dependencias de NuGet y los paquetes del SO del contenedor de una imagen Docker de .NET usando CycloneDX, Syft y Dependency-Track -- y por qué un solo SBOM no es suficiente."
pubDate: 2026-01-10
tags:
  - "docker"
  - "dotnet"
lang: "es"
translationOf: "2026/01/sbom-for-net-in-docker-stop-trying-to-force-one-tool-to-see-everything"
translatedBy: "claude"
translationDate: 2026-04-30
---
Un hilo de DevOps planteó una pregunta que sigo viendo: "¿Cómo rastreo a la vez las dependencias de NuGet y los paquetes del SO del contenedor para una aplicación .NET enviada como imagen Docker?". El autor ya estaba cerca del enfoque correcto: CycloneDX para el grafo del proyecto .NET, Syft para la imagen y luego ingestión en Dependency-Track.

Fuente: [Hilo de Reddit](https://www.reddit.com/r/devops/comments/1q8erp9/sbom_generation_for_a_net_app_in_a_container/).

## Un solo SBOM suele ser el objetivo equivocado

Una imagen de contenedor contiene al menos dos universos de dependencias:

-   Dependencias de la aplicación: paquetes NuGet resueltos en tiempo de compilación (tu mundo `*.deps.json`).
-   Dependencias de la imagen: paquetes del SO y capas de la imagen base (tu mundo de `apt`, `apk`, libc, OpenSSL).

En .NET 9 y .NET 10, cualquiera de los dos lados puede desaparecer por accidente:

-   Los escáneres de imágenes pueden perderse las versiones de NuGet porque no leen el grafo del proyecto.
-   Las herramientas de SBOM a nivel de aplicación no verán los paquetes del SO de la imagen base porque no escanean capas.

Por eso "que una sola herramienta lo haga todo" suele terminar en puntos ciegos.

## Genera dos SBOM y conserva la procedencia

Esta es la pipeline práctica:

-   **SBOM A** (a nivel de aplicación): genera desde la solución o el proyecto en tiempo de compilación.
    -   Herramienta: [cyclonedx-dotnet](https://github.com/CycloneDX/cyclonedx-dotnet)
-   **SBOM B** (a nivel de imagen): genera desde la imagen ya construida.
    -   Herramienta: [Syft](https://github.com/anchore/syft)
-   **Ingesta y monitoreo**: sube ambos a [Dependency-Track](https://dependencytrack.org/).

La clave es la procedencia. Quieres poder responder: "¿Esta CVE está en mi imagen base o en mi grafo de NuGet?" sin adivinar.

## Comandos mínimos que puedes pegar en un job de CI

```bash
# App SBOM (NuGet focused)
dotnet tool install --global CycloneDX
dotnet CycloneDX .\MyApp.sln -o .\sbom --json

# Image SBOM (OS packages and what the image reveals)
docker build -t myapp:ci .
syft myapp:ci -o cyclonedx-json=.\sbom\container.cdx.json
```

Si quieres que el SBOM de la aplicación coincida con lo que realmente se entrega, genéralo desde el mismo commit que produjo la imagen del contenedor y guarda ambos artefactos juntos.

## ¿Deberías fusionar los BOM?

Si tu pregunta principal es "¿debería fusionar estos BOM en uno solo?", mi respuesta por defecto es: no fusiones por defecto.

-   Mantenlos separados para que las alertas sigan siendo accionables.
-   Si necesitas un único informe de cumplimiento, fusiona en la capa de informes, no aplanando la procedencia en el propio SBOM.

En Dependency-Track, esto suele convertirse en dos proyectos: `myapp` y `myapp-image`. No es complejidad extra. Es un modelo más limpio.

## Por qué Syft "se pierde NuGet" y qué hacer al respecto

Syft es fuerte con imágenes y sistemas de archivos. Reporta lo que puede identificar a partir de lo que puede ver. Si quieres dependencias autoritativas de NuGet, genéralas desde el grafo del proyecto con las herramientas de CycloneDX.

Puedes experimentar escaneando la salida publicada (por ejemplo `syft dir:publish/`), pero trátalo como complemento. La pregunta "¿qué paquetes referenciamos y en qué versiones?" pertenece al grafo de compilación, no a un escaneo de capas.

Si estás construyendo servicios .NET 10 en contenedores, dos SBOM es la respuesta honesta. Obtienes mejor cobertura, propiedad más clara y menos falsos positivos que desperdician un sprint.
