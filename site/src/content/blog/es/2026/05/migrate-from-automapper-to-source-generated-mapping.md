---
title: "Migrar de AutoMapper al mapeo generado por código fuente con Mapperly"
description: "Una lista de verificacion paso a paso para reemplazar los Profiles, IMapper, ForMember y ProjectTo de AutoMapper 15 por mappers generados por codigo fuente con Riok.Mapperly 4.3 en .NET 11."
pubDate: 2026-05-30
updatedDate: 2026-05-30
template: migration
tags:
  - "migration"
  - "automapper"
  - "mapperly"
  - "source-generators"
  - "dotnet-11"
lang: "es"
translationOf: "2026/05/migrate-from-automapper-to-source-generated-mapping"
translatedBy: "claude"
translationDate: 2026-05-30
---

Reemplazar AutoMapper por un generador de código fuente es una refactorización mecánica, archivo por archivo, no una reescritura. Para un servicio típico con 30-80 mapeos repartidos en unas pocas clases `Profile`, calcula de medio día a un día: cada `CreateMap<Source, Dest>()` se convierte en un método `partial` de una clase `[Mapper]`, las llamadas a `IMapper.Map<T>` pasan a ser llamadas directas a métodos, y `ProjectTo<T>()` se convierte en una extensión `IQueryable` generada. Lo que se rompe es todo lo que dependía de la flexibilidad en runtime de AutoMapper: las llamadas dinámicas `Map(object)`, los `IValueResolver` con servicios inyectados, y el registro por escaneo de ensamblados. Vale la pena hacerlo si estás por encima del límite de ingresos de 5.000.000 USD de AutoMapper y no quieres comprar una licencia, si quieres que Native AOT y el trimming funcionen, o si quieres que las propiedades no mapeadas fallen la compilación en lugar de descartarse silenciosamente en runtime.

Versiones referenciadas: esta guía cubre dejar AutoMapper 14.x (la última versión MIT) y 15.0 (la primera versión con doble licencia Reciprocal Public License 1.5 / comercial de Lucky Penny Software). El reemplazo apunta a `<TargetFramework>net11.0</TargetFramework>` con el SDK de .NET 11, C# 14 y Riok.Mapperly 4.3.1 (publicada el 2025-12-22). Si todavía estás decidiendo si irte, es la misma historia de proveedor que MediatR, así que lee [migrar de MediatR a inyección de dependencias simple](/es/2026/05/migrate-from-mediatr-to-plain-dependency-injection/) para el caso paralelo; este artículo asume que la decisión ya está tomada.

## Por qué los equipos dejan AutoMapper justo ahora

- **La licencia obliga a decidir por encima de 5 millones USD.** AutoMapper 15.0 se publica bajo la licencia copyleft recíproca RPL-1.5 más un nivel comercial de pago. El uso gratuito cubre empresas por debajo de 5.000.000 USD de ingresos brutos anuales y entornos que no son de producción. Por encima de ese límite, el software comercial de código cerrado no puede usar la versión RPL, así que es comprar o irse. Todo lo publicado bajo MIT (14.x y anteriores) sigue siendo usable bajo MIT para siempre, pero dejas de recibir correcciones.
- **Los errores de mapeo pasan de runtime a tiempo de compilación.** AutoMapper valida la configuración solo cuando llamas a `AssertConfigurationIsValid()` o llegas al mapeo en runtime. Mapperly reporta una propiedad no mapeada como un diagnóstico `RMG` en tiempo de compilación, así que un campo olvidado es una advertencia de compilación, no una `NullReferenceException` en producción.
- **El arranque sale más barato y AOT se vuelve más fácil.** AutoMapper construye y compila expresiones de mapeo en el primer uso mediante reflexión. Mapperly emite C# plano en tiempo de compilación, así que no hay costo de arranque ni reflexión que pelee con el trimmer, lo que importa al [reducir el tiempo de arranque en frío de una AWS Lambda en .NET 11](/es/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) o al enviar [Native AOT](/es/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/).
- **Puedes leer el código generado.** Mapperly escribe un cuerpo de método parcial legible en el que puedes entrar con el depurador, en lugar de un árbol de expresión compilado y opaco.

## Qué se rompe

| Área | Cambio | Severidad |
| --- | --- | --- |
| Inyección de `IMapper` | Reemplazada por la clase mapper generada concreta, inyectada directamente | alta |
| `Profile` + `CreateMap<,>()` | Colapsan en una clase parcial `[Mapper]` con un método `partial` por dirección | alta |
| `ForMember(... MapFrom ...)` | Reemplazado por `[MapProperty]` o un método de mapeo privado | alta |
| `ReverseMap()` | No hay reverso automático; declaras el método de la dirección de retorno explícitamente | media |
| `IValueResolver` / `ITypeConverter` con DI | Reemplazados por un constructor en el mapper más un método privado | media |
| `ProjectTo<T>(config)` | Reemplazado por una extensión de proyección `IQueryable<T>` generada | media |
| Escaneo `AddAutoMapper(assembly)` | Reemplazado por registro explícito `AddSingleton<TMapper>()` | media |
| `mapper.Map(object, type)` (dinámico) | No hay punto de entrada sin tipo en runtime; cada mapeo es un método tipado | alta |
| Prueba `AssertConfigurationIsValid()` | Redundante; la compilación es la aserción | baja |

## Lista de verificación previa

1. **Instala el SDK de .NET 11** y confirma que `dotnet --version` reporta `11.0.x`.
2. **Inventaría tus mapeos.** Ejecuta un grep de `CreateMap<` para contar las configuraciones y de `\.Map<` y `ProjectTo<` para contar los puntos de llamada. Ese es el alcance de tu migración.
3. **Encuentra los mapeos dinámicos.** Busca con grep las llamadas `Map(` que pasan un argumento `Type` o un origen `object`. Estas no tienen equivalente directo en Mapperly y necesitan un método tipado o un switch manual; ocúpate de ellas primero.
4. **Encuentra los resolvers.** Busca con grep `IValueResolver`, `ITypeConverter` e `IMappingAction`. Cada uno necesita un método privado en el mapper.
5. **No hace falta respaldo especial, ramifica normalmente.** Este cambio es reversible archivo por archivo (ver Plan de reversión), así que una rama de funcionalidad basta.

## Pasos de la migración

### 1. Agrega Mapperly junto a AutoMapper

Instala ambos paquetes para poder migrar un profile a la vez:

```bash
# .NET 11 SDK, run from the project directory
dotnet add package Riok.Mapperly --version 4.3.1
```

Mapperly entrega solo un analizador y los atributos de `Riok.Mapperly.Abstractions`, así que no agrega ninguna dependencia en runtime. Verifica que la compilación siga funcionando: `dotnet build` sin errores nuevos. Deja el paquete de AutoMapper referenciado hasta que desaparezca el último profile.

### 2. Convierte un profile simple a una clase `[Mapper]`

Toma primero el profile más pequeño. El antes:

```csharp
// AutoMapper 15.0
public class CarProfile : Profile
{
    public CarProfile()
    {
        CreateMap<Car, CarDto>();
    }
}
```

El después es una clase parcial con un método parcial. Mapperly rellena el cuerpo:

```csharp
// .NET 11, C# 14, Riok.Mapperly 4.3.1
using Riok.Mapperly.Abstractions;

[Mapper]
public partial class CarMapper
{
    public partial CarDto ToDto(Car car);
}
```

Verifica: compila el proyecto y abre el archivo generado (aparece en la salida del analizador, o pon `<EmitCompilerGeneratedFiles>true</EmitCompilerGeneratedFiles>` en el `.csproj` para escribirlo en disco). Confirma que cada propiedad de `CarDto` se asigne. Si alguna no se asigna, Mapperly emite un diagnóstico como `RMG020` para un miembro de destino no mapeado; eso es la característica, no un fallo.

### 3. Traduce `ForMember` a `[MapProperty]`

La personalización por miembro de AutoMapper se mapea a atributos de Mapperly. Un renombrado:

```csharp
// AutoMapper 15.0
CreateMap<Car, CarDto>()
    .ForMember(d => d.ModelName, o => o.MapFrom(s => s.Model));
```

se convierte en un atributo `[MapProperty]` que nombra los miembros de origen y destino:

```csharp
// .NET 11, C# 14, Riok.Mapperly 4.3.1
[MapProperty(nameof(Car.Model), nameof(CarDto.ModelName))]
public partial CarDto ToDto(Car car);
```

Para un valor calculado, la lambda `MapFrom` en línea de AutoMapper se convierte en un método de mapeo privado referenciado por `Use`:

```csharp
// .NET 11, C# 14, Riok.Mapperly 4.3.1
[Mapper]
public partial class CarMapper
{
    [MapProperty(nameof(Car.Price), nameof(CarDto.Price), Use = nameof(FormatPrice))]
    public partial CarDto ToDto(Car car);

    private string FormatPrice(decimal price) => price.ToString("C");
}
```

Para descartar una propiedad deliberadamente, reemplaza el `Ignore()` de AutoMapper por `[MapperIgnoreTarget(nameof(CarDto.Internal))]` o `[MapperIgnoreSource(nameof(Car.Secret))]`. Verifica cada conversión revisando que el cuerpo generado asigne exactamente los miembros que esperas.

### 4. Reemplaza `ReverseMap()` por un método explícito

El `ReverseMap()` de AutoMapper es una sola llamada. Mapperly no tiene reverso automático, así que declara la dirección de retorno como su propio método en el mismo mapper:

```csharp
// .NET 11, C# 14, Riok.Mapperly 4.3.1
[Mapper]
public partial class CarMapper
{
    public partial CarDto ToDto(Car car);
    public partial Car ToEntity(CarDto dto);
}
```

Es más código, pero es honesto: el mapeo inverso ya no está implícito, así que una propiedad asimétrica (un campo de destino sin origen) aparece como su propio diagnóstico en lugar de ignorarse silenciosamente. Verifica ambos cuerpos generados.

### 5. Mueve los resolvers con dependencias al constructor del mapper

Un `IValueResolver` de AutoMapper que necesita un servicio inyectado:

```csharp
// AutoMapper 15.0
public class PriceResolver : IValueResolver<Car, CarDto, string>
{
    private readonly ICurrencyService _currency;
    public PriceResolver(ICurrencyService currency) => _currency = currency;
    public string Resolve(Car s, CarDto d, string m, ResolutionContext ctx)
        => _currency.Format(s.Price);
}
```

se convierte en un constructor en el mapper más un método privado. Mapperly genera un constructor que reenvía los parámetros que declaras, así que el mapper participa en la inyección de constructor normal:

```csharp
// .NET 11, C# 14, Riok.Mapperly 4.3.1
[Mapper]
public partial class CarMapper
{
    private readonly ICurrencyService _currency;
    public CarMapper(ICurrencyService currency) => _currency = currency;

    [MapProperty(nameof(Car.Price), nameof(CarDto.Price), Use = nameof(FormatPrice))]
    public partial CarDto ToDto(Car car);

    private string FormatPrice(decimal price) => _currency.Format(price);
}
```

Verifica resolviendo el mapper desde el contenedor en una prueba y comprobando el precio formateado.

### 6. Convierte `ProjectTo<T>` a una proyección generada

El `ProjectTo<T>()` de AutoMapper construye un árbol de `Expression` para que EF Core pueda traducir el mapeo a SQL. Mapperly genera el mismo tipo de extensión `IQueryable` cuando declaras un método que toma y devuelve `IQueryable<T>`:

```csharp
// .NET 11, C# 14, Riok.Mapperly 4.3.1
[Mapper]
public static partial class CarQueryMapper
{
    public static partial IQueryable<CarDto> ProjectToDto(this IQueryable<Car> q);
}
```

El punto de llamada cambia de `.ProjectTo<CarDto>(_config)` a `.ProjectToDto()`:

```csharp
// .NET 11, EF Core 11
var dtos = await db.Cars
    .Where(c => c.NumberOfSeats > 4)
    .ProjectToDto()
    .ToListAsync();
```

Verifica capturando el SQL generado (`db.Cars...ToQueryString()` o el logging de EF Core) y confirmando que la proyección se ejecuta en la base de datos, no en memoria. Ten en cuenta que el camino de proyección de Mapperly no ejecuta object factories ni métodos personalizados de creación de objetos, porque debe producir un árbol de expresión traducible.

### 7. Reemplaza el registro de DI

Elimina el registro de AutoMapper y el escaneo de ensamblados:

```csharp
// AutoMapper 15.0 - remove this
builder.Services.AddAutoMapper(typeof(CarProfile).Assembly);
```

Registra cada mapper explícitamente. Un mapper sin dependencias inyectadas no tiene estado y es seguro para hilos, así que regístralo como singleton; uno con una dependencia scoped debe coincidir con ese ciclo de vida:

```csharp
// .NET 11
builder.Services.AddSingleton<CarMapper>();        // no dependencies
builder.Services.AddScoped<InvoiceMapper>();       // depends on a scoped service
```

Luego cambia los consumidores de `IMapper` al mapper concreto. `_mapper.Map<CarDto>(car)` se convierte en `_carMapper.ToDto(car)`. Los mappers estáticos no necesitan registro alguno; llama a `CarQueryMapper.ProjectToDto(query)` directamente. Verifica que la app arranque: un registro faltante es ahora una `InvalidOperationException` de arranque, que es exactamente el fallo temprano que quieres.

### 8. Elimina AutoMapper

Una vez que el grep de `using AutoMapper` y `CreateMap<` no devuelva nada, quita el paquete:

```bash
dotnet remove package AutoMapper
```

Verifica con un `dotnet build` limpio y una ejecución completa de `dotnet test`.

## Verificación

Ejecuta esta lista de verificación después de que desaparezca el último profile:

- `dotnet build` produce cero errores y has revisado cada diagnóstico `RMG`, tratando las advertencias de miembro no mapeado como intencionales o corrigiéndolas.
- `dotnet test` pasa con cero fallos, incluyendo cualquier prueba que antes llamaba a `AssertConfigurationIsValid()` (elimínalas; la compilación es ahora la aserción).
- Las consultas de proyección siguen traduciéndose a SQL: confirma con `ToQueryString()` que ningún `ProjectToDto()` cae en evaluación del lado del cliente.
- Para una compilación AOT o con trimming, `dotnet publish -c Release` no produce advertencias de trim `IL2xxx` que antes venían de la reflexión de AutoMapper.
- Una carga de trabajo sensible al arranque en frío arranca de forma medible más rápido; el primer mapeo ya no paga el costo de compilación de expresiones.

## Plan de reversión

Esta migración es reversible archivo por archivo, lo cual es su principal propiedad de seguridad. Como mantuviste AutoMapper referenciado durante el paso 7, cualquier mapper individual que se porte mal puede revertirse restaurando su `Profile` y volviendo a apuntar ese único consumidor a `IMapper`; los dos sistemas coexisten sin conflicto. El único momento de ida sin vuelta es el paso 8, quitar el paquete. No elimines AutoMapper hasta que cada consumidor esté convertido y toda la suite de pruebas esté en verde. Si estás nervioso, envía las conversiones de mappers en una versión y la eliminación del paquete en la siguiente.

## Tropiezos que tuvimos

- **`RMG020` en propiedades que sí querías descartar.** Mapperly advierte cuando un miembro de origen no mapea a nada. Siléncialo deliberadamente con `[MapperIgnoreSource(...)]` en lugar de suprimir el diagnóstico globalmente, para que el próximo descarte no intencional siga advirtiendo.
- **El aplanamiento no es automático como esperas.** AutoMapper aplana `Order.Customer.Name` en `OrderDto.CustomerName` por convención de nombres. Mapperly soporta el aplanamiento de miembros anidados, pero si el nombre de tu DTO no coincide con la ruta de origen con puntos, debes deletrearlo con `[MapProperty([nameof(Order.Customer), nameof(Customer.Name)], nameof(OrderDto.CustomerName))]`.
- **No hay `Map(object, Type)` sin tipo.** Si tenías una tubería genérica que mapeaba `object` a un `Type` en runtime, no hay equivalente generado por código fuente. Reemplázalo por un método tipado por par, o mantén un pequeño switch escrito a mano. Este es el único lugar donde un cambio limpio es imposible.
- **Destinos `record` con `init` y constructor primario.** Mapperly mapea a través del constructor cuando un destino es un `record` o solo tiene setters `init`, que suele ser lo que quieres; si elige el constructor equivocado, desambígualo con `[MapperConstructor]`. El comportamiento de AutoMapper aquí era más laxo, así que un mapeo que antes funcionaba puede sacar a la luz una ambigüedad real. Para conocer las formas de destino, ver [record vs class vs struct en C#](/es/2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix/).
- **El mapeo de enums es más estricto por nombre.** Mapperly mapea enums por valor de forma predeterminada y puede advertir sobre miembros de enum no mapeados, donde AutoMapper pasaba el entero silenciosamente. Decide explícitamente entre por valor y por nombre con la estrategia `[MapEnum]`.

Si quieres entender cómo el generador hace esto en tiempo de compilación antes de confiar en él en producción, la mecánica es la misma que se cubre en [cómo escribir un generador de código fuente para INotifyPropertyChanged](/es/2026/04/how-to-write-a-source-generator-for-inotifypropertychanged/).

## Fuentes

- [AutoMapper and MediatR Commercial Editions Launch Today](https://www.jimmybogard.com/automapper-and-mediatr-commercial-editions-launch-today/), Jimmy Bogard
- [AutoMapper and MediatR Licensing Update](https://www.jimmybogard.com/automapper-and-mediatr-licensing-update/), Jimmy Bogard
- [Documentación de Mapperly: configuración y proyecciones queryable](https://mapperly.riok.app/docs/configuration/mapper/)
- [riok/mapperly en GitHub](https://github.com/riok/mapperly) y [Riok.Mapperly 4.3.1 en NuGet](https://www.nuget.org/packages/Riok.Mapperly)
