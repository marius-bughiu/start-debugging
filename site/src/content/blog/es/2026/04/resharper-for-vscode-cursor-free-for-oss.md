---
title: "ReSharper aterriza en VS Code y Cursor, gratis para uso no comercial"
description: "JetBrains lanzó ReSharper como una extensión de VS Code con análisis de C#, refactorización y pruebas unitarias completas. Funciona también en Cursor y Google Antigravity, y no cuesta nada para OSS y aprendizaje."
pubDate: 2026-04-12
tags:
  - "resharper"
  - "vs-code"
  - "csharp"
  - "tooling"
lang: "es"
translationOf: "2026/04/resharper-for-vscode-cursor-free-for-oss"
translatedBy: "claude"
translationDate: 2026-04-25
---

Por años, ReSharper significaba una sola cosa: una extensión de Visual Studio. Si querías análisis de C# de calidad JetBrains fuera de Visual Studio, Rider era la respuesta. Eso cambió el 5 de marzo de 2026, cuando JetBrains [liberó ReSharper para Visual Studio Code](https://blog.jetbrains.com/dotnet/2026/03/05/resharper-for-visual-studio-code-cursor-and-compatible-editors-is-out/), Cursor y Google Antigravity. La [versión 2026.1](https://blog.jetbrains.com/dotnet/2026/03/30/resharper-2026-1-released/) del 30 de marzo siguió con monitoreo de rendimiento e integración más ajustada.

## Lo que obtienes

La extensión trae la experiencia central de ReSharper a cualquier editor que hable la API de extensiones de VS Code:

- **Análisis de código** para C#, XAML, Razor y Blazor con la misma base de datos de inspecciones que ReSharper usa en Visual Studio
- **Refactorización a nivel de solución**: renombrar, extraer método, mover tipo, inline variable, y el resto del catálogo
- **Navegación** incluyendo ir a definición en código fuente descompilado
- **Un Solution Explorer** que maneja proyectos, paquetes NuGet, y generadores de código fuente
- **Pruebas unitarias** para NUnit, xUnit.net, y MSTest con controles inline de ejecución/depuración

Después de instalar la extensión y abrir una carpeta, ReSharper detecta archivos `.sln`, `.slnx`, `.slnf`, o `.csproj` independientes automáticamente. Sin configuración manual necesaria.

## El ángulo de licenciamiento

JetBrains hizo esto gratis para uso no comercial. Eso cubre contribuciones de código abierto, aprendizaje, creación de contenido, y proyectos por afición. Los equipos comerciales necesitan una licencia ReSharper o dotUltimate, la misma que cubre la extensión de Visual Studio.

## Una prueba rápida

Instala desde el VS Code Marketplace, luego abre cualquier solución C#:

```bash
code my-project/
```

ReSharper indexa la solución y comienza a mostrar inspecciones inmediatamente. Prueba la Command Palette (`Ctrl+Shift+P`) y escribe "ReSharper" para ver acciones disponibles, o haz clic derecho en cualquier símbolo para el menú de refactorización.

Una forma rápida de verificar que está funcionando:

```csharp
// ReSharper will flag this with "Use collection expression" in C# 12+
var items = new List<string> { "a", "b", "c" };
```

Si ves la sugerencia de convertir a `["a", "b", "c"]`, el motor de análisis está corriendo.

## Para quién es esto

Los usuarios de Cursor escribiendo C# ahora obtienen análisis de primera clase sin abandonar su editor AI-native. Los usuarios de VS Code que evitaron Rider por costo o preferencia obtienen la misma profundidad de inspección que ReSharper ha ofrecido a los usuarios de Visual Studio por dos décadas. Y los mantenedores de OSS lo obtienen todo gratis.

El [post de anuncio completo](https://blog.jetbrains.com/dotnet/2026/03/05/resharper-for-visual-studio-code-cursor-and-compatible-editors-is-out/) cubre detalles de instalación y limitaciones conocidas.
