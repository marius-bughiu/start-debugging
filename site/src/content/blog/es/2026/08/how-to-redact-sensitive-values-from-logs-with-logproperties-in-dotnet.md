---
title: "Cómo redactar valores sensibles de los registros con LogProperties y redacción de datos en .NET"
description: "Guía completa para redactar datos clasificados en registros generados por código fuente: construye una taxonomía, escribe un Redactor, conecta EnableRedaction y AddRedaction, y entiende el discriminador que rompe silenciosamente el enmascarado parcial. Con salida real de Microsoft.Extensions.Compliance.Redaction 10.9.0."
pubDate: 2026-08-17
template: how-to
tags:
  - "dotnet"
  - "logging"
  - "security"
  - "source-generators"
lang: "es"
translationOf: "2026/08/how-to-redact-sensitive-values-from-logs-with-logproperties-in-dotnet"
translatedBy: "claude"
translationDate: 2026-08-17
---

Redactar valores sensibles en los registros de .NET requiere tres piezas que deben estar todas presentes: un atributo de clasificación de datos sobre la propiedad, `AddRedaction` para registrar los redactores en la inyección de dependencias, y `EnableRedaction` en el builder de registro. Si falta la clasificación, no se protege nada. Si falta `EnableRedaction`, los valores clasificados se eliminan por completo del estado estructurado. Si falta `AddRedaction` mientras `EnableRedaction` está activo, los valores en crudo se escriben en tus registros en texto plano. Este artículo recorre las tres piezas, más el discriminador de redacción que rompe sin avisar cualquier redactor que haga enmascarado parcial.

Todo lo que sigue se compiló y ejecutó contra `Microsoft.Extensions.Compliance.Redaction` 10.9.0, `Microsoft.Extensions.Compliance.Abstractions` 10.9.0 y `Microsoft.Extensions.Telemetry` 10.9.0, sobre el SDK de .NET 10.0.201 apuntando a `net10.0`. Estos paquetes se publican con la cadencia de `dotnet/extensions` y no con la del runtime, y 10.9.0 (publicado el 2026-08-11) apunta a `net8.0`, `net9.0`, `net10.0` y `net462`, así que el mismo código aplica desde .NET 8 hasta las previews actuales de .NET 11. Todavía no existe una versión 11.x de estos paquetes.

## Qué emite realmente el generador de código fuente para una propiedad clasificada

Toda la funcionalidad descansa sobre una sola cosa: el generador de código fuente de `[LoggerMessage]` emite los valores clasificados en un *arreglo separado* del de las etiquetas normales. Dado este método de registro:

```csharp
// Microsoft.Extensions.Telemetry.Abstractions 10.9.0, net10.0
public static partial class Log
{
    [LoggerMessage(2, LogLevel.Information, "Via LogProperties")]
    public static partial void ViaProps(this ILogger logger, [LogProperties] Payment payment);
}
```

el generador produce (recortado, pero por lo demás literal de `EmitCompilerGeneratedFiles`):

```csharp
var state = LoggerMessageHelper.ThreadLocalState;

_ = state.ReserveTagSpace(2);
state.TagArray[1] = new("{OriginalFormat}", "Via LogProperties");
state.TagArray[0] = new("payment.Amount", payment?.Amount);

_ = state.ReserveClassifiedTagSpace(2);
state.ClassifiedTagArray[1] = new("payment.CardNumber", payment?.CardNumber,
    new DataClassificationSet(_SensitiveAttribute));
state.ClassifiedTagArray[0] = new("payment.Cvv", payment?.Cvv,
    new DataClassificationSet(_SensitiveAttribute));
```

`Amount` va a `TagArray`. `CardNumber` y `Cvv` van a `ClassifiedTagArray` junto con el `DataClassificationSet` que vino del atributo. Aquí nada redacta nada: el generador solo *etiqueta* los valores. Quien consuma `LoggerMessageState` decide qué pasa después, y por eso la conexión importa tanto. Si no conoces cómo `[LoggerMessage]` genera código en primer lugar, vale la pena el desvío por [qué es un generador de código fuente y cuándo lo necesitas](/es/2026/06/what-is-a-source-generator-and-when-do-i-need-one/).

## Construir la taxonomía, los atributos y un redactor

Una clasificación es un par `(TaxonomyName, Value)`. Defínelas una sola vez en una clase estática para que toda la solución comparta un mismo vocabulario:

```csharp
// Microsoft.Extensions.Compliance.Abstractions 10.9.0
using Microsoft.Extensions.Compliance.Classification;

public static class Taxonomy
{
    public const string Name = "Contoso";

    public static DataClassification Sensitive => new(Name, nameof(Sensitive));
    public static DataClassification Pii => new(Name, nameof(Pii));
}
```

Los ejemplos de MS Learn para esta funcionalidad muestran parámetros clasificados escritos como `[MyTaxonomyClassifications.Private] string SSN`. Eso no compila: una propiedad estática no es un atributo. Necesitas una subclase real de `DataClassificationAttribute` por cada clasificación, que es lo que describe correctamente la [documentación de clasificación de datos](https://learn.microsoft.com/en-us/dotnet/core/extensions/data-classification):

```csharp
public sealed class SensitiveAttribute : DataClassificationAttribute
{
    public SensitiveAttribute() : base(Taxonomy.Sensitive) { }
}

public sealed class PiiAttribute : DataClassificationAttribute
{
    public PiiAttribute() : base(Taxonomy.Pii) { }
}
```

Ahora decora el modelo. Todo lo que no lleve atributo se registra tal cual:

```csharp
public sealed class Payment
{
    [Sensitive] public string CardNumber { get; set; } = "";
    [Pii] public string Email { get; set; } = "";
    public int Amount { get; set; }
    [LogPropertyIgnore] public string InternalTrace { get; set; } = "";
}
```

Un redactor es una clase abstracta con dos miembros. `GetRedactedLength` dimensiona el búfer de destino, `Redact` lo llena y devuelve cuántos caracteres escribió:

```csharp
// Microsoft.Extensions.Compliance.Redaction 10.9.0
using Microsoft.Extensions.Compliance.Redaction;

public sealed class LastFourRedactor : Redactor
{
    public override int GetRedactedLength(ReadOnlySpan<char> input)
        => input.Length <= 4 ? input.Length : 4 + 4;

    public override int Redact(ReadOnlySpan<char> source, Span<char> destination)
    {
        if (source.Length <= 4)
        {
            source.CopyTo(destination);
            return source.Length;
        }

        "****".CopyTo(destination);
        source[^4..].CopyTo(destination[4..]);
        return 8;
    }
}
```

La firma basada en spans es deliberada: la tubería de registro redacta de span a span a través de un `JustInTimeRedactor` agrupado, así que un redactor bien escrito no reserva memoria por cada registro.

## Cómo conectarlo

Cuatro pasos, y los cuatro son imprescindibles:

1. Instala `Microsoft.Extensions.Compliance.Redaction` para los redactores y `Microsoft.Extensions.Telemetry` para la integración con el registro. Los tipos de clasificación llegan de forma transitiva desde `Microsoft.Extensions.Compliance.Abstractions`.
2. Llama a `AddRedaction` sobre la colección de servicios y asigna cada clasificación a un redactor.
3. Llama a `EnableRedaction` sobre el builder de registro. Esto sustituye por `ExtendedLogger`, el único componente que lee `ClassifiedTagArray`.
4. Registra a través de un método `[LoggerMessage]` generado por código fuente. La redacción no aplica a `logger.LogInformation(...)`.

```csharp
var services = new ServiceCollection();

services.AddLogging(b =>
{
    b.AddJsonConsole();
    b.EnableRedaction();          // Microsoft.Extensions.Logging namespace
});

services.AddRedaction(r =>
{
    r.SetRedactor<LastFourRedactor>(Taxonomy.Sensitive);
    r.SetFallbackRedactor<ErasingRedactor>();
});
```

`EnableRedaction` vive en el espacio de nombres `Microsoft.Extensions.Logging` a pesar de distribuirse en el paquete `Microsoft.Extensions.Telemetry`, así que el `using Microsoft.Extensions.Telemetry;` del ejemplo oficial no hace falta.

## Las tres configuraciones y lo que realmente registra cada una

Aquí es donde la funcionalidad muerde. Este es el mismo `Payment` registrado bajo tres conexiones distintas, tomado de la salida real de `JsonConsole`.

**`AddRedaction` registrado, `EnableRedaction` sin llamar.** El `ILogger` normal nunca mira `ClassifiedTagArray`, así que las propiedades clasificadas están ausentes del estado estructurado y el mensaje aplanado muestra un marcador de posición:

```json
{"State":{"Message":"customer.Plan=enterprise,customer.Id=42,customer.CardNumber=<omitted> ([Contoso:Sensitive]),customer.Email=<omitted> ([Contoso:Pii])","customer.Plan":"enterprise","customer.Id":42}}
```

No hay fuga, pero tampoco hay datos, y ningún error te avisa de que la redacción está apagada. Este comportamiento está registrado en el [issue 5163 de dotnet/extensions](https://github.com/dotnet/extensions/issues/5163).

**`EnableRedaction` llamado, `AddRedaction` nunca llamado.** Este es el peligroso. Sin ningún `IRedactorProvider` en el contenedor, la tubería cae a un redactor de paso directo y escribe el valor en crudo:

```json
{"State":{"customer.CardNumber":"4111111111111111:customer.CardNumber","customer.Email":"ada@contoso.com:customer.Email"}}
```

Tus números de tarjeta están ahora en el archivo de registro, con el nombre de la etiqueta añadido amablemente. Nada te avisa. Si te llevas una sola cosa de este artículo: `EnableRedaction` y `AddRedaction` deben añadirse juntos, y una prueba de integración que busque un secreto conocido en el destino de los registros es un seguro barato.

**Ambos llamados.** Los valores clasificados se redactan, los no clasificados pasan intactos, y las propiedades con `[LogPropertyIgnore]` no aparecen en absoluto:

```json
{"State":{"payment.Email":"****","payment.CardNumber":"****","payment.Amount":1999}}
```

Llamar a `AddRedaction()` sin ninguna configuración es seguro: el respaldo por defecto es `ErasingRedactor`, así que todo valor clasificado se convierte en una cadena vacía. Verificado directamente contra el proveedor, `GetRedactor` devuelve `ErasingRedactor` para una clasificación sin asignar y para `DataClassification.Unknown`, y `NullRedactor` (paso directo) solo para `DataClassification.None`.

## El discriminador que rompe el enmascarado parcial

Registra el `LastFourRedactor` de antes, registra un número de tarjeta `4111111111111111`, y obtienes esto:

```json
{"payment.CardNumber":"****mber","payment.Email":"****mail"}
```

`mber` son los últimos cuatro caracteres de `payment.CardNumber`, no los de la tarjeta. El redactor nunca vio el valor por sí solo. Instrumentar `Redact` con un espía muestra exactamente qué llega:

```text
[spy] Redact saw: "4111111111111111:payment.CardNumber" (len 35)
[spy] Redact saw: "ada@contoso.com:payment.Email"      (len 29)
```

Esto es intencional, no un fallo. `ExtendedLogger` construye cada redacción a través de `JustInTimeRedactor.Get(value, redactor, discriminator)` donde el discriminador es el nombre de la etiqueta, y `LoggerRedactionOptions.ApplyDiscriminator` vale `true` por defecto. La razón documentada es la resistencia a la correlación: incluir el nombre de la etiqueta en el texto redactado hace imposible saber que un `user.Email` con hash y un `contact.Email` con hash son la misma dirección. Ese es un valor por defecto genuinamente bueno para redactores que hacen hash, y un fallo de corrección silencioso para cualquier cosa que inspeccione la entrada.

La solución es una sola opción:

```csharp
b.EnableRedaction(o => o.ApplyDiscriminator = false);
```

Con el discriminador apagado, el mismo redactor produce lo que esperabas:

```json
{"payment.CardNumber":"****1111","payment.Email":"****.com"}
```

Apágalo solo para los redactores que necesitan ver el valor real. Si dependes de valores con hash para detectar reincidentes dentro de un mismo campo, déjalo encendido. Ten en cuenta que un redactor invocado directamente a través de `IRedactorProvider` nunca ve un discriminador, así que una prueba unitaria de tu redactor de forma aislada pasará mientras la tubería de registro se comporta mal. Prueba a través del logger.

## Hacer hash en lugar de borrar

`HmacRedactor` produce un hash `HMACSHA256` estable, lo que te permite correlacionar apariciones del mismo valor sin almacenarlo:

```csharp
#pragma warning disable EXTEXP0002
services.AddRedaction(r => r.SetHmacRedactor(o =>
{
    o.KeyId = 42;
    o.Key = Convert.ToBase64String(keyBytes);   // base64, at least 44 chars
}, Taxonomy.Pii));
#pragma warning restore EXTEXP0002
```

Salida real, con `ApplyDiscriminator` apagado:

```json
{"payment.Email":"42:AjapxXMS14J9i8GFw62JBQ==","payment.CardNumber":""}
```

El prefijo `42:` es el `KeyId`, así que puedes saber qué clave produjo un hash después de una rotación. Dos advertencias. `SetHmacRedactor` es experimental y genera `EXTEXP0002`, así que necesitas una supresión explícita o `<NoWarn>$(NoWarn);EXTEXP0002</NoWarn>`. Y `CardNumber` salió vacío arriba porque está clasificado como `Sensitive`, que aquí no tiene redactor asignado y por tanto cae en el respaldo `ErasingRedactor`. Asigna todas las clasificaciones que definas, o el respaldo decidirá por ti en silencio.

## El resto de la superficie de LogProperties

`[LogProperties]` tiene más perillas de las que usa la mayoría:

```csharp
[LoggerMessage(4, LogLevel.Information, "Charging customer")]
public static partial void Charging(this ILogger logger,
    [LogProperties(OmitReferenceName = false, SkipNullProperties = true)] Customer customer);
```

`OmitReferenceName` vale `false` por defecto, que es lo que produce el prefijo `customer.` en cada nombre de etiqueta; ponlo en `true` y las etiquetas pasan a ser simplemente `Id`, `Plan`, etcétera. `SkipNullProperties = true` omite del estado las propiedades con valor nulo en lugar de escribir nulos. Ambas son opciones de tiempo de compilación normales, sin costo en tiempo de ejecución.

Los objetos anidados no se recorren por defecto. Un `Customer.Address` de tipo complejo produce una advertencia de compilación en lugar de convertirse a cadena en silencio:

```text
warning LOGGEN036: The type "Address?" doesn't implement ToString(), IConvertible, or IFormattable
(did you forget to apply [LogProperties] or [TagProvider] to "Address"?)
```

Se arregla poniendo `[LogProperties]` sobre la propiedad anidada, que entonces emite etiquetas `customer.Address.Street`, incluidos los atributos de clasificación sobre `Address`. También existe `[LogProperties(Transitive = true)]` para recorrer el grafo automáticamente, pero está marcado como experimental y falla la compilación con `EXTEXP0003` hasta que se suprime.

## Clasificar valores que no puedes atribuir

Los atributos solo funcionan sobre tipos que te pertenecen. Para un DTO de terceros, o cuando la clasificación depende del estado en tiempo de ejecución, usa `[TagProvider]` y clasifica dentro de un método recolector escrito a mano:

```csharp
public static class SessionTagProvider
{
    public static void Provide(ITagCollector collector, Session session)
    {
        collector.Add("user", session.User);
        collector.Add("token", session.Token, new DataClassificationSet(Taxonomy.Sensitive));
    }
}

[LoggerMessage(2, LogLevel.Information, "Session opened")]
public static partial void Opened(this ILogger logger,
    [TagProvider(typeof(SessionTagProvider), nameof(SessionTagProvider.Provide),
                 OmitReferenceName = true)] Session session);
```

La sobrecarga de `ITagCollector.Add` que toma un `DataClassificationSet` es el equivalente programático de un atributo de clasificación, y el valor fluye hacia `ClassifiedTagArray` exactamente igual. Cuidado con los nombres: por defecto el nombre del parámetro se antepone a la clave que pases, así que `collector.Add("session.token", ...)` sobre un parámetro llamado `session` emite la etiqueta `session.session.token`. Pasa claves simples y deja que el nombre del parámetro aporte el prefijo, o pasa claves simples y pon `OmitReferenceName = true` para eliminar el prefijo por completo. No escribas el prefijo tú mismo.

## Demostrarlo con una prueba

`FakeLogger`, de `Microsoft.Extensions.Diagnostics.Testing` 10.9.0, corre detrás del mismo `ExtendedLogger`, así que la redacción se aplica y las etiquetas redactadas se pueden leer a través de `FakeLogCollector`. Eso hace directa la aserción sobre fugas:

```csharp
var services = new ServiceCollection();
services.AddLogging(b => { b.AddFakeLogging(); b.EnableRedaction(); });
services.AddRedaction(r => r.SetRedactor<StarRedactor>(Taxonomy.Sensitive));

using var sp = services.BuildServiceProvider();
sp.GetRequiredService<ILoggerFactory>().CreateLogger("T")
  .Taken(new Payment { CardNumber = "4111111111111111", Amount = 1999 });

var records = sp.GetRequiredService<FakeLogCollector>().GetSnapshot();
Assert.DoesNotContain("4111111111111111",
    string.Join('\n', records.SelectMany(r => r.StructuredState ?? [])
                             .Select(kv => $"{kv.Key}={kv.Value}")));
```

El estado estructurado de ese registro es exactamente `payment.CardNumber = ****`, `payment.Amount = 1999`, `{OriginalFormat} = Payment taken`. Haz la aserción sobre la ausencia del secreto y no sobre la presencia de `****`, para que la prueba siga detectando una regresión si alguien cambia el redactor.

Dos cosas me sorprendieron. La redacción solo aplica a los métodos de registro generados por código fuente, así que cualquier `logger.LogInformation($"card {card}")` que quede en el código está completamente desprotegido. Si todavía no has hecho esa limpieza, [convertir las llamadas interpoladas de ILogger a plantillas de mensaje](/es/2026/07/migrate-from-ilogger-string-interpolation-to-message-templates-in-dotnet-11/) es el requisito previo de toda esta funcionalidad. Segundo, `EnableRedaction` cambia lo que `JsonConsole` escribe en el campo anidado `State.Message`: pasa a ser la cadena literal `Microsoft.Extensions.Logging.ExtendedLogger+ModernTagJoiner`. El `Message` de nivel superior sigue siendo correcto y todas las etiquetas individuales siguen presentes, pero si tienes un analizador aguas abajo leyendo `State.Message`, se romperá. Los destinos estructurados que enumeran el estado, como los que cubre la [guía de configuración de Serilog y Seq](/es/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/) o una [tubería de registro con OpenTelemetry](/es/2026/06/migrate-from-serilog-to-opentelemetry-logging-in-dotnet-11/), no se ven afectados.

El argumento más fuerte a favor de esta funcionalidad es que la clasificación vive sobre el modelo, junto a la propiedad, donde la verá quien agregue un campo. La política de redacción vive en una única llamada en la raíz de composición que un revisor de seguridad puede leer en diez segundos. Esa separación vale el costo de configuración, siempre que de verdad la verifiques: agrega una prueba que registre un modelo completamente poblado en un destino en memoria y falle si aparece en la salida cualquier cadena secreta conocida.

## Fuentes

- [Generación de registro por código fuente en tiempo de compilación](https://learn.microsoft.com/en-us/dotnet/core/extensions/logging/source-generation), MS Learn
- [Clasificación de datos en .NET](https://learn.microsoft.com/en-us/dotnet/core/extensions/data-classification), MS Learn
- [Redacción de datos en .NET](https://learn.microsoft.com/en-us/dotnet/core/extensions/data-redaction), MS Learn
- [ExtendedLogger.ModernPath](https://github.com/dotnet/extensions/blob/main/src/Libraries/Microsoft.Extensions.Telemetry/Logging/ExtendedLogger.cs) y [JustInTimeRedactor](https://github.com/dotnet/extensions/blob/main/src/Libraries/Microsoft.Extensions.Telemetry/Logging/JustInTimeRedactor.cs), dotnet/extensions
- [LoggerRedactionOptions.ApplyDiscriminator](https://github.com/dotnet/extensions/blob/main/src/Libraries/Microsoft.Extensions.Telemetry/Logging/LoggerRedactionOptions.cs), dotnet/extensions
- [Issue 5163 de dotnet/extensions](https://github.com/dotnet/extensions/issues/5163), sobre la salida de LogProperties cuando la redacción está deshabilitada
