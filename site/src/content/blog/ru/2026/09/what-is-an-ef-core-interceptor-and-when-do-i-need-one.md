---
title: "Что такое перехватчик EF Core и когда он нужен?"
description: "Перехватчик EF Core - это класс, который EF вызывает до и после операций вроде выполнения команды или SaveChanges и который может изменить или подавить их, а не только наблюдать. Здесь разобраны семь точек перехвата в EF Core 11, правила регистрации и времени жизни, а также случаи, когда фильтр запроса или обычное журналирование подходят лучше."
pubDate: 2026-09-05
tags:
  - "ef-core"
  - "dotnet-11"
  - "csharp"
  - "aspnetcore"
lang: "ru"
translationOf: "2026/09/what-is-an-ef-core-interceptor-and-when-do-i-need-one"
translatedBy: "claude"
translationDate: 2026-09-05
---

Перехватчик EF Core - это класс, который вы регистрируете на `DbContext` и который EF вызывает до и после конкретной операции: создания или выполнения команды, открытия соединения, начала транзакции, вызова `SaveChanges`, материализации сущности из результатов запроса, компиляции LINQ-запроса или разрешения конфликта идентичности. Важно то, что отличает перехватчики от журналирования: большинство точек перехвата позволяют **изменить или подавить** операцию, а не просто посмотреть на неё. Перехватчик нужен, когда сквозная задача должна применяться ко всем контекстам приложения, не выражается в модели и обязана менять поведение: проставить столбцы аудита, добавить подсказку к запросу, подобрать строку подключения под арендатора или проглотить исключение конкурентного доступа, которое вы сочли безобидным. Если нужно всего лишь увидеть SQL, нужно журналирование, и перехватчик здесь неподходящий инструмент.

Всё дальнейшее относится к EF Core 11 (`Microsoft.EntityFrameworkCore` 11.0, .NET 11, C# 14). Сама поверхность перехвата в EF Core 11 не изменилась: семь интерфейсов стабильны с тех пор, как EF Core 7 добавил `IIdentityResolutionInterceptor`. А вот то, что изменилось вокруг, знать полезно, и об этом я пишу в разделе с подводными камнями.

## Семь точек перехвата

Каждый перехватчик реализует один или несколько интерфейсов, производных от `IInterceptor`, все они находятся в пространстве имён `Microsoft.EntityFrameworkCore.Diagnostics`:

| Интерфейс | Что перехватывает | Singleton |
| --- | --- | --- |
| `IDbCommandInterceptor` | Создание и выполнение команд, ошибки, освобождение `DbDataReader` | Нет |
| `IDbConnectionInterceptor` | Создание, открытие и закрытие соединений; ошибки соединения | Нет |
| `IDbTransactionInterceptor` | Создание, использование, фиксацию и откат транзакций; точки сохранения | Нет |
| `ISaveChangesInterceptor` | `SavingChanges` / `SavedChanges` / `SaveChangesFailed`, оптимистичный контроль конкурентности | Нет |
| `IMaterializationInterceptor` | Создание, инициализацию и завершение экземпляров сущностей из результатов запроса | Да |
| `IQueryExpressionInterceptor` | Дерево выражений LINQ до компиляции запроса | Да |
| `IIdentityResolutionInterceptor` | Конфликты идентичности, когда контекст начинает отслеживать новый экземпляр | Да |

Первые три работают только с реляционными провайдерами; перехват уровня базы данных недоступен в нереляционных провайдерах, например в провайдере Azure Cosmos DB. Столбец `Singleton` не декоративный, и ниже я к нему возвращаюсь, потому что ошибка именно здесь чаще всего заставляет перехватчик тихо ломать производительность.

Для четырёх интерфейсов, не являющихся singleton, есть базовые классы с пустыми реализациями: `DbCommandInterceptor`, `DbConnectionInterceptor`, `DbTransactionInterceptor` и `SaveChangesInterceptor`. Наследуйтесь от них и переопределяйте только два-три нужных метода вместо того, чтобы вручную реализовывать 20 членов интерфейса.

## Форма пары методов и что значит "подавить"

Каждая точка перехвата приходит парой до/после, и каждая половина существует в синхронном и асинхронном вариантах. `ReaderExecuting` выполняется до отправки запроса в базу; `ReaderExecuted` - после его возврата. `SavingChanges` выполняется перед сохранением, `SavedChanges` - после успешного.

Методы "до" возвращают `InterceptionResult` или `InterceptionResult<T>`, и это возвращаемое значение и есть канал управления:

- Верните аргумент `result` без изменений, и EF продолжит как обычно. Это режим только наблюдения.
- Верните `InterceptionResult.Suppress()`, и EF полностью пропустит операцию. Применяется к операциям без возвращаемого значения, например к точке перехвата `ThrowingConcurrencyException`, где подавление означает "не выбрасывай `DbUpdateConcurrencyException`".
- Верните `InterceptionResult<T>.SuppressWithResult(value)`, и EF пропустит операцию и использует ваше значение. Применяется к операциям, которые что-то производят, например чтобы вернуть искусственный `DbDataReader` из кэша вместо выполнения SQL.

Вот и вся ментальная модель. Журналирование сообщает, что EF сделал; перехватчик получает право вето.

Ниже минимальный и по-настоящему полезный перехватчик команд: записывать в журнал любую команду, которая выполняется дольше порога, вместе с той частью EF, которая её выдала.

```csharp
// .NET 11, C# 14 -- Microsoft.EntityFrameworkCore.Relational 11.0
using System.Data.Common;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.Logging;

public sealed class SlowCommandInterceptor(ILogger<SlowCommandInterceptor> logger)
    : DbCommandInterceptor
{
    private static readonly TimeSpan Threshold = TimeSpan.FromMilliseconds(200);

    public override DbDataReader ReaderExecuted(
        DbCommand command,
        CommandExecutedEventData eventData,
        DbDataReader result)
    {
        Report(command, eventData);
        return result;
    }

    public override ValueTask<DbDataReader> ReaderExecutedAsync(
        DbCommand command,
        CommandExecutedEventData eventData,
        DbDataReader result,
        CancellationToken cancellationToken = default)
    {
        Report(command, eventData);
        return new ValueTask<DbDataReader>(result);
    }

    private void Report(DbCommand command, CommandExecutedEventData eventData)
    {
        if (eventData.Duration < Threshold)
        {
            return;
        }

        logger.LogWarning(
            "Slow command ({DurationMs} ms, source {Source}): {Sql}",
            (int)eventData.Duration.TotalMilliseconds,
            eventData.CommandSource,
            command.CommandText);
    }
}
```

Две детали здесь чаще всего упускают. Первое: реализованы и синхронное, и асинхронное переопределения. EF вызывает то, что соответствует вызову приложения, поэтому реализация только `ReaderExecuted` означает, что в асинхронной кодовой базе перехватчик молча ничего не делает. Второе: `eventData.CommandSource` говорит, пришла ли команда из запроса, из `SaveChanges`, из `ExecuteUpdate` или из миграции, и обычно это именно тот фильтр, который вам нужен.

## Регистрация перехватчика

Регистрация происходит при настройке контекста через `DbContextOptionsBuilder.AddInterceptors`:

```csharp
// .NET 11, C# 14 -- Microsoft.EntityFrameworkCore 11.0
builder.Services.AddDbContext<AppDbContext>((sp, options) =>
    options
        .UseSqlServer(builder.Configuration.GetConnectionString("Default"))
        .AddInterceptors(sp.GetRequiredService<SlowCommandInterceptor>()));
```

Разрешение перехватчика из поставщика служб как раз и позволяет ему принимать зависимости через конструктор, именно так он получает `ILogger` выше. Сначала зарегистрируйте сам перехватчик (здесь `builder.Services.AddSingleton<SlowCommandInterceptor>()`, поскольку он не хранит состояние на запрос).

`OnConfiguring` тоже работает и выполняется даже при использовании `AddDbContext`, поэтому это разумное место для перехватчиков, которые должны применяться независимо от способа создания контекста. Один экземпляр перехватчика может реализовывать сразу несколько интерфейсов; зарегистрируйте его один раз, и EF направит каждое событие в нужный интерфейс.

## Перехватчик SaveChanges целиком

Самый распространённый реальный перехватчик - тот, что проставляет столбцы аудита. Его стоит выписать полностью, потому что и пара sync/async, и вызов трекера изменений легко сделать неправильно.

```csharp
// .NET 11, C# 14 -- Microsoft.EntityFrameworkCore 11.0
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;

public interface IAuditable
{
    DateTimeOffset CreatedUtc { get; set; }
    DateTimeOffset ModifiedUtc { get; set; }
}

public sealed class TimestampInterceptor(TimeProvider clock) : SaveChangesInterceptor
{
    public override InterceptionResult<int> SavingChanges(
        DbContextEventData eventData,
        InterceptionResult<int> result)
    {
        Stamp(eventData.Context);
        return result;
    }

    public override ValueTask<InterceptionResult<int>> SavingChangesAsync(
        DbContextEventData eventData,
        InterceptionResult<int> result,
        CancellationToken cancellationToken = default)
    {
        Stamp(eventData.Context);
        return new ValueTask<InterceptionResult<int>>(result);
    }

    private void Stamp(DbContext? context)
    {
        if (context is null)
        {
            return;
        }

        // The docs' own auditing sample calls DetectChanges here rather than
        // assuming the states are already current. Do the same.
        context.ChangeTracker.DetectChanges();

        var now = clock.GetUtcNow();

        foreach (var entry in context.ChangeTracker.Entries<IAuditable>())
        {
            switch (entry.State)
            {
                case EntityState.Added:
                    entry.Entity.CreatedUtc = now;
                    entry.Entity.ModifiedUtc = now;
                    break;
                case EntityState.Modified:
                    entry.Entity.ModifiedUtc = now;
                    break;
            }
        }
    }
}
```

Приём `TimeProvider` вместо прямого чтения `DateTimeOffset.UtcNow` и делает код тестируемым; та же логика применима в любом месте кодовой базы .NET 11 и сочетается с [тестированием зависящего от времени кода через FakeTimeProvider](/ru/2026/07/how-to-test-time-dependent-code-with-timeprovider-and-faketimeprovider-in-dotnet-11/). Полную версию этого шаблона, включая запись истории изменений и работу с текущим пользователем, я разобрал отдельно в статье [использование перехватчиков EF Core 11 для аудита](/ru/2026/06/how-to-use-ef-core-11-interceptors-for-auditing/).

## Подавление операции: случай конкурентного доступа

Яснее всего право вето демонстрирует `ISaveChangesInterceptor.ThrowingConcurrencyException`. EF вызывает его непосредственно перед тем, как выбросить `DbUpdateConcurrencyException`. Если два запроса одновременно удаляют одну строку, проигравший видит ноль затронутых строк и получает исключение, хотя желаемое конечное состояние (строки больше нет) уже достигнуто:

```csharp
// .NET 11, C# 14 -- Microsoft.EntityFrameworkCore 11.0
public sealed class SuppressDeleteConcurrencyInterceptor : ISaveChangesInterceptor
{
    public InterceptionResult ThrowingConcurrencyException(
        ConcurrencyExceptionEventData eventData,
        InterceptionResult result)
        => eventData.Entries.All(e => e.State == EntityState.Deleted)
            ? InterceptionResult.Suppress()
            : result;

    public ValueTask<InterceptionResult> ThrowingConcurrencyExceptionAsync(
        ConcurrencyExceptionEventData eventData,
        InterceptionResult result,
        CancellationToken cancellationToken = default)
        => new(ThrowingConcurrencyException(eventData, result));
}
```

`eventData.Entries` даёт объекты `EntityEntry`, участвующие в операции, поэтому решение принимается по реальному состоянию, а не по совпадению строки в тексте исключения. На реляционном провайдере можно привести `eventData` к `RelationalConcurrencyExceptionEventData` и заодно прочитать вызвавший проблему `Command`.

## Когда перехватчик не нужен

Перехватчики - самый тяжёлый механизм расширения в EF, и хвататься за них первым делом - типичная ошибка. Прежде чем писать перехватчик, проверьте, не покрывает ли случай более лёгкий механизм.

**Вы хотите видеть SQL.** Используйте `Microsoft.Extensions.Logging` или простое журналирование через `LogTo`. Документация прямо говорит, что перехватчики не являются механизмом журналирования, а конвейер журналирования бесплатно даёт уровни, фильтры и приёмники. Если вас интересует количество запросов, а не их текст, ближе подход из статьи [как обнаружить запросы N+1 в EF Core 11](/ru/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/), а общая настройка структурированного журналирования описана в [Serilog и Seq в .NET 11](/ru/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/).

**Вам нужен обратный вызов при сохранении или отслеживании, и синхронного достаточно.** `DbContext` предоставляет обычные события .NET: `SavingChanges`, `SavedChanges`, `SaveChangesFailed`, `ChangeTracker.Tracked` и `ChangeTracker.StateChanged`. Они регистрируются на экземпляр контекста и подключаются в любой момент, что проще перехватчика. Загвоздка в том, что события только синхронные и потому не могут выполнять неблокирующий ввод-вывод. Перехватчики могут, потому что асинхронные половины возвращают `ValueTask`.

**Вам нужна одна и та же информация по всем контекстам процесса.** Это подписка `DiagnosticListener` на источник `"Microsoft.EntityFrameworkCore"`, а не перехватчик. Diagnostic listeners действуют на весь процесс и только наблюдают; перехватчики действуют на контекст и могут изменять. Выбирайте по обеим осям, а не по одной.

**Вы хотите фильтровать каждый запрос по мягкому удалению или арендатору.** Это фильтр запроса, а не `IQueryExpressionInterceptor`. Писать `ExpressionVisitor`, вставляющий `Where`, - это большой объём хрупкого кода ради повторения того, что модель уже умеет, а EF Core 10 и 11 поддерживают несколько независимо отключаемых фильтров на сущность, то есть ровно тот случай, который раньше решали вручную. Смотрите [именованные фильтры запросов для мягкого удаления и мультиарендности](/ru/2026/07/how-to-use-named-query-filters-for-soft-delete-and-multi-tenancy-in-ef-core-11/).

**Вы хотите преобразовать значение свойства на входе и выходе.** Это конвертер значений.

**Поведение относится ровно к одному подклассу `DbContext` и только к сохранению.** Переопределить `SaveChangesAsync` проще, такой код лучше читается в трассировке стека и легче тестируется. К `ISaveChangesInterceptor` стоит переходить, когда логика должна применяться к нескольким типам контекста или когда она должна жить в общей библиотеке, которой класс контекста не принадлежит.

## Подводные камни, стоящие реального времени

**Singleton-перехватчики и `ManyServiceProvidersCreatedWarning`.** `IMaterializationInterceptor`, `IQueryExpressionInterceptor` и `IIdentityResolutionInterceptor` регистрируются во *внутреннем* поставщике служб EF. Каждый отдельный экземпляр, переданный в `AddInterceptors`, приводит к построению нового внутреннего поставщика, поэтому `new MyMaterializationInterceptor()` внутри лямбды `AddDbContext`, выполняющейся на каждую область, рано или поздно вызовет `ManyServiceProvidersCreatedWarning` и обрушит производительность. Держите один экземпляр в статическом поле или разрешайте singleton через внедрение зависимостей. Поскольку они общие, такие перехватчики должны быть потокобезопасными и не хранить изменяемое состояние; до объектов с областью действия добирайтесь через свойство `Context` данных события.

**Зависимости с областью действия в перехватчике `SaveChanges`.** Перехватчики, не являющиеся singleton, свободны от ограничения выше, но если ваш зависит от чего-то с областью действия (доступ к текущему пользователю, определение арендатора), он и сам должен иметь эту область и разрешаться через перегрузку `(sp, options)` метода `AddDbContext`. Зарегистрировать его как singleton и внедрить в него службу с областью действия - классический путь к [cannot consume scoped service from singleton](/ru/2026/05/fix-cannot-consume-scoped-service-from-singleton/).

**`ExecuteUpdate` и `ExecuteDelete` никогда не доходят до перехватчика `SaveChanges`.** Операции над множествами обходят трекер изменений и идут прямо в SQL, поэтому проставление аудита, переписывание мягкого удаления и рассылка доменных событий, подвешенные на `SavingChanges`, пропускаются. Так задумано, и это самый частый способ получить тихие дыры в журнале аудита. Компромисс разобран в статье [ExecuteUpdate и ExecuteDelete для массовых записей](/ru/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/). `IDbCommandInterceptor` эти команды по-прежнему видит, потому что в итоге всё становится `DbCommand`.

**`ConnectionCreating` и `ConnectionCreated` срабатывают, только когда соединение создаёт EF.** Если ваше приложение само создаёт `DbConnection` и передаёт его EF, эти две точки перехвата не выполняются никогда. `ConnectionOpening` при этом работает.

**`IIdentityResolutionInterceptor` не срабатывает для результатов запроса.** В EF Core 11 он вызывается только из `Update`, `Attach` и подобных вызовов отслеживания, но не для сущностей, возвращённых запросом. Это отслеживается в [dotnet/efcore #37574](https://github.com/dotnet/efcore/issues/37574) и может измениться. Если вам нужна лишь стратегия "побеждает последняя запись" при attach, встроенный `UpdatingIdentityResolutionInterceptor` избавит вас от написания своего.

**Перехват дерева выражений - крайняя мера.** `IQueryExpressionInterceptor` мощный, и собственный пример документации, добавляющий стабильную вторичную сортировку, заканчивается замечанием, что добавить `.ThenBy(e => e.Id)` прямо в запрос проще, понятнее и всегда работает. Это верный инстинкт. `ExpressionVisitor`, молча переписывающий каждый запрос приложения, - проблема отладки, которую вы наследуете навсегда.

**Перехватчики выполняются по порядку и видят решения друг друга.** Внедрённые расширениями перехватчики выполняются первыми, в порядке разрешения из поставщика служб, затем идут перехватчики приложения. Более поздний перехватчик может проверить `InterceptionResult<T>.HasResult`, чтобы понять, не подавил ли операцию предыдущий, и это важно, когда вы их складываете в цепочку.

**Одно дополнение EF Core 11, о котором стоит знать.** `ChangeTracker.GetEntriesForState(added, modified, deleted, unchanged)` - это перечислитель с фильтром по состоянию, который пропускает неявный проход `DetectChanges`, выполняемый методом `Entries()`. Он существует именно для горячих путей вроде перехватчиков `SaveChanges` и хуков аудита, где иначе один и тот же обход выполняется дважды на каждое сохранение. Подробности и компромиссы - в статье [EF Core 11 добавляет GetEntriesForState](/ru/2026/04/efcore-11-changetracker-getentriesforstate/).

## Коротко

Пишите перехватчик, когда нужно *изменить* поведение EF во всех контекстах в точке, которую модель выразить не может. Журналирование берите, когда нужно увидеть, что EF сделал; события .NET - когда нужен простой синхронный обратный вызов на одном контексте; diagnostic listener - когда нужно наблюдение по всему процессу; фильтр запроса или конвертер значений - когда задача на самом деле относится к модели. Реализуйте обе половины, синхронную и асинхронную, любой переопределяемой пары, держите singleton-перехватчики без состояния и общими и помните, что всё, что обходит `SaveChanges`, обходит и ваш `ISaveChangesInterceptor`.

## Связанные материалы

- [Как использовать перехватчики EF Core 11 для аудита](/ru/2026/06/how-to-use-ef-core-11-interceptors-for-auditing/)
- [EF Core 11 добавляет GetEntriesForState, чтобы пропустить DetectChanges](/ru/2026/04/efcore-11-changetracker-getentriesforstate/)
- [Как использовать именованные фильтры запросов для мягкого удаления и мультиарендности в EF Core 11](/ru/2026/07/how-to-use-named-query-filters-for-soft-delete-and-multi-tenancy-in-ef-core-11/)
- [Как использовать ExecuteUpdate и ExecuteDelete для массовых записей в EF Core 11](/ru/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/)
- [Fix: cannot consume scoped service from singleton](/ru/2026/05/fix-cannot-consume-scoped-service-from-singleton/)

## Источники

- [Interceptors -- EF Core, Microsoft Learn](https://learn.microsoft.com/en-us/ef/core/logging-events-diagnostics/interceptors)
- [.NET events -- EF Core, Microsoft Learn](https://learn.microsoft.com/en-us/ef/core/logging-events-diagnostics/events)
- [Using diagnostic listeners -- EF Core, Microsoft Learn](https://learn.microsoft.com/en-us/ef/core/logging-events-diagnostics/diagnostic-listeners)
- [IIdentityResolutionInterceptor Interface -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.diagnostics.iidentityresolutioninterceptor)
- [CommandExecutedEventData Class -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.diagnostics.commandexecutedeventdata)
- [What's New in EF Core 11 -- Microsoft Learn](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew)
- [Identity resolution interceptor is not called for query results -- dotnet/efcore #37574](https://github.com/dotnet/efcore/issues/37574)
