---
title: "Fix: CA1070 \"Do not declare event fields as virtual\""
description: "CA1070 dispara em eventos do tipo campo declarados virtual. Remova o virtual, deixe o evento não virtual e faça as classes derivadas sobrescreverem um protected virtual OnXxx."
pubDate: 2026-08-29
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "csharp"
  - "analyzers"
  - "events"
lang: "pt-br"
translationOf: "2026/08/fix-ca1070-do-not-declare-event-fields-as-virtual"
translatedBy: "claude"
translationDate: 2026-08-29
---

CA1070 dispara quando um evento do tipo campo carrega o modificador `virtual`. A correção é remover `virtual` e dar às classes derivadas um método disparador `protected virtual void OnThresholdReached(...)` para sobrescrever. Isso não é preciosismo de estilo: se alguma coisa sobrescrever esse evento virtual, o compilador entrega à classe base e à classe derivada dois campos de apoio privados separados, e o disparo feito pela classe base não invoca nada, em silêncio.

O texto do diagnóstico que você está procurando:

```text
warning CA1070: Event 'ThresholdReached' should not be declared virtual
```

Tudo abaixo foi verificado no SDK `10.0.302` (.NET 10, C# 14), com os analisadores que já vêm no SDK, e contra o código-fonte de `DoNotDeclareEventFieldsAsVirtual` em `dotnet/sdk`.

## O dotnet build reporta CA1070?

Não. A severidade padrão é sugestão, não aviso, porque o analisador é declarado com `RuleLevel.IdeSuggestion`:

```csharp
// dotnet/sdk, Microsoft.CodeQuality.Analyzers/QualityGuidelines/DoNotDeclareEventFieldsAsVirtual.cs
internal static readonly DiagnosticDescriptor Rule = DiagnosticDescriptorHelper.Create(
    RuleId,
    CreateLocalizableResourceString(nameof(DoNotDeclareEventFieldsAsVirtualTitle)),
    CreateLocalizableResourceString(nameof(DoNotDeclareEventFieldsAsVirtualMessage)),
    DiagnosticCategory.Design,
    RuleLevel.IdeSuggestion,
    ...
```

Diagnósticos de nível sugestão aparecem no Visual Studio, no Rider e no `dotnet format`, mas o `dotnet build` não os imprime e `TreatWarningsAsErrors` não os alcança. Um projeto cheio de eventos virtuais compila assim:

```text
    0 Warning(s)
    0 Error(s)
```

Duas formas de torná-la real:

```xml
<!-- .NET 10 SDK 10.0.302: promotes the All-mode analyzers, CA1070 included -->
<PropertyGroup>
  <AnalysisMode>All</AnalysisMode>
</PropertyGroup>
```

```ini
# .editorconfig, just this rule
[*.{cs,vb}]
dotnet_diagnostic.CA1070.severity = warning
```

É a mesma armadilha de invisibilidade de [CA1873 e os argumentos caros de logging](/pt-br/2026/08/fix-ca1873-evaluation-of-this-argument-may-be-expensive-and-unnecessary-if-logging-is-disabled/), e as contrapartidas de promover sugestões no CI estão cobertas em [TreatWarningsAsErrors sem sabotar os builds de desenvolvimento](/pt-br/2026/01/treatwarningsaserrors-without-sabotaging-dev-builds-net-10/).

## Por que alguém marca um evento como virtual?

Quase sempre por causa do CS0070. Uma classe derivada não consegue disparar um evento da classe base:

```csharp
// .NET 10, C# 14
public class Sensor
{
    public event EventHandler? ThresholdReached;
}

public class LoggingSensor : Sensor
{
    public void Raise() => ThresholdReached?.Invoke(this, EventArgs.Empty);
}
```

```text
error CS0070: The event 'Sensor.ThresholdReached' can only appear on the left hand side
of += or -= (except when used from within the type 'Sensor')
```

O compilador está dizendo que, fora do tipo declarante, um evento é apenas um par add/remove, nunca o delegate por trás dele. A saída que parece óbvia é marcar o evento como `virtual` e sobrescrevê-lo em `LoggingSensor`, para que o nome resolva para algo que a classe derivada possui. Isso compila. E também quebra o evento.

## Por que sobrescrever um evento do tipo campo virtual quebra o evento?

A classe base para de disparar. Aqui está a falha inteira em um único arquivo:

```csharp
// .NET 10 (SDK 10.0.302), C# 14
using System;

public class Sensor
{
    public virtual event EventHandler? ThresholdReached;   // CA1070
    public void Raise() => ThresholdReached?.Invoke(this, EventArgs.Empty);
}

public class LoggingSensor : Sensor
{
    public override event EventHandler? ThresholdReached;
    public void RaiseFromDerived() => ThresholdReached?.Invoke(this, EventArgs.Empty);
}

public static class Program
{
    public static void Main()
    {
        LoggingSensor derived = new();
        Sensor asBase = derived;
        asBase.ThresholdReached += (_, _) => Console.WriteLine("handler ran");

        Console.WriteLine("Sensor.Raise():");
        asBase.Raise();                 // fires nothing
        Console.WriteLine("LoggingSensor.RaiseFromDerived():");
        derived.RaiseFromDerived();     // fires the handler
    }
}
```

Saída real no .NET 10:

```text
Sensor.Raise():
LoggingSensor.RaiseFromDerived():
handler ran
```

O mesmo objeto, o mesmo handler: um disparo funciona e o outro não faz nada.

O motivo é que um evento do tipo campo são duas coisas diferentes ao mesmo tempo, e apenas uma delas é virtual. Os acessadores `add` e `remove` são métodos de verdade e recebem sim o modificador `virtual`. O campo delegate de apoio não recebe, porque campos não podem ser virtuais. Refletir sobre o assembly compilado mostra exatamente o que o compilador emitiu:

```text
Sensor: field ThresholdReached, IsPrivate=True, type=EventHandler
Sensor: add_ThresholdReached IsVirtual=True, IsFinal=False, DeclaringType=Sensor
LoggingSensor: field ThresholdReached, IsPrivate=True, type=EventHandler
LoggingSensor: add_ThresholdReached IsVirtual=True, IsFinal=False, DeclaringType=LoggingSensor
```

Dois campos privados, um por tipo. Portanto:

- `asBase.ThresholdReached += handler` passa pelo acessador add virtual, despacha para `LoggingSensor.add_ThresholdReached` e cai no campo de `LoggingSensor`.
- `Sensor.Raise()` não passa por acessador nenhum. Dentro do tipo declarante, `ThresholdReached?.Invoke(...)` compila para uma leitura direta do campo privado do próprio `Sensor`, que continua null.

A especificação do C# permite isso. Uma declaração de evento virtual torna os acessadores virtuais, e uma declaração de evento que sobrescreve "não declara um evento novo, apenas especializa as implementações dos acessadores". A linguagem da especificação sugere que os acessadores derivados deveriam especializar o acesso a um único campo compartilhado, o que exigiria que o compilador promovesse o campo de apoio da base de privado para protegido. Ele nunca fez isso. A Microsoft documentou isso como um bug conhecido do compilador lá em 2007 e decidiu não corrigir, porque corrigir ressuscitaria invocações de handlers em código que silenciosamente dependia de elas nunca rodarem.

O que mudou desde 2007 é que a falha ficou mais silenciosa. O repro original usava `myEvent(this, null)` e lançava `NullReferenceException`, o que ao menos apontava para o problema. A invocação condicional a null moderna, para a qual todo analisador e correção automática empurra você, transforma isso em um no-op silencioso.

## Como isso aparece em uma classe base de MVVM?

O formato que as pessoas usam ao escrever `INotifyPropertyChanged` em um view model base é exatamente o caso quebrado:

```csharp
// .NET 10, C# 14
public class ViewModelBase : INotifyPropertyChanged
{
    public virtual event PropertyChangedEventHandler? PropertyChanged;   // CA1070
    protected void Notify(string n) => PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(n));
}

public class OrderViewModel : ViewModelBase
{
    public override event PropertyChangedEventHandler? PropertyChanged;
}
```

O motor de binding assina através da interface `INotifyPropertyChanged`, o que roteia para o acessador add virtual, que guarda o handler em `OrderViewModel`. `Notify` roda dentro de `ViewModelBase` e lê o campo de `ViewModelBase`. Confirmei no .NET 10 que o handler nunca é chamado: a interface simplesmente não atualiza, sem exceção e sem nenhum erro de binding na janela de saída.

O `override` no view model derivado costuma ser vestigial, adicionado por alguém perseguindo o CS0070 ou copiado de um template. Apagá-lo corrige o binding na hora, porque aí existe apenas um campo de apoio. Vale conferir isso antes de reescrever qualquer coisa. Se você está construindo a infraestrutura de notificação do zero, [um source generator para INotifyPropertyChanged](/pt-br/2026/04/how-to-write-a-source-generator-for-inotifypropertychanged/) emite o formato não virtual correto e nunca erra nisso.

## Como corrijo o CA1070?

Em ordem de preferência.

**1. Evento não virtual mais um disparador protected virtual.** Este é o padrão que as diretrizes de design do .NET prescrevem, e é para onde o CA1070 está te empurrando. As classes derivadas ganham o ponto de extensão que realmente queriam, e existe exatamente um campo de apoio.

```csharp
// .NET 10, C# 14. Builds clean under AnalysisMode=All.
public class Sensor
{
    public event EventHandler? ThresholdReached;

    protected virtual void OnThresholdReached(EventArgs e)
        => ThresholdReached?.Invoke(this, e);

    public void Raise() => OnThresholdReached(EventArgs.Empty);
}

public class LoggingSensor : Sensor
{
    protected override void OnThresholdReached(EventArgs e)
    {
        Console.WriteLine("[derived saw the raise]");
        base.OnThresholdReached(e);
    }
}
```

Note que o disparador lê o campo, então ele precisa morar no tipo declarante. As sobrescritas derivadas chamam `base.OnThresholdReached(e)` para disparar de fato. Se esquecer a chamada a `base`, você suprimiu o evento, o que às vezes é justamente a intenção.

**2. Mantenha o evento virtual, mas escreva acessadores explícitos sobre um campo protegido.** Use isso quando a classe derivada realmente precisa interceptar a assinatura, por exemplo para conectar de forma preguiçosa um hook do sistema operacional no primeiro assinante. O CA1070 não dispara aqui, porque a regra mira apenas eventos do tipo campo.

```csharp
// .NET 10, C# 14
public class Sensor
{
    protected EventHandler? _thresholdReached;

    public virtual event EventHandler? ThresholdReached
    {
        add => _thresholdReached += value;
        remove => _thresholdReached -= value;
    }

    public void Raise() => _thresholdReached?.Invoke(this, EventArgs.Empty);
}

public class LoggingSensor : Sensor
{
    public override event EventHandler? ThresholdReached
    {
        add { Console.WriteLine("[derived add]"); _thresholdReached += value; }
        remove => _thresholdReached -= value;
    }
}
```

O `+=` em um campo delegate não é atômico, então use `Interlocked.CompareExchange` ou um lock nos acessadores se os assinantes puderem chegar de várias threads. Os dois handlers dispararam corretamente na minha execução, porque agora os dois acessadores apontam para o mesmo campo protegido.

**3. Torne o evento da base abstract.** Um evento do tipo campo abstrato não pode ser usado como campo, então a classe base fisicamente não consegue dispará-lo e o bug dos campos separados não pode acontecer. O CA1070 não dispara, porque o analisador verifica `IsVirtual`, que é false para membros abstratos.

```csharp
// .NET 10, C# 14
public abstract class Sensor
{
    public abstract event EventHandler? ThresholdReached;
    public abstract void Raise();
}
```

Isso é correto, mas raramente é o que você quer, já que toda classe derivada agora precisa reimplementar o evento e o disparo.

## Quais declarações o CA1070 realmente sinaliza?

Apenas a declaração `virtual` da base, o que surpreende quem roda o analisador esperando que ele aponte para a linha que de fato está quebrada. A verificação é uma única ação sobre símbolos:

```csharp
// dotnet/sdk, DoNotDeclareEventFieldsAsVirtual.cs
if (!eventSymbol.IsVirtual ||
    eventSymbol.AddMethod?.IsImplicitlyDeclared == false ||
    eventSymbol.RemoveMethod?.IsImplicitlyDeclared == false)
{
    return;
}
```

`IEventSymbol.IsVirtual` é true apenas para membros declarados com a palavra-chave `virtual`. Um membro `override` reporta `IsOverride`, não `IsVirtual`, e um membro `abstract` reporta `IsAbstract`. Então o diagnóstico cai na declaração da base e em nenhum outro lugar. As verificações de `IsImplicitlyDeclared` são o que restringe a regra a eventos do tipo campo: se você escreveu os acessadores, eles não são implícitos e a regra desiste.

Esta é a matriz completa que montei e rodei contra o SDK 10.0.302 com `dotnet_diagnostic.CA1070.severity = warning`:

| Declaração | CA1070? |
| --- | :---: |
| `public virtual event EventHandler A;` | sim |
| `protected virtual event EventHandler B;` em uma classe pública não selada | sim |
| `internal virtual event EventHandler C;` | não |
| `public virtual event EventHandler D { add {} remove {} }` | não |
| `public override event EventHandler A;` na classe derivada | não |
| `public abstract event EventHandler E;` | não |
| `public virtual event EventHandler F;` dentro de uma classe `internal` | não |
| `public event EventHandler G;` (não virtual) | não |

As duas linhas que pegam as pessoas de surpresa são as internas, e elas são configuráveis.

## Como faço o CA1070 cobrir eventos internal e private?

Por padrão a regra analisa apenas símbolos visíveis externamente, seguindo o velho comportamento do FxCop. Configure `api_surface` para ampliá-la:

```ini
[*.{cs,vb}]
dotnet_diagnostic.CA1070.severity = warning
dotnet_code_quality.CA1070.api_surface = all
```

Na mesma matriz, `api_surface = all` reporta A, B, C e F. `api_surface = private, internal` reporta apenas C e F. Para um assembly de aplicação em vez de uma biblioteca publicada, `all` é a configuração certa: ali nada é contrato de API pública, e o bug não se importa com acessibilidade.

Uma divergência de documentação que vale conhecer: a página do MS Learn lista as linguagens aplicáveis como "C# and Visual Basic", mas o analisador está atribuído com `[DiagnosticAnalyzer(LanguageNames.CSharp)]`, com um comentário de supressão dizendo "Construct is invalid in VB.NET". O VB não tem um evento do tipo campo `Overridable` para começar, então não há nada a analisar; a tabela da documentação está simplesmente desatualizada.

## Quando é seguro suprimir o CA1070?

Quando o evento virtual já faz parte de uma API pública publicada. Remover `virtual` é uma quebra binária para qualquer um que o tenha sobrescrito, então a orientação da própria regra é suprimir em vez de quebrar os consumidores. Suprima na declaração, não no projeto inteiro, e deixe uma nota:

```csharp
// Public since v2.0. Removing 'virtual' is a binary break for derived types.
#pragma warning disable CA1070
public virtual event EventHandler? ThresholdReached;
#pragma warning restore CA1070
```

Depois adicione o disparador protegido mesmo assim, para que novos tipos derivados tenham um ponto de extensão correto e parem de recorrer a `override`. Em uma base de código nova ou interna, não suprima. Corrija.

## Pegadinhas e casos parecidos que caem aqui por engano

**CS0070** ("The event 'X' can only appear on the left hand side of += or -=") é o erro de compilação que leva as pessoas a escrever `virtual`, coberto acima. A correção é um disparador protegido, nunca um evento virtual.

**CS0067** ("The event 'X' is never used") aparece sobre o `override` derivado assim que você segue este artigo e para de dispará-lo pela classe derivada. Esse aviso é o fantasma visível ao analisador de um campo de apoio em que ninguém escreve; apagar o override o elimina.

**CA1030** ("Use events where appropriate") e **CA1003** ("Use generic event handler instances") são regras de design sobre o formato dos eventos, não sobre virtualidade, e nenhuma tem relação com o bug dos campos separados.

**"Marquei como virtual para o Moq ou o Castle DynamicProxy conseguirem interceptar."** Bibliotecas de mocking baseadas em proxy realmente precisam de membros virtuais, e a interceptação de eventos é o único caso em que agradá-las planta um bug de verdade. Faça mock da interface: extraia `IThresholdSource` com um `event EventHandler ThresholdReached` simples e deixe o mock implementá-la, assim nada precisa de `virtual`. O mesmo vale para uma classe base marcada como virtual em bloco por causa dos proxies de carregamento preguiçoso do EF Core, onde na prática só as propriedades de navegação precisam disso.

Se um evento virtual já foi publicado e você está caçando as consequências, o sintoma costuma ser um handler que permanece assinado para sempre sem nunca ser invocado, o que aparece como um delegate enraizado em um dump de heap. [Diagnosticar um vazamento de memória gerenciada com dotnet-gcdump e dotnet-dump](/pt-br/2026/07/how-to-diagnose-a-managed-memory-leak-with-dotnet-gcdump-and-dotnet-dump/) percorre como encontrar a cadeia de handlers que sobrevive.

O CA1070 está na caixa desde os analisadores do .NET 5, com severidade Info, e nunca foi promovido. É uma decisão justa para uma regra cuja carga só detona quando alguém escreve `override`, mas significa que o aviso com maior chance de te poupar uma tarde de "por que meu binding não atualiza" é justamente um que o seu build nunca imprime. Transformá-lo em aviso custa uma linha de `.editorconfig`.

## Relacionado

- [Fix: CA1873 "Evaluation of this argument may be expensive and unnecessary if logging is disabled"](/pt-br/2026/08/fix-ca1873-evaluation-of-this-argument-may-be-expensive-and-unnecessary-if-logging-is-disabled/)
- [Como escrever um source generator para INotifyPropertyChanged](/pt-br/2026/04/how-to-write-a-source-generator-for-inotifypropertychanged/)
- [TreatWarningsAsErrors sem sabotar os builds de desenvolvimento (.NET 10)](/pt-br/2026/01/treatwarningsaserrors-without-sabotaging-dev-builds-net-10/)
- [O que é um source generator e quando eu preciso de um?](/pt-br/2026/06/what-is-a-source-generator-and-when-do-i-need-one/)
- [Como diagnosticar um vazamento de memória gerenciada com dotnet-gcdump e dotnet-dump](/pt-br/2026/07/how-to-diagnose-a-managed-memory-leak-with-dotnet-gcdump-and-dotnet-dump/)

## Fontes

- [CA1070: Do not declare event fields as virtual](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca1070) no MS Learn
- [DoNotDeclareEventFieldsAsVirtual.cs](https://github.com/dotnet/sdk/blob/main/src/Microsoft.CodeAnalysis.NetAnalyzers/src/Microsoft.CodeAnalysis.NetAnalyzers/Microsoft.CodeQuality.Analyzers/QualityGuidelines/DoNotDeclareEventFieldsAsVirtual.cs), o código-fonte do analisador
- [Virtual events in C#](https://learn.microsoft.com/en-us/archive/blogs/samng/virtual-events-in-c), o post do time de C# de 2007 que documentou o bug do compilador e a decisão de não corrigi-lo
- [How to raise base class events in derived classes](https://learn.microsoft.com/en-us/dotnet/csharp/programming-guide/events/how-to-raise-base-class-events-in-derived-classes) no MS Learn
- [Handle and raise events](https://learn.microsoft.com/en-us/dotnet/standard/events/), as diretrizes de design de eventos do .NET
- [Compiler Error CS0070](https://learn.microsoft.com/en-us/dotnet/csharp/misc/cs0070) no MS Learn
- [Opção de configuração api_surface](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/code-quality-rule-options#api_surface) para as regras de qualidade de código
