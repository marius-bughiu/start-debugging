---
title: "¿Qué es Native AOT y cuánto te cuesta?"
description: "Native AOT compila tu app de .NET en un único binario nativo autónomo sin JIT, lo que te da un arranque rápido y poco consumo de memoria. El precio es una cadena de herramientas de C en tiempo de compilación, compilaciones más lentas, builds por RID, sin reflexión ni Reflection.Emit, recorte obligatorio y sin Dynamic PGO. Aquí tienes el balance completo."
pubDate: 2026-06-19
tags:
  - "dotnet"
  - "native-aot"
  - "performance"
  - "dotnet-11"
  - "csharp"
lang: "es"
translationOf: "2026/06/what-is-native-aot-and-what-does-it-cost-you"
translatedBy: "claude"
translationDate: 2026-06-19
---

Native AOT es un modelo de publicación de .NET que compila toda tu app, más una copia reducida del runtime, en un único ejecutable nativo autónomo de forma anticipada. La app resultante no tiene compilador JIT, por lo que arranca rápido y usa menos memoria, y se ejecuta en máquinas que no tienen el runtime de .NET instalado. El costo se paga en tres monedas: fricción en tiempo de compilación (necesitas una cadena de herramientas de C, las publicaciones son más lentas y cada build apunta a un único sistema operativo más arquitectura), pérdida de capacidades en tiempo de ejecución (sin código que dependa de la reflexión, sin `System.Reflection.Emit`, sin carga dinámica de ensamblados, recorte obligatorio) y un pequeño impacto en el throughput, a menudo invisible, porque el código AOT nunca recibe reoptimización guiada por perfil. Si esa transacción vale la pena depende por completo de la forma de tu implementación, no de un número de benchmark. Esta publicación es el balance completo para que puedas decidir antes de activarlo.

Todo lo que aparece aquí apunta a `<TargetFramework>net11.0</TargetFramework>` con el SDK de .NET 11 (`11.0.100`). Native AOT en sí llegó en .NET 7, y el soporte de ASP.NET Core aterrizó en .NET 8, así que la mecánica de abajo aplica desde .NET 8 en adelante salvo que se indique una versión.

## Qué significa realmente "anticipado" aquí

Una app de .NET normal se distribuye como IL (lenguaje intermedio). En tiempo de ejecución, el compilador JIT (just-in-time) convierte ese IL en código máquina nativo de forma perezosa, un método a la vez, la primera vez que cada método se ejecuta. Por eso un proceso de .NET recién iniciado es un poco lento en sus primeras solicitudes: se está compilando a sí mismo a medida que avanza. El runtime, el GC y el JIT tienen que estar presentes en la máquina para que esto funcione.

Native AOT elimina el JIT de la ecuación por completo. Cuando ejecutas `dotnet publish` con `<PublishAot>true</PublishAot>`, el SDK ejecuta ILC, el compilador AOT, que compila todo tu IL, todo el IL de tus dependencias y una versión recortada del runtime CoreCLR, en un único binario nativo. Como dice la [descripción general de la implementación de Native AOT](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/) de Microsoft, estas apps "tienen un tiempo de arranque más rápido y huellas de memoria más pequeñas" y "pueden ejecutarse en entornos restringidos donde no se permite un JIT".

La activación mínima es una sola propiedad de MSBuild y un identificador de runtime:

```xml
<!-- .NET 11, C# 14. Enables ILC at publish and turns on AOT analysis while editing. -->
<PropertyGroup>
  <PublishAot>true</PublishAot>
</PropertyGroup>
```

```bash
# .NET 11 SDK 11.0.100. The -r RID is mandatory: AOT output is platform-specific.
dotnet publish -c Release -r linux-x64
```

La salida en el directorio de publicación es un único ejecutable que contiene todo lo que necesita para ejecutarse, "incluida una versión reducida del runtime coreclr". No hay un runtime separado que instalar, y no hay JIT dentro del binario. Esa frase es toda la característica, y también todo el costo. Cada limitación de abajo se deriva de "no hay JIT en tiempo de ejecución".

## La factura en tiempo de compilación

Antes de escribir una línea de código, Native AOT cambia lo que necesitan tu máquina de compilación y tu CI.

**Necesitas una cadena de herramientas nativa de C.** ILC produce código objeto que tiene que ser enlazado en un ejecutable real del sistema operativo por un enlazador de la plataforma, así que los [prerrequisitos](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/) no son negociables según el sistema operativo. En Windows necesitas Visual Studio 2022 o posterior con la carga de trabajo "Desarrollo de escritorio con C++". En Linux instalas clang y las cabeceras de desarrollo de zlib (`sudo apt-get install clang zlib1g-dev` en Ubuntu, `sudo dnf install clang zlib-devel` en Fedora y RHEL, `sudo apk add clang build-base zlib-dev` en Alpine). En macOS necesitas las Command Line Tools de Xcode. Una imagen sencilla del SDK de `dotnet` ya no es suficiente para tus agentes de compilación; tienes que incluir la cadena de herramientas en la imagen de CI también.

**Las publicaciones son más lentas.** La compilación de todo el programa, más el recorte, más el enlazado nativo, es muchísimo más trabajo que emitir IL. Una publicación que tarda unos segundos para una app dependiente del framework puede tardar minutos bajo AOT, y escala con el tamaño de tu grafo de dependencias. Este es un impuesto por publicación, no por ejecución, pero es lo bastante real como para que normalmente no ejecutes AOT en cada build del ciclo interno, solo al publicar.

**Cada build es por RID.** La salida de AOT se ejecuta solo en el sistema operativo y la arquitectura de CPU para los que compilaste. Un binario compilado para `win-x64` no se ejecuta en `linux-arm64`, punto. Peor en Linux en concreto: un binario compilado en una versión de distribución dada se ejecuta solo en esa versión o más nuevas. La documentación es explícita en que "un binario de Native AOT producido en Ubuntu 20.04 va a ejecutarse en Ubuntu 20.04 y posteriores, pero no va a ejecutarse en Ubuntu 18.04". Si distribuyes a varias plataformas necesitas una matriz de compilación, una publicación por RID. .NET 9 amplió los destinos soportados para incluir Windows/Linux x86 y Arm de 32 bits además del x64 y Arm64 que soportaba .NET 8.

Compara esto con una app JIT dependiente del framework, donde un único build se ejecuta en cualquier máquina que tenga el runtime de .NET correspondiente. Esa portabilidad es una de las cosas a las que estás renunciando.

## Las capacidades en tiempo de ejecución a las que renuncias

Esta es la parte que decide la mayoría de los proyectos, porque las pérdidas no son "más lento", son "no funciona, y el paso de publicación te avisará". Como no hay JIT, cualquier cosa que dependa de generar o descubrir código en tiempo de ejecución queda fuera. Directo desde las [limitaciones oficiales](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/):

- **Sin carga dinámica**, por ejemplo `Assembly.LoadFile`. Las arquitecturas de plugins que escanean una carpeta en busca de DLL y las cargan en tiempo de ejecución no pueden funcionar, porque el código nunca se compiló en el binario.
- **Sin generación de código en tiempo de ejecución**, por ejemplo `System.Reflection.Emit`. Esto se lleva por delante en silencio una cantidad sorprendente del ecosistema: bibliotecas de proxy dinámico (Castle DynamicProxy), algunos frameworks de mocking y cualquier serializador o mapeador que emita IL por velocidad.
- **Sin C++/CLI** y, en Windows, **sin COM integrado**.
- **El recorte es obligatorio.** El recortador elimina cualquier código que no pueda demostrar que es alcanzable. La reflexión sin límites (`Type.GetType("SomeName")` desde una cadena, recorridos con `GetProperties()`, `Activator.CreateInstance(someType)`) frustra ese análisis, así que el código que depende mucho de la reflexión o necesita anotaciones o tiene que reemplazarse con un generador de código fuente.
- **El empaquetado en un solo archivo está implícito**, lo que conlleva sus propias [incompatibilidades conocidas](https://learn.microsoft.com/en-us/dotnet/core/deploying/single-file/overview) (APIs que asumen un `.dll` en disco, `Assembly.Location` devolviendo vacío, etc.).
- **`System.Linq.Expressions` siempre se ejecuta interpretado.** No puede compilarse en tiempo de ejecución porque eso necesita el JIT, así que el código que depende mucho de árboles de expresión sigue funcionando pero se ejecuta más lento que en un host con JIT.

La regla práctica más importante: **el compilador te lo dice.** "El proceso de publicación analiza todo el proyecto y sus dependencias en busca de posibles limitaciones. Se emiten advertencias por cada limitación que la app publicada podría encontrar en tiempo de ejecución." Esas advertencias son IL2026 (requiere código no referenciado, un problema de recorte) e IL3050 (requiere código dinámico, un problema de AOT). Trata un `dotnet publish` limpio con cero advertencias IL2026/IL3050 como tu señal de continuar o no, no la documentación. Si no puedes llegar a cero, no publiques con AOT.

La forma de llegar a cero es casi siempre reemplazar la reflexión con generación de código en tiempo de compilación. El `System.Text.Json` con código generado es el ejemplo canónico: en lugar de reflexionar sobre tu DTO en tiempo de ejecución, un generador emite el código de serialización en tiempo de compilación. Si el término es nuevo para ti, [qué es un generador de código fuente y cuándo lo necesitas](/es/2026/06/what-is-a-source-generator-and-when-do-i-need-one/) es el primer paso correcto, porque bajo AOT dejan de ser algo deseable y se convierten en la única forma en que algunas bibliotecas funcionan.

## El costo de throughput que nadie menciona

Hay un costo que los titulares de arranque y tamaño esconden. Un proceso JIT no solo compila tu código una vez. Desde .NET 8, **Dynamic PGO** (optimización guiada por perfil) está activado de forma predeterminada: mientras tu app se ejecuta, el runtime registra qué tipos fluyen realmente a través de las llamadas virtuales y qué ramas son calientes, luego recompila esos métodos en el nivel 1 usando ese perfil real. Esa es información que ningún compilador anticipado puede tener, porque solo existe mientras tu carga de trabajo específica se ejecuta.

El código de Native AOT queda fijo en tiempo de publicación. Nunca recibe reoptimización de nivel 1 y nunca recibe PGO. Para un bucle caliente con uso intensivo de CPU que se ejecuta durante horas, un proceso JIT bien calentado puede superar el throughput del mismo código compilado con AOT, aunque el proceso AOT haya arrancado en una fracción del tiempo. AOT cambia el pico de la cola larga por una curva plana, predecible y rápida desde la primera instrucción. La brecha medida es pequeña (un pequeño porcentaje en un benchmark de API JSON), pero es real y va en la dirección opuesta a todo lo demás que AOT te ofrece. Los números completos están en la [comparación de Native AOT vs ReadyToRun vs JIT](/es/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/), que mide arranque, throughput y tamaño frente a frente.

Un matiz más de tamaño: los genéricos. "Los parámetros genéricos sustituidos con argumentos de tipo struct tienen código especializado generado para cada instanciación." Un JIT las genera bajo demanda; AOT las pregenera todas. Si instancias muchos genéricos de tipo por valor, el binario crece. Los binarios de AOT son pequeños en el caso común (una API mínima ronda los 10-13 MB), pero una biblioteca con muchos genéricos puede inflarlo más de lo que esperas.

## Qué te compra el costo

Los beneficios son genuinos y, para la carga de trabajo adecuada, decisivos. El arranque es el titular: una API mínima con Native AOT arranca aproximadamente tres veces más rápido que la misma app en JIT plano, porque no hay calentamiento del JIT ni carga de ensamblados. La huella de memoria cae más de la mitad, porque el proceso no carga un JIT, ni el IL, ni los metadatos necesarios para compilarlo. Y como la salida es autónoma, la unidad de implementación es un único binario pequeño sin runtime que instalar, por lo que los equipos reducen sustancialmente el tamaño de las imágenes de contenedor al cambiar.

El otro beneficio es categórico en lugar de cuantitativo: las apps AOT "pueden ejecutarse en entornos restringidos donde no se permite un JIT". Algunos runtimes de contenedor bloqueados y políticas de seguridad prohíben las páginas de memoria escribibles-ejecutables que un JIT necesita. AOT es el único modelo de implementación de .NET que se ejecuta ahí.

Por eso el punto óptimo es el cómputo de escala a cero y de alta densidad. En una función facturada por solicitud (AWS Lambda, Azure Functions Consumption, Cloud Run escalado a cero), el arranque en frío domina tanto el SLO de latencia como la factura, así que una mejora de 3x en el arranque vale mucho dolor en tiempo de compilación. El [manual de arranque en frío para AWS Lambda en .NET 11](/es/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) recorre el camino exacto de AOT en Lambda. En un servicio de larga vida con uso intensivo de CPU y un puñado de instancias, el arranque se amortiza hasta desaparecer y estarías renunciando a Dynamic PGO por un beneficio que pagas una sola vez, así que el JIT plano suele ganar.

## Cómo decidir sin adivinar

Ejecuta el análisis antes de comprometerte con nada. La prueba más barata es poner `<PublishAot>true</PublishAot>` y ejecutar una publicación contra tu grafo de dependencias real:

```bash
# .NET 11. Surfaces every IL2026 / IL3050 across your whole dependency tree.
dotnet publish -c Release -r linux-x64 -o ./publish
```

Si eso vuelve con advertencias que no puedes anotar para eliminarlas, AOT no es viable para esta base de código todavía, y tienes tu respuesta por el costo de una publicación. ASP.NET Core afina el punto: los controladores MVC (`AddControllers`), Razor Pages y los hubs de SignalR del lado del servidor no son compatibles con AOT en .NET 11, mientras que las APIs mínimas y gRPC sí lo son. Si quieres la receta completa de build limpio (el host `CreateSlimBuilder`, JSON con código generado, los problemas de los proyectos de biblioteca), [cómo usar Native AOT con APIs mínimas de ASP.NET Core](/es/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) es el paso a paso. Y cuando una API incompatible con AOT se cuela más allá del analizador y solo revienta en tiempo de ejecución, [solucionar la PlatformNotSupportedException resultante](/es/2026/05/fix-platformnotsupportedexception-in-native-aot/) cubre el fallo más común.

Una regla de decisión breve: recurre a Native AOT cuando el tiempo de arranque, la huella de memoria, el tamaño de la implementación o ejecutar sin un JIT sea la restricción que domina, **y** `dotnet publish` reporte cero advertencias de AOT en todo tu grafo de dependencias. Quédate en JIT plano cuando el throughput pico en estado estable importe más que el arranque, cuando distribuyas un único artefacto a varias plataformas, o cuando alguna dependencia clave necesite reflexión o `Reflection.Emit` que no puedas reemplazar. Native AOT no es un `dotnet publish` más rápido; es un contrato de implementación diferente, y los costos de arriba son los términos de ese contrato. Léelos antes de firmar.

## Relacionado

- [Native AOT vs ReadyToRun vs JIT en .NET 11: ¿cuál deberías distribuir?](/es/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) pone números de benchmark duros detrás de las concesiones de arranque, throughput y tamaño.
- [Cómo usar Native AOT con APIs mínimas de ASP.NET Core](/es/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) es el recorrido de build limpio una vez que has decidido distribuirlo.
- [¿Qué es un generador de código fuente y cuándo lo necesito?](/es/2026/06/what-is-a-source-generator-and-when-do-i-need-one/) explica la generación de código en tiempo de compilación que reemplaza la reflexión que AOT prohíbe.
- [Cómo reducir el tiempo de arranque en frío de una AWS Lambda en .NET 11](/es/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) es el escenario de escala a cero donde la mejora de arranque de AOT se paga sola.
- [Solución: PlatformNotSupportedException en Native AOT](/es/2026/05/fix-platformnotsupportedexception-in-native-aot/) cubre el fallo en tiempo de ejecución cuando una API incompatible con AOT se cuela en un build limpio.

## Fuentes

- [Descripción general de la implementación de Native AOT](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/), MS Learn (prerrequisitos, limitaciones, restricciones por RID y plataforma, comportamiento de archivo único y genéricos).
- [Soporte de ASP.NET Core para Native AOT](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/native-aot/), MS Learn (características web soportadas y no soportadas).
- [Incompatibilidades de recorte](https://learn.microsoft.com/en-us/dotnet/core/deploying/trimming/incompatibilities), MS Learn (por qué el recorte es obligatorio y qué rompe).
- [Conversación sobre PGO](https://devblogs.microsoft.com/dotnet/conversation-about-pgo/), .NET Blog (diseño de Dynamic PGO y por qué AOT prescinde de él).
