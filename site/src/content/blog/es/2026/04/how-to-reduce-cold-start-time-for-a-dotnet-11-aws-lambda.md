---
title: "Cómo reducir el tiempo de arranque en frío de un AWS Lambda con .NET 11"
description: "Un manual práctico y específico de versión para recortar los arranques en frío de Lambda con .NET 11. Cubre Native AOT en provided.al2023, ReadyToRun, SnapStart en el runtime gestionado dotnet10, ajuste de memoria, reutilización estática, seguridad de trim, y cómo leer realmente INIT_DURATION."
pubDate: 2026-04-27
template: how-to
tags:
  - "aws"
  - "aws-lambda"
  - "dotnet-11"
  - "native-aot"
  - "performance"
lang: "es"
translationOf: "2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda"
translatedBy: "claude"
translationDate: 2026-04-29
---

Un Lambda típico de .NET pasa de un `dotnet new lambda.EmptyFunction` por defecto con un arranque en frío de 1500-2500 ms a menos de 300 ms apilando cuatro palancas: elegir el runtime correcto (Native AOT en `provided.al2023` o SnapStart en el runtime gestionado), darle a la función suficiente memoria para que init corra en una vCPU completa, subir todo lo reutilizable a la inicialización estática, y dejar de cargar código que no necesitas. Esta guía recorre cada palanca para una Lambda con .NET 11 (`Amazon.Lambda.RuntimeSupport` 1.13.x, `Amazon.Lambda.AspNetCoreServer.Hosting` 1.7.x, .NET 11 SDK, C# 14), explica el orden en que aplicarlas, y muestra cómo verificar cada paso desde la línea `INIT_DURATION` en CloudWatch.

## Por qué un Lambda .NET por defecto arranca tan lentamente

Un arranque en frío en runtime gestionado en Lambda ejecuta cuatro cosas seguidas, y una función .NET por defecto paga por todas. Primero arranca la **microVM Firecracker** y Lambda descarga tu paquete de despliegue. Segundo, el **runtime se inicializa**: para un runtime gestionado eso significa que CoreCLR carga, el JIT del host se calienta, y los assemblies de tu función se mapean en memoria. Tercero, se construye tu **clase handler**, incluyendo cualquier inyección por constructor, carga de configuración, y construcción de clientes del SDK de AWS. Solo después de todo eso Lambda llama a tu `FunctionHandler` para la primera invocación.

El costo específico de .NET aparece en los pasos dos y tres. CoreCLR JIT-compila cada método en la primera llamada. ASP.NET Core (cuando usas el puente de hosting de API Gateway) construye un host completo con logging, configuración, y una pipeline de option-binding. Los clientes por defecto del SDK de AWS resuelven credenciales perezosamente caminando la cadena de proveedores de credenciales, lo cual en Lambda es rápido pero aún así asigna. Los serializadores con mucha reflexión como los caminos por defecto de `System.Text.Json` inspeccionan cada propiedad de cada tipo que ven por primera vez.

Puedes tirar de cuatro palancas, en este orden, con compromisos de retornos decrecientes:

1. **Native AOT** envía un binario precompilado, así que el costo de JIT va a cero y el runtime arranca un ejecutable autocontenido pequeño.
2. **SnapStart** toma una instantánea de una fase de init ya calentada y restaura desde disco en arranque en frío.
3. **El tamaño de memoria** te compra CPU proporcional, lo cual acelera todo en init.
4. **La reutilización estática y el trimming** reducen lo que corre durante init y lo que se rehace por arranque en frío.

## Palanca 1: Native AOT en provided.al2023 (la mayor victoria individual)

Native AOT compila tu función y el runtime de .NET a un único binario estático, elimina el JIT, y reduce el arranque en frío aproximadamente al tiempo que Lambda tarda en lanzar un proceso. AWS publica [orientación de primera clase](https://docs.aws.amazon.com/lambda/latest/dg/dotnet-native-aot.html) para esto en el runtime personalizado `provided.al2023`. Con .NET 11, la cadena de herramientas coincide con lo que vino con .NET 8, pero el analizador de trim es más estricto y advertencias `ILLink` que estaban verdes en .NET 8 pueden encenderse.

La función mínima preparada para AOT se ve así:

```csharp
// .NET 11, C# 14
// PackageReference: Amazon.Lambda.RuntimeSupport 1.13.0
// PackageReference: Amazon.Lambda.Serialization.SystemTextJson 2.4.4
using System.Text.Json.Serialization;
using Amazon.Lambda.Core;
using Amazon.Lambda.RuntimeSupport;
using Amazon.Lambda.Serialization.SystemTextJson;

var serializer = new SourceGeneratorLambdaJsonSerializer<LambdaFunctionJsonContext>();

var handler = static (Request req, ILambdaContext ctx) =>
    new Response($"hello {req.Name}", DateTimeOffset.UtcNow);

await LambdaBootstrapBuilder.Create(handler, serializer)
    .Build()
    .RunAsync();

public record Request(string Name);
public record Response(string Message, DateTimeOffset At);

[JsonSerializable(typeof(Request))]
[JsonSerializable(typeof(Response))]
public partial class LambdaFunctionJsonContext : JsonSerializerContext;
```

Los switches del `csproj` que importan:

```xml
<PropertyGroup>
  <TargetFramework>net11.0</TargetFramework>
  <OutputType>Exe</OutputType>
  <PublishAot>true</PublishAot>
  <StripSymbols>true</StripSymbols>
  <InvariantGlobalization>true</InvariantGlobalization>
  <RootNamespace>MyFunction</RootNamespace>
  <AssemblyName>bootstrap</AssemblyName>
  <TieredCompilation>false</TieredCompilation>
</PropertyGroup>
```

`AssemblyName` de `bootstrap` es requerido por el runtime personalizado. `InvariantGlobalization=true` elimina ICU, ahorrando tamaño de paquete y evitando la temida inicialización de ICU en arranque en frío. Si necesitas datos de cultura reales, intercámbialo por `<PredefinedCulturesOnly>false</PredefinedCulturesOnly>` y acepta el golpe de tamaño.

Construye en Amazon Linux (o en un contenedor Linux) para que el linker coincida con el entorno Lambda:

```bash
# .NET 11 SDK
dotnet lambda package --configuration Release \
  --framework net11.0 \
  --msbuild-parameters "--self-contained true -r linux-x64 -p:PublishAot=true"
```

La herramienta global `Amazon.Lambda.Tools` empaqueta el binario `bootstrap` en un ZIP que subes como runtime personalizado. Con una función de 256 MB y el boilerplate de arriba, espera arranques en frío en el rango de **150 ms a 300 ms**, bajando de 1500-2000 ms en el runtime gestionado.

El compromiso: cada biblioteca con mucha reflexión que metas se convierte en una advertencia de trim. Los generadores de código fuente de `System.Text.Json` manejan la serialización, pero si usas algo que reflexiona sobre tipos genéricos en runtime (AutoMapper antiguo, Newtonsoft, handlers de MediatR basados en reflexión), obtendrás advertencias ILLink o una excepción en runtime. Trata cada advertencia como un bug real. Una alternativa de mediator amigable con trim se cubre en [SwitchMediator v3, un mediator zero-alloc que se mantiene amigable con AOT](/2026/01/switchmediator-v3-a-zero-alloc-mediator-that-stays-friendly-to-aot/).

## Palanca 2: SnapStart en el runtime gestionado dotnet10

Si tu código no es amigable con AOT (mucha reflexión, plugins dinámicos, EF Core 11 con construcción de modelo en runtime), Native AOT no es viable. La siguiente mejor opción es **Lambda SnapStart**, que está soportado en el **runtime gestionado `dotnet10`** hoy. A abril de 2026, el runtime gestionado `dotnet11` aún no es GA, así que el objetivo "gestionado" práctico para código .NET 11 es multi-targetear `net10.0` y correr en el runtime `dotnet10` con SnapStart habilitado, o usar el runtime personalizado descrito arriba. AWS anunció el runtime .NET 10 a finales de 2025 ([blog de AWS: .NET 10 runtime ya disponible en AWS Lambda](https://aws.amazon.com/blogs/compute/net-10-runtime-now-available-in-aws-lambda/)) y el soporte de SnapStart para runtimes .NET gestionados está documentado en [Mejorar el rendimiento de arranque con Lambda SnapStart](https://docs.aws.amazon.com/lambda/latest/dg/snapstart.html).

SnapStart congela la función después de init, toma una instantánea de la microVM Firecracker, y en arranque en frío restaura la instantánea en lugar de correr init de nuevo. Para .NET, donde init es la parte cara, esto típicamente reduce los arranques en frío en 60-90%.

Dos cosas importan para la corrección de SnapStart:

1. **Determinismo tras restaurar.** Cualquier cosa capturada durante init (semillas aleatorias, tokens específicos de máquina, sockets de red, cachés derivadas del tiempo) se comparte entre cada instancia restaurada. Usa los hooks de runtime que AWS proporciona:

```csharp
// .NET 10 target multi-targeted with .NET 11
using Amazon.Lambda.RuntimeSupport;

Core.SnapshotRestore.RegisterBeforeSnapshot(() =>
{
    // flush anything that should not be captured
    return ValueTask.CompletedTask;
});

Core.SnapshotRestore.RegisterAfterRestore(() =>
{
    // re-seed RNG, refresh credentials, reopen sockets
    return ValueTask.CompletedTask;
});
```

2. **Pre-JIT lo que quieras que esté caliente.** SnapStart captura el estado JITeado. La compilación por niveles no habrá promovido los métodos calientes a tier-1 todavía durante init, así que obtienes una instantánea de código mayormente tier-0 a menos que lo empujes. Camina el camino caliente una vez durante init (llama a tu handler con un payload de calentamiento sintético, o invoca métodos clave explícitamente) para que la instantánea incluya sus formas JITeadas. Con `<TieredPGO>true</TieredPGO>` (el default en .NET 11), esto importa un poco menos, pero aún ayuda mensurablemente.

SnapStart es gratis para runtimes .NET gestionados hoy, con la advertencia de que la creación de instantáneas añade un pequeño retraso a los despliegues.

## Palanca 3: el tamaño de memoria compra CPU

Lambda asigna CPU proporcional a memoria. A 128 MB obtienes una fracción de vCPU. A 1769 MB obtienes una vCPU completa, y por encima de eso obtienes más de una. **Init corre en la misma CPU proporcional**, así que una función configurada a 256 MB paga una factura de JIT y DI significativamente más lenta que el mismo código a 1769 MB.

Números concretos para una pequeña Lambda de API mínima de ASP.NET Core:

| Memoria | INIT_DURATION (gestionado dotnet10) | INIT_DURATION (Native AOT) |
| ------- | ----------------------------------- | -------------------------- |
| 256 MB  | ~1800 ms                            | ~280 ms                    |
| 512 MB  | ~1100 ms                            | ~200 ms                    |
| 1024 MB | ~700 ms                             | ~180 ms                    |
| 1769 MB | ~480 ms                             | ~160 ms                    |

La conclusión no es "siempre usa 1769 MB". Es que no puedes concluir nada sobre arranque en frío a 256 MB. Mide al tamaño de memoria que realmente planeas desplegar, y recuerda que **la [máquina de estado AWS Lambda Power Tuning](https://github.com/alexcasalboni/aws-lambda-power-tuning)** encuentra el tamaño de memoria óptimo en costo para tu carga de trabajo en unos minutos.

## Palanca 4: reutilización estática y trimming del grafo init

Una vez elegido el runtime y la memoria, las victorias restantes vienen de hacer menos trabajo durante init y reutilizar más entre invocaciones. Tres patrones cubren la mayor parte de lo que vale la pena hacer.

### Subir clientes y serializadores a campos estáticos

Lambda reutiliza el mismo entorno de ejecución entre invocaciones hasta que se enfría. Cualquier cosa que pongas en un campo estático sobrevive. El error clásico es asignar un `HttpClient` o cliente del SDK de AWS dentro del handler:

```csharp
// .NET 11 - bad: per-invocation construction
public async Task<Response> Handler(Request req, ILambdaContext ctx)
{
    using var http = new HttpClient(); // pays DNS, TCP, TLS every time
    var s3 = new AmazonS3Client();      // re-resolves credentials chain
    // ...
}
```

Súbelos:

```csharp
// .NET 11 - good: shared across warm invocations
public sealed class Function
{
    private static readonly HttpClient Http = new();
    private static readonly AmazonS3Client S3 = new();

    public async Task<Response> Handler(Request req, ILambdaContext ctx)
    {
        // reuses Http and S3 across warm invocations on the same instance
    }
}
```

Este patrón está documentado en [Cómo hacer pruebas unitarias de código que usa HttpClient](/es/2026/04/how-to-unit-test-code-that-uses-httpclient/), que cubre el ángulo de testabilidad. Para Lambda, la regla es simplemente: cualquier cosa cara de construir y segura de reutilizar va estática.

### Usa siempre generadores de código fuente de System.Text.Json

`System.Text.Json` por defecto reflexiona sobre tus tipos DTO en el primer uso, lo que infla el tiempo de init y es incompatible con Native AOT. Los generadores de código fuente hacen el trabajo en tiempo de compilación:

```csharp
// .NET 11
[JsonSerializable(typeof(APIGatewayProxyRequest))]
[JsonSerializable(typeof(APIGatewayProxyResponse))]
[JsonSerializable(typeof(MyDomainObject))]
public partial class LambdaJsonContext : JsonSerializerContext;
```

Pasa el context generado a `SourceGeneratorLambdaJsonSerializer<T>`. Esto recorta cientos de milisegundos de los arranques en frío del runtime gestionado y es obligatorio para AOT.

### Evita ASP.NET Core completo cuando no lo necesitas

El adaptador `Amazon.Lambda.AspNetCoreServer.Hosting` te deja correr una API mínima real de ASP.NET Core detrás de API Gateway. Es una gran victoria de DX, pero levanta el host entero de ASP.NET Core: proveedores de configuración, proveedores de logging, validación de opciones, el grafo de routing. Para una Lambda de 5 endpoints, eso son cientos de milisegundos de init. Compáralo con un handler escrito a mano con `LambdaBootstrapBuilder`, que arranca en decenas de milisegundos.

Elige deliberadamente:

-   **Muchos endpoints, pipeline complejo, quieres middleware**: el hosting de ASP.NET Core está bien, toma la ruta SnapStart.
-   **Un handler, una ruta, el rendimiento importa**: escribe un handler crudo contra `Amazon.Lambda.RuntimeSupport`. Si también quieres formas de petición HTTP, acepta `APIGatewayHttpApiV2ProxyRequest` directamente.

### ReadyToRun cuando AOT es demasiado restrictivo

Si no puedes enviar Native AOT por una dependencia con mucha reflexión, pero tampoco puedes usar SnapStart (quizás porque apuntas a un runtime gestionado que aún no lo soporta), habilita **ReadyToRun**. R2R precompila IL a código nativo que el JIT puede usar sin recompilar en la primera llamada. Recorta el costo de JIT en aproximadamente 50-70% en arranque en frío al precio de un paquete más grande:

```xml
<PropertyGroup>
  <PublishReadyToRun>true</PublishReadyToRun>
  <PublishReadyToRunComposite>true</PublishReadyToRunComposite>
</PropertyGroup>
```

R2R es usualmente una victoria de 100-300 ms de arranque en frío en el runtime gestionado. Apila con todo lo demás y es esencialmente gratis, así que es lo primero que probar si no puedes moverte a AOT o SnapStart.

## Leer INIT_DURATION correctamente

La línea `REPORT` de CloudWatch para una invocación arrancada en frío tiene la forma:

```
REPORT RequestId: ... Duration: 12.34 ms Billed Duration: 13 ms
Memory Size: 512 MB Max Memory Used: 78 MB Init Duration: 412.56 ms
```

`Init Duration` es el costo de arranque en frío: arranque de VM + init de runtime + tu constructor estático y construcción de la clase handler. Algunas reglas para leerlo:

-   `Init Duration` **no se factura** en el runtime gestionado. Sí en runtimes personalizados AOT vía el modelo `provided.al2023`.
-   La primera invocación por instancia concurrente lo muestra. Las invocaciones calientes lo omiten.
-   Las funciones SnapStart reportan `Restore Duration` en lugar de `Init Duration`. Esa es tu métrica de arranque en frío en SnapStart.
-   `Max Memory Used` es la marca de agua máxima. Si se mantiene por debajo de ~30% de `Memory Size`, es probable que estés sobreaprovisionado y podrías intentar un tamaño menor, pero solo después de medir al tamaño menor ya que la CPU baja con la memoria.

La herramienta que hace esto legible: una consulta de CloudWatch Log Insights como

```
fields @timestamp, @initDuration, @duration
| filter @type = "REPORT"
| sort @timestamp desc
| limit 200
```

Para trazas más profundas, [Cómo perfilar una app .NET con dotnet-trace y leer la salida](/es/2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output/) cubre cómo capturar y leer un flame graph de init desde una sesión local de emulador Lambda.

## La concurrencia provisionada es la salida de emergencia, no la respuesta

La concurrencia provisionada mantiene `N` instancias calientes permanentemente. Los arranques en frío en esas instancias son cero, porque no están frías. Es la respuesta correcta cuando tienes un SLO de latencia duro que las palancas de arriba no pueden cumplir, o cuando la semántica de restauración de SnapStart entra en conflicto con tu código. Es la respuesta incorrecta como sustituto de optimizar realmente init: estás pagando por capacidad caliente 24/7 para enmascarar un problema arreglable, y la factura escala con el número de instancias que mantienes calientes. Usa Application Auto Scaling para escalar concurrencia provisionada en un horario si tu tráfico es predecible.

## El orden en que aplico esto en producción

A través de aproximadamente una docena de Lambdas .NET que he ajustado:

1. **Siempre**: JSON con generador de código fuente, campos estáticos para clientes, R2R encendido, `InvariantGlobalization=true` si es independiente del locale.
2. **Si está libre de reflexión**: Native AOT en `provided.al2023`. Esto solo usualmente le gana a cada otra palanca combinada.
3. **Si la reflexión es inevitable**: runtime gestionado `dotnet10` con SnapStart, más una llamada de calentamiento sintético durante init para pre-JITear el camino caliente.
4. **Verifica** con INIT_DURATION al tamaño de memoria de despliegue real. Usa Power Tuning si la curva costo-vs-latencia importa.
5. **Concurrencia provisionada** solo después de lo anterior, y solo con auto-escalado.

El resto de la historia de Lambda con .NET 11 (versiones de runtime, forma de despliegue, qué cambia si volteas de `dotnet10` a un futuro runtime gestionado `dotnet11`) se cubre en [AWS Lambda soporta .NET 10: qué verificar antes de voltear el runtime](/2026/01/aws-lambda-supports-net-10-what-to-verify-before-you-flip-the-runtime/), que es el compañero de este post.

## Fuentes

-   [Compilar el código de función Lambda .NET a un formato de runtime nativo](https://docs.aws.amazon.com/lambda/latest/dg/dotnet-native-aot.html) - docs de AWS.
-   [Mejorar el rendimiento de arranque con Lambda SnapStart](https://docs.aws.amazon.com/lambda/latest/dg/snapstart.html) - docs de AWS.
-   [.NET 10 runtime ya disponible en AWS Lambda](https://aws.amazon.com/blogs/compute/net-10-runtime-now-available-in-aws-lambda/) - blog de AWS.
-   [Visión general de runtimes de Lambda](https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtimes.html) - incluyendo `provided.al2023`.
-   [aws/aws-lambda-dotnet](https://github.com/aws/aws-lambda-dotnet) - el código fuente de `Amazon.Lambda.RuntimeSupport`.
-   [AWS Lambda Power Tuning](https://github.com/alexcasalboni/aws-lambda-power-tuning) - el ajustador costo-vs-latencia.
