---
title: "Трекер .NET 11"
description: "Статус .NET 11 RC3, политика поддержки, изменения runtime и проверки миграции. Руководства по интеграционным тестам, EF Core и журналам запросов."
tagline: "Одна закладка на весь цикл .NET 11."
pubDate: 2026-04-18
updatedDate: 2026-11-02
indexTags:
  - ".net 11"
  - "dotnet 11"
  - ".net 11 preview"
  - "dotnet-11"
lang: "ru"
translationOf: "dotnet-11-tracker"
---

На 2 ноября 2026 года актуальный кандидат — **.NET 11 RC3**. Microsoft выпустила его 25 октября как [внеплановое обновление безопасности](https://devblogs.microsoft.com/dotnet/dotnet-october-2026-oob-security-updates/). [Политика поддержки](https://dotnet.microsoft.com/en-us/platform/support/policy/dotnet-core) указывает статус go-live и срок поддержки. .NET 11 — выпуск STS (Standard Term Support). При переходе с .NET 8 LTS учитывайте эту разницу в плане следующего обновления.

**Исправление, 2 ноября 2026 года.** В предыдущей английской версии RC2 был назван новейшим, а переход с .NET 8 на 11 описан как обновление между LTS. Индекс теперь выбирает теги версий .NET 11, поэтому статьи о других версиях не попадают в него только из-за общего тега .NET.

## Выпуск и runtime

О RC2 см. [инкрементальное чтение CBOR](/ru/2026/10/dotnet-11-rc-2-cborreader-reads-cbor-incrementally/). Среди тем RC1 — [воспроизводимые образы контейнеров](/ru/2026/09/dotnet-11-rc-1-reproducible-container-images-source-date-epoch/), [сигналы процессов](/ru/2026/09/dotnet-11-rc-1-process-signal-exit-status/) и [обновление аутентификации SignalR](/ru/2026/09/signalr-authentication-refresh-finalized-dotnet-11-rc-1/). Об изменениях runtime см. [девиртуализацию обобщённых методов](/ru/2026/09/dotnet-11-jit-devirtualizes-generic-virtual-methods/), [соглашения вызова структур](/ru/2026/10/what-is-transparent-struct-layout-and-why-does-a-single-field-wrapper-struct-change-the-calling-convention-in-dotnet/) и [совместимость CPU](/ru/2026/06/dotnet-11-minimum-cpu-baseline-x86-64-v2/).

## Планирование и проверка миграции

Начните с [чек-листа для .NET 8](/ru/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/) или [руководства по .NET Framework 4.8](/ru/2026/05/migrate-from-dotnet-framework-4-8-to-dotnet-11-in-2026/). Для нескольких проектов проверьте [выбор SDK](/ru/2026/10/dotnetup-public-preview-installs-the-sdk-your-global-json-pins/) и [централизованное управление пакетами](/ru/2026/08/migrate-a-dotnet-solution-to-central-package-management-with-directory-packages-props/). При смене тестового раннера пригодятся [Microsoft.Testing.Platform](/ru/2026/09/migrate-from-vstest-to-microsoft-testing-platform-in-dotnet-11/), [код выхода 5](/ru/2026/10/fix-dotnet-test-exit-code-5-zero-tests-ran-microsoft-testing-platform/) и [возврат к VSTest](/ru/2026/10/fix-dotnet-test-falls-back-to-vstest-in-linux-ci-microsoft-testing-platform/).

Сравнение [WebApplicationFactory и Testcontainers](/ru/2026/08/webapplicationfactory-vs-testcontainers-for-aspnetcore-integration-tests/) помогает выбрать поведение HTTP и базы, которое должен проверять тест. [Хранение enum в строке](/ru/2026/08/how-to-store-an-enum-as-a-string-in-ef-core-11-with-a-value-converter/) показывает, почему числовые строки и имена могут давать разные результаты запросов. Для трассировки аутентифицированных запросов см. [идентификатор пользователя в логах](/ru/2026/09/how-to-add-the-current-user-id-to-every-log-entry-in-aspnet-core/).

## Указатель тем

Хронологический индекс выбирает теги версий .NET 11. Для подробной справки см. [EF Core 11](/ru/pillars/efcore-11-cheat-sheet/) и [C# 14](/ru/pillars/csharp-14-features/).
