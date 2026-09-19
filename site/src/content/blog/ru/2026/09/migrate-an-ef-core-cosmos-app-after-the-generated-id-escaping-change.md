---
title: "Миграция приложения EF Core с Cosmos DB после изменения экранирования генерируемых id в EF Core 11"
description: "EF Core 11 перестает экранировать '/', '\\', '?' и '#' в генерируемых значениях id для Cosmos DB, поэтому документы, записанные EF Core 8-10, больше не находятся по ключу. Как понять, затронуты ли вы, когда включать переключатель EscapeIllegalCosmosIdCharacters и как безопасно переписать id с помощью транзакционного пакета."
pubDate: 2026-09-19
updatedDate: 2026-09-19
template: migration
tags:
  - "migration"
  - "efcore"
  - "efcore-11"
  - "cosmos-db"
  - "dotnet-11"
lang: "ru"
translationOf: "2026/09/migrate-an-ef-core-cosmos-app-after-the-generated-id-escaping-change"
translatedBy: "claude"
translationDate: 2026-09-19
---

EF Core 11 меняет то, как провайдер Azure Cosmos DB строит `id` документа, когда этот `id` составлен из нескольких значений. EF Core 8, 9 и 10 заменяли `/`, `\`, `?` и `#` в каждой части на `^2F`, `^5C`, `^3F` и `^23`. EF Core 11 (изменение вышло в 11.0 preview 5, и я проверил его на 11.0.0 RC 1) вместо этого записывает исходные символы. Если ни одно из значений ваших составных ключей не содержит этих четырех символов, обновление ничего не меняет, и после следующего раздела можно дальше не читать. Если содержат, после обновления `FindAsync` и поиск по ключу перестают находить эти документы. Тогда у вас два варианта: включить переключатель `Microsoft.EntityFrameworkCore.EscapeIllegalCosmosIdCharacters` до запуска приложения или переписать затронутые id. Для ключей, содержащих `/` или `\`, работает только переключатель, потому что Cosmos DB не допускает эти символы в `id`. На аудит уйдет около часа, и большинство команд обнаружит, что делать ничего не нужно.

## Кого это на самом деле затрагивает

Экранирование всегда применялось только к составным id. Я прочитал `JsonIdDefinition` на теге EF Core 11 RC 1: ключ из одного значения записывается как есть, а экранирование происходит только тогда, когда несколько значений соединяются через `|`. Свойства ключа секции исключаются из id до этой проверки. Поэтому тип сущности попадает под изменение, только если выполняется одно из условий:

- Его первичный ключ после удаления свойств ключа секции по-прежнему состоит из двух или более свойств. Например, `HasKey(x => new { x.TenantId, x.OrderId, x.Sku })` вместе с `HasPartitionKey(x => x.TenantId)` дает id `OrderId|Sku`.
- Он использует `HasDiscriminatorInJsonId()`. Приложения, обновлявшиеся с EF Core 8, часто включали это в EF Core 9, чтобы сохранить старые id вида `Post|1`, так что это самый распространенный способ оказаться затронутым.

Кроме того, одно из значений ключа должно содержать `/`, `\`, `?` или `#`. В ключах GUID и целочисленных ключах их быть не может. Проблема возникает на строковых ключах со свободным текстом или в виде путей (артикулы вроде `shoes/red`, slug вроде `2026/09/hello`, имена файлов, URL).

Я прогнал одни и те же сущности через EF Core 10.0.12 и EF Core 11.0.0 RC 1 без базы данных. Добавление сущности в `DbContext` запускает генератор значений id, поэтому сгенерированный id можно прочитать прямо из трекера изменений:

| Значения ключа | EF Core 10.0.12 | EF Core 11 RC 1 | EF Core 11 RC 1 + переключатель |
| ---------- | --------------- | --------------- | ------------------------ |
| `o-1`, `shoes/red` | `o-1\|shoes^2Fred` | `o-1\|shoes/red` | `o-1\|shoes^2Fred` |
| `o-1`, `shoes^2Fred` | `o-1\|shoes^2Fred` | `o-1\|shoes^2Fred` | `o-1\|shoes^2Fred` |
| `o-1`, `C:\temp?#1` | `o-1\|C:^5Ctemp^3F^231` | `o-1\|C:\temp?#1` | `o-1\|C:^5Ctemp^3F^231` |
| `o-1`, `a\|b` | `o-1\|a^\|b` | `o-1\|a^\|b` | `o-1\|a^\|b` |
| одиночный ключ `shoes/red` | `shoes/red` | `shoes/red` | `shoes/red` |
| `HasDiscriminatorInJsonId`, `2026/09/hello` | `LegacyPost\|2026^2F09^2Fhello` | `LegacyPost\|2026/09/hello` | `LegacyPost\|2026^2F09^2Fhello` |

Первые две строки и есть причина изменения ([dotnet/efcore#38244](https://github.com/dotnet/efcore/issues/38244)). Сам символ экранирования `^` никогда не экранировался, поэтому `shoes/red` и `shoes^2Fred` получали один и тот же id, и вторая вставка молча перезаписывала первый документ. Команда EF решила прекратить экранирование вместо того, чтобы экранировать еще и `^`, потому что экранирование `^` сломало бы каждый существующий id, содержащий этот символ. Исправление находится в [dotnet/efcore#38245](https://github.com/dotnet/efcore/pull/38245), слито 2026-05-08. Обратите внимание, что разделитель `|` по-прежнему экранируется как `^|` в обеих версиях, так что эта часть ваших id не меняется.

## Что ломается

| Область | Изменение после обновления до EF Core 11 | Серьезность |
| ---- | ------------------------------------ | -------- |
| `FindAsync` и запросы, фильтрующие по полному ключу плюс ключу секции | EF превращает их в точечное чтение по заново сгенерированному id, поэтому документы, сохраненные с экранированным id, возвращаются как `null` или как пустой результат | высокая |
| Вставка сущности, ключ которой совпадает со старым документом | Новый id отличается, поэтому для `?` и `#` вместо конфликта появляется второй документ с теми же значениями ключа | высокая |
| Новые ключи, содержащие `/` или `\` | EF 11 теперь отправляет эти символы в id, а служба Cosmos DB не допускает `/` и `\` в id ([ограничения службы](https://learn.microsoft.com/azure/cosmos-db/concepts-limits#per-item-limits)), поэтому запись завершается ошибкой | высокая |
| Обновление и удаление сущностей, загруженных запросом | По-прежнему работают: `SaveChanges` использует значение `__id`, материализованное из документа, а не сгенерированное заново | нет |
| Запросы, не фильтрующие по полному ключу | По-прежнему работают, они не используют id | нет |

Опасна вторая строка. Распространенный шаблон "найти, а если нет, добавить" возвращает `null` для старого документа и создает рядом с ним дубликат. Никакого исключения не выбрасывается.

## Предварительный чек-лист

- Приложение собирается с `Microsoft.EntityFrameworkCore.Cosmos` 11.0.0-rc.1.26425.128 (или с GA, когда он выйдет), и вы прочитали остальные [критические изменения EF Core 11](https://learn.microsoft.com/ef/core/what-is-new/ef-core-11.0/breaking-changes). В провайдере Cosmos в 11 несколько изменений, включая удаление синхронного ввода-вывода и сохранения неотображенных свойств при круговом проходе.
- У вас есть доступ через Data Explorer или SDK к каждому контейнеру, в который пишет EF.
- Перед тем как переписывать какие-либо id, в учетной записи включено непрерывное резервное копирование или восстановление на момент времени.
- Вы знаете, какие свойства ключа содержат строки, вводимые пользователями, или свободный текст.

## Шаги миграции

1. **Составьте список типов сущностей с составными id.**
   Этот код обходит модель EF через публичные API метаданных Cosmos и применяет то же правило, что и провайдер:

   ```csharp
   // EF Core 11.0 RC 1, .NET 11 RC 1
   foreach (var entityType in db.Model.GetEntityTypes().Where(t => !t.IsOwned()))
   {
       var key = entityType.FindPrimaryKey()!;
       var partitionKeyNames = entityType.GetPartitionKeyPropertyNames();
       var idParts = key.Properties.Count(p => !partitionKeyNames.Contains(p.Name));
       var discriminatorInId = entityType.GetDiscriminatorInKey()
           is IdDiscriminatorMode.EntityType or IdDiscriminatorMode.RootEntityType;

       Console.WriteLine($"{entityType.DisplayName(),-12} container={entityType.GetContainer(),-8} " +
           $"id parts={idParts} discriminator in id={discriminatorInId} " +
           $"-> {(idParts > 1 || discriminatorInId ? "AFFECTED" : "not affected")}");
   }
   ```

   Для модели с секционированным `OrderLine` (ключ `TenantId, OrderId, Sku`) и `Product` с одиночным ключом он выводит:

   ```text
   OrderLine    container=Orders   id parts=2 discriminator in id=False -> AFFECTED
   Product      container=Catalog  id parts=1 discriminator in id=False -> not affected
   ```

   Проверка: у каждого типа сущности с пометкой `AFFECTED` есть хотя бы одно свойство ключа типа `string`. Если все они `Guid`, `int` или `long`, вы закончили. Для таких ключей EF Core 11 генерирует те же id, что и EF Core 10.

2. **Подсчитайте документы, которые действительно содержат escape-последовательность.**
   Выполните это в Data Explorer для каждого контейнера, в котором хранится затронутый тип:

   ```sql
   -- Azure Cosmos DB for NoSQL
   SELECT c.id, c["$type"] FROM c
   WHERE CONTAINS(c.id, "^2F") OR CONTAINS(c.id, "^5C")
      OR CONTAINS(c.id, "^3F") OR CONTAINS(c.id, "^23")
   ```

   `$type` это имя дискриминатора в JSON, которое EF записывает начиная с EF Core 9. EF Core 11 переименовал свойство модели в `Discriminator`, но в JSON имя по-прежнему `$type`. Проверка: ноль строк означает, что ни у одного сохраненного документа id не изменится. Тогда остается открытым только вопрос, могут ли эти символы содержать *новые* ключи, и к ним шаг 3 по-прежнему применим.

3. **Решите: оставить старое экранирование или перейти на исходные id.**
   Используйте такое правило:

   - Ключи могут содержать `/` или `\`: оставьте старое экранирование с помощью переключателя (шаг 4). Исходные id с этими символами нельзя сохранить в Cosmos DB, так что мигрировать некуда. Единственная альтернатива заключается в изменении самих значений ключей.
   - Ключи могут содержать только `?` или `#`: вы можете переписать id (шаг 5) и навсегда отказаться от старого экранирования. Это заодно устраняет ошибку с коллизиями.
   - Значения ключей могут вводить пользователи: учтите, что при включенном переключателе пользователь, отправивший буквальную строку `shoes^2Fred`, может перезаписать `shoes/red`. Если это важно, проверяйте ввод ключей так, чтобы он никогда не содержал `^`.

   Проверка: запишите решение для каждого типа сущности. Смешанному контейнеру может понадобиться и то, и другое.

4. **Если оставляете экранирование, включите переключатель до загрузки EF.**
   Провайдер читает переключатель один раз, в поле `static readonly` класса `JsonIdDefinition`. Самое надежное место для него это файл проекта, потому что MSBuild записывает его в `runtimeconfig.json`:

   ```xml
   <!-- EF Core 11.0, .NET 11 -->
   <ItemGroup>
     <RuntimeHostConfigurationOption Include="Microsoft.EntityFrameworkCore.EscapeIllegalCosmosIdCharacters"
                                     Value="true" />
   </ItemGroup>
   ```

   `AppContext.SetSwitch("Microsoft.EntityFrameworkCore.EscapeIllegalCosmosIdCharacters", true)` тоже работает, если это первая строка `Program.cs`, до создания любого `DbContext`. Проверяйте с помощью самого генератора id (шаг 6). Я протестировал на RC 1 и запись в `runtimeconfig.json`, и вызов `SetSwitch` при запуске, и оба варианта дали `o-1|shoes^2Fred`.

5. **Если переходите на исходные id, перепишите документы на месте.**
   Cosmos DB не умеет переименовывать `id`, поэтому каждый документ создается заново под новым id, а старый удаляется. У обоих документов один и тот же ключ секции, поэтому транзакционный пакет делает замену атомарной. Вычисляйте новый id самим EF Core 11, а не реализуйте формат заново: добавьте экземпляр, содержащий только ключ, в одноразовый контекст и прочитайте `__id`. Переписывайте через исходный JSON, а не через EF, потому что EF Core 11 больше не сохраняет свойства JSON, не отображенные в модели, и сохранение через EF их бы потеряло.

   ```csharp
   // EF Core 11.0 RC 1, Microsoft.Azure.Cosmos 3.x, .NET 11 RC 1
   // Run with the switch OFF, so EF generates the new ids.
   using var client = new CosmosClient(connectionString);
   var container = client.GetContainer("shop", "Orders");
   var query = new QueryDefinition(
       """
       SELECT * FROM c
       WHERE c["$type"] = "OrderLine"
         AND (CONTAINS(c.id, "^2F") OR CONTAINS(c.id, "^5C") OR CONTAINS(c.id, "^3F") OR CONTAINS(c.id, "^23"))
       """);

   await using var idContext = new ShopContext(connectionString); // never saved
   using var iterator = container.GetItemQueryStreamIterator(query);
   while (iterator.HasMoreResults)
   {
       using var page = await iterator.ReadNextAsync();
       page.EnsureSuccessStatusCode();
       var documents = JsonNode.Parse(page.Content)!["Documents"]!.AsArray();

       foreach (var doc in documents.Select(d => d!.AsObject()))
       {
           var oldId = (string)doc["id"]!;
           var line = new OrderLine
           {
               TenantId = (string)doc["TenantId"]!,
               OrderId = (string)doc["OrderId"]!,
               Sku = (string)doc["Sku"]!,
           };
           var entry = idContext.Add(line);
           var newId = (string)entry.Property("__id").CurrentValue!;
           entry.State = EntityState.Detached;

           if (newId == oldId) continue; // the key really contains "^2F"
           if (newId.Contains('/') || newId.Contains('\\'))
           {
               Console.WriteLine($"BLOCKED  {oldId} -> {newId}");
               continue;
           }

           Console.WriteLine($"{(apply ? "REWRITE " : "DRY RUN ")} {oldId} -> {newId}");
           if (!apply) continue;

           var etag = (string)doc["_etag"]!;
           foreach (var system in new[] { "_rid", "_self", "_etag", "_attachments", "_ts" })
               doc.Remove(system);
           doc["id"] = newId;

           using var body = new MemoryStream(JsonSerializer.SerializeToUtf8Bytes(doc));
           using var result = await container
               .CreateTransactionalBatch(new PartitionKey(line.TenantId))
               .CreateItemStream(body)
               .DeleteItem(oldId, new TransactionalBatchItemRequestOptions { IfMatchEtag = etag })
               .ExecuteAsync();

           if (!result.IsSuccessStatusCode)
               Console.WriteLine($"  FAILED {result.StatusCode}: {result.ErrorMessage}");
       }
   }
   ```

   Ключ читается из собственных свойств документа, а не восстанавливается из экранированного id. Именно это делает инструмент безопасным в случае коллизии: документ, сохраненный как `o-1|shoes^2Fred`, у которого `Sku` действительно равен `shoes^2Fred`, на EF 11 дает тот же id, поэтому пропускается. Я прогнал логику вычисления id офлайн на RC 1 на четырех тестовых документах. Она вывела `BLOCKED o-1|shoes^2Fred -> o-1|shoes/red`, `DRY RUN o-1|gift^23card -> o-1|gift#card`, `DRY RUN o-1|what^3F -> o-1|what?` и пропустила документ с буквальным `shoes^2Fred`. Сам пакет я не запускал ни на рабочей учетной записи, ни в эмуляторе, поэтому сначала выполните пробный прогон, а затем `--apply` на восстановленной копии базы данных. `IfMatchEtag` на удалении заставляет пакет завершиться ошибкой, а не потерять параллельную запись. Если это произошло, запустите инструмент еще раз. Проверка: запрос из шага 2 возвращает только документы `BLOCKED` или ничего.

6. **Зафиксируйте формат id тестом.**
   Генератор id срабатывает при `Add`, поэтому модульный тест может проверить формат без Cosmos DB:

   ```csharp
   // EF Core 11.0 RC 1, xUnit v3
   [Theory]
   [InlineData("shoes/red", "o-1|shoes^2Fred")] // expected with the switch on
   [InlineData("gift#card", "o-1|gift^23card")]
   public void Generated_id_matches_stored_documents(string sku, string expectedId)
   {
       using var db = new ShopContext("AccountEndpoint=https://localhost:8081/;AccountKey=dGVzdA==");
       var entry = db.Add(new OrderLine { TenantId = "t1", OrderId = "o-1", Sku = sku });
       Assert.Equal(expectedId, entry.Property("__id").CurrentValue);
   }
   ```

   Проверка: тест проходит в CI с тем же `runtimeconfig.json`, с которым поставляется приложение. Если кто-то удалит `RuntimeHostConfigurationOption`, упадет этот тест, а не продакшен.

## Проверка

После развертывания EF Core 11 проверьте на реальных данных три вещи:

- `await db.OrderLines.FindAsync("t1", "o-1", "shoes/red")` (ключ, который раньше экранировался) возвращает сущность, а не `null`.
- Запрос из шага 2 возвращает то же количество, что и раньше, если вы оставили переключатель, и ноль (не считая строк `BLOCKED`), если вы мигрировали.
- Запрос на дубликаты ничего не возвращает: `SELECT c.TenantId, c.OrderId, c.Sku, COUNT(1) AS n FROM c GROUP BY c.TenantId, c.OrderId, c.Sku`, затем ищите любое `n` больше 1. Так вы поймаете молчаливые дублирующие вставки из таблицы "Что ломается".

## План отката

Вариант с переключателем полностью обратим: откатите обновление пакета, и EF Core 10 будет генерировать те же id, что и всегда. Переписывание id повторным развертыванием не откатить. EF Core 10 снова генерирует экранированные id и не находит переписанные документы. Поэтому переписывание привязывает вас к EF Core 11. Если нужен путь назад, либо восстановите контейнер из резервной копии, сделанной перед переписыванием, либо разверните EF Core 11 с включенным переключателем (старые id при нем остаются валидными) и запустите инструмент в обратном направлении. Проверьте этот путь заранее, прежде чем на него полагаться.

## Подводные камни

- **У имени переключателя в обиходе два написания.** И issue, и комментарий в коде `JsonIdDefinition` называют его `Microsoft.EntityFrameworkCore.EscapeIllegalIdCharacters`. На самом деле код читает `Microsoft.EntityFrameworkCore.EscapeIllegalCosmosIdCharacters`, и то же имя указано в документе о критических изменениях. Я задал короткое имя в `runtimeconfig.json` на RC 1, и это ни на что не повлияло: id остались неэкранированными.
- **Позднее включение переключателя ничего не дает.** В моем эксперименте `AppContext.SetSwitch`, вызванный после того, как первый `DbContext` уже сгенерировал id, был проигнорирован, и следующий контекст все равно выдал `o-2|shoes/red`. С этим сталкиваются хостируемые приложения, которые задают переключатели из конфигурации после `builder.Build()`.
- **Id из одиночного ключа никогда не экранировались.** `Product` с `Id = "shoes/red"` всегда записывался как `shoes/red`, и на 10, и на 11, так что ограничение Cosmos DB на `/` к нему уже применялось. Изменение затрагивает только id, составленные из нескольких значений.
- **Свойства ключа секции не входят в id.** Проверяя свои ключи, не учитывайте свойства, которые вы передаете в `HasPartitionKey`. Их значения могут содержать что угодно, потому что провайдер отправляет их как ключ секции, а не в составе id.
- **Пакеты работают в пределах одной секции и ограничены 100 операциями.** Инструмент отправляет по одному пакету на документ, чтобы сбои оставались локальными. Если вы объединяете несколько документов в пакет, группируйте их по ключу секции и не превышайте лимит.

## Связанные материалы

- Инструмент переписывания опирается на тот же механизм, который EF Core 11 теперь использует для каждого `SaveChanges`: [EF Core 11 включает транзакционные пакеты Cosmos DB по умолчанию](/ru/2026/04/efcore-11-cosmos-transactional-batches/).
- Если вы перескакиваете сразу через несколько мажорных версий, в статье о [миграции с EF Core 6 на EF Core 11](/ru/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) перечислены остальные критические изменения, которые встретятся по пути.
- Еще одно умолчание EF Core 11, которое незаметно меняется при обновлении: [уровень совместимости SQL Server 150 против 160](/ru/2026/09/sql-server-compatibility-level-150-vs-160-what-changes-for-ef-core-11-queries/).
- Чтобы журналировать каждое точечное чтение и видеть, какие id EF запрашивает у Cosmos DB, самый легкий способ это [перехватчик EF Core](/ru/2026/09/what-is-an-ef-core-interceptor-and-when-do-i-need-one/).
- Если в списке на обновление есть и owned-типы в ваших документах Cosmos, см. [сложные типы против owned-сущностей в EF Core 11](/ru/2026/07/complex-types-vs-owned-entities-in-ef-core-11/).

## Источники

- [Критические изменения EF Core 11: недопустимые символы `id` в Cosmos больше не экранируются](https://learn.microsoft.com/ef/core/what-is-new/ef-core-11.0/breaking-changes#cosmos-no-id-escape)
- [dotnet/efcore#38244: генерируемые значения `id` могут совпадать, если значения ключа содержат escape-последовательности](https://github.com/dotnet/efcore/issues/38244)
- [dotnet/efcore#38245: не экранировать недопустимые символы id](https://github.com/dotnet/efcore/pull/38245)
- [`JsonIdDefinition.cs` на v11.0.0-rc.1.26425.128](https://github.com/dotnet/efcore/blob/v11.0.0-rc.1.26425.128/src/EFCore.Cosmos/Metadata/Internal/JsonIdDefinition.cs)
- [`JsonIdDefinitionFactory.cs` на v11.0.0-rc.1.26425.128](https://github.com/dotnet/efcore/blob/v11.0.0-rc.1.26425.128/src/EFCore.Cosmos/Metadata/Internal/JsonIdDefinitionFactory.cs)
- [Квоты службы Azure Cosmos DB: допустимые символы в значении ID](https://learn.microsoft.com/azure/cosmos-db/concepts-limits#per-item-limits)
- [Транзакционные пакетные операции в Azure Cosmos DB](https://learn.microsoft.com/azure/cosmos-db/transactional-batch)
- [Критические изменения EF Core 9: дискриминатор больше не включается в `id`](https://learn.microsoft.com/ef/core/what-is-new/ef-core-9.0/breaking-changes#cosmos-id-property-changes)
