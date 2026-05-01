---
title: "Что нового в .NET 8"
description: ".NET 8 был выпущен 14 ноября 2023 года как версия LTS (Long Term Support), что означает поддержку, обновления и исправления ошибок не менее трёх лет с даты выхода. Как обычно, .NET 8 включает поддержку новой версии языка C#, а именно C# 12."
pubDate: 2023-06-10
updatedDate: 2023-11-15
tags:
  - "dotnet"
  - "dotnet-8"
lang: "ru"
translationOf: "2023/06/whats-new-in-net-8"
translatedBy: "claude"
translationDate: 2026-05-01
---
.NET 8 был выпущен **14 ноября 2023 года** как версия LTS (Long Term Support), что означает поддержку, обновления и исправления ошибок не менее трёх лет с даты выхода.

Как обычно, .NET 8 включает поддержку новой версии языка C#, а именно C# 12. Загляните на нашу отдельную страницу [что нового в C# 12](/2023/06/whats-new-in-c-12/).

Рассмотрим список изменений и новых возможностей в .NET 8:

-   [.NET Aspire (preview)](/ru/2023/11/what-is-net-aspire/)
    -   [Предварительные требования](/ru/2023/11/how-to-install-net-aspire/)
    -   [Начало работы](/ru/2023/11/getting-started-with-net-aspire/)
-   Изменения в .NET SDK
    -   [Команда 'dotnet workload clean'](/ru/2023/09/dotnet-workload-clean/)
    -   Артефакты 'dotnet publish' и 'dotnet pack'
-   Сериализация
    -   [Политики именования JSON snake\_case и kebab-case](/ru/2023/08/net-8-json-serialize-property-names-using-snake-case-and-kebab-case/)
    -   [Обработка отсутствующих членов при сериализации](/ru/2023/09/net-8-handle-missing-members-during-json-deserialization/)
    -   [Десериализация в свойства только для чтения](/ru/2023/09/net-8-deserialize-into-read-only-properties/)
    -   [Включение непубличных свойств в сериализацию](/ru/2023/09/net-8-include-non-public-members-in-json-serialization/)
    -   [Добавление модификаторов к существующим экземплярам IJsonTypeInfoResolver](/ru/2023/10/system-text-json-how-to-modify-existing-type-info-resolver/)
    -   Потоковая десериализация: [из JSON в AsyncEnumerable](/ru/2023/10/httpclient-get-json-as-asyncenumerable/)
    -   JsonNode: [глубокое клонирование, глубокое копирование](/ru/2023/10/deep-cloning-and-deep-equality-of-a-jsonnode/) и [другие обновления API](/ru/2023/10/jsonnode-net-8-api-updates/)
    -   [Отключение стандартной сериализации на основе reflection](/ru/2023/10/system-text-json-disable-reflection-based-serialization/)
    -   [Добавление/удаление TypeInfoResolver в существующем экземпляре JsonSerializerOptions](/ru/2023/10/add-remove-typeinforesolver-to-existing-jsonserializeroptions/)
-   Базовые библиотеки .NET
    -   [FrozenDictionary -- сравнение производительности](/ru/2023/08/net-8-performance-dictionary-vs-frozendictionary/)
    -   Методы для работы со случайностью -- [GetItems<T>()](/ru/2023/11/c-randomly-choose-items-from-a-list/) и [Shuffle<T>()](/ru/2023/10/c-how-to-shuffle-an-array/)
-   Расширяющие библиотеки
-   Сборка мусора
-   Source generator для привязки конфигурации
-   Улучшения reflection
    -   Долой reflection: знакомьтесь с [UnsafeAccessorAttribute](/ru/2023/10/unsafe-accessor/) (см. [тесты производительности](/ru/2023/11/net-8-performance-unsafeaccessor-vs-reflection/))
    -   [Обновление полей `readonly`](/2023/06/whats-new-in-net-8/)
-   Поддержка Native AOT
-   Улучшения производительности
-   Контейнерные образы .NET
-   .NET в Linux
-   Windows Presentation Foundation (WPF)
    -   [Аппаратное ускорение в RDP](/ru/2023/10/wpf-hardware-acceleration-in-rdp/)
    -   [Диалог Open Folder](/ru/2023/10/wpf-open-folder-dialog/)
        -   Дополнительные параметры диалога ([ClientGuid](/ru/2023/10/wpf-individual-dialog-states-using-clientguid/), [RootDirectory](/ru/2023/10/wpf-limit-openfiledialog-folder-tree-to-a-certain-folder/), [AddToRecent](/ru/2023/10/wpf-prevent-file-dialog-selection-from-being-added-to-recents/) и CreateTestFile)
-   NuGet
