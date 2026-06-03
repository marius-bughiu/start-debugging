---
title: ".NET 11 eleva la linea base minima de CPU a x86-64-v2"
description: ".NET 11 Preview 4 deja de admitir chips x86/x64 anteriores a 2013 y sube la linea base del JIT a x86-64-v2. Esto es lo que se rompe, por que y como verificar tu hardware antes de actualizar."
pubDate: 2026-06-03
tags:
  - "dotnet"
  - "performance"
  - "native-aot"
lang: "es"
translationOf: "2026/06/dotnet-11-minimum-cpu-baseline-x86-64-v2"
translatedBy: "claude"
translationDate: 2026-06-03
---

Si mantienes runners de CI, imagenes base de Docker o cualquier cosa que se ejecute en hardware antiguo, .NET 11 trae un cambio incompatible que no aparece como un error del compilador. Aparece en el arranque, en la maquina de destino, como una negativa a ejecutarse. A partir de .NET 11 Preview 4, el runtime eleva el conjunto de instrucciones minimo garantizado en x86/x64 de `x86-64-v1` a `x86-64-v2`, y Arm64 tambien recibe un aumento menor.

## Que requiere realmente la nueva linea base

`x86-64-v1` solo garantizaba `CMOV`, `CX8`, `SSE` y `SSE2`. `x86-64-v2` agrega `CX16`, `POPCNT`, `SSE3`, `SSSE3`, `SSE4.1` y `SSE4.2`. Esto aplica al minimo de JIT y AOT en los tres sistemas operativos (Apple, Linux, Windows). En la practica, los ultimos chips que no superan este limite quedaron sin soporte alrededor de 2013, y el nivel ya lo requieren Windows 11 y todas las CPU x86/x64 oficialmente admitidas en Windows 10.

En Arm64, el minimo de JIT/AOT en Windows pasa de `armv8.0-a` a `armv8.0-a + LSE`. Linux y Apple mantienen sus minimos de JIT actuales, asi que una Raspberry Pi que solo provee `AdvSimd` sigue funcionando.

Los objetivos de ReadyToRun (R2R) avanzan mas. En Windows y Linux, el objetivo de R2R ahora es `x86-64-v3`, que asume `AVX`, `AVX2`, `BMI1`, `BMI2`, `F16C`, `FMA`, `LZCNT` y `MOVBE`. El objetivo de R2R de Apple no cambia. R2R es un objetivo de generacion de codigo, no un requisito estricto: una CPU por debajo de `x86-64-v3` pero igual o superior a `x86-64-v2` sigue ejecutandose, solo paga un costo extra de jitting en el arranque porque no puede usar el codigo precompilado.

## El modo de fallo

Cuando la CPU esta por debajo del nuevo umbral, la aplicacion no arranca. En su lugar obtienes un mensaje como este:

```text
The current CPU is missing one or more of the baseline instruction sets.
```

No hay ningun interruptor a nivel de proyecto para bajar el umbral. El minimo de JIT/AOT es el minimo.

## Verifica antes de publicar

En Linux con glibc puedes preguntarle al cargador dinamico que niveles de microarquitectura admite la maquina:

```bash
/lib64/ld-linux-x86-64.so.2 --help | grep -A4 "Subdirectories"
```

La salida marca cada nivel como `(supported)` o no:

```text
  x86-64-v4 (not searched)
  x86-64-v3 (supported, searched)
  x86-64-v2 (supported, searched)
```

Si `x86-64-v2` falta en la lista de admitidos, .NET 11 no se ejecutara en ese host. Los culpables habituales son agentes de compilacion antiguos, instancias VPS economicas ancladas a CPU de host muy viejas y entornos emulados. La publicacion AOT apunta a la misma linea base, asi que un binario de Native AOT compilado para `linux-x64` lleva el mismo requisito.

## Por que Microsoft subio el piso

Admitir hardware por debajo de lo que el propio sistema operativo host requiere agrega un costo real de mantenimiento al runtime, y obliga a la generacion de codigo AOT a usar por defecto un minimo comun denominador que deja rendimiento sobre la mesa. Subir la linea base permite que el JIT y crossgen2 asuman que `POPCNT`, `SSE4.2` y similares siempre estan presentes, asi que el codigo generado es mas liviano sin una verificacion de caracteristicas en tiempo de ejecucion. Para la inmensa mayoria de las maquinas, incluida cada equipo con Windows 11, no cambia nada salvo que el codigo es mas rapido.

El unico grupo que necesita actuar es quien todavia apunta a silicio genuinamente antiguo. Audita tus runners e imagenes base ahora, mientras .NET 11 esta en preview, en lugar de descubrir el mensaje en produccion en noviembre. Si estas planificando el salto, incorporalo a tu [lista de verificacion de migracion de .NET 8 a .NET 11](/es/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/).

Fuente: [Novedades del runtime de .NET 11](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/runtime) y la [nota de compatibilidad sobre requisitos minimos de hardware](https://learn.microsoft.com/en-us/dotnet/core/compatibility/jit/11/minimum-hardware-requirements).
