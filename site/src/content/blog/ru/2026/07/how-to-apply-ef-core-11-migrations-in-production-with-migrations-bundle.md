---
title: "Как применять миграции EF Core 11 в продакшене с помощью dotnet ef migrations bundle"
description: "Полное руководство по развёртыванию изменений схемы EF Core 11 через bundle миграций: сборка efbundle в CI, ловушка appsettings.json с именованными строками подключения, self-contained bundle и musl RID для Alpine, блокировка миграций начиная с EF Core 9, откат к целевой миграции и почему транзакция на миграцию не спасает на MySQL."
pubDate: 2026-07-28
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "dotnet"
  - "dotnet-11"
  - "csharp"
  - "migrations"
  - "devops"
lang: "ru"
translationOf: "2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle"
translatedBy: "claude"
translationDate: 2026-07-28
---

Чтобы применить миграции EF Core 11 к продакшен-базе данных, соберите в CI bundle миграций командой `dotnet ef migrations bundle --self-contained -r linux-x64 -o ./artifacts/efbundle`, опубликуйте этот единственный исполняемый файл как артефакт сборки и запустите его отдельным шагом развёртывания: `./efbundle --connection "$CONNECTION_STRING"`. Bundle несёт скомпилированные миграции и среду выполнения EF Core внутри одного файла. Машине, которая его запускает, не нужны ни .NET SDK, ни инструмент `dotnet-ef`, ни доступ к исходному коду, а вашему приложению никогда не нужны права на изменение схемы в базе данных. Эта статья ориентирована на EF Core 11 и .NET 11 (preview 6 на момент написания, GA в ноябре 2026 года) с C# 14. Bundle существуют начиная с EF Core 6, поэтому всё описанное работает от EF Core 6 до 11, и я отмечаю версии, начиная с которых поведение отличается.

## Что на самом деле не так с тремя другими стратегиями

Любая .NET-команда в итоге выбирает один из четырёх способов доставить изменения схемы в продакшен, и у трёх из них есть режим отказа, который проявляется только под нагрузкой или под давлением.

**Вызов `Database.Migrate()` при запуске** причиняет боль чаще всего. Собственные рекомендации Microsoft называют такой подход неподходящим для продакшена, и причины накапливаются: процессу приложения навсегда нужен `db_ddladmin` или эквивалент, а не только на время развёртывания; миграция выполняется без того, чтобы человек посмотрел на SQL; а откат означает выпуск новой сборки. Начиная с EF Core 9 риск конкурентного доступа хотя бы устранён: `Migrate()` и `MigrateAsync()` захватывают блокировку уровня базы данных перед применением чего-либо, поэтому десять реплик, разворачивающихся одновременно, выстроятся в очередь, а не испортят работу друг друга. Это устранило худший симптом, но ни одну из структурных проблем.

**Запуск `dotnet ef database update` на агенте развёртывания** означает установку .NET SDK и инструмента `dotnet-ef` на этот агент, выгрузку исходного кода и сборку проекта только ради применения одного `CREATE INDEX`. Если этот агент и есть ваша продакшен-машина, вы только что поставили на неё компилятор.

**Генерация SQL-скрипта** командой `dotnet ef migrations script --idempotent` остаётся стратегией, которую Microsoft рекомендует в первую очередь, и у неё есть настоящее преимущество: администратор базы данных может прочитать скрипт до выполнения. Цена в том, что теперь нужен инструмент для его выполнения, и, как формулирует команда EF в документации, обработка транзакций и поведение продолжать-после-ошибки у таких инструментов непоследовательны и порой неожиданны. `sqlcmd` спокойно продолжит работу после сбоя на инструкции 40 из 120, оставив вашу схему где-то между двумя миграциями без записи о том, где именно.

Bundle устраняет этот класс проблем: исполняемый файл применяет миграции по тому же пути кода EF Core, что и `dotnet ef database update`, с той же семантикой транзакций, и либо сообщает об успехе, либо возвращает ненулевой код выхода.

## Конвейер из четырёх шагов

Вот форма всего развёртывания, а остальная часть статьи разбирает каждый шаг подробно.

1. **Проверьте, что модель и миграции согласованы.** Выполните `dotnet ef migrations has-pending-model-changes` в CI. Команда завершится с ненулевым кодом, если кто-то изменил сущность и забыл выполнить `migrations add`.
2. **Соберите bundle один раз**, в CI, из того же коммита, из которого собраны бинарные файлы приложения: `dotnet ef migrations bundle --self-contained -r linux-x64 -o ./artifacts/efbundle --force`.
3. **Опубликуйте `efbundle` как артефакт сборки**, вместе с любым нужным ему `appsettings.json`.
4. **Запустите его отдельным шагом развёртывания**, до того как новая версия приложения начнёт обслуживать запросы: `./efbundle --connection "$CONNECTION_STRING"`.

## Сборка bundle

Команда работает на этапе проектирования, поэтому ей нужен `Microsoft.EntityFrameworkCore.Design` в ссылках стартового проекта и рабочая установка `dotnet ef`:

```bash
# EF Core 11, .NET 11
dotnet tool install --global dotnet-ef
dotnet ef migrations bundle
```

```output
Build started...
Build succeeded.
Building bundle...
Done. Migrations Bundle: /src/App.Api/efbundle
```

По умолчанию результат появляется рядом со стартовым проектом и называется `efbundle` (`efbundle.exe` в Windows), собранный под RID той машины, которая выполняет сборку. Опций достаточно мало, чтобы перечислить их полностью:

| Опция | Короткая | Что делает |
| --- | --- | --- |
| `--output <FILE>` | `-o` | Путь создаваемого исполняемого файла. |
| `--force` | `-f` | Перезаписывает существующий bundle. |
| `--self-contained` | | Включает и среду выполнения .NET, чтобы на целевой машине её не требовалось устанавливать. |
| `--target-runtime <RID>` | `-r` | Идентификатор среды выполнения, под который выполняется сборка. |

Плюс обычные опции этапа проектирования: `--project`, `--startup-project`, `--context`, `--configuration`, `--framework`, `--no-build`.

В реальном решении контекст живёт в библиотеке классов, а хост находится в другом месте, поэтому CI запускает что-то ближе к такому:

```bash
# EF Core 11, .NET 11 - context in a class library, host in the API project
dotnet ef migrations bundle \
  --project src/App.Infrastructure \
  --startup-project src/App.Api \
  --context AppDbContext \
  --configuration Release \
  --self-contained -r linux-x64 \
  -o ./artifacts/efbundle \
  --force
```

EF Core 11 позволяет перестать повторять большую часть этого. Положите файл `.config/dotnet-ef.json` в корень репозитория, и `dotnet ef` поднимется по дереву каталогов от рабочего каталога, пока не найдёт его:

```json
{
  "project": "src/App.Infrastructure",
  "startupProject": "src/App.Api",
  "context": "AppDbContext",
  "configuration": "Release"
}
```

Явные опции командной строки по-прежнему имеют приоритет над файлом, так что разработчик может локально переопределить любую из них. Это новшество EF Core 11 и лучший отдельный повод обновить инструмент на агентах сборки.

## Что bundle делает во время выполнения

Запустите исполняемый файл, и он применит каждую миграцию сборки, которая ещё не записана в `__EFMigrationsHistory`:

```bash
./efbundle --connection "Server=prod-sql.contoso.com;Database=Orders;Authentication=Active Directory Default;Encrypt=true"
```

```output
Applying migration '20260721104512_AddOrderIndexes'.
Applying migration '20260726091133_AddCustomerTier'.
Done.
```

Запустите его второй раз, и он не сделает ничего, а это ровно то, чего вы хотите от шага развёртывания, который может быть повторён:

```output
No migrations were applied. The database is already up to date.
Done.
```

Вся его поверхность состоит из одного аргумента и четырёх опций. Аргумент задаёт целевую миграцию: передайте имя или ID миграции, чтобы подняться или **опуститься** до этой точки, и передайте `0`, чтобы откатить все миграции. Опции: `--connection`, `--verbose` (`-v`), `--no-color` и `--prefix-output`. Это всё. Опции `--timeout` нет, и именно поэтому долгое построение индекса на большой таблице требует `Command Timeout=600` внутри самой строки подключения; этот режим отказа я подробно разбирал, когда писал о [таймауте, который убивает миграции EF Core в середине развёртывания](/ru/2026/05/fix-sqlexception-timeout-expired-during-ef-core-migrations/).

Опцию `--prefix-output` стоит включить в CI: она помечает каждую строку уровнем важности, и вашей системе сбора журналов есть по чему фильтровать.

## Ловушка appsettings.json

Это сбой, который стоит командам половины рабочего дня, и из документации он неочевиден.

Если ваш `DbContext` настроен на **именованную** строку подключения, например `optionsBuilder.UseSqlServer("name=ConnectionStrings:DefaultConnection")`, bundle всё равно требует `appsettings.json` в своём рабочем каталоге с этим ключом. Даже когда вы передаёте `--connection` в командной строке. Без него вы получите:

```output
A named connection string was used, but the name 'ConnectionStrings:DefaultConnection'
was not found in the application's configuration. Note that named connection strings
are only supported when using 'IConfiguration' and a service provider, such as in a
typical ASP.NET Core application.
```

Значение в этом файле не имеет значения, потому что `--connection` его перекрывает; должен существовать сам *ключ*, чтобы привязка конфигурации прошла успешно. Это было заведено как [dotnet/efcore#32009](https://github.com/dotnet/efcore/issues/32009) и закрыто как незапланированное, так что стройте план вокруг этого, а не ждите исправления. Два выхода:

- Поставляйте рядом с bundle в артефакте заглушку `appsettings.json` со значением-заполнителем под ожидаемым ключом.
- Или откажитесь от именованной строки подключения на пути этапа проектирования, чтобы bundle нечего было разрешать.

Документация EF Core прямолинейна и по общему случаю: не забудьте скопировать `appsettings.json` рядом с bundle, потому что bundle рассчитывает на его присутствие в каталоге запуска. Если конфигурация разделена по средам, задайте `ASPNETCORE_ENVIRONMENT` (или `DOTNET_ENVIRONMENT` для не-веб-хоста) перед запуском bundle и скопируйте также соответствующий `appsettings.Production.json`. Собственной опции `--environment` у bundle нет.

Я предпочитаю обойти конфигурацию целиком: передавайте полную строку подключения через `--connection`, взятую из хранилища секретов в момент развёртывания, и держите заглушку `appsettings.json` только ради привязчика. Так bundle становится чистой функцией своих аргументов, а это именно то, что нужно, когда один и тот же артефакт продвигается со staging в продакшен.

## Self-contained bundle и подвох с Alpine

`--self-contained -r linux-x64` создаёт исполняемый файл, который несёт среду выполнения .NET с собой. Для развёртывания в контейнерах это правильное значение по умолчанию, потому что тогда шаг миграции может выполняться в минимальном образе, где .NET вообще не установлен.

RID должен совпадать с libc целевой системы, а не только с архитектурой. Self-contained bundle для `linux-x64` рассчитан на glibc и не запустится на Alpine или любом другом образе на основе musl; там нужен `linux-musl-x64`. Сбой выглядит как невнятное "not found" или ошибка загрузчика, а не как понятное сообщение, поэтому задавайте RID осознанно:

```bash
# EF Core 11, .NET 11 - for an Alpine-based runner
dotnet ef migrations bundle --self-contained -r linux-musl-x64 -o ./artifacts/efbundle --force
```

Глобализация - второй камень преткновения на Alpine. Self-contained bundle ожидает ICU, а образам Alpine нужен установленный `icu-libs`. Добавить `apk add --no-cache icu-libs` в образ для миграции дешевле, чем отлаживать `Couldn't find a valid ICU package installed on the system` внутри окна развёртывания.

Если на вашей продакшен-машине уже есть подходящая среда выполнения .NET, уберите `--self-contained` и получите заметно меньший артефакт. В init-контейнере Kubernetes или в Job, который выполняется перед выкаткой, self-contained вариант обычно всё равно выигрывает, потому что отвязывает шаг миграции от версии среды выполнения в образе приложения. Та же логика действует, когда вы [собираете сам образ приложения через `dotnet publish /t:PublishContainer`](/ru/2026/07/how-to-publish-a-dotnet-11-app-as-a-container-image-with-publishcontainer/): держите шаг схемы и шаг приложения как отдельные артефакты.

## Блокировка миграций и то, что она не покрывает

Начиная с EF Core 9 применение миграций сначала захватывает блокировку уровня базы данных. Это относится к `dotnet ef database update`, к `Update-Database`, к `Migrate()` и `MigrateAsync()`, а также к bundle миграций. Блокировка удерживается на протяжении всей операции, включая код заполнения данными, который выполняется в её составе, поэтому если вы заполняете данные через [`UseSeeding` и `UseAsyncSeeding`](/ru/2026/06/how-to-seed-data-with-useseeding-and-useasyncseeding-in-ef-core-11/), эта работа тоже покрыта.

Чего блокировка **не** покрывает, так это SQL-скрипты, потому что они выполняются полностью вне EF Core. Если половина вашего конвейера запускает bundle, а половина - сгенерированный скрипт, взаимного исключения между ними нет. Выберите что-то одно.

Механизм блокировки специфичен для поставщика и имеет острые углы. В SQLite он реализован через таблицу блокировок, которая может остаться брошенной, если процесс умрёт посреди миграции, и тогда она блокирует каждую последующую миграцию, пока вы не очистите её вручную. Это важно, если вы гоняете интеграционные тесты против SQLite и убиваете тестовый хост.

Есть ещё одно ограничение, которое стоит знать до того, как проектировать вокруг этого: обернуть `MigrateAsync` в явную транзакцию нельзя. Начиная с EF Core 9 это выбрасывает исключение.

## Транзакции идут на миграцию, а не на bundle

Распространённое заблуждение - что bundle применяет все ожидающие миграции атомарно. Это не так. EF Core оборачивает в собственную транзакцию **каждую миграцию**. Три ожидающие миграции означают три транзакции. Если вторая падает, первая остаётся применённой и записанной в `__EFMigrationsHistory`, а третья не выполняется вовсе.

Обычно это как раз нужное поведение, ведь повторный запуск bundle продолжит ровно с того места, где он остановился. Но это значит, что "развёртывание провалилось, откатите базу" - не одна операция, и вам стоит продумать промежуточные состояния, в которых может оказаться схема.

Две особенности поставщиков заостряют это:

- В базах данных без транзакционного DDL, прежде всего в MySQL, упавшая миграция может оставить частичные изменения схемы вообще без отката. Каждая инструкция DDL выполняет неявную фиксацию. На MySQL считайте каждую миграцию нетранзакционной и держите миграции достаточно маленькими, чтобы разобрать их вручную.
- Некоторые операции не могут выполняться внутри транзакции даже на SQL Server или PostgreSQL, например конкурентное создание индекса. Для них передавайте `suppressTransaction: true` в `migrationBuilder.Sql(...)` и принимайте, что эта инструкция не покрыта.

```csharp
// EF Core 11, C# 14 - a statement that must not run inside the migration transaction
protected override void Up(MigrationBuilder migrationBuilder)
{
    migrationBuilder.Sql(
        "CREATE INDEX CONCURRENTLY IX_Orders_CustomerId ON \"Orders\" (\"CustomerId\");",
        suppressTransaction: true);
}
```

## Откат

Bundle принимает целевую миграцию позиционным аргументом, и миграция "вниз" - это та же команда с более ранней целью:

```bash
# EF Core 11 - revert to the state right after AddOrderIndexes
./efbundle 20260721104512_AddOrderIndexes

# EF Core 11 - revert everything. Read that twice before running it.
./efbundle 0
```

Чтобы это сработало, запускаемый bundle должен *содержать* миграции, к которым вы откатываетесь, и это довод за то, чтобы хранить каждый когда-либо развёрнутый артефакт bundle, а не только последний. Методы `Down` тоже должны быть корректными, а они - наименее протестированный код в большинстве репозиториев. `Down`, который удаляет столбец, это не откат, а потеря данных с дополнительными шагами. Именно такую проверку и покупает генерация скрипта, и ничто не мешает выпускать в CI оба артефакта: запускайте bundle в конвейере, а `dotnet ef migrations script --idempotent -o schema.sql` прикладывайте к той же сборке, чтобы администратор базы данных мог прочитать.

## Поймать расхождение до развёртывания

Начиная с EF Core 9, `Migrate()` выбрасывает исключение, когда в модели есть изменения, не отражённые в последней миграции (`RelationalEventId.PendingModelChangesWarning`). Обнаруживать это во время развёртывания вы не хотите. Поставьте проверку в CI:

```bash
# EF Core 11 - fails the build if an entity changed without a migration
dotnet ef migrations has-pending-model-changes \
  --project src/App.Infrastructure \
  --startup-project src/App.Api
```

Команда появилась в EF Core 8 и завершается ненулевым кодом, когда модель и миграции разошлись. Совместите её со сборкой bundle в одном job, чтобы артефакт и проверка происходили из одного коммита.

Пока вы укрепляете конвейер, стоит заранее учесть два смежных режима отказа: `dotnet ef` требует фабрику этапа проектирования, когда [не может создать ваш DbContext](/ru/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/), и изменения поведения, которые кусаются при [обновлении с EF Core 6 до EF Core 11](/ru/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/).

## Где уместен `database update --add`, а где нет

EF Core 11 добавил `dotnet ef database update <NAME> --add`, который создаёт миграцию и применяет её одной командой, компилируя миграцию во время выполнения через Roslyn. Для внутреннего цикла разработки это по-настоящему приятный инструмент, и я писал про [одношаговый процесс миграции](/ru/2026/04/efcore-11-single-step-migrations-dotnet-ef-update-add/), когда он появился. Это же и полная противоположность тому, что нужно в продакшене: он генерирует и применяет изменения схемы без артефакта и без промежуточного шага проверки. Пользуйтесь им при прототипировании, а bundle оставьте для всего, за чем стоят реальные данные. То же касается остальных дополнений инструментария EF Core 11: `--connection` у `database drop` и `migrations remove` и `--offline` у `migrations remove` - это удобства цикла разработки, а не средства развёртывания.

Если bundle применил миграции и после этого что-то выглядит неправильно, воспроизведите локально с повышенным уровнем журналирования, а это вопрос того, чтобы [заставить EF Core 11 записывать генерируемый им SQL](/ru/2026/07/how-to-log-the-sql-that-ef-core-11-generates/) на черновой копии схемы.

## Похожие статьи

- [Fix: SqlException Timeout expired во время миграций EF Core](/ru/2026/05/fix-sqlexception-timeout-expired-during-ef-core-migrations/)
- [Fix: dotnet ef migrations add падает с "Unable to create an object of type DbContext"](/ru/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/)
- [Переход с EF Core 6 на EF Core 11: критические изменения, которые действительно кусаются](/ru/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/)
- [EF Core 11 позволяет создать и применить миграцию одной командой](/ru/2026/04/efcore-11-single-step-migrations-dotnet-ef-update-add/)
- [Как опубликовать приложение .NET 11 как образ контейнера с dotnet publish /t:PublishContainer](/ru/2026/07/how-to-publish-a-dotnet-11-app-as-a-container-image-with-publishcontainer/)

## Источники

- [Applying Migrations](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/applying) описывает все четыре стратегии развёртывания, таблицы аргументов и опций `efbundle` и блокировку миграций.
- [EF Core tools reference (.NET CLI)](https://learn.microsoft.com/en-us/ef/core/cli/dotnet) - авторитетный источник по опциям `dotnet ef migrations bundle` и по новому файлу конфигурации `.config/dotnet-ef.json` в EF Core 11.
- [Introducing DevOps-friendly EF Core Migration Bundles](https://devblogs.microsoft.com/dotnet/introducing-devops-friendly-ef-core-migration-bundles/) - исходный анонс с объяснением замысла.
- [dotnet/efcore#32009](https://github.com/dotnet/efcore/issues/32009) документирует требование `appsettings.json` для именованных строк подключения, закрыт как незапланированный.
- [Managing Migrations](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/managing) описывает транзакции на миграцию и `suppressTransaction`.
- [SQLite provider limitations](https://learn.microsoft.com/en-us/ef/core/providers/sqlite/limitations) описывает брошенные блокировки миграций.
