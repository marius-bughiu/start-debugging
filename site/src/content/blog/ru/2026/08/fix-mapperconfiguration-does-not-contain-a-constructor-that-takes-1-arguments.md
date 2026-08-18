---
title: "Решение: 'MapperConfiguration' does not contain a constructor that takes 1 arguments"
description: "AutoMapper 15 удалил конструктор MapperConfiguration с одним аргументом. Передайте ILoggerFactory вторым аргументом и добавьте действие конфигурации в каждый вызов AddAutoMapper."
pubDate: 2026-08-18
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "csharp"
  - "automapper"
  - "migration"
lang: "ru"
translationOf: "2026/08/fix-mapperconfiguration-does-not-contain-a-constructor-that-takes-1-arguments"
translatedBy: "claude"
translationDate: 2026-08-18
---

`new MapperConfiguration(cfg => ...)` больше не компилируется, потому что AutoMapper 15.0 удалил конструктор с одним аргументом. Передайте `ILoggerFactory` вторым аргументом: `new MapperConfiguration(cfg => ..., loggerFactory)`, либо `NullLoggerFactory.Instance` в тестах. Тот же релиз удалил и все перегрузки `AddAutoMapper`, не принимавшие действие конфигурации, поэтому `services.AddAutoMapper(typeof(Program))` ломается в той же сборке с другим кодом ошибки.

Всё изложенное ниже проверено на AutoMapper 15.1.3 и 16.2.0 с .NET SDK 10.0.201 при целевой платформе `net10.0`. Изменение появилось в [15.0.0 от 2025-07-02](https://github.com/LuckyPennySoftware/AutoMapper/releases/tag/v15.0.0) и в 16.2.0 форма API остаётся такой же.

## Ошибка в контексте

```text
Repro.cs(11,26): error CS1729: 'MapperConfiguration' does not contain a constructor that takes 1 arguments
```

Если вы регистрируете AutoMapper через внедрение зависимостей, та же сборка обычно выдаёт ещё две ошибки, которые представляют собой то же критическое изменение в другом обличье:

```text
Repro.cs(15,32): error CS1503: Argument 2: cannot convert from 'System.Type' to 'System.Action<AutoMapper.IMapperConfigurationExpression>'
Repro.cs(16,32): error CS1503: Argument 2: cannot convert from 'System.Reflection.Assembly' to 'System.Action<AutoMapper.IMapperConfigurationExpression>'
```

Три ошибки, одна причина. Если исправить только конструктор, сборка останется красной.

## Почему конструктор с одним аргументом исчез

В AutoMapper 15 появились лицензионный ключ и журналирование состояния лицензии, а этому журналированию нужно куда-то писать. Вместо того чтобы обращаться к статическому логгеру или к внешнему приёмнику, сопровождающие сделали зависимость явной: `MapperConfiguration` теперь принимает ту `ILoggerFactory`, через которую будет писать. Джимми Богард [подтвердил в issue #4542](https://github.com/LuckyPennySoftware/AutoMapper/issues/4542), что это намеренное критическое изменение и что оно отсутствовало в исходных заметках к релизу. Именно поэтому столько людей на него натыкается, не понимая, что искать.

Рефлексия по опубликованным сборкам делает разницу наглядной. AutoMapper 14.0.0 предоставляет:

```text
// AutoMapper 14.0.0
MapperConfiguration.ctor(MapperConfigurationExpression)
MapperConfiguration.ctor(Action`1)
```

AutoMapper 15.1.3 и 16.2.0 предоставляют оба:

```text
// AutoMapper 15.1.3 and 16.2.0
MapperConfiguration.ctor(MapperConfigurationExpression, ILoggerFactory)
MapperConfiguration.ctor(Action`1, ILoggerFactory)
```

Перегрузки с параметром `ILoggerFactory` по умолчанию нет, поэтому сохранить компиляцию старого места вызова невозможно. Каждое прямое создание объекта придётся тронуть.

## Минимальное воспроизведение

```csharp
// .NET 10, C# 14, AutoMapper 15.1.3
using AutoMapper;

public record Source(int Id, string Name);
public record Dest(int Id, string Name);

public class Repro
{
    public void OldStyle()
    {
        // error CS1729
        var config = new MapperConfiguration(cfg => cfg.CreateMap<Source, Dest>());
        var mapper = config.CreateMapper();
    }
}
```

Файл `csproj`, в котором нет ничего кроме `<PackageReference Include="AutoMapper" Version="15.1.3" />`, уже воспроизводит ошибку. Обратите внимание: это поломка только на этапе компиляции. В движке маппинга ничего не изменилось, поэтому как только места вызова начнут компилироваться, ваши маппинги будут вести себя ровно так же, как на 14.

## Что передавать в качестве ILoggerFactory вне внедрения зависимостей?

Для статических конфигураций маппера, тестовых фикстур и консольных утилит, где хоста нет, правильный ответ это `NullLoggerFactory.Instance` из `Microsoft.Extensions.Logging.Abstractions`. AutoMapper уже зависит от `Microsoft.Extensions.Logging.Abstractions`, так что добавлять новый пакет не нужно.

```csharp
// .NET 10, C# 14, AutoMapper 15.1.3
using AutoMapper;
using Microsoft.Extensions.Logging.Abstractions;

public static class Maps
{
    public static readonly MapperConfiguration Config = new(
        cfg =>
        {
            cfg.LicenseKey = "<your key>";
            cfg.AddProfile<MyProfile>();
        },
        NullLoggerFactory.Instance);

    public static readonly IMapper Mapper = Config.CreateMapper();
}
```

Статическая `MapperConfiguration` по-прежнему поддерживаемый приём. Это было второе опасение в issue #4542, и Богард ответил на него прямо: статический экземпляр допустим, а лицензионный ключ может браться из `IConfiguration` или из хранилища секретов, а не зашиваться литералом.

`AssertConfigurationIsValid()` по-прежнему висит на объекте конфигурации ровно как раньше, поэтому тестам валидации не нужны изменения помимо конструктора:

```csharp
// .NET 10, C# 14, AutoMapper 15.1.3
[Fact]
public void Mapping_configuration_is_valid()
{
    var config = new MapperConfiguration(
        cfg => cfg.AddProfile<MyProfile>(),
        NullLoggerFactory.Instance);

    config.AssertConfigurationIsValid();
}
```

Если вы хотите видеть диагностику лицензии в прогоне тестов, замените `NullLoggerFactory.Instance` на настоящую фабрику. Больше этот параметр ни для чего не используется.

## Как исправить вызовы AddAutoMapper, сломавшиеся одновременно?

Каждая перегрузка `AddAutoMapper` без действия конфигурации была удалена в 15.0. Сравнение публичных статических методов `Microsoft.Extensions.DependencyInjection.ServiceCollectionExtensions` по версиям показывает, что исчезли эти три:

```text
// Present in AutoMapper 14.0.0, gone in 15.0.0 and later
AddAutoMapper(IServiceCollection, Assembly[])
AddAutoMapper(IServiceCollection, Type[])
AddAutoMapper(IServiceCollection, IEnumerable<Assembly>, ServiceLifetime)
```

Это значит, что действие конфигурации теперь обязательно и всегда идёт вторым:

```csharp
// .NET 10, C# 14, AutoMapper 15.1.3, ASP.NET Core minimal host
var builder = WebApplication.CreateBuilder(args);

// Before (AutoMapper 14):
// builder.Services.AddAutoMapper(typeof(Program));

// After:
builder.Services.AddAutoMapper(
    cfg => cfg.LicenseKey = builder.Configuration["AutoMapper:LicenseKey"],
    typeof(Program));
```

Если действию нечего сказать, пустая лямбда допустима: `services.AddAutoMapper(_ => { }, typeof(Program))`. По позиции она всё равно обязательна.

Путь через внедрение зависимостей сам предоставляет `ILoggerFactory`, поэтому никакой `MapperConfiguration` вручную создавать не нужно. Стоит знать, что именно регистрируется, потому что времена жизни асимметричны:

```text
// Registered by AddAutoMapper, AutoMapper 15.1.3
AutoMapper.IConfigurationProvider -> Singleton
AutoMapper.IMapper               -> Transient
```

Дорогой объект, скомпилированная конфигурация, является синглтоном. `IMapper` это дешёвая transient-обёртка над ним, поэтому внедрение `IMapper` в scoped- и transient-сервисы ничего не стоит и не приводит к [проблеме захваченной зависимости при получении scoped-сервиса из синглтона](/ru/2026/05/fix-cannot-consume-scoped-service-from-singleton/).

Есть и перегрузка, которая передаёт вам `IServiceProvider`. Она полезна, когда ключ лежит за сервисом, а не в сырой конфигурации:

```csharp
// .NET 10, C# 14, AutoMapper 15.1.3
services.AddAutoMapper(
    (sp, cfg) => cfg.LicenseKey = sp.GetRequiredService<ILicenseStore>().AutoMapperKey,
    typeof(MyProfile));
```

## Что делать, если сразу следом появляется 'No service for type ILoggerFactory has been registered'?

Вы правите конструктор, сборка зеленеет, и тест падает уже во время выполнения:

```text
System.InvalidOperationException: No service for type 'Microsoft.Extensions.Logging.ILoggerFactory' has been registered.
```

Это регистрация внедрения зависимостей тянется за фабрикой логгеров, которая теперь нужна AutoMapper. В приложении ASP.NET Core вы этого никогда не увидите, потому что `WebApplicationBuilder` настраивает журналирование раньше, чем вы успеете вызвать `AddAutoMapper`. Увидите вы это в модульных тестах и небольших консольных приложениях, которые собирают голую `ServiceCollection`:

```csharp
// .NET 10, C# 14, AutoMapper 15.1.3 - throws on resolve
var services = new ServiceCollection();
services.AddAutoMapper(cfg => cfg.CreateMap<Source, Dest>());
var mapper = services.BuildServiceProvider().GetRequiredService<IMapper>();
```

Исправляется одной строкой:

```csharp
// .NET 10, C# 14, AutoMapper 15.1.3 - resolves
var services = new ServiceCollection();
services.AddLogging();                       // this is the missing piece
services.AddAutoMapper(cfg => cfg.CreateMap<Source, Dest>());
var mapper = services.BuildServiceProvider().GetRequiredService<IMapper>();
```

Сообщение об ошибке достаточно общее, чтобы люди гонялись за ним как за отдельным багом, ровно так же, как [отсутствующая регистрация DbContextOptions](/ru/2026/06/fix-no-service-for-type-dbcontextoptions-has-been-registered/) отправляет искать не в тот файл. Если оно появилось в том же коммите, который перевёл вас на AutoMapper 15, дело именно в этом.

## Что на самом деле происходит, если лицензионный ключ так и не задать

Ничего не ломается. AutoMapper 15.1.3 прекрасно маппит объекты вообще без ключа, с недействительным ключом и с пустой строкой. Получаете вы сообщение в журнале, в категории `LuckyPennySoftware.AutoMapper.License`:

```text
warn: LuckyPennySoftware.AutoMapper.License[0]
      You do not have a valid license key for the Lucky Penny software AutoMapper. This is allowed for
      development and testing scenarios. If you are running in production you are required to have a
      licensed version. Please visit https://luckypennysoftware.com to obtain a valid license.
```

Это весь механизм принуждения, и именно поэтому параметру `ILoggerFactory` пришлось появиться. Документация прямо говорит, что никакого другого принуждения к лицензии, кроме сообщений в журнале, нет. Это юридическое обязательство, а не техническая преграда, поэтому относитесь к предупреждению как к вопросу соответствия требованиям, а не как к проблеме выполнения, которую надо заглушить.

Одна деталь, которая стоит людям вечера: неправильно сформированный ключ пишется на уровне critical перед предупреждением, с ошибкой разбора JWT, потому что ключ это подписанный JWT:

```text
crit: LuckyPennySoftware.AutoMapper.License[0]
      Error validating the Lucky Penny software license key
      Microsoft.IdentityModel.Tokens.SecurityTokenMalformedException: IDX14100: JWT is not well formed,
      there are no dots (.).
```

Если ваш конвейер журналирования поднимает тревогу на `Critical`, обрезанный или испорченный пробелами ключ в переменной окружения разбудит кого-нибудь ночью, пока приложение продолжает работать корректно. Поищите эту строку, прежде чем решить, что AutoMapper сломан.

Ещё два практических замечания по ключу. Во-первых, `cfg.LicenseKey` не единственный документированный путь: в документации перечислены переменные окружения `AUTOMAPPER_LICENSE_KEY` и `LUCKYPENNY_LICENSE_KEY`, разрешаемые в этом порядке после явного значения в коде. В моих тестах на 15.1.3 ни одна из переменных окружения не подхватывалась, поскольку намеренно испорченное значение в каждой из них давало только общее предупреждение об отсутствии лицензии и никогда ту ошибку разбора JWT, которую вызывает явный `cfg.LicenseKey`. На линии 15.x задавайте ключ в коде и читайте его из конфигурации. Во-вторых, AutoMapper 16.2.0 в том же тесте не записал ни одного сообщения о лицензии, так что не считайте отсутствие предупреждения доказательством того, что ключ принят.

## Стоит ли вместо этого закрепиться на AutoMapper 14?

Это самый частый обходной путь, предлагаемый в обсуждениях issue, и с 2026-03 он плохой. AutoMapper 14.0.0 и всё, что ниже 15.1.1, несут [GHSA-rvv3-g6hj-g44x](https://github.com/advisories/GHSA-rvv3-g6hj-g44x), проблему неконтролируемой рекурсии высокой степени серьёзности (CVSS 7.5): маппинг глубоко вложенного или самоссылающегося графа объектов исчерпывает стек и роняет процесс с `StackOverflowException`, которое невозможно перехватить. Если недоверенный ввод доходит до маппируемого типа, это отказ в обслуживании. Возврат на 14.0.0 сегодня даёт вот это при каждой сборке:

```text
warning NU1903: Package 'AutoMapper' 14.0.0 has a known high severity vulnerability,
https://github.com/advisories/GHSA-rvv3-g6hj-g44x
```

Исправление вышло в 15.1.1 и 16.1.1, оба релиза опубликованы в 2026-03. Так что настоящий выбор стоит между 15.1.3 и 16.2.0, а не между 15 и 14. Обе версии принимают один и тот же конструктор, поэтому описанная выше работа по миграции одинакова в любом случае.

Если вы предпочли бы вообще не платить за маппер, это решение отдельно от данной ошибки компиляции, и принимать его лучше обдуманно, а не под давлением сломанной сборки. Компромиссы разобраны в разборе [миграции с AutoMapper на маппинг, генерируемый исходным кодом, с Mapperly](/ru/2026/05/migrate-from-automapper-to-source-generated-mapping/), а тот же вопрос коммерческой лицензии уже разыгрывался для другой библиотеки Богарда в [MediatR против простых сервисных классов](/ru/2026/05/mediatr-vs-plain-service-classes-in-2026/).

## Что снова меняется в AutoMapper 16

Ничего, к чему нужно прикасаться. Форма конструктора и сигнатуры `AddAutoMapper` идентичны между 15.1.3 и 16.2.0, поэтому код, исправленный под 15, компилируется на 16 без изменений. Различия лежат в упаковке:

- 15.x нацелена на `net8.0`, `net9.0` и `netstandard2.0`.
- 16.x добавляет `net10.0` и `net471`, а её зависимости `Microsoft.Extensions.*` подняты с 8.0.0 до 10.0.0.

Если вы уже на .NET 10, версия 16.2.0 избавляет граф зависимостей от пакетов расширений 8.0.0. Если вы застряли на .NET 8 с зафиксированным набором транзитивных зависимостей, 15.1.3 это поддерживаемое и пропатченное место, где можно остаться. Обе версии находятся за исправлением безопасности, а само обновление в обоих случаях сводится к одной и той же правке в три строки: добавить фабрику логгеров, добавить действие конфигурации, решить, где живёт ключ.

## Связанные материалы

- [Миграция с AutoMapper на маппинг, генерируемый исходным кодом, с Mapperly](/ru/2026/05/migrate-from-automapper-to-source-generated-mapping/)
- [MediatR против простых сервисных классов в 2026: должна ли смена лицензии вас сдвинуть?](/ru/2026/05/mediatr-vs-plain-service-classes-in-2026/)
- [Исправление: No service for type 'Microsoft.EntityFrameworkCore.DbContextOptions' has been registered](/ru/2026/06/fix-no-service-for-type-dbcontextoptions-has-been-registered/)
- [Решение: Cannot consume scoped service 'X' from singleton 'Y'](/ru/2026/05/fix-cannot-consume-scoped-service-from-singleton/)
- [Миграция с EF Core 6 на EF Core 11: критические изменения, которые действительно бьют](/ru/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/)

## Источники

- [Руководство по обновлению до AutoMapper 15.0](https://docs.automapper.io/en/stable/15.0-Upgrade-Guide.html)
- [Заметки к релизу AutoMapper v15.0.0](https://github.com/LuckyPennySoftware/AutoMapper/releases/tag/v15.0.0)
- [Issue #4542: MapperConfiguration single argument constructor](https://github.com/LuckyPennySoftware/AutoMapper/issues/4542)
- [Документация по настройке лицензии AutoMapper](https://docs.automapper.io/en/stable/License-configuration.html)
- [Документация по внедрению зависимостей в AutoMapper](https://docs.automapper.io/en/stable/Dependency-injection.html)
- [GHSA-rvv3-g6hj-g44x: неконтролируемая рекурсия в AutoMapper](https://github.com/advisories/GHSA-rvv3-g6hj-g44x)
