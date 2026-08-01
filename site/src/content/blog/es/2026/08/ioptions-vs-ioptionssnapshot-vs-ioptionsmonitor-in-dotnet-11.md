---
title: "IOptions<T> vs IOptionsSnapshot<T> vs IOptionsMonitor<T> en .NET 11"
description: "Usa IOptions<T> por defecto. Usa IOptionsMonitor<T> cuando un singleton debe ver recargas de configuración, e IOptionsSnapshot<T> solo cuando un consumidor scoped necesita un valor estable durante una solicitud. El eje que decide es el tiempo de vida del consumidor, no la forma de la configuración."
pubDate: 2026-08-01
template: vs
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "dependency-injection"
lang: "es"
translationOf: "2026/08/ioptions-vs-ioptionssnapshot-vs-ioptionsmonitor-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-08-01
---

Inyecta `IOptions<T>` salvo que tengas una razón concreta para no hacerlo. Es un singleton, enlaza tu clase de configuración exactamente una vez durante toda la vida del proceso y es el más barato de los tres al resolverse. Recurre a `IOptionsMonitor<T>` cuando un servicio de larga vida debe observar cambios de configuración sin reiniciar, y a `IOptionsSnapshot<T>` en un caso muy concreto: un consumidor scoped o transient que quiere un valor estable durante una sola solicitud pero que puede diferir entre solicitudes. El eje que decide esto es el tiempo de vida de la clase que hace la inyección, no la forma de la configuración inyectada. Todo lo que sigue apunta a .NET 11 (probado contra Preview 6, SDK `11.0.100-preview.6.26359.118`) y C# 14, con `Microsoft.Extensions.Options` 11.0.0. Las tres interfaces se comportan así desde .NET Core 2.0, así que todo esto funciona sin cambios en .NET 10 GA; lo único realmente nuevo es el trabajo de validación de .NET 11 al final.

## La matriz de características

| Característica | `IOptions<T>` | `IOptionsSnapshot<T>` | `IOptionsMonitor<T>` |
| --- | --- | --- | --- |
| Implementación concreta | `UnnamedOptionsManager<T>` | `OptionsManager<T>` | `OptionsMonitor<T>` |
| Tiempo de vida en DI | Singleton | **Scoped** | Singleton |
| Inyectable en un singleton | Sí | No, dependencia cautiva | Sí |
| Ve una recarga de configuración | Nunca | Sí, en el siguiente scope | Sí, de inmediato |
| Opciones con nombre | No | Sí, `Get(name)` | Sí, `Get(name)` |
| Callbacks de cambio | No | No | Sí, `OnChange` |
| Acceso al valor | `.Value` | `.Value`, `.Get(name)` | `.CurrentValue`, `.Get(name)` |
| Cada cuánto corre el binder | Una vez por proceso | Una vez por scope, por nombre | Una vez por cambio, por nombre |
| Dónde se cachea la instancia | Campo del singleton | `OptionsCache<T>` dentro del manager scoped | `IOptionsMonitorCache<T>` singleton |

Dos filas cargan con casi todo el peso. La fila del tiempo de vida es la que produce excepciones al arrancar, y la fila de "cada cuánto corre el binder" es la que produce CPU inesperada en una ruta caliente. Todo lo demás se deriva de esas dos.

Las tres las registra `AddOptions()`, que el host llama por ti. De [OptionsServiceCollectionExtensions](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.Options/src/OptionsServiceCollectionExtensions.cs):

```csharp
// Microsoft.Extensions.Options 11.0.0 -- what AddOptions() actually registers
services.TryAdd(ServiceDescriptor.Singleton(typeof(IOptions<>), typeof(UnnamedOptionsManager<>)));
services.TryAdd(ServiceDescriptor.Scoped(typeof(IOptionsSnapshot<>), typeof(OptionsManager<>)));
services.TryAdd(ServiceDescriptor.Singleton(typeof(IOptionsMonitor<>), typeof(OptionsMonitor<>)));
services.TryAdd(ServiceDescriptor.Transient(typeof(IOptionsFactory<>), typeof(OptionsFactory<>)));
services.TryAdd(ServiceDescriptor.Singleton(typeof(IOptionsMonitorCache<>), typeof(OptionsCache<>)));
```

Fíjate en que `IOptionsFactory<T>` es transient y hace el trabajo real: ejecuta cada `IConfigureOptions<T>` registrado en orden, luego cada `IPostConfigureOptions<T>`, y después la validación. Las tres interfaces de acceso solo se diferencian en con cuánta agresividad cachean la salida de la fábrica. Esa es toda la historia, y por eso la elección es sobre tiempo de vida.

La clase de configuración y el registro son idénticos para las tres:

```csharp
// .NET 11, C# 14
public sealed class PaymentOptions
{
    public string ApiKey { get; set; } = "";
    public int TimeoutSeconds { get; set; } = 30;
}

// Program.cs
builder.Services.Configure<PaymentOptions>(
    builder.Configuration.GetSection("Payment"));
```

## Cuándo elegir IOptions

Que sea tu opción por defecto. Renuncias al soporte de recarga, y en la mayoría de los servicios eso no es una pérdida real.

- **Todo lo que se lee al arrancar.** Cadenas de conexión, una URL base, el nombre de una cola, un feature flag que cambiarías con un redespliegue. `IOptions<T>` es un singleton, así que inyectarlo en un singleton, en un servicio scoped o en uno transient funciona igual. Si obtienes un error `Cannot consume scoped service` mientras cableas tu configuración, `IOptions<T>` suele ser la solución y no la causa. Mira [por qué ocurre esa excepción y cómo desenredarla](/es/2026/05/fix-cannot-consume-scoped-service-from-singleton/).
- **Rutas calientes.** `UnnamedOptionsManager<T>` cachea la instancia enlazada en un campo. Tras el primer acceso, `.Value` es una lectura de campo. No hay búsqueda en diccionario, ni comparación de nombres, ni asignación de memoria.
- **Capturar en el constructor es seguro.** Como el valor nunca puede cambiar, `options.Value` en un constructor es correcto y no un bug latente.

```csharp
// .NET 11, C# 14
public sealed class PaymentClient(IOptions<PaymentOptions> options)
{
    // Safe: the value is fixed for the life of the process.
    private readonly PaymentOptions _settings = options.Value;

    public TimeSpan Timeout => TimeSpan.FromSeconds(_settings.TimeoutSeconds);
}
```

El costo de `IOptions<T>` es exactamente uno: no admite opciones con nombre, así que `Configure<Features>("Personalize", ...)` le resulta invisible. Si necesitas dos configuraciones de la misma clase, ya descartaste `IOptions<T>`. Ese es también el momento de revisar si [los servicios con clave en la inyección de dependencias de .NET 11](/es/2026/06/how-to-register-and-resolve-keyed-services-in-dotnet-11-dependency-injection/) encajan mejor que las opciones con nombre para lo que realmente estás modelando.

## Cuándo elegir IOptionsSnapshot

Recurre a él cuando un consumidor **scoped** necesita un valor que se mantenga consistente durante una unidad de trabajo pero que pueda moverse entre unidades de trabajo.

- **Un valor por solicitud que no debe cambiar a mitad de camino.** Un controlador y tres servicios a los que llama resuelven la misma instancia scoped de `OptionsManager<T>`, así que los cuatro ven la misma instancia de `PaymentOptions` incluso si `appsettings.json` se reescribe a mitad de la solicitud. `IOptionsMonitor<T>` no da esa garantía: dos lecturas de `CurrentValue` en la misma solicitud pueden devolver dos instancias distintas.
- **Opciones con nombre en un consumidor scoped.** `Get(name)` está soportado, y la `OptionsCache<T>` por scope hace que el segundo `Get("Personalize")` de la solicitud sea un acierto de caché.

```csharp
// .NET 11, C# 14 -- scoped service, values stable for this request
public sealed class CheckoutService(IOptionsSnapshot<PaymentOptions> snapshot)
{
    private readonly PaymentOptions _settings = snapshot.Value;

    public string Key => _settings.ApiKey;
}
```

Dos límites duros. Primero, `IOptionsSnapshot<T>` se registra como `Scoped`, así que inyectarlo en un singleton falla, incluyendo dentro de un `IHostedService` o `BackgroundService`, que son singletons. El host activa `ValidateScopes` y `ValidateOnBuild` en el entorno Development, así que ahí obtienes un `Cannot consume scoped service` claro al arrancar; fuera de Development esas comprobaciones están desactivadas por defecto, y el mismo código resuelve una dependencia cautiva que nunca se refresca en silencio. Activa la validación de scopes en todos los entornos si quieres que el fallo sea ruidoso. La solución alternativa es [crear un scope dentro del BackgroundService](/es/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/) y resolver desde ahí, pero si lo único que querías eran valores frescos, `IOptionsMonitor<T>` es la respuesta más simple. Segundo, en una aplicación de consola o en un `IHost` puro no hay un scope ambiente salvo que lo crees, así que `IOptionsSnapshot<T>` fuera de un host web casi siempre significa que en realidad querías `IOptionsMonitor<T>`.

## Cuándo elegir IOptionsMonitor

Recurre a él cuando un **singleton** debe ver cambios, o cuando necesitas un callback.

- **Un singleton que no debe reiniciarse para tomar un valor nuevo.** Un limitador de tasa, una política de caché, un porcentaje de muestreo, un nivel de registro.
- **Necesitas reaccionar, no solo leer.** `OnChange` es la única notificación push de las tres.
- **Invalidación selectiva.** `IOptionsMonitorCache<T>.TryRemove(name)` fuerza que una sola instancia con nombre se reconstruya en el siguiente acceso, útil cuando es tu propio código, y no un vigilante de archivos, el que sabe que el valor quedó obsoleto.

`OptionsMonitor<T>` se suscribe a cada `IOptionsChangeTokenSource<T>` registrado. Cuando uno se dispara, `InvokeChanged` ejecuta `_cache.TryRemove(name)`, reconstruye de inmediato con `TOptions options = Get(name)` y luego invoca a los oyentes con la instancia nueva. `CurrentValue` es una envoltura delgada sobre `Get(Options.DefaultName)`, que es `_cache.GetOrAdd(localName, () => localFactory.Create(localName))`.

```csharp
// .NET 11, C# 14 -- singleton, always current
public sealed class RateLimiter : IDisposable
{
    private readonly IDisposable? _subscription;
    private volatile PaymentOptions _current;

    public RateLimiter(IOptionsMonitor<PaymentOptions> monitor)
    {
        _current = monitor.CurrentValue;
        _subscription = monitor.OnChange(updated => _current = updated);
    }

    public int TimeoutSeconds => _current.TimeoutSeconds;

    public void Dispose() => _subscription?.Dispose();
}
```

Ese `IDisposable` importa. `OnChange` devuelve un `ChangeTrackerDisposable` cuyo `Dispose` ejecuta `_monitor._onChange -= OnChange`. Registra un callback desde un servicio scoped o transient y tira el valor devuelto, y cada solicitud añade un oyente al delegado multicast de un singleton que nunca se quita. El resultado es una fuga de memoria lenta más una tormenta de callbacks, y es una de las formas más comunes en que un `IOptionsMonitor<T>` sale mal.

Las notificaciones de cambio solo existen para los proveedores de configuración basados en el sistema de archivos, como `Microsoft.Extensions.Configuration.Json`, `.Ini`, `.Xml`, `.KeyPerFile` y `.UserSecrets`, y solo cuando el proveedor se agregó con `reloadOnChange: true`. Un proveedor de variables de entorno o de línea de comandos nunca se dispara, así que sobre esas fuentes `IOptionsMonitor<T>` degrada en silencio a un `IOptions<T>` algo más caro.

## La medición que importa es un conteo, no una cifra en nanosegundos

A propósito no publico cifras de ns/op aquí, porque el costo de resolución de los tres está dominado por lo que hagan tus propios delegados `IConfigureOptions<T>` y tus validadores, lo que significa que los números de mi máquina no te dirían nada sobre la tuya. El número que sí es portable es **cuántas veces corre tu binder**, y puedes medirlo en unas quince líneas.

```csharp
// .NET 11 Preview 6, C# 14 -- counts how often the options are actually built
public sealed class CountingConfigure : IConfigureOptions<PaymentOptions>
{
    public static int Count;
    public void Configure(PaymentOptions options) => Interlocked.Increment(ref Count);
}

builder.Services.AddSingleton<IConfigureOptions<PaymentOptions>, CountingConfigure>();

app.MapGet("/probe", (
    IOptions<PaymentOptions> o,
    IOptionsSnapshot<PaymentOptions> s,
    IOptionsMonitor<PaymentOptions> m) =>
{
    _ = o.Value; _ = s.Value; _ = m.CurrentValue;
    return CountingConfigure.Count;
});
```

Golpea `/probe` repetidamente y el contador sube exactamente en uno por solicitud, y ese uno es el `IOptionsSnapshot<T>`. `IOptions<T>` aporta solo en la primera solicitud, `IOptionsMonitor<T>` aporta en la primera solicitud y luego una vez por recarga, e `IOptionsSnapshot<T>` aporta en cada solicitud porque un scope nuevo significa un `OptionsManager<T>` nuevo con una `OptionsCache<T>` vacía. Agrega `.ValidateDataAnnotations()` a ese registro y los validadores también se vuelven a ejecutar en cada solicitud. En un endpoint que hace 5 000 solicitudes por segundo, eso son 5 000 reenlaces y 5 000 pasadas de validación por segundo para un valor que casi nunca cambia. Esta es la razón concreta por la que `IOptionsSnapshot<T>` no debería ser tu opción por defecto, y es una afirmación que puedes verificar en tu propia aplicación en lugar de aceptarla de un gráfico.

## Los detalles que deciden por ti

**`OnChange` se dispara por configuración que no te importa.** Los callbacks están conectados al token de cambio de la raíz de configuración, no a tu sección. Cualquier escritura en cualquier parte de `IConfiguration` invoca a todos los oyentes de `IOptionsMonitor<T>` de la aplicación. El equipo de .NET lo registró como [dotnet/runtime#109445](https://github.com/dotnet/runtime/issues/109445) y lo cerró como no planificado, así que el comportamiento es permanente: mientras cualquier parte de la configuración cambie, todas las instancias de `IOptionsMonitor` pueden disparar sus callbacks. Si tu callback reconstruye un recurso caro, cachea el valor anterior y compara antes de actuar.

**`OnChange` también se dispara más de una vez por guardado.** Los editores escriben archivos en varias operaciones, y el `IFileProvider.Watch` subyacente reporta cada una, así que un solo `Ctrl+S` produce comúnmente dos callbacks y a veces más. Esto es [dotnet/aspnetcore#2542](https://github.com/dotnet/aspnetcore/issues/2542), y es un artefacto del vigilante de archivos, no un bug de la pila de opciones. Haz tu callback idempotente o aplícale un debounce.

**El seguimiento de archivos no es confiable en volúmenes de Docker ni en recursos compartidos de red.** Configura `DOTNET_USE_POLLING_FILE_WATCHER=1` para sondear en su lugar. El intervalo de sondeo es de cuatro segundos y no es configurable, lo cual es una restricción real si contabas con una propagación más rápida.

**`IOptions<T>` de verdad significa para siempre.** El valor se enlaza la primera vez que se lee `.Value` y se cachea durante toda la vida del proceso. Si el modelo mental de tu equipo es "el objeto de configuración se refresca", `IOptions<T>` parecerá roto durante un incidente cuando un cambio de configuración no haga nada. Decide esto por cada clase de configuración y déjalo escrito.

**Configurar opciones con servicios scoped es una trampa sin importar el acceso que uses.** `IConfigureOptions<T>` se resuelve a través del proveedor raíz para `IOptions<T>`, así que una dependencia scoped inyectada en tu delegado de configuración se convierte en una dependencia cautiva. Resuelve un `IServiceProvider` y crea un scope dentro de `Configure`, y recuerda que ese scope no es el scope de la solicitud.

## Lo que aporta .NET 11

Dos cosas que vale la pena conocer, ambas en la capa de validación y no en la de acceso.

`OptionsBuilder<TOptions>` gana una sobrecarga genérica de `Validate` que toma un parámetro de tipo en lugar de un delegado. El tipo debe implementar `IValidateOptions<TOptions>` y estar registrado en DI, lo que alinea la validación de opciones con el patrón normal de DI:

```csharp
// .NET 11, C# 14
services.AddSingleton<IValidateOptions<MyOptions>, MyOptionsValidator>();
services.AddOptions<MyOptions>()
    .Bind(configuration.GetSection("MyOptions"))
    .Validate<MyOptionsValidator>();
```

`System.ComponentModel.DataAnnotations` también aprendió validación asíncrona en .NET 11, vía `AsyncValidationAttribute`, `IAsyncValidatableObject` y `Validator.ValidateObjectAsync`. `Microsoft.Extensions.Options` lo recoge mediante un nuevo `IAsyncStartupValidator`, así que una opción cuya validez depende de una llamada de red puede hacer fallar la aplicación al arrancar en lugar de en el primer uso. Ninguno de los dos cambios altera qué acceso deberías inyectar; ambos hacen de `ValidateOnStart` una opción por defecto más fuerte de lo que era en .NET 10.

## La recomendación, otra vez

Empieza cada clase de configuración con `IOptions<T>`. Pasa a `IOptionsMonitor<T>` cuando un singleton concreto tenga una necesidad documentada de observar cambios, y libera la suscripción de `OnChange`. Usa `IOptionsSnapshot<T>` solo cuando un consumidor scoped necesite estabilidad por solicitud de un valor que de verdad cambia, y acepta que estás pagando un reenlace completo más una revalidación en cada solicitud para conseguirlo. Si te descubres recurriendo a `IOptionsSnapshot<T>` porque desapareció un error de compilación, resolviste un problema de tiempo de vida con un problema de rendimiento.

## Relacionado

- [Fix: Cannot consume scoped service 'X' from singleton 'Y'](/es/2026/05/fix-cannot-consume-scoped-service-from-singleton/)
- [Cómo usar servicios scoped dentro de un BackgroundService en ASP.NET Core 11](/es/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/)
- [Cómo registrar y resolver servicios con clave en la inyección de dependencias de .NET 11](/es/2026/06/how-to-register-and-resolve-keyed-services-in-dotnet-11-dependency-injection/)
- [Fix: No connection string named 'DefaultConnection' could be found](/es/2026/05/fix-no-connection-string-named-defaultconnection/)
- [Cómo escribir pruebas de integración con WebApplicationFactory en ASP.NET Core 11](/es/2026/07/how-to-write-integration-tests-with-webapplicationfactory-in-aspnetcore-11/)

## Fuentes

- [Patrón de opciones en .NET](https://learn.microsoft.com/en-us/dotnet/core/extensions/options), Microsoft Learn
- [Novedades de las bibliotecas de .NET 11](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/libraries), Microsoft Learn
- [OptionsServiceCollectionExtensions.cs](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.Options/src/OptionsServiceCollectionExtensions.cs), dotnet/runtime
- [OptionsMonitor.cs](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.Options/src/OptionsMonitor.cs), dotnet/runtime
- [IOptionsMonitor OnChange se dispara cada vez que algo cambia en IConfiguration](https://github.com/dotnet/runtime/issues/109445), issue 109445 de dotnet/runtime
- [ChangeToken.OnChange se dispara dos veces al escuchar cambios de configuración](https://github.com/dotnet/aspnetcore/issues/2542), issue 2542 de dotnet/aspnetcore
- [Los peligros y trampas de usar servicios scoped al configurar opciones](https://andrewlock.net/the-dangers-and-gotchas-of-using-scoped-services-when-configuring-options-in-asp-net-core/), Andrew Lock
