---
title: "Уход от BinaryFormatter после его удаления в современном .NET"
description: "Реализация BinaryFormatter была удалена в .NET 9 и по-прежнему выбрасывает PlatformNotSupportedException в .NET 10 и .NET 11: как выбрать сериализатор на замену, читать уже сохранённые NRBF-блобы через NrbfDecoder и что ломается в WinForms, WPF и ResX."
pubDate: 2026-09-02
updatedDate: 2026-09-02
template: migration
tags:
  - "migration"
  - "binaryformatter"
  - "serialization"
  - "system-text-json"
  - "dotnet-10"
  - "dotnet-11"
  - "security"
  - "dotnet"
lang: "ru"
translationOf: "2026/09/migrate-off-binaryformatter-after-its-removal-in-modern-dotnet"
translatedBy: "claude"
translationDate: 2026-09-02
---

Сервис, который сериализует собственные типы в собственное хранилище, уходит от `BinaryFormatter` за один-три дня. Кодовая база, где NRBF-полезные нагрузки пересекли границу, которую вы не контролируете (очередь, общий столбец базы данных, десктопный клиент со своим графиком выпусков), потребует недель, потому что сложность не в замене сериализатора, а в вытеснении старых полезных нагрузок. Встроенная реализация была удалена в .NET 9 Preview 6 и остаётся удалённой: в .NET 9, .NET 10 и .NET 11 preview методы `BinaryFormatter.Serialize` и `BinaryFormatter.Deserialize` выбрасывают [`PlatformNotSupportedException`](https://learn.microsoft.com/en-us/dotnet/core/compatibility/serialization/9.0/binaryformatter-removal) для любого типа проекта, а старое свойство MSBuild `EnableUnsafeBinaryFormatterSerialization` само по себе уже ничего не возвращает. Это руководство написано для .NET 10.0.11 (GA) с замечаниями по .NET 11 SDK (preview 7, август 2026), `System.Formats.Nrbf` 10.0.11 и `System.Runtime.Serialization.Formatters` 10.0.11.

## Почему это не опционально

- **Переключателей не осталось.** В .NET 8 отключение стало поведением по умолчанию, а `<EnableUnsafeBinaryFormatterSerialization>true</EnableUnsafeBinaryFormatterSerialization>` ещё работало. Начиная с .NET 9 это свойство само по себе бездействует; реализующего кода в общем фреймворке просто нет.
- **Пакет совместимости явно не поддерживается.** `System.Runtime.Serialization.Formatters` поставляет рабочую реализацию вместе с её уязвимостями. Это заплатка ради срока, а не пункт назначения.
- **Риск создаёт формат, а не ошибки.** NRBF кодирует внутри полезной нагрузки, какие типы нужно создать, и это [CWE-502, "Deserialization of Untrusted Data"](https://cwe.mitre.org/data/definitions/502.html). Никакие исправления не спасут формат, задача которого -- позволить полезной нагрузке выбирать конструктор.
- **Старые блобы можно читать, не десериализуя их.** `NrbfDecoder`, вышедший в .NET 9 вместе с удалением, декодирует NRBF в записи, не загружая ни одного пользовательского типа. Именно это делает возможной поэтапную миграцию вместо одномоментного переключения.

## Что ломается

| Область | Изменение | Серьёзность |
| --- | --- | --- |
| `BinaryFormatter.Serialize` / `Deserialize` | Выбрасывает `PlatformNotSupportedException` при каждом вызове, во всех типах проектов | высокая |
| `EnableUnsafeBinaryFormatterSerialization` | Само по себе больше не достаточно; нужен ещё пакет совместимости | высокая |
| Сохранённые NRBF-блобы | Ничто во фреймворке больше их не десериализует | высокая |
| `SoapFormatter`, `NetDataContractSerializer` | Удалены или отнесены к [опасным сериализаторам](https://learn.microsoft.com/en-us/dotnet/standard/serialization/binaryformatter-security-guide); это не цель миграции | высокая |
| Буфер обмена и перетаскивание в WinForms/WPF | Полный цикл проходит только список встроенных типов. `DataFormats.Serializable` и пользовательские форматы падают на всём остальном | высокая |
| Дизайнер WinForms / ResX | Сериализация пользовательского типа во время разработки требует `TypeConverter` | средняя |
| `Exception(SerializationInfo, StreamingContext)` | Помечен устаревшим как `SYSLIB0051`; старая сериализация исключений -- балласт | средняя |
| `MSB3825` в MSBuild | Предупреждение о ресурсах в двоичном формате; подавляется через `GenerateResourceWarnOnBinaryFormatterUse` | низкая |
| `SettingsPropertyValue.PropertyValue` | Имеет тип `object`, поэтому пользовательские настройки `System.Configuration` с собственными типами нельзя мигрировать без слома API | высокая |

## Подготовительный список

- Установлен .NET SDK 10.0.100 или новее (`dotnet --list-sdks`).
- Инвентаризация: `grep -rn "BinaryFormatter\|IFormatter\|SoapFormatter\|NetDataContractSerializer" --include=*.cs .` плюс просмотр зависимостей NuGet, потому что удивляют именно транзитивные вызывающие.
- Тесты полного цикла вокруг каждой границы сериализации **до** того, как вы что-то трогаете. Ошибки сериализации молчаливы; они проявляются как null в поле через три релиза.
- Выборка настоящих сохранённых полезных нагрузок из продакшн-хранилища. Синтетические нагрузки не проверяют дрейф версий.
- Записанное решение о том, контролируете ли вы и производителя, и потребителя каждой полезной нагрузки. Если нет, вам нужен путь двойного чтения из шага 4, а не прямая замена.

## Шаги миграции

1. **Инвентаризуйте каждую границу полезной нагрузки, а не каждое место вызова.** Сгруппируйте использования `BinaryFormatter` по тому, куда уходят байты: только в память (помощник глубокого клонирования), кеш внутри процесса, долговременное хранилище (столбец базы данных, блоб, файл на диске) и межпроцессное взаимодействие (буфер обмена, очередь, RPC в стиле remoting). Использования в памяти и внутри процесса меняются одним коммитом. Долговременные и межпроцессные требуют окна перехода формата. Зафиксируйте замкнутый набор типов, доходящих до каждой границы.

   Проверка: каждое совпадение из `grep` выше отнесено ровно к одной из четырёх групп, а у каждой долговременной границы есть названный ответственный и названный список сериализуемых типов.

2. **Выберите сериализатор на замену для каждой границы.** Прямой замены нет, и выбирать один и тот же везде не обязательно. [Официальное сравнение](https://learn.microsoft.com/en-us/dotnet/standard/serialization/binaryformatter-migration-guide/choose-a-serializer) сводится к следующему: `System.Text.Json`, когда полезная нагрузка может быть текстовой и типы можно снабдить атрибутами (единственный вариант в списке с полноценной поддержкой AOT и генерацией исходного кода); `DataContractSerializer`, когда типы менять вообще нельзя, потому что это единственный рекомендованный сериализатор, уважающий `[Serializable]` и `ISerializable`; [MessagePack for C#](https://github.com/MessagePack-CSharp/MessagePack-CSharp) или [protobuf-net](https://github.com/protobuf-net/protobuf-net), когда нагрузка должна остаться компактной двоичной.

   Проверка: рядом с каждой границей из шага 1 записан один сериализатор и однострочное обоснование. Если обоснование звучит как "он был по умолчанию", вернитесь назад.

3. **Сначала замените использования в памяти и внутри процесса.** Это бесплатный выигрыш, сокращающий площадь для сложных шагов. Типу `[Serializable]`, переезжающему на `System.Text.Json`, нужно явное согласие на всё, что раньше было неявным: поля не сериализуются, пока вы не попросите, приватные члены требуют собственного контракта, а сам `[Serializable]` не значит ничего.

   ```csharp
   // .NET 10.0.11, C# 14
   using System.Text.Json;
   using System.Text.Json.Serialization;

   [JsonSourceGenerationOptions(IncludeFields = true)]
   [JsonSerializable(typeof(CartSnapshot))]
   internal partial class CartContext : JsonSerializerContext;

   public sealed class CartSnapshot
   {
       public int Version;                 // a field, so IncludeFields is required
       public string? CouponCode { get; set; }
       public List<int> LineItemIds { get; set; } = [];
   }

   byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(snapshot, CartContext.Default.CartSnapshot);
   CartSnapshot? back = JsonSerializer.Deserialize(bytes, CartContext.Default.CartSnapshot);
   ```

   Проверка: `dotnet test` зелёный, а утверждение полного цикла сравнивает каждый публичный **и** приватный член, а не только те, о которых вы вспомнили.

4. **Добавьте путь двойного чтения на каждой долговременной границе.** Именно этот шаг позволяет выкатиться. `NrbfDecoder.StartsWithPayloadHeader` сообщает, являются ли только что прочитанные байты старым NRBF, и если да, вы их декодируете, заново сериализуете новым сериализатором и записываете обратно. Чтения переносят корпус лениво; записи с первого дня идут только в новом формате.

   ```csharp
   // .NET 10.0.11, System.Formats.Nrbf 10.0.11
   using System.Formats.Nrbf;

   internal static CartSnapshot Load(string path)
   {
       byte[] raw = File.ReadAllBytes(path);

       if (!NrbfDecoder.StartsWithPayloadHeader(raw))
       {
           return JsonSerializer.Deserialize(raw, CartContext.Default.CartSnapshot)!;
       }

       CartSnapshot upgraded = ReadLegacy(raw);
       File.WriteAllBytes(path, JsonSerializer.SerializeToUtf8Bytes(upgraded, CartContext.Default.CartSnapshot));
       return upgraded;
   }
   ```

   Проверка: тест, который записывает настоящий продакшн-образец NRBF во временный файл, вызывает `Load`, проверяет значения, а затем проверяет, что второй `Load` больше не идёт по старой ветке.

5. **Реализуйте `ReadLegacy` через `NrbfDecoder`, по одному типу за раз.** `NrbfDecoder` декодирует; он никогда не создаёт ваши типы, никогда не загружает сборку и никогда не рекурсирует. Конструирование выполняете вы, и именно поэтому он безопасен на недоверенном входе. `ClassRecord` отдаёт члены по имени через типизированные аксессоры, а `TypeNameMatches` сравнивает имена типов, игнорируя идентичность сборки, так что переадресация типов и смена версии сборки вас не ломают.

   ```csharp
   // .NET 10.0.11, System.Formats.Nrbf 10.0.11
   using System.Formats.Nrbf;

   private static CartSnapshot ReadLegacy(byte[] raw)
   {
       using MemoryStream stream = new(raw);
       ClassRecord root = NrbfDecoder.DecodeClassRecord(stream);

       if (!root.TypeNameMatches(typeof(CartSnapshot)))
       {
           throw new InvalidDataException($"Unexpected payload type '{root.TypeName.AssemblyQualifiedName}'.");
       }

       SZArrayRecord<int> ids = (SZArrayRecord<int>)root.GetArrayRecord(nameof(CartSnapshot.LineItemIds))!;
       if (ids.Length > 10_000)
       {
           throw new InvalidDataException("Line item array exceeds the sane limit.");
       }

       return new CartSnapshot
       {
           Version = root.HasMember(nameof(CartSnapshot.Version)) ? root.GetInt32(nameof(CartSnapshot.Version)) : 1,
           CouponCode = root.GetString(nameof(CartSnapshot.CouponCode)),
           LineItemIds = [.. ids.GetArray()],
       };
   }
   ```

   `HasMember` -- это аварийный выход для версионирования: поле, добавленное или переименованное между записью полезной нагрузки и сегодняшним днём, даёт `false`, а не исключение. Проверка длины перед `GetArray` не опциональна, потому что NRBF позволяет враждебной нагрузке дёшево пообещать два миллиарда null.

   Проверка: по одному тесту декодирования на каждый старый тип против настоящей сохранённой нагрузки, плюс тест, подтверждающий, что нагрузка чрезмерного размера или с неверным типом выбрасывает `InvalidDataException`, а не выделяет память.

6. **Если типы действительно нельзя менять, используйте `DataContractSerializer` вместо шагов 3-5.** Это единственный рекомендованный вариант, уважающий модель программирования `[Serializable]` и `ISerializable`, так что типы остаются нетронутыми. Подвох в том, что известные типы нужно указывать заранее, включая приватные, а некоторые распространённые типы (в частности `DateTimeOffset`) не входят в список разрешённых по умолчанию. `PreserveObjectReferences` возвращает поведение с идентичностью объектов и циклами, которое `BinaryFormatter` давал бесплатно.

   ```csharp
   // .NET 10.0.11
   using System.Runtime.Serialization;

   DataContractSerializer serializer = new(
       typeof(CartSnapshot),
       new DataContractSerializerSettings
       {
           KnownTypes = [typeof(PercentageCoupon), typeof(FixedAmountCoupon), typeof(DateTimeOffset)],
           PreserveObjectReferences = true,
       });
   ```

   Не хватайтесь за `NetDataContractSerializer` только потому, что имя выглядит ближе. Он встраивает информацию о типах в полезную нагрузку так же, как `BinaryFormatter`, и числится опасным сериализатором.

   Проверка: тест полного цикла по всему замыканию известных типов, включая граф с намеренным циклом, который проходит при `PreserveObjectReferences = true`.

7. **Разбирайтесь с WinForms и WPF отдельно.** С .NET 9 оба фреймворка внутренне используют подмножество NRBF для буфера обмена, перетаскивания и ресурсов времени разработки, но только для встроенного списка: примитивы, `string`, `decimal`, `TimeSpan`, `DateTime`, `nint`, `nuint`, `PointF`, `RectangleF`, плюс `Bitmap` и `ImageListStreamer` в WinForms, а также массивы и списки из них. Всё остальное откатывается к `BinaryFormatter` и падает. Предписанное решение для буфера обмена и перетаскивания -- самостоятельно класть в буфер `string` или `byte[]`, обычно JSON, и разбирать его на принимающей стороне. Для сериализации пользовательского типа через дизайнер и ResX зарегистрируйте `TypeConverter`, чтобы дизайнер использовал его вместо отката к `BinaryFormatter`.

   Проверка: ручное копирование-вставка и перетаскивание между двумя запущенными экземплярами приложения для каждого пользовательского формата, плюс полный цикл в дизайнере (открыть форму, сохранить, открыть заново) без `MSB3825` и без исключения во время выполнения.

8. **Только после этого решайте насчёт пакета совместимости.** Если сторонняя зависимость вызывает `BinaryFormatter` внутри себя и ждать её исправления нельзя, установите `System.Runtime.Serialization.Formatters` только в проекте **приложения**. Пакет не меняет идентичность типа `BinaryFormatter`, поэтому библиотеки в графе подхватывают рабочую реализацию без пересборки.

   ```xml
   <!-- .NET 10.0.11. Unsupported, and a temporary measure. -->
   <PropertyGroup>
     <TargetFramework>net10.0</TargetFramework>
     <EnableUnsafeBinaryFormatterSerialization>true</EnableUnsafeBinaryFormatterSerialization>
   </PropertyGroup>

   <ItemGroup>
     <PackageReference Include="System.Runtime.Serialization.Formatters" Version="10.0.11" />
   </ItemGroup>
   ```

   Для ResX есть второй барьер: дополнительно установите переключатель AppContext `System.Resources.Extensions.UseBinaryFormatter` в `true`.

   Проверка: ссылка на пакет существует ровно в одном файле проекта, и есть датированная задача сопровождения, называющая зависимость, которая к этому вынудила.

## Проверьте миграцию

- `grep -rn "BinaryFormatter" --include=*.cs src/` ничего не возвращает за пределами пути декодирования старого формата и его тестов.
- `dotnet build -warnaserror` чист, без `SYSLIB0011` и без `MSB3825`.
- `dotnet test -c Release` зелёный и включает как минимум один тест декодирования на каждый старый тип против настоящего продакшн-образца полезной нагрузки.
- Прогон в staging читает продакшн-корпус: логируйте количество нагрузок, ушедших по старой ветке, и убедитесь, что оно стремится к нулю в течение окна перехода.
- В логах нет `PlatformNotSupportedException` первого шанса.
- Если приложение на WinForms или WPF, буфер обмена и перетаскивание проверены между двумя процессами, а не только внутри одного.

## Откат

Изменение кода обратимо, изменение данных -- нет. Как только шаг 4 перезаписал блоб в новом формате, старые байты исчезли, и откат на сборку, понимающую только NRBF, их не прочитает. Два следствия, которые стоит запланировать: храните байты прежнего формата в течение всего окна отката (пишите обновлённую нагрузку в новый столбец или под новый ключ, а не поверх, и удаляйте старую только после закрытия окна), и оставьте путь чтения старого формата через `NrbfDecoder` в коде минимум на один релиз после того, как счётчик миграции достигнет нуля. Если вы выкатываете пакет совместимости как мост, откат тривиален, но угроза безопасности реальна всё время, пока он развёрнут, поэтому проставьте дату в задаче сопровождения.

## Подводные камни, о которых стоит знать заранее

**`[Serializable]` ничего не значит для `System.Text.Json`.** Типы, которые проходили полный цикл через `BinaryFormatter` с приватными полями и без публичного конструктора, под JSON молча дадут `{}`. Сбой -- это не исключение, а пустой вывод, поэтому тест полного цикла из шага 3 обязан сравнивать приватное состояние.

**Идентичность объектов исчезает.** `BinaryFormatter` сохранял ссылки и справлялся с циклами. `System.Text.Json` требует `ReferenceHandler.Preserve`, `DataContractSerializer` требует `PreserveObjectReferences = true`, и если пропустить оба, общий дочерний объект после полного цикла молча превращается в два объекта. Там, где старый код полагался на равенство по ссылке после десериализации, это допущение теперь неверно.

**`NrbfDecoder` -- декодер, а не эмулятор `BinaryFormatter`.** Его поведение намеренно не совпадает с поведением `BinaryFormatter`, поэтому успешное декодирование нельзя считать доказательством того, что вызов `BinaryFormatter` был бы безопасен. Он также не поддерживает массивы с ненулевым начальным индексом, которые .NET Framework мог записывать в NRBF-нагрузки, а .NET никогда не читал.

**Некоторые библиотеки нельзя мигрировать в принципе.** `SettingsPropertyValue.PropertyValue` имеет тип `object`, поэтому файл настроек `System.Configuration` мог содержать буквально что угодно. Замкнутого набора типов для декодирования нет, а значит, нет и пути через `NrbfDecoder` без слома API. Именно из-за таких типов инвентаризация из шага 1 идёт первой.

**Сериализация исключений -- отдельное устаревание.** `SYSLIB0051` покрывает конструктор `Exception(SerializationInfo, StreamingContext)` и остальную поддержку старой сериализации. Ваши пользовательские исключения, скорее всего, всё ещё несут этот конструктор; удалять его безопасно, когда ничто больше не гоняет исключения через форматтер, и это хороший `grep` для того же прохода.

**Межверсионная конверсия должна выполняться там, где реализация ещё есть.** Если вы одновременно уходите с .NET Framework, напишите одноразовый инструмент конверсии блобов, пока у вас ещё есть среда выполнения с рабочим `BinaryFormatter`, либо используйте `System.Formats.Nrbf`, который нацелен в том числе на .NET Standard 2.0 и .NET Framework именно для того, чтобы сторона декодирования могла работать где угодно.

## Связанные материалы

- Шаг с BinaryFormatter входит в более крупный скачок из [чек-листа обновления с .NET 8 на .NET 11](/ru/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/) и обычно оказывается самым дорогим пунктом при [переносе кодовой базы .NET Framework 4.8 на .NET 11](/ru/2026/05/migrate-from-dotnet-framework-4-8-to-dotnet-11-in-2026/).
- Если заменой стал JSON, иерархиям типов `[Serializable]`, которые BinaryFormatter обрабатывал неявно, нужны [явные аннотации `JsonDerivedType`](/ru/2026/07/how-to-serialize-a-polymorphic-type-hierarchy-with-jsonderivedtype-in-system-text-json/), а неудобные формы обычно оседают в [пользовательском `JsonConverter`](/ru/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/).
- Командам, которые делают это одновременно с чисткой Newtonsoft, стоит сначала прочитать [миграцию с Newtonsoft на System.Text.Json в большой кодовой базе](/ru/2026/05/migrate-from-newtonsoft-json-to-system-text-json-in-a-large-codebase/), потому что оба прохода трогают одни и те же файлы.
- Сборки с обрезкой и AOT упираются в соседнюю стену: смотрите [reflection-based serialization has been disabled for this application](/ru/2026/07/fix-reflection-based-serialization-has-been-disabled-for-this-application/) и более широкий разбор [PlatformNotSupportedException в Native AOT](/ru/2026/05/fix-platformnotsupportedexception-in-native-aot/).

## Источники

- [BinaryFormatter migration guide](https://learn.microsoft.com/en-us/dotnet/standard/serialization/binaryformatter-migration-guide/), Microsoft Learn
- [Breaking change: In-box BinaryFormatter implementation removed and always throws](https://learn.microsoft.com/en-us/dotnet/core/compatibility/serialization/9.0/binaryformatter-removal), Microsoft Learn
- [Read BinaryFormatter (NRBF) payloads](https://learn.microsoft.com/en-us/dotnet/standard/serialization/binaryformatter-migration-guide/read-nrbf-payloads), Microsoft Learn
- [Choose a serializer](https://learn.microsoft.com/en-us/dotnet/standard/serialization/binaryformatter-migration-guide/choose-a-serializer), Microsoft Learn
- [WinForms and WPF OLE guidance](https://learn.microsoft.com/en-us/dotnet/standard/serialization/binaryformatter-migration-guide/winforms-wpf-ole-guidance), Microsoft Learn
- [BinaryFormatter removal from .NET 9 is complete](https://github.com/dotnet/announcements/issues/317), dotnet/announcements
- [BinaryFormatter obsoletion plan](https://github.com/dotnet/designs/blob/main/accepted/2020/better-obsoletion/binaryformatter-obsoletion.md), dotnet/designs
- [MS-NRBF: .NET Remoting Binary Format specification](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-nrbf/)
