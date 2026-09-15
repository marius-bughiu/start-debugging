---
title: "Исправление: EF Core MigrateAsync и CanConnectAsync 60 секунд повторяют попытки при 'Login failed for user'"
description: "Проверка существования базы в провайдере SQL Server для EF Core повторяет ошибку 18456 целую минуту, с EnableRetryOnFailure или без него. Падайте сразу, ограничьте RetryTimeout или дождитесь EF Core 12."
pubDate: 2026-09-15
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "ef-core-11"
  - "sql-server"
  - "dotnet-10"
  - "csharp"
lang: "ru"
translationOf: "2026/09/fix-migrateasync-canconnectasync-keep-retrying-on-login-failed-for-user-ef-core"
translatedBy: "claude"
translationDate: 2026-09-15
---

Если `Database.MigrateAsync()`, `EnsureCreatedAsync()` или `CanConnectAsync()` зависает примерно на минуту, прежде чем выбросить `Login failed for user` (или прежде чем вернуть `false`), то повторные попытки делает сам EF Core, а не `EnableRetryOnFailure`. `SqlServerDatabaseCreator` при проверке существования базы считает SQL-ошибку 18456 повторяемой и переподключается каждые 500 ms, пока не истечёт его минутный `RetryTimeout`. Отключение повторов ничего не меняет. Обходных путей три: открыть соединение самостоятельно перед миграцией, чтобы неверный пароль падал с первой попытки, уменьшить `RetryTimeout` или задать тайм-аут для проверок работоспособности. Настоящее исправление ([dotnet/efcore#38927](https://github.com/dotnet/efcore/pull/38927)) выйдет только в EF Core 12. Всё это я измерил на EF Core 10.0.12 и 11.0.0-rc.1, и ведут они себя одинаково.

## Ошибка в контексте

Само исключение представляет собой обычную ошибку входа в SQL Server. Выдаёт его то, сколько времени оно добирается до вас:

```text
Microsoft.Data.SqlClient.SqlException (0x80131904): Login failed for user 'app'.
Error Number:18456,State:1,Class:14
```

Типичные симптомы:

- Контейнер, который при запуске применяет миграции и содержит неверный пароль в строке подключения, 60 секунд молча висит, прежде чем упасть, поэтому startup probe оркестратора часто убивает его раньше, и исключения вы так и не видите.
- `/health` на основе `AddDbContextCheck<T>()` при неверных учётных данных целую минуту не может сообщить `Unhealthy`, а проба балансировщика нагрузки завершается по тайм-ауту задолго до этого.
- Журнал ошибок SQL Server (или аудит Azure SQL) показывает всплеск из более чем сотни записей `Login failed for user` от одного запуска процесса.
- Интеграционные тесты, проверяющие, что "при неверных учётных данных `CanConnectAsync` возвращает `false`", проходят, но каждый занимает минуту.

Обычный запрос с той же строкой подключения падает с первой попытки. Медленный путь ограничен API, которые спрашивают "существует ли эта база данных?"

## Почему EF Core повторяет попытку при ошибке входа

`CanConnectAsync`, `MigrateAsync`, `EnsureCreatedAsync` и `EnsureDeletedAsync` начинают с вызова `IRelationalDatabaseCreator.ExistsAsync()`. Для SQL Server это [`SqlServerDatabaseCreator`](https://github.com/dotnet/efcore/blob/v10.0.12/src/EFCore.SqlServer/Storage/Internal/SqlServerDatabaseCreator.cs), и его проверка существования представляет собой отдельный цикл:

```csharp
// EF Core 10.0.12 and 11.0.0-rc.1, SqlServerDatabaseCreator (abridged)
public virtual TimeSpan RetryDelay { get; set; } = TimeSpan.FromMilliseconds(500);
public virtual TimeSpan RetryTimeout { get; set; } = TimeSpan.FromMinutes(1);

// inside ExistsAsync: open the connection, run SELECT 1, and on SqlException:
if (!retryOnNotExists && IsDoesNotExist(e)) // 4060, 1832, 5120
    return false;
if (DateTime.UtcNow > giveUp || !RetryOnExistsFailure(e))
    throw;
await Task.Delay(RetryDelay, ct);

private bool RetryOnExistsFailure(SqlException exception)
    => (exception.Number is 203 && exception.InnerException is Win32Exception)
       || exception.Number is 233 or -2 or 4060 or 1832 or 5120 or 18456;
```

Ошибку 18456 добавили в этот список в EF Core 6.0 в [dotnet/efcore#25832](https://github.com/dotnet/efcore/pull/25832). Это был обходной путь для [dotnet/efcore#15644](https://github.com/dotnet/efcore/issues/15644): Azure SQL может ненадолго отвечать `Login failed` сразу после `CREATE DATABASE`, поэтому `EnsureCreated` и первый `Migrate` для новой базы случайным образом падали. Обходной путь был нужен только в проверке после создания (`CreateAsync` вызывает `ExistsAsync(retryOnNotExists: true)`), но тот же метод используется для каждой проверки существования. В итоге просто неверный пароль воспринимается как "база данных ещё прогревается" и повторяется целую минуту. Именно об этом сообщил [dotnet/efcore#38886](https://github.com/dotnet/efcore/issues/38886), открытый 2026-08-31.

Это же объясняет, почему `EnableRetryOnFailure` выглядит виноватым, хотя это не так. Цикл выполняется внутри одной операции стратегии выполнения. Когда минута истекает, стратегия спрашивает `SqlServerTransientExceptionDetector.ShouldRetryOn(18456)`, получает `false` (18456 в том списке нет) и повторно выбрасывает исключение. С повторами или без них время одинаковое. `errorNumbersToAdd` тоже не играет роли, если только вы не добавите туда 18456, что сделает ситуацию хуже.

Затем `CanConnectAsync` оборачивает всё это в `try/catch`, который превращает любое исключение, кроме отмены, в `false`. Поэтому вариант с проверкой работоспособности никогда не выбрасывает исключение: ему просто нужна минута, чтобы сказать "нет".

## Минимальное воспроизведение без SQL Server

Чтобы это увидеть, сервер не нужен. `DbConnectionInterceptor`, который при каждом физическом открытии соединения выбрасывает `SqlException` с номером 18456, заменяет сервер с неверными учётными данными. `SqlException` создаётся через рефлексию, потому что его конструкторы internal. Проба считает попытки открытия и замеряет время каждого вызова:

```csharp
// .NET 10, EF Core 10.0.12 (also run on .NET 11 RC 1 with EF Core 11.0.0-rc.1.26425.128)
public class FailingOpen(int number) : DbConnectionInterceptor
{
    int _attempts;
    public int Attempts => _attempts;

    public override ValueTask<InterceptionResult> ConnectionOpeningAsync(
        DbConnection c, ConnectionEventData e, InterceptionResult r, CancellationToken ct = default)
    {
        Interlocked.Increment(ref _attempts);
        throw FakeSql.Create(number, "Login failed for user 'app'.");
    }
}

public class Shop(FailingOpen interceptor, bool retry) : DbContext
{
    public DbSet<Product> Products => Set<Product>();

    protected override void OnConfiguring(DbContextOptionsBuilder o)
        => o.UseSqlServer(
                "Server=db.invalid;Database=Shop;User Id=app;Password=wrong;Encrypt=False",
                sql => { if (retry) sql.EnableRetryOnFailure(); })
            .AddInterceptors(interceptor);
}
```

Результаты, одинаковые на EF Core 10.0.12 (SqlClient 6.0) и EF Core 11.0.0-rc.1 (SqlClient 7.0):

| Вызов | Ошибка | `EnableRetryOnFailure` | Попыток открытия | Время | Результат |
|---|---|---|---|---|---|
| `CanConnectAsync()` | 18456 | выкл. | 121 | 60.4 s | `false` |
| `CanConnectAsync()` | 18456 | вкл. | 121 | 60.2 s | `false` |
| `MigrateAsync()` | 18456 | вкл. | 121 | 60.2 s | `SqlException` 18456 |
| `EnsureCreatedAsync()` | 18456 | вкл. | 121 | 60.2 s | `SqlException` 18456 |
| `Products.ToListAsync()` | 18456 | вкл. | 1 | 0.1 s | `SqlException` 18456 |
| `CanConnectAsync()` | 4060 | вкл. | 1 | 0.0 s | `false` |

Перехватчик падает мгновенно, поэтому 121 попытка является потолком: одна каждые 500 ms в течение 60 секунд. С реальным сервером каждая попытка также платит за TCP-соединение, TLS и обмен при входе, так что попыток будет меньше, но минута останется той же. Последняя строка показывает асимметрию: *отсутствующая база данных* (4060) сразу приводит к `false`, а повторяется как раз *неверный пароль*.

## Исправление в деталях

В порядке предпочтения.

### 1. Исправьте учётные данные с помощью кода состояния на стороне сервера

Минута повторов лишь замедляет поиск настоящей проблемы. Клиент всегда сообщает `State:1`. Настоящую причину сервер записывает в свой журнал ошибок в виде кода состояния (в Azure SQL его фиксирует аудит):

| Состояние | Значение |
|---|---|
| 2, 5 | Имя входа не существует |
| 6 | Имя входа Windows использовано с проверкой подлинности SQL |
| 7 | Имя входа отключено (и пароль неверный) |
| 8 | Неверный пароль |
| 18 | Пароль необходимо сменить |
| 38, 40 | Имя входа действительно, но не может открыть запрошенную базу данных |
| 58 | Проверка подлинности SQL на сервере, работающем только в режиме Windows |

Полный список есть на странице [MSSQLSERVER_18456](https://learn.microsoft.com/en-us/sql/relational-databases/errors-events/mssqlserver-18456-database-engine-error). Состояния 38 и 40 стоит знать, потому что они выглядят как проблема с учётными данными, а на деле это проблема с правами или с именем базы данных. Это родственники случая 4060, разобранного в [посте про отказ в разрешении CREATE DATABASE](/ru/2026/08/fix-create-database-permission-denied-in-database-master-dotnet-ef-database-update/).

### 2. Падайте сразу, до миграции

Если вы применяете миграции при запуске, сначала откройте соединение сами. `OpenConnectionAsync` не проходит через цикл проверки существования, поэтому неверный пароль выбрасывает исключение с первой попытки. Если соединение уже открыто, `MigrateAsync` использует его повторно:

```csharp
// .NET 10, EF Core 10.0.12 / 11.0.0-rc.1
static async Task MigrateFailFastAsync(DbContext db, CancellationToken ct = default)
{
    var opened = false;
    try
    {
        await db.Database.OpenConnectionAsync(ct);
        opened = true;
    }
    catch (SqlException ex) when (ex.Number == 4060)
    {
        // Database missing (or no user for this login in it): let MigrateAsync decide.
    }

    try
    {
        await db.Database.MigrateAsync(ct);
    }
    finally
    {
        if (opened) await db.Database.CloseConnectionAsync();
    }
}
```

Проба намерила 1 попытку и 0.0 s до `SqlException` 18456 при включённом `EnableRetryOnFailure`. `catch` для 4060 важен. Если ваши миграции должны *создавать* базу данных (локальная разработка, первое развёртывание), предварительное открытие падает с 4060, потому что базы ещё нет. Если проглотить эту ошибку, `MigrateAsync` пойдёт обычным путём создания, включая повтор после создания, который действительно нужен Azure SQL. Если ваши базы всегда создаются отдельно, уберите `catch`, и пусть 4060 тоже прерывает запуск.

Для производственных конвейеров лучшим долгосрочным решением будет вообще убрать миграции из запуска приложения и выполнять [migrations bundle](/ru/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/) как шаг развёртывания. Он попадает в тот же цикл, но шаг конвейера, упавший через минуту, доставляет куда меньше боли, чем под в crash loop.

### 3. Ограничьте `RetryTimeout`

`RetryTimeout` и `RetryDelay` являются публичными устанавливаемыми свойствами `SqlServerDatabaseCreator`, который находится в пространстве имён `.Internal`. Его использование вызывает предупреждение анализатора EF1001, а его форма может меняться между выпусками:

```csharp
// .NET 10, EF Core 10.0.12 / 11.0.0-rc.1
#pragma warning disable EF1001 // Internal EF Core API usage.
using Microsoft.EntityFrameworkCore.SqlServer.Storage.Internal;
using Microsoft.EntityFrameworkCore.Storage;

var creator = (SqlServerDatabaseCreator)db.GetService<IRelationalDatabaseCreator>();
creator.RetryTimeout = TimeSpan.FromSeconds(5);
await db.Database.MigrateAsync();
#pragma warning restore EF1001
```

С этим кодом проба намерила 11 попыток и 5.0 s для `MigrateAsync`. Тот же тайм-аут ограничивает и проверку после создания, поэтому на Azure SQL не ставьте его в ноль, если `EnsureCreated` или `Migrate` создаёт базу данных. Нескольких секунд достаточно, чтобы обходной путь для #15644 продолжал работать, а минута исчезла. Creator является scoped-сервисом, поэтому задавайте значение для каждого экземпляра контекста, который применяет миграции, а не один раз при запуске.

### 4. Задайте тайм-аут для проверок работоспособности базы данных

`AddDbContextCheck<T>()` по умолчанию выполняет `CanConnectAsync`, а [`HealthCheckRegistration.Timeout`](https://github.com/dotnet/aspnetcore/blob/main/src/HealthChecks/Abstractions/src/HealthCheckRegistration.cs) по умолчанию равен `Timeout.InfiniteTimeSpan`. В отличие от `AddCheck`, у `AddDbContextCheck` нет параметра `timeout`, поэтому нужно сделать две вещи: заменить тест на такой, который обходит цикл проверки существования, и задать тайм-аут регистрации через `HealthCheckServiceOptions`:

```csharp
// .NET 10, ASP.NET Core 10.0, Microsoft.Extensions.Diagnostics.HealthChecks.EntityFrameworkCore 10.0.12
builder.Services.AddHealthChecks()
    .AddDbContextCheck<Shop>(customTestQuery: async (db, ct) =>
    {
        await db.Database.OpenConnectionAsync(ct);
        await db.Database.CloseConnectionAsync();
        return true;
    });

// The registration is named after the context type unless you pass a name.
builder.Services.Configure<HealthCheckServiceOptions>(o =>
    o.Registrations.Single(r => r.Name == nameof(Shop)).Timeout = TimeSpan.FromSeconds(5));
```

`DbContextHealthCheck` перехватывает всё, что выбрасывает тест, и сообщает `Unhealthy` с приложенным исключением, так что неверный пароль теперь виден в отчёте о работоспособности как `Login failed for user 'app'.`, а не как голый отказ минутой позже. Тайм-аут служит страховкой от всего остального, например от сервера, который принимает TCP-соединение и никогда не отвечает. Общая настройка описана в статье о [добавлении конечной точки проверки работоспособности в minimal API](/ru/2026/07/how-to-add-a-health-check-endpoint-to-a-minimal-api-in-aspnetcore-11/).

### 5. Обновитесь, когда выйдет EF Core 12

[dotnet/efcore#38927](https://github.com/dotnet/efcore/pull/38927), слитый 2026-09-10 с milestone 12.0.0, передаёт `retryOnNotExists` в `RetryOnExistsFailure`, так что 18456 повторяется только после того, как провайдер только что создал базу данных:

```csharp
// EF Core main (12.0), after dotnet/efcore#38927
|| (exception.Number is 233 or -2 or 4060 or 1832 or 5120)
|| (retryOnLoginFailure && exception.Number is 18456))
```

На сегодняшний день этого изменения нет ни в `release/10.0`, ни в `release/11.0` (в обеих ветках всё ещё старая однострочная проверка), так что EF Core 11.0 GA, скорее всего, выйдет с минутным повтором. Ежедневную сборку EF Core 12 я не запускал. PR добавляет синхронные и асинхронные регрессионные тесты для обоих путей, так что на 10 и 11 у вас есть только описанные выше обходные пути.

## Подводные камни и похожие ошибки

**Токен отмены меняет результат, а не только время.** `CanConnectAsync(ct)` повторно выбрасывает отмену, поэтому с `CancellationTokenSource` на 5 секунд проба получила `TaskCanceledException` после 10 попыток, а не `false`. Коду, который проверяет только булево значение, нужен `catch (OperationCanceledException)`.

**Синхронный путь блокирует поток.** `Database.Migrate()` и `CanConnect()` используют `Thread.Sleep(RetryDelay)` в том же цикле, так что минута тратится на удержание потока из пула потоков. Это ещё одна причина применять миграции вне кода, обслуживающего запросы.

**Ошибку 4060 повторяет `EnableRetryOnFailure`, просто не здесь.** 4060 (`Cannot open database "Shop" requested by the login`) *есть* в списке временных ошибок. `CanConnectAsync` сразу возвращает для неё `false`, но обычный запрос с `EnableRetryOnFailure()` по умолчанию (6 повторов, максимальная задержка 30 s) сделал 7 попыток за 57.9 s, прежде чем выбросить `RetryLimitExceededException`. Если "login failed" во время запроса занимает около минуты, посмотрите номер внутреннего исключения, прежде чем винить цикл creator. А если вы всё равно настраиваете стратегию, [пост о стратегии выполнения и пользовательских транзакциях](/ru/2026/06/fix-execution-strategy-does-not-support-user-initiated-transactions/) разбирает другую ловушку, которую она расставляет.

**Шум неудачных входов имеет побочные эффекты.** Каждый повтор является настоящим неудачным входом на сервере. При `CHECK_POLICY = ON` имена входа SQL подчиняются политике блокировки учётных записей Windows, а аудит Azure SQL записывает каждую попытку. Минута повторов может заблокировать учётную запись, и после этого падает даже правильный пароль, с ошибкой 18486 ("the account is currently locked out") вместо 18456.

**Тайм-ауты представляют собой другую проблему.** Если минута заканчивается `Timeout expired`, а не `Login failed`, вы имеете дело с тайм-аутами команд или шлюза во время долгой миграции, что разобрано в статье [SqlException timeout expired во время миграций EF Core](/ru/2026/05/fix-sqlexception-timeout-expired-during-ef-core-migrations/).

## Связанные материалы

- [Исправление: CREATE DATABASE permission denied in database 'master' при dotnet ef database update](/ru/2026/08/fix-create-database-permission-denied-in-database-master-dotnet-ef-database-update/)
- [Как применять миграции EF Core 11 в продакшене с помощью migrations bundle](/ru/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/)
- [Исправление: SqlException timeout expired во время миграций EF Core](/ru/2026/05/fix-sqlexception-timeout-expired-during-ef-core-migrations/)
- [Исправление: The configured execution strategy does not support user-initiated transactions](/ru/2026/06/fix-execution-strategy-does-not-support-user-initiated-transactions/)
- [Как добавить конечную точку проверки работоспособности в minimal API в ASP.NET Core 11](/ru/2026/07/how-to-add-a-health-check-endpoint-to-a-minimal-api-in-aspnetcore-11/)

## Источники

- [dotnet/efcore#38886: CanConnectAsync / MigrateAsync retries on authentication failure instead of throwing](https://github.com/dotnet/efcore/issues/38886) и исправление, [dotnet/efcore#38927: Restrict SQL Server login failure retries to post-creation checks](https://github.com/dotnet/efcore/pull/38927).
- [dotnet/efcore#25832: Update SQL Server transient error list](https://github.com/dotnet/efcore/pull/25832), который добавил 18456 ради [dotnet/efcore#15644](https://github.com/dotnet/efcore/issues/15644).
- [`SqlServerDatabaseCreator.cs` в v10.0.12](https://github.com/dotnet/efcore/blob/v10.0.12/src/EFCore.SqlServer/Storage/Internal/SqlServerDatabaseCreator.cs), [в v11.0.0-rc.1](https://github.com/dotnet/efcore/blob/v11.0.0-rc.1.26425.128/src/EFCore.SqlServer/Storage/Internal/SqlServerDatabaseCreator.cs) и [`SqlServerTransientExceptionDetector.cs`](https://github.com/dotnet/efcore/blob/v10.0.12/src/EFCore.SqlServer/Storage/Internal/SqlServerTransientExceptionDetector.cs).
- [Connection resiliency](https://learn.microsoft.com/en-us/ef/core/miscellaneous/connection-resiliency) (Microsoft Learn, EF Core).
- [MSSQLSERVER_18456](https://learn.microsoft.com/en-us/sql/relational-databases/errors-events/mssqlserver-18456-database-engine-error) (Microsoft Learn, SQL Server).
- [`DbContextHealthCheck.cs`](https://github.com/dotnet/aspnetcore/blob/main/src/Middleware/HealthChecks.EntityFrameworkCore/src/DbContextHealthCheck.cs) в dotnet/aspnetcore.
