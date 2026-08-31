---
title: "AutoMapper vs Mapperly vs mapeo escrito a mano en 2026"
description: "Mapperly es la opción por defecto para código .NET nuevo: iguala la velocidad del mapeo escrito a mano, sobrevive a Native AOT y detecta miembros sin mapear en tiempo de compilación. AutoMapper sigue ganando en ProjectTo. Con benchmarks y umbrales de licencia."
pubDate: 2026-08-31
template: vs
tags:
  - "comparison"
  - "automapper"
  - "mapperly"
  - "source-generators"
  - "dotnet"
  - "performance"
lang: "es"
translationOf: "2026/08/automapper-vs-mapperly-vs-hand-written-mapping-in-2026"
translatedBy: "claude"
translationDate: 2026-08-31
---

Para código .NET nuevo en 2026, usa **Mapperly**. Genera C# plano en tiempo de compilación, corre dentro de un 3% del mapeo escrito a mano, se publica limpio bajo Native AOT y convierte una propiedad olvidada en un diagnóstico del compilador en lugar de una cadena vacía silenciosa. Escribe el mapeo **a mano** cuando un proyecto tiene menos de unos veinte mapas o cuando las formas de origen y destino realmente divergen. Quédate con **AutoMapper** solo cuando `ProjectTo` sea crítico en una base de código grande con EF Core y califiques para el nivel Community gratuito, porque por encima de 5 000 000 USD de ingresos anuales la licencia convierte la decisión en una orden de compra.

Todos los números de abajo se midieron en un Apple M4 (10 núcleos) con .NET SDK 10.0.302 apuntando a `net10.0`, usando AutoMapper 16.2.0 (publicado el 2026-07-02), Riok.Mapperly 4.3.1 (publicado el 2025-12-22) y BenchmarkDotNet 0.15.8.

## La matriz

| | AutoMapper 16.2.0 | Mapperly 4.3.1 | Escrito a mano |
| --- | --- | --- | --- |
| Licencia | copyleft RPL-1.5 o comercial de pago | Apache 2.0 | ninguna |
| Costo por encima de 5 000 000 USD de ingresos | de 799 a 6 399 USD al año | gratis | gratis |
| Cómo se produce el mapeo | reflexión más árboles de expresión compilados en el primer uso | generador de código fuente de Roslyn en tiempo de compilación | tú |
| Miembro de destino sin mapear | silencioso, solo lo detecta `AssertConfigurationIsValid()` | advertencia `RMG012`, escalable a error | el compilador tampoco te dice nada |
| Miembro de origen sin mapear | no se reporta | advertencia `RMG020` | no se reporta |
| Publicación con Native AOT | `IL2104` más `IL3053`, falla al arrancar | cero advertencias, funciona | cero advertencias, funciona |
| Costo en frío del primer mapeo | ~33 ms para 3 mapas | ~1 ms | 0 |
| Mapeo de un objeto | 105.79 ns | 60.44 ns | 58.48 ns |
| Proyección con EF Core | `ProjectTo` con expansión explícita, parámetros y profundidad de recursión | proyección `IQueryable` generada, varias características no soportadas | escribe el `Select` |
| `Map(object, type)` en runtime | sí | no | no |
| Salida depurable | árbol de expresión compilado | `.g.cs` legible en el que puedes entrar paso a paso | tu propio código |

## La licencia es el eje del que cuelga todo lo demás

El 2025-07-02 Jimmy Bogard trasladó AutoMapper y MediatR a Lucky Penny Software y relicenció ambos. AutoMapper 15.0.0 y posteriores se distribuyen bajo un modelo dual: la [Reciprocal Public License 1.5](https://github.com/LuckyPennySoftware/AutoMapper/blob/main/LICENSE.md) para uso open source, o una licencia comercial de pago. La versión 14.x y anteriores permanecen bajo MIT para siempre.

RPL-1.5 no es MIT con pasos extra. Es un copyleft recíproco fuerte que alcanza al software desplegado, no solo al distribuido, así que los productos comerciales de código cerrado no pueden realmente publicarse sobre la compilación RPL. Eso deja el acuerdo comercial, cuyo nivel Community gratuito cubre a organizaciones con menos de 5 000 000 USD de ingresos brutos anuales que además hayan recibido menos de 10 000 000 USD de capital externo, y que no sean entidades gubernamentales, cuasi gubernamentales o de educación superior. Por encima de esa línea, los [niveles publicados](https://automapper.io/) son Standard a 799 USD al año para 1 a 10 desarrolladores, Professional a 1 499 USD al año para 11 a 50, y Enterprise a 6 399 USD al año para desarrolladores ilimitados. Solo cuentan los desarrolladores que escriben o mantienen activamente código que llama a la biblioteca, lo que excluye QA, diseño y trabajo de front-end.

La aplicación de la licencia es deliberadamente suave. No hay servidor de licencias, ni llamada de red, ni bloqueo de características. Una clave ausente o vencida produce un mensaje de log y nada más, y desde 16.2.0 la clave también puede venir de las variables de entorno `AUTOMAPPER_LICENSE_KEY` o `LUCKYPENNY_LICENSE_KEY` en lugar de `cfg.LicenseKey`. Pero aplicación suave no es lo mismo que permiso, y "no notamos una advertencia en los logs" no es una postura de licencia que nadie quiera defender en una revisión de compras.

Es la misma bifurcación que con las bibliotecas de mediator, y el razonamiento se traslada directamente: revisa [MediatR vs clases de servicio simples en 2026](/es/2026/05/mediatr-vs-plain-service-classes-in-2026/) para el desglose completo del nivel Community y las obligaciones de RPL-1.5.

## Cuándo elegir Mapperly

- **Cualquier cosa que se publique con trimming o Native AOT.** Esto no es una preferencia, es una barrera dura. Mira la sección de AOT más abajo.
- **Serverless y procesos de vida corta.** Mapperly no cuesta nada al arrancar porque no hay un objeto de configuración que construir.
- **Bases de código donde la deriva de los DTO es un riesgo real.** Una columna nueva en la entidad que nadie agregó al DTO produce `RMG020` en tiempo de compilación. AutoMapper no lo mencionará en absoluto.
- **Equipos que quieren leer el mapeo.** Mapperly escribe un archivo `.g.cs` que puedes abrir, comparar y recorrer en el depurador.

## Cuándo elegir el mapeo escrito a mano

- **Superficie pequeña.** Por debajo de unos veinte mapas, un método estático `ToDto` por tipo es menos maquinaria que un generador más su vocabulario de atributos, y nunca sorprende a nadie.
- **Formas que realmente difieren.** Cuando la mayoría de los miembros necesitan `MapFrom`, `IValueResolver` o lógica condicional, ambas bibliotecas degeneran en una peor forma de escribir el método que ibas a escribir de todos modos.
- **Contratos de API pública.** Los DTO que son un formato de cable versionado merecen un mapeo explícito y revisable donde cada asignación de campo aparece en el diff.
- **Cualquier capa donde quieras cero dependencias en tiempo de compilación.** Mapperly es un generador de código fuente, así que participa en tu compilación; un método estático no.

## Cuándo quedarse con AutoMapper

- **Una base de código grande con EF Core construida sobre `ProjectTo`.** Las extensiones queryable de AutoMapper soportan expansión explícita, parametrización en runtime mediante objetos anónimos, `RecursiveQueriesMaxDepth` para modelos autorreferenciales y mapeo polimórfico. Las proyecciones de Mapperly cubren el caso común pero explícitamente no soportan object factories, estrategias de enum `ByName`, manejo de referencias ni clonado profundo, y reportarán `RMG068` cuando no puedan hacer inline de un método definido por el usuario.
- **Estás por debajo del umbral Community y los mapas ya funcionan.** Reescribir 200 mapas que funcionan para ahorrar 45 ns por llamada no es un caso de negocio.
- **Mapeo dinámico y sin tipos.** `mapper.Map(source, sourceType, destType)` no tiene equivalente generado en tiempo de compilación. Si tienes un sistema de plugins que descubre tipos en runtime, AutoMapper está haciendo algo que Mapperly estructuralmente no puede.

Si decides irte, la mecánica está cubierta paso a paso en [migrar de AutoMapper a mapeo generado con Mapperly](/es/2026/05/migrate-from-automapper-to-source-generated-mapping/).

## El benchmark

El modelo es un `Order` con cinco miembros escalares, un `Customer` anidado, cinco hijos `OrderLine` y un enum mapeado a su nombre en texto. `[MemoryDiagnoser]`, job por defecto, y la compilación de expresiones de AutoMapper precalentada en `[GlobalSetup]` para que la medición sea rendimiento en estado estable y no el costo de la primera llamada.

```csharp
// .NET SDK 10.0.302, net10.0, C# 14
// AutoMapper 16.2.0, Riok.Mapperly 4.3.1, BenchmarkDotNet 0.15.8
[MemoryDiagnoser]
public class MappingBenchmarks
{
    private Order _order = null!;
    private List<Order> _orders = null!;
    private IMapper _autoMapper = null!;
    private OrderMapper _mapperly = null!;

    [GlobalSetup]
    public void Setup()
    {
        _order = MakeOrder(1);
        _orders = Enumerable.Range(1, 1000).Select(MakeOrder).ToList();

        var config = new MapperConfiguration(
            cfg => cfg.AddProfile<OrderProfile>(),
            NullLoggerFactory.Instance);
        _autoMapper = config.CreateMapper();
        _mapperly = new OrderMapper();

        _autoMapper.Map<OrderDto>(_order); // warm the expression compilation
    }

    [Benchmark(Baseline = true)]
    public OrderDto HandWritten_Single() => HandMapper.ToDto(_order);

    [Benchmark]
    public OrderDto Mapperly_Single() => _mapperly.ToDto(_order);

    [Benchmark]
    public OrderDto AutoMapper_Single() => _autoMapper.Map<OrderDto>(_order);
}
```

Resultados en un Apple M4, 10 núcleos físicos, .NET 10.0.10 Arm64 RyuJIT:

| Método | Media | Ratio | Asignado | Ratio de asignación |
| --- | ---: | ---: | ---: | ---: |
| HandWritten_Single | 58.48 ns | 1.00 | 624 B | 1.00 |
| Mapperly_Single | 60.44 ns | 1.03 | 624 B | 1.00 |
| AutoMapper_Single | 105.79 ns | 1.81 | 704 B | 1.13 |
| HandWritten_1000 | 72,696 ns | 1.00 | 632,091 B | 1.00 |
| Mapperly_1000 | 77,334 ns | 1.06 | 672,093 B | 1.06 |
| AutoMapper_1000 | 103,376 ns | 1.42 | 720,640 B | 1.14 |

Léelo con honestidad: 45 nanosegundos por objeto no es la razón por la que deberías cambiar. En una petición que mapea 1 000 pedidos toda la diferencia son 31 microsegundos, que no van a aparecer al lado de un solo viaje a la base de datos. El argumento de rendimiento solo pesa de verdad con conteos de objetos muy altos, y es la más débil de las tres razones para preferir Mapperly.

La brecha de 40 000 bytes entre Mapperly y el mapeo escrito a mano en el caso de 1 000 objetos es un artefacto real que vale la pena entender. Mapperly ensancha el parámetro de un mapeador de colección anidada generado a `IReadOnlyCollection<T>`:

```csharp
// Riok.Mapperly 4.3.1 generated output, trimmed
private List<OrderLineDto> MapToListOfOrderLineDto(IReadOnlyCollection<OrderLine> source)
{
    var target = new List<OrderLineDto>(source.Count);
    foreach (var item in source)
        target.Add(MapToOrderLineDto(item));
    return target;
}
```

Enumerar una `List<T>` a través de una interfaz aplica boxing a su enumerador de struct: 40 bytes por pedido, 40 000 bytes en todo el lote. Declarar tú mismo el mapeador de la colección anidada con un parámetro concreto `List<OrderLine>` lo elimina. Este es exactamente el tipo de cosa que puedes encontrar y arreglar porque el código generado está en disco, que es la diferencia práctica entre un generador de código fuente y un árbol de expresión compilado.

## El detalle que decide por ti: Native AOT

Publica una aplicación de consola que llama a AutoMapper 16.2.0 con `<PublishAot>true</PublishAot>` en `net10.0` y la compilación advierte:

```text
AutoMapper.dll : warning IL2104: Assembly 'AutoMapper' produced trim warnings.
AutoMapper.dll : warning IL3053: Assembly 'AutoMapper' produced AOT analysis warnings.
```

Las advertencias son fáciles de ignorar. El binario resultante no lo es:

```text
Unhandled exception. System.TypeInitializationException: A type initializer threw an exception.
 ---> System.ArgumentNullException: Value cannot be null. (Parameter 'method')
   at System.Linq.Expressions.Expression.Call(MethodInfo, Expression)
   at AutoMapper.Execution.ExpressionBuilder..cctor()
   at AutoMapper.MapperConfiguration..ctor(MapperConfigurationExpression, ILoggerFactory)
```

El trimmer eliminó un método que `ExpressionBuilder` busca por reflexión, así que el constructor estático muere antes de tu primer mapeo. La aplicación equivalente con Mapperly publicada con la misma configuración emite cero advertencias IL, produce un binario nativo de 1.1 MB y funciona. Eso no es un problema de ajuste que puedas resolver con atributos `DynamicDependency` en el sitio de la llamada; es una propiedad de construir mapas a partir de árboles de expresión en runtime, que es la misma trampa descrita en [qué es el código trim-safe y cómo lo escribo](/es/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/). Si Native AOT está en tu hoja de ruta, la decisión ya está tomada.

La versión suave del mismo efecto es el arranque en frío. Construir la configuración y ejecutar el primer mapeo para tres tipos tomó 33 milisegundos en esta máquina, frente a 1 milisegundo para `new OrderMapper()` más su primera llamada. En una aplicación web de vida larga eso es invisible. En una Lambda es una porción medible de una invocación en frío, que es por lo que aparece en [reducir el tiempo de arranque en frío de una Lambda de AWS con .NET](/es/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/).

## Dónde aparece de verdad la diferencia de seguridad

Agrega una propiedad `Slug` a un DTO y olvida mapearla. AutoMapper 16.2.0 mapea el objeto de todos modos:

```text
map ok: Id=1 Name=n Slug=''
```

`AssertConfigurationIsValid()` sí lo detecta, lanzando `AutoMapperConfigurationException` con "Unmapped members were found", pero solo si te acordaste de llamarlo, y solo para miembros de *destino* sin mapear. Una propiedad de origen que ya no llega a ningún DTO no se reporta en absoluto.

Mapperly reporta ambas direcciones en tiempo de compilación, con el texto real del mensaje:

```text
warning RMG020: The member InternalNote on the mapping source type Diag.Source
                is not mapped to any member on the mapping target type Diag.Target
warning RMG012: The member Slug on the mapping target type Diag.Target
                was not found on the mapping source type Diag.Source
```

Son advertencias por defecto, lo que significa que se ahogarán en una compilación ruidosa. Escálalas en `.editorconfig` y la compilación falla de plano:

```ini
[*.cs]
dotnet_diagnostic.RMG012.severity = error
dotnet_diagnostic.RMG020.severity = error
```

Ese es el ajuste que convierte a Mapperly de "un AutoMapper más rápido" en una categoría distinta de herramienta: los errores de mapeo dejan de ser incidentes en producción y pasan a ser fallos de compilación. Es también la ilustración más clara de por qué los [generadores de código fuente](/es/2026/06/what-is-a-source-generator-and-when-do-i-need-one/) valen la dependencia en tiempo de compilación.

El mapeo escrito a mano, para que conste, no ofrece tal verificación. Una asignación olvidada en un método `ToDto` es exactamente igual de silenciosa que en AutoMapper. Su seguridad viene de ser visible en la revisión de código, no de las herramientas.

## La decisión

Usa Mapperly por defecto para código nuevo, y escala `RMG012` y `RMG020` a errores desde el primer día para obtener realmente el beneficio. Escribe el mapeo a mano cuando el proyecto es pequeño o las formas son irregulares, y acepta que estás cambiando verificaciones de herramientas por revisabilidad. Quédate con AutoMapper cuando una base de código madura y cargada de `ProjectTo` ya funciona, estás por debajo del umbral Community y Native AOT no está en la hoja de ruta; y si cualquiera de esas tres cosas deja de ser cierta, empieza la migración en lugar de presupuestar la licencia. La tabla de rendimiento es la parte menos interesante de esta comparación. La seguridad frente al trimming y los diagnósticos en tiempo de compilación son lo que de verdad cambia cómo se comporta una base de código.

## Relacionado

- [Migrar de AutoMapper a mapeo generado con Mapperly](/es/2026/05/migrate-from-automapper-to-source-generated-mapping/)
- [Solución: 'MapperConfiguration' no contiene un constructor que tome 1 argumentos](/es/2026/08/fix-mapperconfiguration-does-not-contain-a-constructor-that-takes-1-arguments/)
- [MediatR vs clases de servicio simples en 2026](/es/2026/05/mediatr-vs-plain-service-classes-in-2026/)
- [¿Qué es un generador de código fuente y cuándo lo necesito?](/es/2026/06/what-is-a-source-generator-and-when-do-i-need-one/)
- [¿Qué es Native AOT y qué te cuesta?](/es/2026/06/what-is-native-aot-and-what-does-it-cost-you/)

## Fuentes

- [Licensing FAQ - Lucky Penny Software](https://luckypennysoftware.com/faq) - el límite en 15.0.0, los umbrales Community de 5 000 000 USD de ingresos y 10 000 000 USD de capital, y cómo se cuentan los desarrolladores.
- [AutoMapper LICENSE.md](https://github.com/LuckyPennySoftware/AutoMapper/blob/main/LICENSE.md) - el texto de la licencia dual RPL-1.5 o comercial.
- [Documentación de configuración de licencia de AutoMapper](https://docs.automapper.io/en/latest/License-configuration.html) - el descubrimiento de `AUTOMAPPER_LICENSE_KEY` y `LUCKYPENNY_LICENSE_KEY`, y el modelo de aplicación solo por logs.
- [AutoMapper Queryable Extensions](https://docs.automapper.io/en/latest/Queryable-Extensions.html) - expansión explícita de `ProjectTo`, parametrización y la restricción de "debe ser la última llamada de la cadena".
- [Proyecciones queryable de Mapperly](https://mapperly.riok.app/docs/configuration/queryable-projections/) - la lista de características no soportadas y el diagnóstico de inlining `RMG068`.
- [Diagnósticos del analizador de Mapperly](https://mapperly.riok.app/docs/configuration/analyzer-diagnostics/) - `RMG012`, `RMG020` y la escalada de severidad en `.editorconfig`.
- [Riok.Mapperly en NuGet](https://www.nuget.org/packages/Riok.Mapperly) - fecha de publicación de 4.3.1 y licencia Apache 2.0.
- [AutoMapper en NuGet](https://www.nuget.org/packages/AutoMapper) - fecha de publicación de 16.2.0 e historial de versiones.
