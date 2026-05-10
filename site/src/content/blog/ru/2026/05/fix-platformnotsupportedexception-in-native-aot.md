---
title: "Fix: PlatformNotSupportedException: Operation is not supported on this platform в Native AOT"
description: "Native AOT убирает JIT и интерпретатор, поэтому reflection emit, компиляция деревьев выражений и невиденные MakeGenericType бросают во время выполнения. Найдите вызов через IL3050 и замените его на генератор исходного кода или заранее подготовленный путь."
pubDate: 2026-05-10
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "native-aot"
  - "trimming"
lang: "ru"
translationOf: "2026/05/fix-platformnotsupportedexception-in-native-aot"
translatedBy: "claude"
translationDate: 2026-05-10
---

Решение: Native AOT публикует один статический нативный бинарник без JIT и без интерпретатора, поэтому любой путь кода, который генерирует IL во время выполнения, компилирует дерево `Expression<T>` или просит среду выполнения собрать обобщённую инстанциацию, которую она никогда не видела, бросит `PlatformNotSupportedException`. Первый шаг всегда один и тот же: пересоберите с `dotnet publish -r <rid> -c Release` и прочитайте предупреждение `IL3050`, в котором указан член-нарушитель, затем замените его на AOT-совместимую альтернативу (генератор исходного кода, заранее инстанцированный обобщённый тип или feature switch).

```text
System.PlatformNotSupportedException: Operation is not supported on this platform.
   at System.Reflection.Emit.DynamicMethod..ctor(String name, Type returnType, Type[] parameterTypes)
   at SomeLibrary.Internal.ExpressionCompiler.Compile(LambdaExpression expr)
   at SomeLibrary.PublicEntryPoint.DoTheThing()
   at Program.<Main>$(String[] args) in /src/Program.cs:line 12
```

```text
System.PlatformNotSupportedException: Dynamic code generation is not supported on this platform.
   at System.Reflection.Emit.AssemblyBuilder.DefineDynamicAssembly(...)
   at System.Linq.Expressions.Compiler.LambdaCompiler.CompileLambda(LambdaExpression lambda, Boolean hasClosureArgument)
   at System.Linq.Expressions.Expression`1[[T]].Compile()
```

Это руководство написано против .NET 11 SDK (preview 4), `Microsoft.NET.Sdk` 11.0.0-preview.4 и C# 14. Текст исключения и лежащее в основе ограничение остаются стабильными с того момента, как Native AOT появился как поддерживаемый способ развёртывания в .NET 8, поэтому всё ниже применимо без изменений к .NET 8, 10 и 11. В .NET 9 добавили историю с анализатором `RequiresDynamicCodeAttribute`, который стоит за IL3050, а .NET 11 ужесточает её ещё сильнее, переводя больше путей BCL в AOT-безопасные варианты.

Два разных сообщения используют один и тот же тип исключения. `Operation is not supported on this platform` приходит из быстрого пути JIT-emit, который натыкается на `RuntimeFeature.IsDynamicCodeSupported == false`. `Dynamic code generation is not supported on this platform` приходит из самого `Reflection.Emit`, когда что-то пытается построить `DynamicAssembly` или `DynamicMethod`. У них одна и та же первопричина и одна и та же поверхность исправления, поэтому не тратьте время, рассматривая их как разные баги.

## Почему single-file Native AOT-бинарник не может генерировать IL

`dotnet publish /p:PublishAot=true` создаёт полностью предварительно скомпилированный нативный образ. JIT не статически слинкован. Интерпретатор Mono не статически слинкован. Писатель `Reflection.Emit` из CoreCLR вырезается при компиляции. Во время выполнения `System.Runtime.CompilerServices.RuntimeFeature.IsDynamicCodeSupported` возвращает `false`, и любой API, который зависит от записи нового IL или сборки нового делегата из сырого машинного кода, либо возвращает отказ в стиле охранника `IsSupported`, либо выбрасывает это исключение.

Четыре формы, которые попадают на это ограничение в реальном коде:

1. **Прямое использование `Reflection.Emit`.** `DynamicMethod`, `AssemblyBuilder.DefineDynamicAssembly`, `TypeBuilder`, `ILGenerator.Emit`. Бросают сразу же.
2. **`Expression<T>.Compile()` над нетривиальным деревом.** Компилятор выражений внутри опускается до `DynamicMethod`. `Compile(preferInterpretation: true)` откатывается на интерпретатор в .NET 8 и 10, но интерпретатор тоже выпиливается из Native AOT, поэтому даже перегрузка с `true` бросает, если только в BCL нет fallback'а, обходящего дерево.
3. **`Type.MakeGenericType` / `MethodInfo.MakeGenericMethod` с аргументами типа, которых компилятор не видел.** `List<int>` работает, потому что AOT-компилятор инстанцировал его. `MakeGenericType(someTypeFromReflection)` над значимым типом, до которого компилятор так и не добрался, бросает.
4. **Транзитивно всё, построенное поверх вышеуказанного.** Скомпилированные через выражения мапперы AutoMapper, FastMember, открытые обобщённые типы MediatR, кеш конвертеров Newtonsoft.Json, путь скомпилированного запроса EF Core над POCO-графами, которые не покрыл model builder, gRPC.Core со старым codegen и клиенты Dataverse / Service Fabric / WCF, опирающиеся на динамические прокси.

В JIT-сборке среда выполнения просто генерирует tier-0 код для нового метода и идёт дальше. В Native AOT ей некуда положить новый код, поэтому она бросает в первый же момент, когда вызывается API.

## Минимальное воспроизведение

```csharp
// .NET 11 SDK preview 4, C# 14, <PublishAot>true</PublishAot>
using System.Linq.Expressions;

Expression<Func<int, int>> expr = x => x + 1;
var compiled = expr.Compile();   // throws on Native AOT
Console.WriteLine(compiled(41));
```

`.csproj`:

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net11.0</TargetFramework>
    <PublishAot>true</PublishAot>
    <InvariantGlobalization>true</InvariantGlobalization>
  </PropertyGroup>
</Project>
```

Опубликуйте под Linux x64:

```bash
dotnet publish -r linux-x64 -c Release
```

Шаг публикации печатает:

```text
warning IL3050: Using member 'System.Linq.Expressions.Expression`1<TDelegate>.Compile()' which has 'RequiresDynamicCodeAttribute' can break functionality when AOT compiling. Compiling a lambda requires dynamic code.
```

Запустите бинарник:

```text
Unhandled exception. System.PlatformNotSupportedException: Dynamic code generation is not supported on this platform.
```

Это каноническая версия ошибки. Та же форма применима независимо от того, является ли нарушителем ваш собственный код, NuGet-пакет или транзитивно подтянутый кусок фреймворка.

## Решение, в подробностях

Решения ниже упорядочены от самого дешёвого к самому инвазивному. Берите первое, которое скомпилируется.

### 1. Замените API на AOT-совместимую альтернативу (предпочтительно)

Почти у каждого проблемного API теперь есть AOT-дружественная замена, которую команда .NET выпустила именно из-за этого класса исключений.

| Враждебно к AOT | AOT-дружественная замена |
|---|---|
| `Newtonsoft.Json` | `System.Text.Json` с контекстом-генератором исходного кода `[JsonSerializable]` |
| `AutoMapper` (компилируемый через выражения) | Мапперы, сгенерированные исходным кодом (режим source-generator у Mapster, Riok.Mapperly, `MapTo`) |
| `MediatR` (регистрация открытых обобщений) | Написанные вручную интерфейсы handler'ов, либо `Mediator` (тот, что с генератором исходного кода) |
| `Microsoft.AspNetCore.Mvc.Controllers` | `WebApplication.CreateSlimBuilder` + minimal API с `JsonSerializerContext` |
| Модель EF Core, собираемая в runtime | `OptimizeQuery` / `dotnet ef dbcontext optimize` для предварительной генерации модели |
| Перехватчики `Castle.DynamicProxy` | Декораторы, сгенерированные исходным кодом (например, через Roslyn или PolySharp) |
| `Expression<T>.Compile()` | `delegate*<...>`, литерал `Func<...>` или ручная замена `IL`, скомпилированная во время сборки |

Конкретный пример, заменяющий вызов компиляции лямбды:

```csharp
// .NET 11, C# 14
// Before: AOT-hostile
Expression<Func<int, int>> expr = x => x + 1;
var compiled = expr.Compile();

// After: pure delegate, no expression tree, no Compile()
Func<int, int> compiled = x => x + 1;
```

Если вам действительно нужна форма дерева выражений (потому что вы инспектируете тело), оставьте дерево, но прекратите вызывать `Compile()` и переключите потребителя на `delegate`, написанный вами вручную.

### 2. Используйте `RuntimeFeature.IsDynamicCodeSupported` как feature switch

Если динамический путь опционален, спрячьте его за runtime feature flag и поставьте медленный, но AOT-безопасный fallback:

```csharp
// .NET 11, C# 14
using System.Runtime.CompilerServices;

public static T Materialize<T>(IDataReader reader)
{
    if (RuntimeFeature.IsDynamicCodeSupported)
    {
        return EmitMaterializer<T>.Compile()(reader);   // existing fast path
    }

    return ReflectionMaterializer<T>.Materialize(reader); // slower but no IL emit
}
```

AOT-компилятор статически вычисляет `IsDynamicCodeSupported` как `false` для опубликованного бинарника и обрезает всю динамическую ветку, включая `EmitMaterializer<T>`. Никакого больше IL3050, никакого больше выброса в runtime. Важно: анализатор обрезает только тогда, когда тестом является буквальное чтение свойства; не присваивайте его сначала локальной переменной и не оборачивайте в метод, иначе trimmer оставит мёртвую ветку.

### 3. Заранее инстанцируйте обобщения, которые компилятор не видит

Если в сообщении указано `MakeGenericType` или `MakeGenericMethod`, AOT-компилятор не знает, какой `T` собирать. Два выхода:

```csharp
// .NET 11, C# 14
// Tell the AOT compiler exactly which generic instantiations to keep.
[DynamicallyAccessedMembers(DynamicallyAccessedMemberTypes.PublicConstructors)]
public class Repository<T> { /* ... */ }

// And in your DI bootstrap, use closed generics:
services.AddScoped<Repository<User>>();
services.AddScoped<Repository<Order>>();
// not: services.AddScoped(typeof(Repository<>));
```

Или для чисто рефлексивного вызова переключитесь на эквивалент, сгенерированный исходным кодом. ASP.NET Core 11 поставляет AOT-безопасные перегрузки для распространённых форм внедрения зависимостей; команда runtime также добавила AOT-дружественные intrinsic'и `Activator.CreateInstance<T>()` для конструкторов без параметров.

### 4. Пометьте метод как `RequiresDynamicCode` и перестаньте вызывать его из AOT-путей

Если вы пишете библиотеку и метод действительно нуждается в динамической генерации кода, пробросьте требование на ваших вызывающих, чтобы анализатор мог предупредить уже на их уровне:

```csharp
// .NET 11, C# 14
[RequiresDynamicCode("Builds a per-type accessor with Reflection.Emit. " +
                     "Not supported in Native AOT. Use SourceGenAccessor<T> instead.")]
public static Func<object, object> BuildGetter(PropertyInfo prop) => /* emit */;
```

Атрибут не исправляет исключение в runtime, но превращает молчаливый креш в IL3050 во время сборки, а это и есть контракт, которого ожидают потребители Native AOT.

### 5. Уберите зависимость

Последний вариант. Если библиотека, от которой вы зависите, жёстко зашивает `Reflection.Emit` и не предлагает AOT-режим, единственными честными вариантами остаются (а) заменить библиотеку, (б) оставить эту подсистему за границей не-AOT-процесса (worker, опубликованный с JIT, за HTTP- или named pipe-границей) или (в) ждать, пока сопровождающий выше по течению выпустит AOT-путь. Не глушите исключение `try/catch`-ом; программа после этого находится в неопределённом состоянии, потому что потребитель почти наверняка зависит от провалившейся операции.

## Распространённые варианты и похожие ошибки

- **`PlatformNotSupportedException: System.Reflection.Emit.DynamicMethod` из `System.Linq.Expressions`.** Та же первопричина, что и у Compile(), часто всплывает внутри провайдеров `Queryable` и JSON-конвертеров. Поищите в логе публикации строку IL3050, которая называет исходный метод. Если вы пришли сюда из JSON-сериализатора, см. [наш разбор того, как писать AOT-безопасные конвертеры System.Text.Json](/ru/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/).
- **`PlatformNotSupportedException: Operation is not supported on this platform` из `Assembly.Load(byte[])`.** Native AOT не позволяет загружать дополнительные управляемые сборки во время выполнения. Fallback'а нет. Перенесите загрузку плагинов в не-AOT хост.
- **`PlatformNotSupportedException: Cannot emit a dynamic assembly.` из `Castle.DynamicProxy`.** В Castle нет AOT-пути начиная с 5.x; замените перехват на декораторы, сгенерированные исходным кодом, или вынесите проксируемый сервис из AOT-бинарника.
- **`NotSupportedException: BinaryFormatter serialization and deserialization are disabled.`** Другой тип исключения, но та же общая тема "удалено из AOT-бинарника". Не оборачивайте его в `try/catch`; перепишите сериализацию на System.Text.Json.
- **`PlatformNotSupportedException: ... requires the JIT.`** Это сообщение вы увидите на целях интерпретатора Mono (iOS, watchOS, MAUI Catalyst), когда интерпретатор тоже выключен. Поверхность исправления та же, что и в Native AOT: заранее запеките обобщение, переключитесь на генератор исходного кода или спрячьте путь за feature switch.
- **Ошибка появляется только на одной платформе.** Некоторые пакеты поставляют NuGet runtime asset на каждый RID. Сборка `linux-x64` может скомпилироваться с отключённым `Reflection.Emit`, тогда как `win-x64` работает. Всегда тестируйте публикацию на каждом RID, который вы поставляете.

## Как убедиться, что вы действительно починили

Три проверки перед тем, как объявлять победу:

1. `dotnet publish -r <rid> -c Release` не выдаёт ни одного предупреждения `IL3050`. Поднимите их до ошибок с помощью `<TreatWarningsAsErrors>true</TreatWarningsAsErrors>` и `<IsAotCompatible>true</IsAotCompatible>`.
2. Опубликованный бинарник выполняет ранее падавший путь под `DOTNET_TieredCompilation=0` и `DOTNET_ReadyToRun=0`. Native AOT не учитывает эти переменные, но они дают быстрый способ убедиться, что вы случайно не тестируете self-contained JIT-сборку.
3. Таблица импортов опубликованного бинарника не содержит ни одной ссылки на JIT (`clrjit.dll` / `libclrjit.so`). На Linux `nm --dynamic` по бинарнику не должен показывать символы `clrjit`.

Если все три проходят, у вас AOT-чистый бинарник, и исключение по тому же пути не вернётся.

## Связанное

- [Как использовать Native AOT с minimal API ASP.NET Core](/ru/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) проводит вас по полному пути публикации и поверхности предупреждений IL3050 для типичного веб-сервиса.
- [Как уменьшить время холодного старта для AWS Lambda на .NET 11](/ru/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) — это причина, по которой большинство команд вообще тянутся к Native AOT.
- [Как написать собственный JsonConverter в System.Text.Json](/ru/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) — AOT-безопасная замена тогда, когда вас тянуло отдать `JsonSerializer`-у рефлексивные метаданные.
- [Как написать генератор исходного кода для INotifyPropertyChanged](/ru/2026/04/how-to-write-a-source-generator-for-inotifypropertychanged/) — это паттерн, который вы используете, когда существующая библиотека хочет сделать `Reflection.Emit` за вас.
- [В Rider 2026.1 появился просмотрщик ASM, декодирующий вывод JIT и Native AOT](/ru/2026/04/rider-2026-1-asm-viewer-jit-nativeaot-disassembly/) — пригодится, когда вы хотите убедиться, что trimmer действительно убрал динамическую ветку.

## Источники

- [Native AOT deployment overview, Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/)
- [IL3050: Avoid calling members annotated with RequiresDynamicCodeAttribute when publishing as Native AOT, Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/warnings/il3050)
- [Introduction to AOT warnings, Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/fixing-warnings)
- [Intrinsic APIs marked RequiresDynamicCode, Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/intrinsic-requiresdynamiccode-apis)
- [How to make libraries compatible with Native AOT, .NET Blog](https://devblogs.microsoft.com/dotnet/creating-aot-compatible-libraries/)
- [AOT with Reflection, dotnet/runtime discussion #95244](https://github.com/dotnet/runtime/discussions/95244)
- [RuntimeFeature.IsDynamicCodeSupported, .NET API browser](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.runtimefeature.isdynamiccodesupported)
