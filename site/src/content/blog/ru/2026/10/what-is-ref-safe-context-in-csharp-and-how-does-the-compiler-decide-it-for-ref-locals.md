---
title: "Что такое ref-safe-context в C# и как компилятор определяет его для ref-локальных переменных"
description: "ref-safe-context это область, в которой ссылка на переменную остаётся валидной. Разбираем четыре контекста, правило, фиксирующее контекст ref-локальной переменной по её инициализатору, почему ref-переназначение никогда не может ни расширить, ни сузить контекст, и ошибки CS8157, CS8168, CS8374 и CS9079, которые из этого следуют, с выводом компилятора C# 14 на .NET 10 и .NET 11 RC1."
pubDate: 2026-10-15
template: how-to
tags:
  - "csharp"
  - "csharp-14"
  - "dotnet-11"
  - "ref-locals"
  - "span"
  - "compiler-errors"
lang: "ru"
translationOf: "2026/10/what-is-ref-safe-context-in-csharp-and-how-does-the-compiler-decide-it-for-ref-locals"
translatedBy: "claude"
translationDate: 2026-10-15
---

Коротко: ref-safe-context (контекст безопасности ссылки) это область кода, в которой ссылка (`ref`-локальная переменная, `ref`-возврат, `ref`-поле) на данную переменную гарантированно указывает на живую память. Компилятор C# назначает каждой переменной один из четырёх контекстов, от самого узкого к самому широкому: declaration-block, function-member, return-only и caller-context. У `ref`-локальной переменной нет собственного контекста. Она копирует ref-safe-context выражения, которым была инициализирована, этот контекст фиксирован на всё время её жизни, и каждый последующий `r = ref other;` должен указывать на то, чей контекст не уже. Это единственное правило объясняет, почему `ref`-локальную переменную, инициализированную из локальной переменной стека, нельзя вернуть, даже если потом переназначить её на элемент массива.

Все результаты в этой статье получены на реальных сборках: .NET 10 SDK 10.0.302 с `<LangVersion>14</LangVersion>` и те же файлы, пересобранные на .NET 11 RC1 SDK (11.0.100-rc.1.26425.128). Диагностика на обеих версиях идентична и вставлена из вывода компилятора, а не пересказана.

## Зачем компилятору вообще отслеживать "контекст"

`ref` в C# это управляемый указатель. Он может указывать в кучу (элемент массива, поле экземпляра класса), в статическую память или в кадр стека (локальная переменная, параметр). Куча и статическая память живут дольше любого вызова метода. Кадр стека умирает, когда метод возвращается. Если бы метод мог отдать `ref` на одну из собственных локальных переменных, вызывающий код держал бы указатель на мёртвый кадр, то есть ровно тот баг use-after-free, от которого `ref` и должен был защищать.

C# решает это не проверкой во время выполнения, а статически: каждая переменная получает ref-safe-context, описывающий, как далеко может уйти ссылка на неё, а каждое место, где ссылка сохраняется или возвращается, проверяет, что контекст объекта ссылки (referent) не уже контекста самой ссылки. Стандарт C# формулирует это одним предложением в [разделе 9.7.2](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/language-specification/variables#972-ref-safe-contexts): "The referent of a reference variable shall have a ref-safe-context that is at least as wide as the ref-safe-context of the reference variable itself." То есть объект, на который указывает ссылочная переменная, должен иметь ref-safe-context не уже, чем у самой этой переменной.

Есть родственное понятие, safe-context (контекст безопасности значения), которое относится к значениям типов `ref struct`, таких как `Span<T>`. Ref-safe-context отвечает на вопрос "как долго валидна ссылка на эту переменную?" Safe-context отвечает на вопрос "как долго валидно значение, хранящееся в этой переменной (а оно само содержит ссылки)?" Большая часть статьи посвящена первому, но они пересекаются в индексаторах `Span<T>`, о чём ниже.

## Четыре контекста, от узкого к широкому

| Контекст | Что его имеет | Можно вернуть через ref? |
| --- | --- | --- |
| declaration-block | Обычные локальные переменные, ограниченные блоком, в котором объявлены | Нет |
| function-member | Параметры-значения, параметры `out`, `this` в методе структуры, локальные переменные и параметры `scoped ref` | Нет |
| return-only | Параметры `ref` и `in` | Да, только через `return ref` |
| caller-context | Элементы массивов, поля экземпляров классов, статические поля, поля, достигаемые через параметры `ref` | Да |

Две детали легко упустить. Во-первых, declaration-block действительно определяется блоком: локальная переменная, объявленная в теле `if`, имеет более узкий контекст, чем объявленная в начале метода. Во-вторых, return-only существует для того, чтобы параметр `ref` можно было вернуть (`return ref p;` допустимо), но нельзя было сохранить там, где он переживёт вызов, например в `ref`-поле `ref struct`, переданной вызывающим кодом. Этот уровень был добавлен в C# 11 в рамках [улучшений низкоуровневых структур](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/proposals/csharp-11.0/low-level-struct-improvements).

Базовый случай в коде, каждый метод скомпилирован под C# 14:

```csharp
// .NET 10 SDK 10.0.302, C# 14 (same result on .NET 11 RC1)
class Contexts
{
    int[] _arr = new int[10];
    static int s_counter;

    // declaration-block: error CS8168
    static ref int FromLocal() { int v = 5; return ref v; }

    // function-member (value parameter): error CS8157 once aliased
    static ref int FromValueParam(int p) { ref int r = ref p; return ref r; }

    // return-only (ref parameter): OK
    static ref int FromRefParam(ref int p) { ref int r = ref p; return ref r; }

    // caller-context (array element): OK
    ref int FromArray() { ref int r = ref _arr[3]; return ref r; }

    // caller-context (static field): OK
    static ref int FromStatic() { ref int r = ref s_counter; return ref r; }
}
```

Две ошибки:

```text
error CS8168: Cannot return local 'v' by reference because it is not a ref local
error CS8157: Cannot return 'r' by reference because it was initialized to a value that cannot be returned by reference
```

Внимательно прочитайте формулировку CS8157: "because it was initialized to" (потому что она была инициализирована значением). Компилятор смотрит не на то, на что `r` указывает в момент `return`, а на то, чем `r` была инициализирована.

## Как ref-локальная переменная получает контекст

Правило стандарта для локальных переменных ([раздел 9.7.2.2](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/language-specification/variables#9722-local-variable-ref-safe-context)) состоит из двух строк:

- Если `v` является ссылочной переменной, её ref-safe-context совпадает с ref-safe-context её инициализирующего выражения.
- В остальных случаях её ref-safe-context равен declaration-block.

Итак, компилятор определяет контекст `ref`-локальной переменной ровно в одном месте: в объявлении. Для выражения-инициализатора контекст вычисляется по таким правилам:

1. Локальная переменная или параметр-значение: собственный контекст (declaration-block или function-member).
2. Параметр `ref` или `in`: return-only.
3. Поле `e.F` экземпляра класса, элемент массива, статическое поле: caller-context.
4. Поле `e.F` структуры: контекст `e`. Поле локальной переменной-структуры это declaration-block, поле `this` внутри метода структуры это function-member.
5. Условное выражение `c ? ref a : ref b`: более узкий из контекстов `a` и `b`.
6. Вызов метода, свойства или индексатора, возвращающего `ref`: самый узкий из caller-context и ref-safe-context каждого аргумента `ref` (плюс safe-context каждого аргумента, включая получателя), при этом аргументы, привязанные к параметрам `scoped` и `out`, пропускаются.

Правило 6 удивляет больше всего, потому что из него следует, что совершенно безобидный вспомогательный метод может "отравить" `ref`-локальную переменную:

```csharp
// .NET 10 SDK 10.0.302, C# 14
static ref int Pick(ref int a) => ref a;

static ref int ThroughHelper()
{
    int v = 5;
    ref int r = ref Pick(ref v); // r inherits v's declaration-block context
    return ref r;                // error CS8157
}
```

Сам `Pick` корректен, он возвращает собственный `ref`-параметр. Но компилятор не заглядывает внутрь `Pick`. Он видит только сигнатуру: "возвращает `ref`, который может быть любым из моих `ref`-аргументов", поэтому контекст результата равен контексту самого узкого аргумента, а этот аргумент является локальной переменной. Так спецификация не даёт "отмыть" ссылку на стек через вызов метода.

Выход, если вспомогательный метод действительно никогда не возвращает этот аргумент, это сказать об этом явно с помощью `scoped`:

```csharp
// .NET 10 SDK 10.0.302, C# 14
static ref int PickSecond(scoped ref int a, ref int b) => ref b;

static ref int Fine(ref int b)
{
    int v = 5;
    ref int r = ref PickSecond(ref v, ref b); // only b contributes: return-only
    return ref r;                             // OK
}
```

Параметр `scoped ref` нельзя ни вернуть, ни захватить внутри вызываемого метода, поэтому он больше не влияет на контекст результата. У условного оператора такой лазейки нет:

```csharp
// .NET 10 SDK 10.0.302, C# 14
ref int Either(bool f)
{
    int v = 1;
    ref int r = ref f ? ref _arr[0] : ref v; // narrowest wins: declaration-block
    return ref r;                            // error CS8157
}
```

## Ref-переназначение не может ни расширить, ни сузить контекст

Начиная с C# 7.3 `ref`-локальную переменную можно перенаправить на другой объект через `r = ref other;`. Правило из [раздела 9.7.2.9](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/language-specification/variables#9729-limitations-on-reference-variables) звучит так: "For a ref reassignment `e1 = ref e2`, the ref-safe-context of `e2` shall be at least as wide a context as the ref-safe-context of `e1`." Иначе говоря, ref-safe-context `e2` должен быть не уже, чем у `e1`. Контекст самой локальной переменной в результате не меняется. Из этого следуют последствия в обе стороны.

**Сужение приводит к ошибке.** Инициализируем из элемента массива, затем пробуем указать на локальную переменную:

```csharp
// .NET 10 SDK 10.0.302, C# 14
ref int Narrowing()
{
    ref int r = ref _arr[0]; // caller-context
    int v = 1;
    r = ref v;               // error CS8374
    return ref r;
}
```

```text
error CS8374: Cannot ref-assign 'v' to 'r' because 'v' has a narrower escape scope than 'r'.
```

То же происходит между вложенными блоками, и именно с этим вариантом люди сталкиваются в реальных циклах:

```csharp
// .NET 10 SDK 10.0.302, C# 14
static void NestedBlock()
{
    int outer = 1;
    ref int r = ref outer;   // declaration-block of the method body
    {
        int inner = 2;
        r = ref inner;       // error CS8374: inner's block is narrower
    }
}
```

**Расширение разрешено, но не помогает.** Инициализируем из локальной переменной, затем указываем на элемент массива. Переназначение компилируется. Возврат нет:

```csharp
// .NET 10 SDK 10.0.302, C# 14
ref int Widening()
{
    int v = 1;
    ref int r = ref v;   // declaration-block, fixed forever
    r = ref _arr[0];     // OK: caller-context is wider
    return ref r;        // error CS8157: r was *initialized* to a local
}
```

Анализ намеренно не учитывает поток выполнения. Компилятор не отслеживает, что `r` сейчас указывает на кучу. Он знает только объявленный контекст, а это declaration-block.

**Ловушка return-only.** Параметр `ref` имеет контекст return-only, который уже, чем caller-context. Поэтому следующий код не компилируется, причём с другим кодом ошибки:

```csharp
// .NET 10 SDK 10.0.302, C# 14
ref int FieldThenParam(ref int p)
{
    ref int r = ref _arr[0]; // caller-context
    r = ref p;               // error CS9079
    return ref r;
}
```

```text
error CS9079: Cannot ref-assign 'p' to 'r' because 'p' can only escape the current method through a return statement.
```

И `_arr[0]`, и `p` по отдельности можно вернуть, но их сочетание отвергается. Во всех таких случаях исправление одно и то же: инициализируйте `ref`-локальную переменную **самым узким** объектом из тех, на которые она будет указывать, а затем переназначайте на более широкие.

```csharp
// .NET 10 SDK 10.0.302, C# 14
ref int ParamThenField(ref int p, bool useField)
{
    ref int r = ref p;               // return-only
    if (useField) r = ref _arr[0];   // caller-context is wider: OK
    return ref r;                    // OK: return-only is returnable
}
```

## Локальные переменные `scoped ref`: осознанный выбор более узкого контекста

`ref`-локальную переменную можно и намеренно сузить. Объявление `scoped ref` даёт ей контекст function-member независимо от инициализатора:

```csharp
// .NET 10 SDK 10.0.302, C# 14
ref int ScopedLocal()
{
    scoped ref int r = ref _arr[0]; // function-member, despite caller-context initializer
    return ref r;                   // error CS8157
}
```

Сам по себе это выглядит бессмысленно. Польза появляется, когда локальную переменную позже переназначают на что-то более узкое. Сравните два метода ниже, отличающиеся только ключевым словом `scoped`:

```csharp
// .NET 10 SDK 10.0.302, C# 14
void Unscoped()
{
    ref int r = ref _arr[0]; // caller-context
    int v = 1;
    r = ref v;               // error CS8374
    r = 5;
}

void Scoped()
{
    scoped ref int r = ref _arr[0]; // function-member
    int v = 1;
    r = ref v;                      // OK: v's block is the method body
    r = 5;
}
```

Воспринимайте `scoped` как документированный способ сказать "эта ссылка никогда не покидает метод", что открывает переназначения, которые запретил бы выведенный контекст. То же ключевое слово у локальной переменной типа `ref struct` (`scoped Span<int> s`) сужает уже её safe-context, что не даёт её содержимому выйти за пределы метода.

## Структуры, `this` и `[UnscopedRef]`

Внутри метода экземпляра структуры `this` является неявным параметром `scoped ref`, поэтому его контекст это function-member, как и у всех его полей (правило 4). Именно поэтому структура не может вернуть через ref собственное поле:

```csharp
// .NET 10 SDK 10.0.302, C# 14
using System.Diagnostics.CodeAnalysis;

struct Counter
{
    int _n;

    public ref int Bad() => ref _n;                 // error CS8170
    [UnscopedRef] public ref int Good() => ref _n;  // OK: this widened to return-only

    static ref int UseGood()
    {
        Counter c = default;
        ref int r = ref c.Good(); // receiver c is a local: declaration-block
        return ref r;             // error CS8157
    }
}
```

```text
error CS8170: Struct members cannot return 'this' or other instance members by reference
```

`[UnscopedRef]` расширяет `this` на один уровень, от function-member до return-only, чего достаточно для `return ref _n`. Но это не делает результат безопасным для кучи. В месте вызова `c.Good()` это вызов, возвращающий `ref`, с получателем, переданным по `ref`, поэтому действует правило 6, и результат наследует declaration-block контекст локальной переменной `c`. Возвращённая ссылка живёт ровно столько, сколько структура, на которую она указывает, и это абсолютно правильно.

## Span: где ref-safe-context встречается с safe-context

У `Span<T>` есть индексатор, возвращающий `ref`, поэтому `ref span[i]` тоже подчиняется правилу 6. Получатель вносит свой **safe-context**, а safe-context span зависит от того, откуда взялась его память:

```csharp
// .NET 10 SDK 10.0.302, C# 14
static ref int FromStackSpan()
{
    Span<int> local = stackalloc int[4]; // safe-context: function-member
    ref int r = ref local[0];
    return ref r;                        // error CS8157
}

static ref int FromHeapSpan()
{
    Span<int> local = new int[4];        // safe-context: caller-context
    ref int r = ref local[0];
    return ref r;                        // OK
}
```

Два метода отличаются только инициализатором `local`, и компилируется лишь один. У параметра-span safe-context равен caller-context, поэтому классический шаблон "найти элемент по ссылке" допустим без всяких аннотаций:

```csharp
// .NET 10 SDK 10.0.302, C# 14
static ref int MaxRef(Span<int> values)
{
    ref int best = ref values[0];        // caller-context via the span parameter
    for (int i = 1; i < values.Length; i++)
        if (values[i] > best) best = ref values[i]; // same context: OK
    return ref best;
}

int[] data = { 3, 9, 4 };
MaxRef(data) = 0;
Console.WriteLine(string.Join(",", data)); // 3,0,4
```

Каждое переназначение внутри цикла берёт элемент из того же span, поэтому контексты никогда не конфликтуют. К такой форме и стоит стремиться: один источник, один контекст, переназначайте свободно.

## Как читать коды ошибок

Когда вы натыкаетесь на одну из этих ошибок, её код подсказывает, какая сторона правила нарушена:

1. **CS8168** ("not a ref local"): вы применили `return ref` к обычной локальной переменной или параметру-значению. Верните значение или перенесите хранилище в кучу.
2. **CS8157** ("was initialized to a value that cannot be returned"): инициализатор `ref`-локальной переменной имел контекст уже, чем return-only. Смотрите на инициализатор, а не на последнее переназначение. Проверьте вспомогательные вызовы на локальные `ref`-аргументы и пометьте не выходящие за пределы метода параметры как `scoped`.
3. **CS8374** ("narrower escape scope"): переназначение попыталось сузить контекст локальной переменной. Сначала инициализируйте самым узким объектом или объявите локальную переменную в том же блоке, что и объект ссылки.
4. **CS9079** ("can only escape the current method through a return statement"): частный случай CS8374, когда новый объект ссылки это параметр `ref` или `in` (return-only), а локальная переменная имела caller-context. Инициализируйте её из параметра.
5. **CS8170**: структура возвращает ссылку на собственное поле. Добавьте `[UnscopedRef]`, если вызывающий код готов к тому, что результат привязан к времени жизни самой структуры.

## О чём стоит знать дополнительно

- `ref`-локальные переменные нельзя захватывать лямбдами и локальными функциями, и они не могут быть живыми через `await` или `yield return`. Это отдельное ограничение из раздела 9.7.2.9, а не ошибка контекста, но оно часто встречается при том же рефакторинге.
- Параметры `out` неявно являются `scoped ref` по правилам безопасности ссылок C# 11, поэтому `return ref outParam;` завершается ошибкой `error CS9075: Cannot return a parameter by reference 'o' because it is scoped to the current method`, хотя `return ref refParam;` работает. Понижение `<LangVersion>` старого поведения не возвращает: с `<LangVersion>10</LangVersion>` в проекте `net10.0` я получил ту же CS9075, потому что компилятор применяет новые правила всякий раз, когда целевая среда выполнения поддерживает `ref`-поля. Пометьте параметр как `[UnscopedRef] out int o`, если это действительно нужно.
- Параметры `in` это return-only, как и параметры `ref`, но только в виде `ref readonly`. [Статья о параметрах `ref readonly`](/ru/2023/10/csharp-ref-readonly-parameters/) рассказывает, когда выбирать какой.
- Компилятор консервативен. Правило 6 исходит из того, что метод, возвращающий `ref`, может вернуть любой из своих `ref`-аргументов. Если ваш метод этого не делает, `scoped` это не обходной путь, а правильный, документированный контракт.
- Небезопасный код выходит из-под проверок. Внутри блоков `unsafe` можно брать указатели на локальные переменные, и компилятор не отслеживает их время жизни. [Переработка `unsafe` в C# 16 как контракта вызывающей стороны](/ru/2026/05/csharp-16-unsafe-keyword-caller-contract/) как раз делает эту границу явной.

## Связанные материалы

- Если `Span<T>` для вас в новинку, начните со статьи [что такое `Span<T>` и когда он действительно ускоряет код](/ru/2026/06/what-is-span-and-when-does-it-make-my-code-faster/).
- Чтобы выбрать форму коллекции, прежде чем думать о временах жизни, см. [List vs Span vs ReadOnlySpan в C#](/ru/2026/05/list-vs-span-vs-readonlyspan-in-csharp/).
- C# 14 также изменил привязку span; [критическое изменение в разрешении перегрузок со span](/ru/2026/05/fix-csharp-14-overload-resolution-breaking-change-with-spans/) объясняет сюрпризы с `MemoryExtensions`.
- [Неявные преобразования span в C# 14](/ru/2025/04/implicit-span-conversions-in-c-14-first-class-support-for-span-and-readonlyspan/) описывают новые преобразования на уровне языка, благодаря которым массивы передаются в параметры span, как `MaxRef` выше, в большем числе мест, включая получателей методов расширения.

## Источники

- [C# standard, section 9.7.2 Ref safe contexts](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/language-specification/variables#972-ref-safe-contexts), включая 9.7.2.2 (локальные переменные), 9.7.2.6 (вызов функции) и 9.7.2.9 (ref-переназначение).
- [C# standard, section 9.7.3 The scoped modifier](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/language-specification/variables#973-the-scoped-modifier).
- [Low-level struct improvements](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/proposals/csharp-11.0/low-level-struct-improvements), предложение C# 11, в котором появились return-only, `scoped` и `[UnscopedRef]`.
- [Reference variables](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/statements/declarations#reference-variables) и [`ref` structure types](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/builtin-types/ref-struct) в справочнике по языку C#.
