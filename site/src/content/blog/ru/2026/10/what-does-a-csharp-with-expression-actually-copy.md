---
title: "Что на самом деле копирует выражение `with` в C# и почему вычисляемые свойства record не пересчитываются?"
description: "Выражение with вызывает сгенерированный компилятором метод <Clone>$ записи, который запускает конструктор копирования: он копирует каждое поле экземпляра и пропускает все инициализаторы. Поэтому свойства, инициализированные из других свойств, кешированные значения и идентификаторы Guid оказываются устаревшими. Измерения на .NET 10 с C# 14 и исправления, которые действительно работают."
pubDate: 2026-10-16
tags:
  - "csharp"
  - "csharp-14"
  - "records"
  - "dotnet-10"
  - "immutability"
lang: "ru"
translationOf: "2026/10/what-does-a-csharp-with-expression-actually-copy"
translatedBy: "claude"
translationDate: 2026-10-16
---

**Короткий ответ:** в C# 14 на .NET 10 (и во всех версиях с момента появления records в C# 9) выражение `a with { X = 1 }` для record-класса делает две вещи: вызывает сгенерированный компилятором метод `<Clone>$`, который вызывает конструктор копирования записи, а затем по порядку выполняет перечисленные вами аксессоры `init`. Конструктор копирования копирует **каждое поле экземпляра** байт в байт (поверхностная копия) и **не** запускает инициализаторы полей и свойств. Поэтому свойство вроде `public string FullName { get; } = $"{First} {Last}";` вычисляется один раз в конструкторе оригинала, копируется как сохранённое значение и никогда не пересчитывается. Делайте производные значения выражениями (`=> $"{First} {Last}"`) или сбрасывайте кеши в аксессорах `init` тех свойств, от которых они зависят.

Дальше в статье показано, что именно генерирует компилятор, какие виды "вычисляемых" членов переживают `with`, а какие нет, неприятный побочный эффект кеширования внутри record для равенства и паттерны, которые выдерживают проверку. Все выводы ниже получены из файловых приложений (`dotnet run probe.cs`) на SDK 10.0.302 и среде выполнения 10.0.10.

## Что компилятор генерирует для record

Возьмём обычный позиционный record:

```csharp
// .NET 10, C# 14
record Person(string First, string Last);
```

Помимо первичного конструктора, свойств, равенства и `ToString`, компилятор создаёт два копирующих члена. [Спецификация records](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-9.0/records.md#copy-and-clone-members) называет их "конструктором копирования" и методом "clone". Оба видны через рефлексию:

```csharp
// .NET 10, C# 14
using System.Reflection;

foreach (var m in typeof(Person).GetMethods(BindingFlags.Instance | BindingFlags.Public | BindingFlags.DeclaredOnly)
                                .Where(m => m.Name.Contains("Clone")))
    Console.WriteLine($"method: {m.Name} virtual={m.IsVirtual} returns {m.ReturnType.Name}");

foreach (var c in typeof(Person).GetConstructors(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic))
    Console.WriteLine($"ctor: ({string.Join(",", c.GetParameters().Select(p => p.ParameterType.Name))}) protected={c.IsFamily}");
```

Вывод:

```text
method: <Clone>$ virtual=True returns Person
ctor: (String,String) protected=False
ctor: (Person) protected=True
```

`<Clone>$` это имя, которое нельзя написать в C#, поэтому вызвать метод может только компилятор. Его тело просто `return new Person(this);`. Копирование происходит в защищённом конструкторе `Person(Person original)`, и спецификация точно описывает, что он делает: после вызова конструктора копирования базового типа (или `object()`) он "копирует значения всех полей экземпляра, неявно или явно объявленных в типе record", и он "не запускает инициализаторы полей и свойств экземпляра, присутствующие в объявлении record".

Значит, вот это:

```csharp
var b = a with { First = "Grace" };
```

приблизительно превращается в:

```csharp
var tmp = a.<Clone>$();   // new Person(a): field-by-field copy, no initializers
tmp.First = "Grace";       // the init accessor, legal here because the compiler emits it
var b = tmp;
```

Из этого преобразования напрямую следуют два вывода. Во-первых, ничто из написанного вами в теле record не выполняется при копировании, кроме аксессоров `init` тех членов, которые вы назвали. Во-вторых, эти аксессоры `init` выполняются после копирования, над экземпляром, который уже содержит все поля оригинала.

## Четыре способа написать "вычисляемое" свойство, четыре разных результата

Вот record с четырьмя членами, которые все выглядят производными от `First` и `Last`:

```csharp
// .NET 10, C# 14
record Name(string First, string Last)
{
    public string Init { get; } = $"{First} {Last}";   // property initializer
    public string Expr => $"{First} {Last}";            // expression-bodied
    private string? _cached;
    public string Cached => _cached ??= $"{First} {Last}"; // lazy cache in a field
}
```

И запуск, который обращается к кешу до копирования:

```csharp
var a = new Name("Ada", "Lovelace");
Console.WriteLine(a.Cached);              // fills the cache on a
var b = a with { First = "Grace" };
Console.WriteLine($"{b.Init} | {b.Expr} | {b.Cached}");
Console.WriteLine(b);
```

Вывод:

```text
Ada Lovelace
Ada Lovelace | Grace Lovelace | Ada Lovelace
Name { First = Grace, Last = Lovelace, Init = Ada Lovelace, Expr = Grace Lovelace, Cached = Ada Lovelace }
```

Верно только свойство с телом-выражением. Причины один в один соответствуют описанному выше преобразованию:

- **`Init { get; } = ...`** опирается на скрытое поле `<Init>k__BackingField`. Инициализатор выполнился один раз, внутри первичного конструктора `a`. Конструктор копирования скопировал резервное поле как строку и не перезапускал инициализатор. `First` потом изменился, но `Init` никто не переприсваивает.
- **`Expr => ...`** не имеет резервного поля. Это метод, который читает `First` и `Last` при каждом вызове, поэтому он отражает то, что хранит копия сейчас.
- **`Cached => _cached ??= ...`** самый коварный случай. Если вызвать `with` *до* того, как кто-то прочитал `Cached` у оригинала, `_cached` всё ещё `null`, копируется как `null`, и копия вычисляет правильное значение. Если кеш оригинала уже заполнен, копия наследует `"Ada Lovelace"`, и `??=` не срабатывает. Ошибка зависит от того, прочитал ли свойство какой-то посторонний путь выполнения, и воспроизвести её мучительно.

То же происходит со всем, что создаёт инициализатор поля. Record с `public Guid Id { get; } = Guid.NewGuid();` сохраняет **один и тот же** `Id` в каждой копии `with`. Я убедился, что инициализатор просто не выполняется, с помощью счётчика:

```csharp
// .NET 10, C# 14
var t = new Tracked("x");
var t2 = t with { Value = "y" };
Console.WriteLine($"initializer runs: {Counter.Count}, stamp same: {t.Stamp == t2.Stamp}");

static class Counter { public static int Count; }
record Tracked(string Value)
{
    public long Stamp { get; } = ++Counter.Count;
}
```

```text
initializer runs: 1, stamp same: True
```

Одно создание, один запуск инициализатора, два экземпляра. Если вы используете records для событий или команд с генерируемым ID или меткой времени, `with` даёт второй объект, который выдаёт себя за то же самое событие.

## Ловушка равенства: скрытые поля участвуют в `==`

Равенство records тоже синтезируется из полей экземпляра, включая приватные. Поэтому устаревшая копия из примера выше не равна заново созданному record с теми же видимыми данными:

```csharp
var c = new Name("Grace", "Lovelace");
Console.WriteLine(b == c); // False: b.Init and b._cached still say "Ada Lovelace"
```

Хуже того, ленивый кеш делает равенство зависимым от *истории чтения*, даже без всякого `with`:

```csharp
// .NET 10, C# 14
var x = new Name2("Ada", "Lovelace");
var y = new Name2("Ada", "Lovelace");
Console.WriteLine(x == y);   // True
_ = x.FullName;              // only reads a property
Console.WriteLine(x == y);   // False

record Name2(string First, string Last)
{
    private string? _fullName;
    public string FullName => _fullName ??= $"{First} {Last}";
}
```

```text
True
False
```

Чтение геттера изменило результат `==`. Если такие records служат ключами словаря, элементами множества или сравниваются в проверках тестов, вы получите сбои, которые исчезают, стоит добавить `Console.WriteLine` для отладки. Это самый сильный аргумент против кеширования внутри record вообще.

## Копия поверхностная, до самого низа

Конструктор копирования копирует значения полей. Для полей ссылочных типов значение это ссылка, поэтому обе записи указывают на один и тот же объект:

```csharp
// .NET 10, C# 14
var o = new Order(1, new List<string> { "apple" });
var o2 = o with { Id = 2 };
o2.Items.Add("pear");
Console.WriteLine($"o.Items: {string.Join(",", o.Items)} same list: {ReferenceEquals(o.Items, o2.Items)}");

record Order(int Id, List<string> Items);
```

```text
o.Items: apple,pear same list: True
```

То же верно для поля `Lazy<T>` (обе копии делят уже вычисленный `Lazy`), для `StringBuilder` или вложенного изменяемого класса. Record неизменяем лишь настолько, насколько неизменяемо его самое изменяемое поле. Предпочитайте `ImmutableArray<T>` или `IReadOnlyList<T>` поверх массива, который вы никогда не меняете, и считайте `with` операцией "скопировать верхний уровень".

## Наследование: `with` сохраняет тип времени выполнения

`<Clone>$` виртуальный, и каждый производный record переопределяет его с ковариантным возвращаемым типом. `with` через переменную базового типа создаёт производный тип:

```csharp
// .NET 10, C# 14
Person p = new Student("Alan", "Turing", "King's");
var q = p with { First = "Alonzo" };
Console.WriteLine(q.GetType().Name); // Student

record Person(string First, string Last);
record Student(string First, string Last, string College) : Person(First, Last);
```

Рефлексия для `Student` показывает `<Clone>$ returns Student`. Обычно это то, что нужно, но это значит, что `with` по базовой ссылке копирует состояние, существующее только в производном типе (здесь `College`) и недоступное вызывающему коду, включая любые устаревшие кешированные поля, объявленные в производном record.

Для `sealed record` компилятор делает конструктор копирования `private`, а `<Clone>$` невиртуальным (проба напечатала `sealed copy ctor private: True; clone virtual: False`).

## Что выражению `with` разрешено присваивать

Поскольку `with` выполняет аксессоры после клонирования, оно может задавать только члены с аксессором `set` или `init`, доступные в месте вызова. Попытка "починить" устаревшее вычисляемое свойство присваиванием не компилируется:

```csharp
// .NET 10, C# 14
record A(int X) { public int Computed { get; } = X * 2; }

var b = new A(1) with { Computed = 3 };
// error CS0200: Property or indexer 'A.Computed' cannot be assigned to -- it is read only
```

`with` для обычного класса отвергается сразу, потому что у класса нет `<Clone>$`:

```text
error CS8858: The receiver type 'Svc' is not a valid record type and is not a struct type.
```

Начиная с C# 10 `with` работает также со структурами (включая `record struct`), кортежами и анонимными типами. Для них нет ни метода clone, ни конструктора копирования: значение копируется так, как копирует любое присваивание структуры, а затем присваиваются перечисленные члены. [Документация по выражению `with`](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/operators/with-expression) прямо говорит, что семантику копирования для структурных типов настроить нельзя.

Члены `required` не заставляют повторять их в `with`. Синтезированный конструктор копирования помечен `[SetsRequiredMembers]`, поэтому `r with { }` для record с `required string Name` компилируется и копирует `Name`. Если `required` в инициализаторах вызывает у вас затруднения, [разбор CS9035](/ru/2026/07/fix-cs9035-required-member-must-be-set-in-the-object-initializer/) рассматривает сторону инициализатора объекта.

## Исправления, которые действительно работают

### 1. Вычислять при обращении (ответ по умолчанию)

```csharp
// .NET 10, C# 14
record Name(string First, string Last)
{
    public string FullName => $"{First} {Last}";
}
```

Нет резервного поля, нечего копировать, нечему устаревать, и ничего лишнего в `Equals`/`GetHashCode`. Собственная рекомендация Microsoft на странице о `with` такая же: вычисляемые свойства в records "следует вычислять при обращении, а не инициализировать при создании экземпляра". Интерполяция двух строк дёшева; измеряйте, прежде чем решать, что это не так.

### 2. Проверять или пересчитывать в аксессорах `init`

Аксессоры `init` это единственная часть вашего кода, которая действительно выполняется во время `with`. [Ключевое слово `field`](/ru/2025/04/c-14-the-field-keyword-and-field-backed-properties/) из C# 14 позволяет легко разместить там логику без объявления резервного поля. Проверка работает так, как вы надеетесь:

```csharp
// .NET 10, C# 14
record Person(string First, string Last)
{
    public string Last { get; init => field = string.IsNullOrEmpty(value)
        ? throw new ArgumentException("Last required")
        : value; } = Last;
}

var bad = new Person("Ada", "Lovelace") with { Last = "" }; // throws ArgumentException: Last required
```

Если значение действительно дорого вычислять и кеш необходим, инвалидируйте кеш из аксессоров `init` входных свойств и исключите кеш из равенства:

```csharp
// .NET 10, C# 14
record Name(string First, string Last)
{
    private string? _fullName;
    public string First { get; init { field = value; _fullName = null; } } = First;
    public string Last  { get; init { field = value; _fullName = null; } } = Last;
    public string FullName => _fullName ??= $"{First} {Last}";

    public virtual bool Equals(Name? other) =>
        other is not null && EqualityContract == other.EqualityContract
        && First == other.First && Last == other.Last;
    public override int GetHashCode() => HashCode.Combine(First, Last);
}
```

В этой версии `a with { First = "Grace" }` печатает `Grace Lovelace`, даже если `a.FullName` читали раньше, а `b == new Name("Grace", "Lovelace")` равно `True`. Цена в том, что `Equals` и `GetHashCode` теперь поддерживаются вручную, и компилятор не предупредит, если вы добавите свойство и забудете включить его.

### 3. Написать собственный конструктор копирования

Конструктор копирования можно объявить самостоятельно и копировать только то, что должно сохраниться:

```csharp
// .NET 10, C# 14
record Fixed(string First, string Last)
{
    private string? _full;
    public string FullName => _full ??= $"{First} {Last}";

    protected Fixed(Fixed original)
    {
        First = original.First;
        Last = original.Last;
        // _full deliberately not copied
    }
}
```

Это работает (`f with { First = "Grace" }` даёт `Grace Lovelace` после того, как кеш оригинала был заполнен), и это документированный способ глубокого копирования списка. Но у способа и самые острые углы:

- Теперь вы отвечаете за копирование **каждого** поля. Добавите свойство через месяц, забудете этот конструктор, и `with` молча сбросит его в `default`.
- В производном record нужно вызвать конструктор копирования базового типа. Если его пропустить, получите две ошибки: `CS1729: 'Base' does not contain a constructor that takes 0 arguments` и `CS8868: A copy constructor in a record must call a copy constructor of the base, or a parameterless object constructor if the record inherits from object.` Исправление: `protected Derived(Derived other) : base(other) { ... }`.
- Он должен быть `public` или `protected`, если только record не sealed.
- Он ничего не делает для `Equals`: поле кеша по-прежнему делает `==` зависимым от истории чтения.

Используйте его для глубокого копирования коллекций, а не как механизм инвалидации кеша.

### 4. Не помещать идентичность в инициализатор

Для ID и меток времени, которые должны быть уникальны для каждого экземпляра, не генерируйте их в инициализаторе свойства в record, к которому будете применять `with`. Либо передавайте их явно (`evt with { Id = Guid.NewGuid() }`), либо создавайте новые события через фабрику вместо `with`. Копировать событие и сохранять его ID это ровно то, для чего `with` предназначен.

## Чек-лист для типов record, к которым применяется `with`

- Каждое производное значение задано выражением или пересчитывается из аксессоров `init`.
- Никаких приватных полей-кешей, если вы не переопределяете также `Equals` и `GetHashCode`.
- Никаких изменяемых коллекций, либо собственный конструктор копирования, который их клонирует.
- Никаких инициализаторов `= Guid.NewGuid()` или `= DateTime.UtcNow` в типах, которые копируются.
- Производные records, объявляющие конструктор копирования, вызывают `base(original)`.

Если вы решаете, должен ли тип вообще быть record, [матрица решений record, class и struct](/ru/2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix/) разбирает компромиссы, а аспект EF Core (копия через `with` это экземпляр, которого трекер изменений никогда не видел) описан в статье [как правильно использовать records с EF Core 11](/ru/2026/04/how-to-use-records-with-ef-core-11-correctly/). Разработчики на Dart сталкиваются с тем же вопросом поверхностной копии в `copyWith`, он обсуждается в [Dart records против классов Freezed](/ru/2026/05/dart-records-vs-freezed-classes/).

## Связанные материалы

- [Record, class и struct в C#: матрица решений](/ru/2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix/)
- [Как правильно использовать records с EF Core 11](/ru/2026/04/how-to-use-records-with-ef-core-11-correctly/)
- [C# 14: ключевое слово `field` и свойства с резервным полем](/ru/2025/04/c-14-the-field-keyword-and-field-backed-properties/)
- [Исправление CS9035: обязательный член должен быть задан в инициализаторе объекта](/ru/2026/07/fix-cs9035-required-member-must-be-set-in-the-object-initializer/)

## Источники

- [The `with` expression, C# reference (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/operators/with-expression)
- [Records, nondestructive mutation (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/builtin-types/record#nondestructive-mutation)
- [Records proposal, "Copy and Clone members" (dotnet/csharplang)](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-9.0/records.md#copy-and-clone-members)
- [The `field` keyword (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/keywords/field)
