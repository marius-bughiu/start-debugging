---
title: "Microsoft.Data.SqlClient vs System.Data.SqlClient в .NET 11"
description: "Используйте Microsoft.Data.SqlClient. System.Data.SqlClient объявлен устаревшим, уже выдаёт CS0618 на каждый тип, к которому вы прикасаетесь, и теряет свои .NET-ассеты, когда .NET 8 достигнет конца поддержки 2026-11-10, в тот же день, когда выходит .NET 11. Измеренный разрыв в возможностях, значение Encrypt по умолчанию, ломающее миграцию, и разделение пакета в 7.0."
pubDate: 2026-09-17
template: vs
tags:
  - "comparison"
  - "dotnet"
  - "dotnet-11"
  - "sql-server"
  - "migration"
lang: "ru"
translationOf: "2026/09/microsoft-data-sqlclient-vs-system-data-sqlclient-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-09-17
---

Используйте **`Microsoft.Data.SqlClient`**. Это не близкое сравнение, и таким оно не было с 2022 года. `System.Data.SqlClient` формально объявлен устаревшим, описание его пакета NuGet буквально гласит "DEPRECATED - Use Microsoft.Data.SqlClient.", каждый публичный тип помечен `[Obsolete]`, а по собственному поэтапному плану Microsoft его .NET-ассеты исчезают, когда .NET 8 достигнет конца поддержки **2026-11-10** -- в тот же день, когда выходит .NET 11. Остаётся решить только, какую линию `Microsoft.Data.SqlClient` брать (7.0 или LTS 6.1) и как пережить миграцию, потому что пакеты различаются гораздо сильнее, чем одним пространством имён.

Всё изложенное ниже проверено на macOS 26.6.2 (Apple M4) с .NET SDK `10.0.302`, против `Microsoft.Data.SqlClient` 7.0.3 и `System.Data.SqlClient` 4.9.1, текущих релизов на момент написания. Выбор ассетов на `net11.0` идентичен: ни один из пакетов не содержит папки `net10.0` или `net11.0`, поэтому проект .NET 11 разрешает `runtimes/unix/lib/net9.0/Microsoft.Data.SqlClient.dll` и `runtimes/unix/lib/net8.0/System.Data.SqlClient.dll`, ровно то же, что разрешает проект `net10.0`.

## Матрица

| | `Microsoft.Data.SqlClient` 7.0.3 | `System.Data.SqlClient` 4.9.1 |
| --- | --- | --- |
| Статус поддержки | STS, развивается (7.0 GA 2026-03-17) | Устарел, только сопровождение |
| Публикуется из | [dotnet/SqlClient](https://github.com/dotnet/SqlClient) | [dotnet/maintenance-packages](https://github.com/dotnet/maintenance-packages) |
| Публичных типов | 91 в 7 пространствах имён | 51 в 5 пространствах имён |
| `[Obsolete]` в публичном API | Нет | Да, CS0618 на каждом типе |
| Старший .NET-ассет | `net9.0` | `net8.0` |
| .NET-ассет удаляется когда | не планируется | конец поддержки .NET 8, 2026-11-10 |
| Значение `Encrypt` по умолчанию | `true` с 4.0 | `false` |
| Тип свойства `Encrypt` | `SqlConnectionEncryptOption` | `bool` |
| TDS 8.0 / `Encrypt=Strict` | Да с 5.0 | Нет |
| TLS 1.3 | Да, через TDS 8.0 | Нет |
| Аутентификация Microsoft Entra ID | Да, через `Extensions.Azure` | Нет |
| `SqlBatch` | Да с 5.2 | Нет |
| Always Encrypted с защищёнными анклавами | Да | Нет |
| Классификация данных / чувствительность | Да (6 типов) | Нет |
| Тип `json` из SQL Server 2025 (`SqlJson`) | Да с 6.0 | Нет |
| Тип `vector` из SQL Server 2025 (`SqlVector<T>`) | Да с 6.1 | Нет |
| Настраиваемая логика повторов | Да | Нет |
| Ключевых слов строки подключения | 48 | 38 |
| Вывод публикации, консольный hello-world | 7.35 MB / 23 сборки | 1.07 MB / 2 сборки |

Число типов и ключевых слов получено загрузкой обеих сборок в `MetadataLoadContext` и сравнением `GetExportedTypes()` и `SqlConnectionStringBuilder.GetProperties()`, а не чтением примечаний к выпуску.

## Часы устаревания и есть весь аргумент

Microsoft опубликовала [план устаревания](https://github.com/dotnet/announcements/issues/322) в августе 2024 года, и он необычно конкретен. Версия 5.0.0 должна была убрать всё ниже .NET 8 и .NET Framework 4.6.2 и добавить `[Obsolete]` к .NET-ассетам. После GA .NET 9 -- ничего больше. После конца поддержки .NET 8 библиотечные .NET-ассеты удаляются, и остаются только потребители .NET Framework 4.6.2+, обслуживаемые через сам .NET Framework, а не через пакет. Формулировка объявления прямая: Microsoft не рассчитывает обновлять пакет после этого момента.

.NET 8 достигает [конца поддержки 2026-11-10](https://devblogs.microsoft.com/dotnet/dotnet-8-9-end-of-support/). .NET 11 выходит в RTM в тот же день. Так что вопрос "какой SqlClient в .NET 11" отвечает сам на себя: в день, когда .NET 11 появится как поддерживаемая среда выполнения, у `System.Data.SqlClient` не будет никакой поддерживаемой .NET-истории вообще. Восстанавливаться пакет по-прежнему будет. Проект `net11.0` спокойно возьмёт ассет `net8.0` и запустится. Просто это будет необслуживаемый код, сидящий на вашем пути подключения.

Заметьте, что в одну сторону пакет от плана всё же отклонился: 4.9.1 вышел 2026-02-12 с ассетом `net8.0`, которого исходный план не обещал, а репозиторий переехал в `dotnet/maintenance-packages`. Это сопровождение, а не разработка. Зависимость в nuspec по-прежнему `runtime.native.System.Data.SqlClient.sni` **4.4.0**, нативная сборка SNI 2017 года.

## Что компилятор уже говорит вам

Верить объявлению на слово не обязательно. Подключите 4.9.1 из современного проекта и коснитесь чего угодно:

```csharp
// net10.0 (identical on net11.0), System.Data.SqlClient 4.9.1
using System.Data.SqlClient;

var b = new SqlConnectionStringBuilder { DataSource = "localhost", InitialCatalog = "db" };
Console.WriteLine($"Encrypt default: {b.Encrypt}");
```

```text
warning CS0618: 'SqlConnectionStringBuilder' is obsolete:
'Use the Microsoft.Data.SqlClient package instead.'
```

```text
Encrypt default: False
```

Та же программа против `Microsoft.Data.SqlClient` 7.0.3 компилируется с нулём предупреждений и печатает `Encrypt default: True`. Эта одна строка -- самое значимое поведенческое различие между двумя пакетами, и остальная часть статьи уделяет ему реальное внимание.

## Разрыв, который не закрыть прослойкой

10 ключевых слов строки подключения, существующих только в `Microsoft.Data.SqlClient`, -- это не удобства. Сравнение свойств `SqlConnectionStringBuilder` даёт ровно: `Authentication`, `AttestationProtocol`, `ColumnEncryptionSetting`, `CommandTimeout`, `EnclaveAttestationUrl`, `FailoverPartnerSPN`, `HostNameInCertificate`, `IPAddressPreference`, `ServerCertificate`, `ServerSPN`. Обратное сравнение пусто: у `System.Data.SqlClient` нет ни одного ключевого слова, которого не хватает современному драйверу.

Передайте эти ключевые слова старому построителю, и вы получите те самые сценарии отказа, с которыми сталкиваются при попытке подключить унаследованное приложение к SQL Server 2022 или 2025:

```csharp
// System.Data.SqlClient 4.9.1
new SqlConnectionStringBuilder("Server=localhost;Encrypt=Strict");
// FormatException: String 'Strict' was not recognized as a valid Boolean.

new SqlConnectionStringBuilder("Server=localhost;Authentication=Active Directory Default");
// ArgumentException: Keyword not supported: 'authentication'.

new SqlConnectionStringBuilder("Server=localhost;HostNameInCertificate=sql.contoso.com");
// ArgumentException: Keyword not supported: 'hostnameincertificate'.

new SqlConnectionStringBuilder("Server=localhost;ServerCertificate=/etc/ssl/sql.pem");
// ArgumentException: Keyword not supported: 'servercertificate'.
```

`Encrypt=Strict` -- это клиентская половина [TDS 8.0](https://learn.microsoft.com/en-us/sql/relational-databases/security/networking/tds-8), ревизии протокола, введённой в SQL Server 2022, чтобы TLS-рукопожатие происходило до TDS, а не внутри него. Именно TDS 8.0 делает TLS 1.3 достижимым из клиента SQL Server. `System.Data.SqlClient` для этого никогда не обновляли, а значит, никакого TLS 1.3 и никакого пути к нему. Если у вашей команды безопасности есть требование по TLS 1.3, выбор драйвера за вас уже сделали.

То же касается Microsoft Entra ID. `Authentication=Active Directory Default`, `Active Directory Managed Identity` и им подобные просто не разбираются. Истории с токенами тоже нет: `SqlConnection.AccessTokenCallback` -- один из членов, существующих только в современном драйвере, наряду с `RetryLogicProvider`, `SspiContextProvider`, `ServerProcessId` и всем семейством `RegisterColumnEncryptionKeyStoreProviders`.

Если вы подключаетесь к SQL Server 2025 и хотите использовать нативный тип столбца `json` или столбцы `vector`, `Microsoft.Data.SqlTypes.SqlJson` (6.0) и `Microsoft.Data.SqlTypes.SqlVector<T>` (6.1) -- единственные поддерживаемые клиентские представления. `SqlVector<T>` в частности передаёт векторы в компактной двоичной форме поверх TDS вместо строк JSON. Если вы вообще взвешиваете этот тип столбца, [сравнение нативного столбца json и nvarchar(max)](/ru/2026/09/json-vs-nvarchar-max-for-storing-json-in-sql-server-with-ef-core-11/) покрывает сторону хранения того же решения.

## Единственный честный аргумент за старый пакет, измеренный

`System.Data.SqlClient` маленький. Это всё его оставшееся преимущество, и оно реально. Я опубликовал консольное приложение hello-world (`dotnet publish -c Release -r osx-arm64 --self-contained false`) против каждого драйвера:

| Пакет | Вывод публикации | Сборок | Транзитивных пакетов |
| --- | --- | --- | --- |
| `System.Data.SqlClient` 4.9.1 | 1.07 MB | 2 | 4 |
| `Microsoft.Data.SqlClient` 7.0.3 | 7.35 MB | 23 | 22 |
| `Microsoft.Data.SqlClient` 6.1.7 | 17.3 MB | 29 | 29 |

Строка 6.1.7 -- причина, по которой релиз 7.0 важен, даже если вы уже были на современном драйвере. Сравнивая две папки публикации, 7.0.3 убирает `Azure.Core`, `Azure.Identity`, `Microsoft.Identity.Client`, `Microsoft.Identity.Client.Broker`, `Microsoft.Identity.Client.Extensions.Msal`, `Microsoft.Identity.Client.NativeInterop`, `System.ClientModel`, `System.Memory.Data`, `Microsoft.Bcl.AsyncInterfaces` и, самый крупный файл во всём выводе 6.1.7, `msalruntime_arm64.dylib` размером **7.5 MB**. Нативный бинарник брокера MSAL в консольном приложении, которое нигде не аутентифицируется. Версия 7.0 перенесла всё это в необязательный пакет `Microsoft.Data.SqlClient.Extensions.Azure`, и итоговый вывод на 10.2 MB меньше.

Итак, `Microsoft.Data.SqlClient` по-прежнему примерно в 7 раз больше по развёрнутому объёму, чем устаревший пакет. Если для вас это действительно важно -- урезанный образ контейнера, бинарник Native AOT -- взвесьте это против 22 пакетов, которые он заодно тянет в ваш граф восстановления. Рекомендации это не меняет. 6 MB сборок не стоят неподдерживаемого стека TLS. Но это единственное число, где старый пакет выигрывает, и делать вид, что это не так, было бы нечестно.

## Переключение `Encrypt` и есть слом миграции

Большинство миграций с `System.Data.SqlClient` на `Microsoft.Data.SqlClient`, которые проваливаются, проваливаются именно здесь. Старое значение по умолчанию -- `Encrypt=false`. Современное -- `Encrypt=true` начиная с 4.0. Строки подключения, работавшие десятилетие, начинают падать на проверке сертификата против тестового SQL Server с самоподписанным сертификатом.

Рефлекторное исправление -- `TrustServerCertificate=true`, и вне контролируемой машины разработчика оно неверное: оно превращает шифрование в неаутентифицированный туннель. `Microsoft.Data.SqlClient` даёт два инструмента получше, и оба -- ключевые слова, которых у старого драйвера нет:

```csharp
// Microsoft.Data.SqlClient 7.0.3
// The server's cert is issued to sql-prod.internal but you connect by IP or alias.
var cs = "Server=10.0.4.12,1433;Database=orders;"
       + "Encrypt=Strict;"
       + "HostNameInCertificate=sql-prod.internal;"
       + "Authentication=Active Directory Default";
```

`HostNameInCertificate` решает случай несовпадения имени, не отключая проверку. `ServerCertificate` указывает на конкретный файл PEM или CER для самоподписанного сервера или сервера с частным УЦ, снова не отключая проверку. Вместе эти два позволяют заменить почти любое реальное `TrustServerCertificate=true` в кодовой базе на что-то, что всё ещё проверяет.

Ещё одна ловушка в той же области: тип свойства `SqlConnectionStringBuilder.Encrypt` сменился с `bool` на `SqlConnectionEncryptOption` в 5.0. Присваивания вида `builder.Encrypt = true` по-прежнему компилируются благодаря неявному преобразованию, так что выглядит как совместимость на уровне исходного кода. Это **двоичное** ломающее изменение. Любая сборка, которую вы не перекомпилируете против нового драйвера, выбросит `MissingMethodException` во время выполнения. Если вы поставляете общую библиотеку доступа к данным, пересоберите и переопубликуйте её, а не просто подменяйте драйвер под ней. Тот же класс ошибок порождает [ошибку Could not load file or assembly 'Microsoft.Data.SqlClient, Version=7.0.0.0'](/ru/2026/09/fix-could-not-load-file-or-assembly-microsoft-data-sqlclient-version-7-0-0-0/), когда устаревшая копия 6.x выигрывает восстановление.

## Ещё четыре вещи, которые кусают во время миграции

**Аутентификации Entra теперь нужен второй пакет.** В 7.0 забыть про него означает получить понятное сообщение вместо загадки, и это реальное улучшение:

```text
System.ArgumentException: Cannot find an authentication provider for 'ActiveDirectoryDefault'.
Install the 'Microsoft.Data.SqlClient.Extensions.Azure' NuGet package to use
Active Directory (Entra ID) authentication methods.
```

Добавьте `Microsoft.Data.SqlClient.Extensions.Azure`, закреплённый на той же версии, что и основной драйвер. Начиная с 7.0.2 основной драйвер и сопутствующие пакеты используют согласованные номера версий, так что `7.0.3` для обоих.

**Некоторые типы меняют пространство имён, но не все.** `SqlDataRecord` и `SqlMetaData` переходят из `Microsoft.SqlServer.Server` в `Microsoft.Data.SqlClient.Server`. `SqlFileStream` переходит из `System.Data.SqlTypes` в `Microsoft.Data.SqlTypes`. `SqlNotificationRequest` переходит из `System.Data.Sql` в `Microsoft.Data.Sql`. `OperationAbortedException` переходит из `System.Data` в `Microsoft.Data`. А вот атрибуты SQL CLR остаются на месте: `SqlFunctionAttribute`, `SqlUserDefinedTypeAttribute`, `IBinarySerialize` и остальные сегодня лежат в сборке `System.Data.SqlClient`, а при современном драйвере -- в отдельном пакете `Microsoft.SqlServer.Server`, поэтому этот пакет и появляется в списке транзитивных. Не делайте слепую замену по `System.Data`. `CommandType`, `DbType`, `IsolationLevel`, `DataTable` и все типы из `System.Data.Common` остаются ровно там, где были.

**Параметры даты и времени ведут себя иначе.** `DbType.Time` со значением `DateTime` старый драйвер принимал; современный хочет `TimeSpan`. `DbType.Date` со значением `DateTime` отсекает компоненты времени вместо того, чтобы отправлять их. Если у вас есть вызовы `AddWithValue` вокруг столбцов с датами, именно там прячется тихое изменение поведения. Указывайте `SqlDbType`, длину, точность и масштаб явно везде, где это важно.

**Режим globalization-invariant не поддерживается.** Если ваш контейнер ставит `InvariantGlobalization=true`, чтобы сэкономить на запуске и размере, `Microsoft.Data.SqlClient` в такой конфигурации не поддерживается. Это кусает как раз те команды, которые занимаются описанной выше работой по урезанию.

И прежде чем объявлять миграцию завершённой, запустите `dotnet list package --include-transitive`. Удаление вашей прямой ссылки не удаляет ту, которую тянет старый ORM или вспомогательная библиотека SQL CLR. Два пакета SqlClient в одном графе прекрасно компилируются, а затем падают в тот момент, когда `SqlConnection` из одного попадает в API, ожидающий другой, потому что имена идентичны, а типы -- нет.

## Какую линию Microsoft.Data.SqlClient брать

| Линия | Выпущена | Поддержка | Конец поддержки |
| --- | --- | --- | --- |
| 7.0 (`7.0.3`) | 2026-03-17 | STS | определится следующим релизом |
| 6.1 (`6.1.7`) | 2025-08-14 | **LTS** | 2028-08-14 |

Берите **7.0.3** для нового сервиса на .NET 11. Вы получаете пакет на 10 MB легче, подключаемый SSPI через `SspiContextProvider`, улучшенную маршрутизацию для Azure SQL Hyperscale и паритет `SqlClientDiagnosticListener` на .NET Framework. Берите **6.1.7**, если вам нужно датированное обязательство по поддержке на бумаге или вы посреди миграции и прямо сейчас не можете переварить разделение `Extensions.Azure`. Обе линии поддерживают SQL Server с 2017 по 2025, Azure SQL и Fabric. Всё 6.0 и ниже уже вне поддержки, включая линию LTS 5.1, которая закончилась 2026-01-20.

Рекомендация остаётся такой же, как в начале: мигрируйте. Компилятор уже предупреждает вас, описание пакета уже говорит "устарел", а среда выполнения, на которую нацелен старый пакет, достигает конца поддержки в тот день, когда выходит .NET 11. Работа -- это замена пакета, проход по пространствам имён, внимательный взгляд на каждое `Encrypt` и `TrustServerCertificate` в вашей конфигурации и пересборка каждой сборки, которая касается `SqlConnectionStringBuilder`. Заложите день на обычный сервис. Это гораздо более приятный день, чем тот, когда требование по TLS 1.3 падает на необслуживаемый драйвер.

## Похожее

- [Fix: Could not load file or assembly 'Microsoft.Data.SqlClient, Version=7.0.0.0' после обновления EF Core](/ru/2026/09/fix-could-not-load-file-or-assembly-microsoft-data-sqlclient-version-7-0-0-0/)
- [Миграция с .NET Framework 4.8 на .NET 11 в 2026 году](/ru/2026/05/migrate-from-dotnet-framework-4-8-to-dotnet-11-in-2026/)
- [Уровень совместимости SQL Server 150 vs 160: что меняется для запросов EF Core 11](/ru/2026/09/sql-server-compatibility-level-150-vs-160-what-changes-for-ef-core-11-queries/)
- [Нативный столбец json vs nvarchar(max) для хранения JSON в SQL Server с EF Core 11](/ru/2026/09/json-vs-nvarchar-max-for-storing-json-in-sql-server-with-ef-core-11/)
- [Fix: EF Core MigrateAsync и CanConnectAsync продолжают повторять попытки при 'Login failed for user' 60 секунд](/ru/2026/09/fix-migrateasync-canconnectasync-keep-retrying-on-login-failed-for-user-ef-core/)

## Источники

- [Announcement: System.Data.SqlClient package is now deprecated](https://github.com/dotnet/announcements/issues/322), issue 322 в dotnet/announcements, с полным поэтапным планом устаревания.
- [Migrate from System.Data.SqlClient to Microsoft.Data.SqlClient](https://learn.microsoft.com/en-us/sql/connect/ado-net/migrate-system-data-sql-client-to-microsoft-data-sql-client), MS Learn, обновлено 2026-09-16.
- [Microsoft.Data.SqlClient namespace and compatibility](https://learn.microsoft.com/en-us/sql/connect/ado-net/introduction-microsoft-data-sqlclient-namespace), MS Learn.
- [SqlClient driver support lifecycle](https://learn.microsoft.com/en-us/sql/connect/ado-net/sqlclient-driver-support-lifecycle), MS Learn, для таблиц поддержки 7.0 и 6.1.
- [Microsoft.Data.SqlClient 7.0.0 release notes](https://github.com/dotnet/SqlClient/blob/main/release-notes/7.0/7.0.0.md), dotnet/SqlClient.
- [TDS 8.0](https://learn.microsoft.com/en-us/sql/relational-databases/security/networking/tds-8), MS Learn, о связи `Encrypt=Strict` и TLS 1.3.
- [.NET 8 and .NET 9 will reach end of support on November 10, 2026](https://devblogs.microsoft.com/dotnet/dotnet-8-9-end-of-support/), .NET Blog.
- [System.Data.SqlClient на NuGet](https://www.nuget.org/packages/System.Data.SqlClient), версия 4.9.1, опубликована 2026-02-12.
