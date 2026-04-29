---
title: ".NET Framework 3.5 se vuelve independiente en las nuevas builds de Windows: qué se rompe"
description: "A partir de Windows 11 Build 27965, .NET Framework 3.5 ya no es un componente opcional de Windows. Esto es lo que se rompe en CI, aprovisionamiento e imágenes maestras, y cómo arreglarlo."
pubDate: 2026-02-07
tags:
  - "dotnet"
  - "windows"
lang: "es"
translationOf: "2026/02/net-framework-3-5-is-going-standalone-on-new-windows-builds-what-breaks-in-automation"
translatedBy: "claude"
translationDate: 2026-04-29
---
Microsoft cambió algo que muchos desarrolladores y profesionales de TI automatizaron y luego olvidaron: a partir de **Windows 11 Insider Preview Build 27965**, **.NET Framework 3.5 ya no se incluye como componente opcional de Windows**. Si lo necesitas, ahora debes obtenerlo como un **instalador independiente**.

Esta es una historia sobre .NET Framework, pero golpeará a equipos que construyen servicios modernos en **.NET 10** y **C# 14**, porque el dolor aparece en lugares como máquinas de desarrollador recién instaladas, agentes de CI efímeros, imágenes maestras y redes cerradas.

## El detalle clave: "NetFx3" ya no está garantizado

Del anuncio:

-   El cambio se aplica a **Build 27965 y futuras versiones de plataforma** de Windows.
-   **No afecta a Windows 10** ni a versiones anteriores de Windows 11 hasta **25H2**.
-   Está ligado a la realidad del ciclo de vida: **.NET Framework 3.5 se acerca al fin de soporte el 9 de enero de 2029**.

Si tus scripts asumen "habilita la característica y Windows se encarga", espera fallos en la línea más reciente.

## Qué debe hacer ahora tu aprovisionamiento

Trata a .NET Framework 3.5 como una dependencia que aprovisionas y verificas explícitamente. Como mínimo:

-   Detecta las versiones de build de Windows que están en el nuevo comportamiento.
-   Verifica si `NetFx3` se puede consultar y habilitar en esa máquina.
-   Si no, sigue la guía oficial para el instalador independiente y las notas de compatibilidad.

Aquí tienes una salvaguarda práctica que puedes incluir en el aprovisionamiento del agente de build o en un paso "preflight":

```powershell
# Works on Windows PowerShell 5.1 and PowerShell 7+
$os = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
$build = [int]$os.CurrentBuildNumber

Write-Host "Windows build: $build"

# Query feature state (if the OS exposes it this way)
dism /online /Get-FeatureInfo /FeatureName:NetFx3

if ($build -ge 27965) {
  Write-Host ".NET Framework 3.5 is obtained via standalone installer on this Windows line."
  Write-Host "Official guidance (installers + compatibility + migration paths):"
  Write-Host "https://go.microsoft.com/fwlink/?linkid=2348700"
}
```

Esto no instala nada por sí solo. Hace que el fallo sea explícito, temprano y fácil de interpretar cuando una imagen de máquina cambió silenciosamente bajo tus pies.

## El "porqué" sobre el que debes actuar ahora

Incluso si planeas migrar, probablemente aún tienes:

-   Herramientas internas o aplicaciones de proveedor que requieren 3.5
-   Suites de pruebas que arrancan utilidades antiguas
-   Clientes con ciclos de actualización largos

Así que la victoria inmediata no es "quedarse en 3.5". La victoria inmediata es hacer tu entorno predecible mientras trabajas hacia objetivos soportados.

Fuentes:

-   [Publicación del blog de .NET: .NET Framework 3.5 pasa a despliegue independiente](https://devblogs.microsoft.com/dotnet/dotnet-framework-3-5-moves-to-standalone-deployment-in-new-versions-of-windows/)
-   [Guía de Microsoft Learn: instaladores, compatibilidad y migración](https://go.microsoft.com/fwlink/?linkid=2348700)
