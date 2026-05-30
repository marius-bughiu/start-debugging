---
title: "Миграция с AutoMapper на маппинг, генерируемый исходным кодом, с Mapperly"
description: "Пошаговый чек-лист по замене Profiles, IMapper, ForMember и ProjectTo из AutoMapper 15 на мапперы, генерируемые исходным кодом Riok.Mapperly 4.3 в .NET 11."
pubDate: 2026-05-30
updatedDate: 2026-05-30
template: migration
tags:
  - "migration"
  - "automapper"
  - "mapperly"
  - "source-generators"
  - "dotnet-11"
lang: "ru"
translationOf: "2026/05/migrate-from-automapper-to-source-generated-mapping"
translatedBy: "claude"
translationDate: 2026-05-30
---

Замена AutoMapper генератором исходного кода -- это механический рефакторинг файл за файлом, а не переписывание. Для типичного сервиса с 30-80 маппингами, разбросанными по нескольким классам `Profile`, заложите от половины дня до дня: каждый `CreateMap<Source, Dest>()` превращается в метод `partial` в классе `[Mapper]`, вызовы `IMapper.Map<T>` становятся прямыми вызовами методов, а `ProjectTo<T>()` превращается в сгенерированное расширение `IQueryable`. Ломается всё, что опиралось на гибкость AutoMapper во время выполнения: динамические вызовы `Map(object)`, `IValueResolver` с внедрёнными сервисами и регистрация через сканирование сборок. Это стоит делать, если вы выше границы дохода AutoMapper в 5 000 000 USD и не хотите покупать лицензию, если вы хотите, чтобы работали Native AOT и тримминг, или если вы хотите, чтобы немаппленные свойства приводили к ошибке сборки, а не отбрасывались молча во время выполнения.

Упоминаемые версии: это руководство охватывает уход с AutoMapper 14.x (последний выпуск под MIT) и 15.0 (первый выпуск с двойной лицензией Reciprocal Public License 1.5 / коммерческой от Lucky Penny Software). Замена нацелена на `<TargetFramework>net11.0</TargetFramework>` с .NET 11 SDK, C# 14 и Riok.Mapperly 4.3.1 (выпущена 2025-12-22). Если вы ещё решаете, уходить ли вообще, это та же история поставщика, что и с MediatR, поэтому прочитайте [миграцию с MediatR на простое внедрение зависимостей](/ru/2026/05/migrate-from-mediatr-to-plain-dependency-injection/) для параллельного случая; эта статья предполагает, что решение уже принято.

## Почему команды уходят с AutoMapper именно сейчас

- **Лицензия вынуждает решать выше 5 млн USD.** AutoMapper 15.0 выпускается под реципрокной copyleft-лицензией RPL-1.5 плюс платный коммерческий уровень. Бесплатное использование покрывает компании с годовым валовым доходом ниже 5 000 000 USD и непроизводственные среды. Выше этой границы коммерческое ПО с закрытым исходным кодом не может использовать сборку под RPL, так что вариант -- купить или уйти. Всё, что опубликовано под MIT (14.x и ранее), остаётся доступным под MIT навсегда, но вы перестаёте получать исправления.
- **Ошибки маппинга переходят со времени выполнения на время компиляции.** AutoMapper проверяет конфигурацию только когда вы вызываете `AssertConfigurationIsValid()` или доходите до маппинга во время выполнения. Mapperly сообщает о немаппленном свойстве диагностикой `RMG` во время компиляции, так что забытое поле -- это предупреждение сборки, а не `NullReferenceException` в продакшене.
- **Запуск становится дешевле, а AOT -- проще.** AutoMapper строит и компилирует выражения маппинга при первом использовании через рефлексию. Mapperly выдаёт обычный C# во время компиляции, так что нет ни стоимости запуска, ни рефлексии, борющейся с тримминг-инструментом, что важно при [сокращении времени холодного старта AWS Lambda на .NET 11](/ru/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) или при поставке [Native AOT](/ru/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/).
- **Вы можете читать сгенерированный код.** Mapperly пишет читаемое тело частичного метода, в которое можно зайти отладчиком, вместо непрозрачного скомпилированного дерева выражений.

## Что ломается

| Область | Изменение | Серьёзность |
| --- | --- | --- |
| Внедрение `IMapper` | Заменяется конкретным сгенерированным классом маппера, внедряемым напрямую | высокая |
| `Profile` + `CreateMap<,>()` | Схлопываются в частичный класс `[Mapper]` с одним методом `partial` на направление | высокая |
| `ForMember(... MapFrom ...)` | Заменяется на `[MapProperty]` или приватный метод маппинга | высокая |
| `ReverseMap()` | Нет автоматического обратного маппинга; метод обратного направления объявляется явно | средняя |
| `IValueResolver` / `ITypeConverter` с DI | Заменяются конструктором у маппера плюс приватным методом | средняя |
| `ProjectTo<T>(config)` | Заменяется сгенерированным расширением проекции `IQueryable<T>` | средняя |
| Сканирование `AddAutoMapper(assembly)` | Заменяется явной регистрацией `AddSingleton<TMapper>()` | средняя |
| `mapper.Map(object, type)` (динамический) | Нет нетипизированной точки входа во время выполнения; каждый маппинг -- типизированный метод | высокая |
| Тест `AssertConfigurationIsValid()` | Избыточен; сборка и есть утверждение | низкая |

## Предполётный чек-лист

1. **Установите .NET 11 SDK** и убедитесь, что `dotnet --version` сообщает `11.0.x`.
2. **Проведите инвентаризацию маппингов.** Запустите grep по `CreateMap<`, чтобы подсчитать конфигурации, и по `\.Map<` и `ProjectTo<`, чтобы подсчитать места вызовов. Это объём вашей миграции.
3. **Найдите динамические маппинги.** Сделайте grep по вызовам `Map(`, которые передают аргумент `Type` или источник `object`. У них нет прямого эквивалента в Mapperly, им нужен типизированный метод или ручной switch; займитесь ими в первую очередь.
4. **Найдите резолверы.** Сделайте grep по `IValueResolver`, `ITypeConverter` и `IMappingAction`. Каждому нужен приватный метод у маппера.
5. **Особый бэкап не нужен, создайте ветку как обычно.** Это изменение обратимо файл за файлом (см. План отката), так что достаточно ветки функциональности.

## Шаги миграции

### 1. Добавьте Mapperly рядом с AutoMapper

Установите оба пакета, чтобы мигрировать по одному profile за раз:

```bash
# .NET 11 SDK, run from the project directory
dotnet add package Riok.Mapperly --version 4.3.1
```

Mapperly поставляет только анализатор и атрибуты из `Riok.Mapperly.Abstractions`, так что он не добавляет зависимости времени выполнения. Убедитесь, что сборка по-прежнему проходит: `dotnet build` без новых ошибок. Оставьте пакет AutoMapper в ссылках, пока не исчезнет последний profile.

### 2. Преобразуйте простой profile в класс `[Mapper]`

Возьмите сначала самый маленький profile. До:

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

После -- частичный класс с частичным методом. Mapperly заполняет тело:

```csharp
// .NET 11, C# 14, Riok.Mapperly 4.3.1
using Riok.Mapperly.Abstractions;

[Mapper]
public partial class CarMapper
{
    public partial CarDto ToDto(Car car);
}
```

Проверьте: соберите проект и откройте сгенерированный файл (он появляется в выводе анализатора, или задайте `<EmitCompilerGeneratedFiles>true</EmitCompilerGeneratedFiles>` в `.csproj`, чтобы записать его на диск). Убедитесь, что каждое свойство `CarDto` присваивается. Если какое-то не присваивается, Mapperly выдаёт диагностику вроде `RMG020` для немаппленного члена назначения; это и есть возможность, а не сбой.

### 3. Переведите `ForMember` в `[MapProperty]`

Настройка по членам из AutoMapper отображается на атрибуты Mapperly. Переименование:

```csharp
// AutoMapper 15.0
CreateMap<Car, CarDto>()
    .ForMember(d => d.ModelName, o => o.MapFrom(s => s.Model));
```

превращается в атрибут `[MapProperty]`, называющий члены источника и назначения:

```csharp
// .NET 11, C# 14, Riok.Mapperly 4.3.1
[MapProperty(nameof(Car.Model), nameof(CarDto.ModelName))]
public partial CarDto ToDto(Car car);
```

Для вычисляемого значения встроенная лямбда `MapFrom` из AutoMapper превращается в приватный метод маппинга, на который ссылаются через `Use`:

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

Чтобы намеренно отбросить свойство, замените `Ignore()` из AutoMapper на `[MapperIgnoreTarget(nameof(CarDto.Internal))]` или `[MapperIgnoreSource(nameof(Car.Secret))]`. Проверьте каждое преобразование, убедившись, что сгенерированное тело присваивает именно те члены, которые вы ожидаете.

### 4. Замените `ReverseMap()` явным методом

`ReverseMap()` из AutoMapper -- это один вызов. У Mapperly нет автоматического обратного маппинга, поэтому объявите обратное направление как отдельный метод у того же маппера:

```csharp
// .NET 11, C# 14, Riok.Mapperly 4.3.1
[Mapper]
public partial class CarMapper
{
    public partial CarDto ToDto(Car car);
    public partial Car ToEntity(CarDto dto);
}
```

Это больше кода, но честнее: обратный маппинг больше не подразумевается, так что асимметричное свойство (поле назначения без источника) всплывает как собственная диагностика, вместо того чтобы молча игнорироваться. Проверьте оба сгенерированных тела.

### 5. Перенесите резолверы с зависимостями в конструктор маппера

`IValueResolver` из AutoMapper, которому нужен внедрённый сервис:

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

превращается в конструктор у маппера плюс приватный метод. Mapperly генерирует конструктор, который пробрасывает объявленные вами параметры, так что маппер участвует в обычном внедрении через конструктор:

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

Проверьте, разрешив маппер из контейнера в тесте и проверив отформатированную цену.

### 6. Преобразуйте `ProjectTo<T>` в сгенерированную проекцию

`ProjectTo<T>()` из AutoMapper строит дерево `Expression`, чтобы EF Core мог перевести маппинг в SQL. Mapperly генерирует такое же расширение `IQueryable`, когда вы объявляете метод, принимающий и возвращающий `IQueryable<T>`:

```csharp
// .NET 11, C# 14, Riok.Mapperly 4.3.1
[Mapper]
public static partial class CarQueryMapper
{
    public static partial IQueryable<CarDto> ProjectToDto(this IQueryable<Car> q);
}
```

Место вызова меняется с `.ProjectTo<CarDto>(_config)` на `.ProjectToDto()`:

```csharp
// .NET 11, EF Core 11
var dtos = await db.Cars
    .Where(c => c.NumberOfSeats > 4)
    .ProjectToDto()
    .ToListAsync();
```

Проверьте, захватив сгенерированный SQL (`db.Cars...ToQueryString()` или логирование EF Core) и убедившись, что проекция выполняется в базе данных, а не в памяти. Учтите, что путь проекции Mapperly не запускает object factories или пользовательские методы создания объектов, потому что он должен произвести переводимое дерево выражений.

### 7. Замените регистрацию DI

Удалите регистрацию AutoMapper и сканирование сборок:

```csharp
// AutoMapper 15.0 - remove this
builder.Services.AddAutoMapper(typeof(CarProfile).Assembly);
```

Регистрируйте каждый маппер явно. Маппер без внедрённых зависимостей не имеет состояния и потокобезопасен, поэтому регистрируйте его как singleton; маппер со scoped-зависимостью должен соответствовать этому жизненному циклу:

```csharp
// .NET 11
builder.Services.AddSingleton<CarMapper>();        // no dependencies
builder.Services.AddScoped<InvoiceMapper>();       // depends on a scoped service
```

Затем переключите потребителей с `IMapper` на конкретный маппер. `_mapper.Map<CarDto>(car)` превращается в `_carMapper.ToDto(car)`. Статическим мапперам регистрация вообще не нужна; вызывайте `CarQueryMapper.ProjectToDto(query)` напрямую. Проверьте, что приложение запускается: отсутствующая регистрация теперь -- это `InvalidOperationException` при запуске, именно тот ранний сбой, который вам нужен.

### 8. Удалите AutoMapper

Как только grep по `using AutoMapper` и `CreateMap<` ничего не возвращает, удалите пакет:

```bash
dotnet remove package AutoMapper
```

Проверьте чистым `dotnet build` и полным прогоном `dotnet test`.

## Проверка

Пройдите этот чек-лист после исчезновения последнего profile:

- `dotnet build` выдаёт ноль ошибок, и вы просмотрели каждую диагностику `RMG`, трактуя предупреждения о немаппленных членах как намеренные или исправляя их.
- `dotnet test` проходит с нулём провалов, включая любой тест, который раньше вызывал `AssertConfigurationIsValid()` (удалите их; сборка теперь и есть утверждение).
- Запросы проекции по-прежнему переводятся в SQL: подтвердите через `ToQueryString()`, что ни один `ProjectToDto()` не скатывается к вычислению на стороне клиента.
- Для AOT- или тримминг-сборки `dotnet publish -c Release` не выдаёт предупреждений тримминга `IL2xxx`, которые раньше приходили из рефлексии AutoMapper.
- Чувствительная к холодному старту нагрузка запускается измеримо быстрее; первый маппинг больше не платит за компиляцию выражений.

## План отката

Эта миграция обратима файл за файлом, что является её главным свойством безопасности. Поскольку вы держали AutoMapper в ссылках вплоть до шага 7, любой отдельный маппер, который ведёт себя неправильно, можно откатить, восстановив его `Profile` и переключив этого одного потребителя обратно на `IMapper`; две системы сосуществуют без конфликта. Единственный необратимый момент -- это шаг 8, удаление пакета. Не удаляйте AutoMapper, пока каждый потребитель не преобразован и весь набор тестов не зелёный. Если вы нервничаете, поставьте преобразования мапперов в одном релизе, а удаление пакета -- в следующем.

## Подводные камни, с которыми мы столкнулись

- **`RMG020` на свойствах, которые вы действительно хотели отбросить.** Mapperly предупреждает, когда член источника никуда не маппится. Заглушите его намеренно с помощью `[MapperIgnoreSource(...)]`, а не подавляя диагностику глобально, чтобы следующий непреднамеренный пропуск всё ещё предупреждал.
- **Уплощение не автоматическое, как вы ожидаете.** AutoMapper уплощает `Order.Customer.Name` в `OrderDto.CustomerName` по соглашению об именах. Mapperly поддерживает уплощение вложенных членов, но если имя вашего DTO не совпадает с путём источника через точку, вы должны прописать его явно через `[MapProperty([nameof(Order.Customer), nameof(Customer.Name)], nameof(OrderDto.CustomerName))]`.
- **Нет нетипизированного `Map(object, Type)`.** Если у вас был обобщённый конвейер, маппивший `object` в `Type` во время выполнения, эквивалента, генерируемого исходным кодом, нет. Замените его типизированным методом на каждую пару или держите небольшой написанный вручную switch. Это единственное место, где чистая замена невозможна.
- **Целевые `record` с `init` и первичным конструктором.** Mapperly маппит через конструктор, когда назначение -- это `record` или имеет только `init`-сеттеры, что обычно и нужно; если он выбирает неправильный конструктор, уточните это через `[MapperConstructor]`. Поведение AutoMapper здесь было более вольным, так что ранее работавший маппинг может выявить настоящую неоднозначность. О формах назначения см. [record против class против struct в C#](/ru/2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix/).
- **Маппинг перечислений строже по имени.** Mapperly по умолчанию маппит перечисления по значению и может предупреждать о немаппленных членах перечисления, тогда как AutoMapper молча пропускал целое число. Решите явно между по значению и по имени с помощью стратегии `[MapEnum]`.

Если вы хотите понять, как генератор делает это во время компиляции, прежде чем доверять ему в продакшене, механика та же, что описана в [как написать генератор исходного кода для INotifyPropertyChanged](/ru/2026/04/how-to-write-a-source-generator-for-inotifypropertychanged/).

## Источники

- [AutoMapper and MediatR Commercial Editions Launch Today](https://www.jimmybogard.com/automapper-and-mediatr-commercial-editions-launch-today/), Jimmy Bogard
- [AutoMapper and MediatR Licensing Update](https://www.jimmybogard.com/automapper-and-mediatr-licensing-update/), Jimmy Bogard
- [Документация Mapperly: конфигурация и queryable-проекции](https://mapperly.riok.app/docs/configuration/mapper/)
- [riok/mapperly на GitHub](https://github.com/riok/mapperly) и [Riok.Mapperly 4.3.1 на NuGet](https://www.nuget.org/packages/Riok.Mapperly)
