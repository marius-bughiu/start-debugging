---
title: "¿Qué es la bandera W^X en .NET y la necesita Native AOT?"
description: "W^X (write xor execute) es la regla de que ninguna página de memoria sea escribible y ejecutable al mismo tiempo. En .NET es la opción DOTNET_EnableWriteXorExecute, activa por defecto desde .NET 7, y existe únicamente para el JIT. Native AOT nunca la lee. Aquí está cómo la implementa el runtime, cuánto cuesta y cuándo desactivarla es una solución legítima."
pubDate: 2026-09-04
tags:
  - "dotnet"
  - "native-aot"
  - "jit"
  - "performance"
  - "security"
  - "dotnet-11"
lang: "es"
translationOf: "2026/09/what-is-the-w-xor-x-flag-in-dotnet-and-does-native-aot-need-it"
translatedBy: "claude"
translationDate: 2026-09-04
---

W^X ("write xor execute") es una política de protección de memoria: cualquier página de memoria puede ser escribible o ejecutable, nunca ambas a la vez. En .NET se expone como la opción `DOTNET_EnableWriteXorExecute`, y su valor por defecto es `1` desde .NET 7. La premisa que se esconde en la formulación habitual de esta pregunta está al revés, así que corrijámosla de entrada: Native AOT no necesita la bandera W^X, y no la lee. La bandera configura el asignador de memoria ejecutable de CoreCLR, que existe para servir al JIT. Native AOT no tiene JIT ni asignador de memoria ejecutable. La relación real va en la dirección contraria: las plataformas que imponen W^X sin excepciones (iOS, tvOS) hacen imposible la compilación JIT, y Native AOT es la respuesta a esa restricción, no un consumidor de la bandera.

Todo lo que sigue apunta a `<TargetFramework>net11.0</TargetFramework>` con el SDK de .NET 11, pero la mecánica es estable desde .NET 7. Cuando un comportamiento dependa de una versión concreta, lo digo.

## Por qué es un problema que una página sea escribible y ejecutable

El exploit clásico de corrupción de memoria tiene dos mitades: meter bytes controlados por el atacante en el proceso, y luego lograr que la CPU salte a ellos. Si cada página del proceso es escribible o ejecutable, la segunda mitad deja de funcionar. Los bytes que escribiste viven en una página que la CPU se niega a ejecutar, y las páginas que la CPU sí ejecutará son páginas en las que no puedes escribir. La política salió de OpenBSD en 2003 y hoy es lo mínimo exigible: Windows llama a su versión DEP, Linux se apoya en el bit NX más los permisos de página del cargador, y Apple silicon la impone a nivel de kernel para todos los procesos.

Para código compilado normal esto es gratis. El cargador mapea tu sección `.text` como lectura-ejecución y tu sección `.data` como lectura-escritura, y nunca hace falta cambiar nada. El caso incómodo es un runtime que genera código máquina mientras el programa se ejecuta.

## Por qué el JIT es el caso incómodo

Un compilador JIT escribe bytes de código máquina en memoria y luego los invoca. La implementación ingenua asigna una página RWX, escribe y salta. Esa es exactamente la forma que W^X está diseñada para prohibir, y le entrega al atacante una página garantizada como escribible y ejecutable en una dirección más o menos estable.

La solución obvia es asignar la página como lectura-escritura, emitir el código y luego pasarla a lectura-ejecución con `mprotect`. Eso no basta para CoreCLR, por dos razones. Primero, hay una ventana en la que la página es escribible y su dirección ya se conoce. Segundo, y más importante, el runtime no escribe el código una sola vez. Lo parchea continuamente: los stubs de conteo de llamadas se reescriben cuando un método cruza el umbral de niveles, la [compilación por niveles](/es/2026/07/what-is-tiered-compilation-and-how-do-i-reason-about-it/) cambia el código de nivel 0 por el de nivel 1, las celdas de despacho de stubs virtuales se reparchean a medida que se resuelven los sitios de llamada monomórficos. Alternar una página entre RW y RX en cada parche es lento y además propenso a condiciones de carrera entre hilos.

## Cómo lo implementa CoreCLR en realidad: doble mapeo

La respuesta de CoreCLR es crear dos mapeos virtuales de la misma memoria física. Un mapeo es lectura-ejecución y es lo que ejecuta la CPU. El otro es lectura-escritura y es a través de lo que escribe el runtime. Ninguna dirección virtual es nunca ambas cosas, así que la política se mantiene, pero el runtime puede seguir parcheando código sin cambiar ningún permiso de página.

La plomería es `ExecutableAllocator` y el ayudante RAII `ExecutableWriterHolder` en `src/coreclr/inc/executableallocator.h`. Cada punto de la VM que quiere modificar código toma un writer holder, escribe a través de `holder.GetRW()` y deja que el destructor libere la vista escribible. El almacenamiento de respaldo se crea en `src/coreclr/minipal/Unix/doublemapping.cpp`, que en Linux hace:

```c
// dotnet/runtime, src/coreclr/minipal/Unix/doublemapping.cpp
int fd = memfd_create("doublemapper", MFD_CLOEXEC);
```

En FreeBSD usa `shm_open(SHM_ANON, ...)`, y en otros sistemas Unix recurre a un objeto de memoria compartida POSIX llamado `/shm-dotnet-<pid>` al que se le aplica `shm_unlink` de inmediato. Ese memfd es la pieza que puedes observar realmente desde fuera del proceso:

```bash
# Linux, .NET 11. Count the double mappings in a running .NET process.
grep -c doublemapper /proc/$(pgrep -n MyApp)/maps
```

Las plataformas de Apple toman otra ruta. `CreateDoubleMemoryMapper` retorna temprano en Apple sin crear ningún descriptor de archivo, porque macOS en arm64 ofrece un mecanismo por hilo en su lugar: las páginas asignadas con `MAP_JIT` pueden alternarse entre escribibles y ejecutables solo para el hilo que llama, mediante `pthread_jit_write_protect_np`. El runtime lo envuelve como `PAL_JitWriteProtect`, y en `HOST_APPLE && HOST_ARM64` el writer holder simplemente devuelve la misma dirección en vez de un segundo mapeo:

```cpp
// dotnet/runtime, executableallocator.h, Apple arm64 path
m_addressRW = addressRX;
PAL_JitWriteProtect(true);
```

Ese alcance por hilo es la parte que se le escapa a mucha gente: en Apple silicon el permiso de escritura pertenece a un hilo, no a la página, y por eso nunca debes dejar que un hilo escriba una región mientras otro la ejecuta.

## La bandera, y cómo configurarla

La opción se declara una sola vez, en `src/coreclr/inc/clrconfigvalues.h`:

```cpp
// dotnet/runtime, src/coreclr/inc/clrconfigvalues.h
RETAIL_CONFIG_DWORD_INFO(EXTERNAL_EnableWriteXorExecute, W("EnableWriteXorExecute"), 1,
                         "Enable W^X for executable memory.");
```

Por defecto `1` en todas las arquitecturas excepto `TARGET_RISCV64`, donde la misma declaración envía un valor por defecto de `0`. Pasó a ser el valor por defecto en el [PR #69672](https://github.com/dotnet/runtime/pull/69672), integrado en mayo de 2022 para .NET 7. Antes de eso, .NET 6 lo enviaba activo por defecto solo para macOS arm64 (donde el sistema operativo no te deja elegir) y opcional en el resto, tal como prometía el [anuncio de .NET 6](https://devblogs.microsoft.com/dotnet/announcing-net-6/).

Hay dos formas de configurarlo. La variable de entorno funciona en todas partes:

```bash
# Disables W^X for this process only. .NET 7 and later.
DOTNET_EnableWriteXorExecute=0 ./MyApp
```

Desde .NET 9 también puedes ponerlo en `runtimeconfig.json`, gracias al [PR #101490](https://github.com/dotnet/runtime/pull/101490):

```json
{
  "configProperties": {
    "System.Runtime.EnableWriteXorExecute": 0
  }
}
```

En un proyecto de estilo SDK, exprésalo como un elemento de MSBuild para que sobreviva a una recompilación:

```xml
<!-- .NET 9 and later. Ignored by .NET 8 and earlier, which need the env var. -->
<ItemGroup>
  <RuntimeHostConfigurationOption Include="System.Runtime.EnableWriteXorExecute" Value="0" />
</ItemGroup>
```

La ruta por runtimeconfig nunca se retroportó a .NET 8; la solicitud en el [issue #103340](https://github.com/dotnet/runtime/issues/103340) se cerró como no planificada. En .NET 8 la variable de entorno es tu única opción. Y ten en cuenta el cambio de precedencia de .NET 9: ahora las variables de entorno ganan sobre `runtimeconfig.json`, así que un `DOTNET_EnableWriteXorExecute` perdido en una imagen de contenedor anulará en silencio la configuración de tu proyecto.

## Cuánto cuesta

Esta no es una mitigación gratuita, y el equipo del runtime la midió antes de activarla. Las cifras del [PR #69672](https://github.com/dotnet/runtime/pull/69672) sobre los benchmarks plaintext, json, fortunes y orchard de ASP.NET en x64 Windows, x64 Linux y arm64 Linux fueron una regresión de arranque del 5 al 10 por ciento, y el análisis posterior situó el tiempo hasta la primera solicitud en torno a un 10 por ciento peor. En estado estable no se observó ninguna diferencia medible, lo cual tiene sentido: una vez que los métodos calientes están compilados por el JIT y parcheados, el asignador de memoria ejecutable deja de estar en cualquier ruta que importe.

La primera versión que se envió era peor que eso en cargas con mucha compilación JIT. El [PR #74526](https://github.com/dotnet/runtime/pull/74526) siguió una regresión en las pruebas de expresiones regulares que resultó estar motivada por compilar unos 50 000 métodos, cada uno de los cuales asignaba y liberaba un mapeo escribible nuevo. Cachear el último mapeo escribible usado en lugar de desmapearlo de inmediato lo arregló por completo, y se envió en .NET 7 junto con el cambio de valor por defecto. Si estás midiendo el arranque en .NET 7 o posterior, ya tienes esa corrección.

La lectura práctica: W^X te cuesta arranque, no throughput. Eso importa para procesos de vida corta y arranques en frío, y importa mucho menos para un servidor de larga duración. Es el mismo eje sobre el que se negocia [Native AOT frente a ReadyToRun frente a JIT puro](/es/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/).

## Dónde encaja Native AOT en realidad

Ahora la parte que la pregunta invierte. Native AOT publica un binario cuyo código se compila por completo en tiempo de compilación y lo mapea el cargador del sistema operativo como lectura-ejecución, exactamente igual que un programa en C. No hay JIT, ni niveles, ni reparcheo de stubs, y por lo tanto no hay `ExecutableAllocator`. Busca en el runtime de Native AOT bajo `src/coreclr/nativeaot/Runtime` y no encontrarás `EnableWriteXorExecute` en ninguna parte. Configurar la bandera contra un binario de Native AOT no hace absolutamente nada: la opción es un valor de configuración de la VM de CoreCLR, y el runtime de Native AOT es un runtime distinto y mucho más pequeño que nunca lee la configuración del CLR.

Puedes confirmar la ausencia de generación de código en tiempo de ejecución desde código gestionado:

```csharp
// .NET 11, C# 14. Prints False under Native AOT, True under CoreCLR.
using System.Runtime.CompilerServices;

Console.WriteLine(RuntimeFeature.IsDynamicCodeCompiled);
```

Eso no es exactamente lo mismo que decir que Native AOT no asigna memoria ejecutable en tiempo de ejecución. Asigna un poco, por una razón concreta: los delegados marshalados. Cuando entregas un delegado de instancia gestionado a código nativo como un puntero a función, la dirección de destino tiene que codificar qué instancia del delegado invocar, y eso no puede hornearse en la imagen porque la instancia no existe en tiempo de compilación. El runtime materializa un pequeño thunk por delegado:

```csharp
// .NET 11, C# 14. This is the call that forces a runtime-allocated thunk.
using System.Runtime.InteropServices;

Action<int> callback = Console.WriteLine;
nint fnPtr = Marshal.GetFunctionPointerForDelegate(callback);
// fnPtr points at a thunk allocated from a thunk pool, not at compiled image code.
GC.KeepAlive(callback);
```

Esos thunks vienen de `PalAllocateThunksFromTemplate`, cuya firma en `src/coreclr/nativeaot/Runtime/unix/PalUnix.cpp` es:

```cpp
UInt32_BOOL PalAllocateThunksFromTemplate(HANDLE hTemplateModule, uint32_t templateRva,
                                          size_t templateSize, void** newThunksOut);
```

El diseño, añadido para plataformas tipo iOS en el [PR #82317](https://github.com/dotnet/runtime/pull/82317), nunca produce una página RWX. En destinos de Apple reserva dos rangos adyacentes con `vm_allocate`, y luego usa `vm_remap` con `VM_FLAGS_FIXED | VM_FLAGS_OVERWRITE` para mapear la página de código de plantilla ya compilada desde la imagen cargada hacia la mitad ejecutable, mientras que la mitad escribible contiene solo los *datos* por thunk (la dirección de destino y el handle del delegado). El código nunca se escribe en tiempo de ejecución, solo se apunta a él. Eso es cumplimiento de W^X por construcción y no por política, que es precisamente por lo que funciona en una plataforma que no ofrece ninguna vía de escape.

`PalVirtualAlloc` en el mismo archivo sí pasa `MAP_JIT` al asignar memoria ejecutable en macOS arm64, ya que el kernel lo exige allí.

## En qué dirección va realmente la causalidad

Apple no permite que una aplicación de terceros de la App Store mapee memoria RWX ni cambie una página a ejecutable después de escribir en ella. No hay ningún entitlement que cambie esto para aplicaciones que se publican. Esa sola restricción elimina la compilación JIT, y con ella el modo JIT de Mono, los niveles de CoreCLR y la recarga en caliente de código compilado. Es el mismo muro contra el que choca Flutter, y por eso una [compilación de depuración de Flutter en iOS falla con mprotect permission denied](/es/2026/08/fix-mprotect-failed-permission-denied-in-a-flutter-ios-debug-build/) en versiones recientes de iOS mientras que las compilaciones de lanzamiento, totalmente compiladas AOT, no se ven afectadas.

Así que el encuadre correcto es: iOS impone W^X, W^X prohíbe el JIT, y Native AOT es la forma en que .NET entrega código a una plataforma que prohíbe el JIT. Native AOT soporta plataformas tipo iOS desde .NET 9, y es el modo de compilación por defecto para las compilaciones de lanzamiento de .NET MAUI en iOS y Mac Catalyst. Nada de esa cadena involucra la bandera `EnableWriteXorExecute`, que solo gobernó cómo el JIT de CoreCLR mete sus bytes en memoria en plataformas que de otro modo le habrían dejado ser descuidado.

## Cuándo desactivarla es una solución legítima

W^X es una mitigación de defensa en profundidad. Desactivarla es una reducción real de la postura de seguridad de tu proceso, así que trata `DOTNET_EnableWriteXorExecute=0` primero como herramienta de diagnóstico y solo como configuración permanente cuando tengas un motivo. Estos son los motivos que se sostienen:

**Perfilar marcos compilados por el JIT con `perf` de Linux.** El runtime escribe su mapa de perf usando la dirección del mapeo RW, no la del mapeo RX que la CPU ejecuta realmente, así que los marcos del JIT se resuelven a símbolos equivocados o a nada. Esto lleva abierto desde julio de 2022 como el [issue #71786](https://github.com/dotnet/runtime/issues/71786) y sigue aparcado en el hito Future. Si necesitas un perfil de `perf` usable del código compilado por el JIT, desactiva W^X para esa ejecución. Para el perfilado del día a día, prefiere [dotnet-trace, que lee sus propios eventos de rundown](/es/2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output/) y no se ve afectado.

**Entradas `/memfd:doublemapper (deleted)` que crecen.** El [issue #89776](https://github.com/dotnet/runtime/issues/89776) reporta que estos mapeos se acumulan en Linux (se liberan en macOS pero no en Linux), lo que se manifiesta como conteos de mapeos y memoria virtual en aumento en un servicio de larga duración. En ARM32 el mismo mecanismo se ha reportado como una fuga de memoria en toda regla que provoca muertes por OOM en el [issue #121455](https://github.com/dotnet/runtime/issues/121455). Si tu `/proc/<pid>/maps` está lleno de `doublemapper`, eso es lo que estás viendo.

**`SIGXFSZ` bajo un rlimit de tamaño de archivo.** El memfd es un archivo en lo que respecta al kernel, así que un `ulimit -f` por debajo del tamaño que pide el mapeador mata el proceso con `SIGXFSZ`. Ese fue el [issue #117819](https://github.com/dotnet/runtime/issues/117819).

**Depuradores nativos poniendo puntos de interrupción.** Escribir un `int3` a través del mapeo RX en lugar del RW producía violaciones de acceso, seguidas en el [issue #107444](https://github.com/dotnet/runtime/issues/107444). Si conectas `lldb` o `gdb` a un proceso .NET y ves fallos al insertar puntos de interrupción, desactiva W^X para esa sesión de depuración.

**Rosetta.** Aquí no necesitas hacer nada. El doble mapeo nunca ha funcionado correctamente bajo la emulación de Rosetta ([issue #70910](https://github.com/dotnet/runtime/issues/70910)), y el runtime detecta Rosetta y desactiva W^X por ti.

Lo que no está en esa lista es "mi aplicación arranca lento". Si el arranque en frío es tu problema, la bandera te compra un 5 a 10 por ciento mientras que una solución de verdad, ReadyToRun o [Native AOT con su propio balance de costos](/es/2026/06/what-is-native-aot-and-what-does-it-cost-you/), te compra mucho más y no debilita el proceso. Recurre a la bandera cuando tengas uno de los síntomas concretos de arriba, y déjale un comentario al lado diciendo cuál.

## Relacionados

- [¿Qué es Native AOT y cuánto te cuesta?](/es/2026/06/what-is-native-aot-and-what-does-it-cost-you/)
- [Native AOT vs ReadyToRun vs JIT en .NET 11: ¿cuál deberías publicar?](/es/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/)
- [¿Qué es la compilación por niveles y cómo razonar sobre ella?](/es/2026/07/what-is-tiered-compilation-and-how-do-i-reason-about-it/)
- [Cómo perfilar una app .NET con dotnet-trace y leer su salida](/es/2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output/)
- [Solución: mprotect failed: 13 (Permission denied) en una compilación debug de Flutter para iOS](/es/2026/08/fix-mprotect-failed-permission-denied-in-a-flutter-ios-debug-build/)

## Fuentes

- [W^X support, dotnet/runtime PR #54954](https://github.com/dotnet/runtime/pull/54954)
- [Enable W^X by default, dotnet/runtime PR #69672](https://github.com/dotnet/runtime/pull/69672)
- [Enable caching of writeable W^X mappings, dotnet/runtime PR #74526](https://github.com/dotnet/runtime/pull/74526)
- [Read EnableWriteXorExecute from runtimeConfig, dotnet/runtime PR #101490](https://github.com/dotnet/runtime/pull/101490)
- [NativeAOT thunk page generation and mapping for iOS-like platforms, PR #82317](https://github.com/dotnet/runtime/pull/82317)
- [clrconfigvalues.h, dotnet/runtime](https://github.com/dotnet/runtime/blob/main/src/coreclr/inc/clrconfigvalues.h)
- [doublemapping.cpp, dotnet/runtime](https://github.com/dotnet/runtime/blob/main/src/coreclr/minipal/Unix/doublemapping.cpp)
- [Announcing .NET 6, .NET Blog](https://devblogs.microsoft.com/dotnet/announcing-net-6/)
- [.NET Runtime config options, Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/core/runtime-config/)
- [Native AOT support for iOS-like platforms, Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/ios-like-platforms/)
- [pthread_jit_write_protect_np(3), Apple](https://keith.github.io/xcode-man-pages/pthread_jit_write_protect_np.3.html)
