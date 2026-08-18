---
title: "Fix: The call is ambiguous between the following methods or properties depois de migrar para membros de extensão do C# 14"
description: "CS0121 depois de mover um método de extensão para um bloco extension do C# 14: o compilador ainda emite a forma estática antiga. Apague a duplicata ou qualifique a chamada."
pubDate: 2026-08-18
template: error-page
tags:
  - "errors"
  - "csharp"
  - "csharp-14"
  - "dotnet-10"
  - "extension-members"
lang: "pt-br"
translationOf: "2026/08/fix-the-call-is-ambiguous-after-moving-to-csharp-14-extension-members"
translatedBy: "claude"
translationDate: 2026-08-18
---

Você moveu um método de extensão com parâmetro `this` para um bloco `extension` do C# 14, manteve o original "só por garantia", e agora cada ponto de chamada falha com CS0121. A correção é apagar uma das duas declarações, porque elas não são duas coisas diferentes: o compilador reduz um método de bloco de extensão exatamente ao mesmo método estático com parâmetro `this` que você já tinha. Se você não pode apagar nenhuma das duas (a outra vive em um pacote NuGet), qualifique a chamada com a classe estática que a contém: `MyExtensions.WordCount(s)` em vez de `s.WordCount()`.

```
error CS0121: The call is ambiguous between the following methods or properties:
'New.StringExtensions2.extension(string).WordCount()' and 'Old.StringExtensions.WordCount(string)'
```

Repare no formato da mensagem. Um candidato é impresso como `extension(string).WordCount()` e o outro como `WordCount(string)`. Essa assimetria é todo o diagnóstico: o Roslyn está dizendo que um candidato veio de um bloco de extensão e o outro de um método clássico com parâmetro `this`, e ele não consegue escolher entre os dois. Tudo abaixo foi verificado no SDK do .NET 10.0.201 com `<LangVersion>14.0</LangVersion>`.

## Por que o CS0121 dispara quando as duas sintaxes estão em escopo?

O C# 14 não introduziu um segundo mecanismo de busca separado para membros de extensão. Um bloco de extensão é uma sintaxe de declaração, e o compilador o reduz a um membro de classe estática indistinguível do que `this string s` produz. Quando duas diretivas `using` trazem cada uma uma classe para o escopo e as duas classes contribuem com um candidato `WordCount(string)` de aplicabilidade idêntica, a resolução de sobrecarga fica sem critério de desempate, então ela reporta CS0121.

Essa não é uma regra nova. O mesmo erro sempre disparou quando duas bibliotecas definem o mesmo método de extensão sobre o mesmo tipo. O que é novo é que migrar o seu próprio código agora cria a colisão, porque uma migração pela metade deixa as duas formas vivas ao mesmo tempo.

## O que o compilador realmente emite para um bloco de extensão?

Essa é a parte que vale a pena internalizar, porque explica todos os sintomas desta página. Pegue um único bloco com um método e uma propriedade:

```csharp
// .NET 10.0.201, C# 14
namespace Lib;

public static class StringExtensions
{
    extension(string s)
    {
        public int WordCount() => s.Split(' ').Length;
        public bool IsBlank => string.IsNullOrWhiteSpace(s);
    }
}
```

Usar reflexão sobre o `Lib.StringExtensions` compilado na mesma solução imprime:

```
METHOD Int32 WordCount(String s) [Extension]
METHOD Boolean get_IsBlank(String s)
NESTED <G>$34505F560D9EACF86A87F3ED1F85E448 ext-attr=True
CLASS ext-attr=True
```

Três coisas saem desse despejo:

1. `WordCount` é emitido como um método estático público que recebe o receptor como primeiro parâmetro, carregando `[ExtensionAttribute]`. Ele *é* um método de extensão clássico nos metadados. É por isso que ele colide com um método `this` escrito à mão, e por isso escrever os dois é uma duplicata, não uma camada de compatibilidade.
2. A propriedade é reduzida a `get_IsBlank(String s)`, um método estático público **sem** `[ExtensionAttribute]`. Propriedades não são métodos de extensão clássicos, então são encontradas por um caminho de busca diferente e falham com um diagnóstico diferente (veja abaixo).
3. O tipo aninhado `<G>$<hash>` é o tipo marcador baseado em conteúdo que o compilador gera por bloco de extensão. O hash deriva do conteúdo do bloco, e é por isso que dois blocos com receptores e membros idênticos na mesma classe colidem com CS9329.

Como o método reduzido realmente é um método de extensão normal, um projeto fixado em `<LangVersion>13.0</LangVersion>` ainda pode consumi-lo. Verifiquei isso com uma referência de projeto de um app em C# 13 para uma biblioteca em C# 14: `"a b c".WordCount()` e `StringExtensions.WordCount("a b c")` compilam e imprimem `3`. Adicionar `"a b c".IsBlank` ao mesmo arquivo falha com `error CS9260: Feature 'extensions' is not available in C# 13.0`. *Métodos* de extensão declarados em um bloco podem ser consumidos por versões de linguagem antigas; *propriedades* de extensão não.

## Reprodução mínima: duas classes estáticas, um nome de método

```csharp
// Old.cs -- .NET 10.0.201, C# 14
namespace Old;

public static class StringExtensions
{
    public static int WordCount(this string s) => s.Split(' ').Length;
}
```

```csharp
// New.cs -- .NET 10.0.201, C# 14
namespace New;

public static class StringExtensions2
{
    extension(string s)
    {
        public int WordCount() => s.Split(' ').Length;
    }
}
```

```csharp
// Use.cs -- .NET 10.0.201, C# 14
using Old;
using New;

System.Console.WriteLine("a b c".WordCount()); // CS0121
```

O `dotnet build` falha no ponto de chamada, não em nenhuma das declarações. Isso importa: as declarações são legais individualmente, então o erro só aparece em arquivos que importam os dois namespaces. Uma solução parcialmente migrada vai portanto compilar em alguns projetos e falhar em outros, o que parece um build instável até você olhar as listas de `using`.

A mesma coisa acontece entre assemblies, que é a versão que a maioria das pessoas realmente encontra. Uma biblioteca publica blocos de extensão, você mantém um adaptador local com método `this` que escreveu antes da atualização, e qualquer arquivo que importe os dois namespaces quebra:

```
error CS0121: The call is ambiguous between the following methods or properties:
'Lib.StringExtensions.extension(string).WordCount()' and 'App.Compat.MyStringExtensions.WordCount(string)'
```

## Como corrijo o CS0121 quando sou dono das duas declarações?

Apague a versão com parâmetro `this`. Essa é a correção inteira, e não é um meio-termo: como mostrado acima, o bloco de extensão ainda emite um método estático marcado com `[ExtensionAttribute]` com a assinatura idêntica, então todo ponto de chamada existente continua funcionando, incluindo a forma totalmente qualificada `MyExtensions.WordCount(s)` e chamadores em versões de linguagem antigas.

```csharp
// .NET 10.0.201, C# 14 -- one declaration, both call shapes still work
namespace Lib;

public static class StringExtensions
{
    extension(string s)
    {
        public int WordCount() => s.Split(' ').Length;
    }
}

// both of these compile:
// "a b c".WordCount()
// StringExtensions.WordCount("a b c")
```

A regra de migração para escrever no quadro branco: **um bloco de extensão substitui o método antigo, ele não fica ao lado dele.** Todo instinto de "manter o antigo por compatibilidade" está errado aqui, porque a compatibilidade binária e de código-fonte já é preservada pela redução.

## Como desambiguo quando a duplicata vive em um pacote NuGet?

Você não pode apagar uma declaração que não é sua, então escolha uma destas, em ordem de preferência.

**Chame o método estático diretamente.** Os dois candidatos expõem uma forma estática, então nomeie a classe que você quer:

```csharp
// .NET 10.0.201, C# 14
System.Console.WriteLine(New.StringExtensions2.WordCount("a b c")); // extension block version
System.Console.WriteLine(Old.StringExtensions.WordCount("a b c"));  // this-parameter version
```

Isso compila limpo. É verboso no ponto de chamada mas é inequívoco, dá para achar com grep e sobrevive a futuras atualizações de pacote.

**Remova o `using` e mude para um alias de namespace.** Membros de extensão só entram em escopo por um `using` simples do namespace. Um alias de namespace importa os *nomes* sem contribuir com candidatos de extensão:

```csharp
// .NET 10.0.201, C# 14
using OldAlias = Old; // types reachable as OldAlias.StringExtensions, but no extension candidates
using New;

System.Console.WriteLine("x".WordCount()); // binds to New, prints 2
```

Rodei exatamente esse arquivo e ele imprime `2`. Essa é a opção mais limpa quando um arquivo precisa de tipos de um namespace mas não das extensões dele. Cuidado com diretivas `global using` em `GlobalUsings.cs` ou itens `<Using Include="..."/>` no csproj, porque essas importam extensões em todo arquivo do projeto e são o motivo habitual de a ambiguidade aparecer em um arquivo cuja própria lista de `using` parece inocente.

**Dê nomes diferentes aos dois membros.** Se você é dono do mais novo e ele ainda não foi publicado, renomear sai mais barato do que ensinar uma regra de desambiguação ao time inteiro.

## Posso marcar o método antigo com `[Obsolete]` para desempatar?

Não. Obsolescência não é critério de desempate da resolução de sobrecarga. O candidato continua aplicável e o erro é idêntico:

```csharp
// .NET 10.0.201, C# 14 -- still CS0121
[System.Obsolete("Use Lib")]
public static int WordCount(this string s) => 1;
```

`[Obsolete]` serve para dizer aos consumidores que parem de chamar algo, mas não faz nada pelo conjunto de candidatos do compilador. O mesmo vale para `[EditorBrowsable(EditorBrowsableState.Never)]`, que só esconde membros do IntelliSense.

## Quando eu recebo CS0111 em vez de CS0121?

Porque as duas declarações estão na *mesma* classe estática. Aí não é uma chamada ambígua, é um membro duplicado:

```csharp
// .NET 10.0.201, C# 14
namespace A;

public static class E1
{
    public static int WordCount(this string s) => 1;

    extension(string s)
    {
        public int WordCount() => 2; // CS0111
    }
}
```

```
error CS0111: Type 'E1' already defines a member called 'WordCount' with the same parameter types
```

O CS0111 é reportado na declaração, antes de existir qualquer ponto de chamada. É o mais gentil dos dois erros porque prova a equivalência diretamente: o compilador considera que `WordCount(this string)` e o `WordCount()` do bloco têm os mesmos tipos de parâmetros. Se você está migrando uma classe um método por vez, esse é o erro que vai ver primeiro.

## E se a ambiguidade estiver em uma propriedade de extensão (CS9339)?

Propriedades de extensão têm o próprio diagnóstico, porque não são métodos com `[ExtensionAttribute]` nos metadados e são resolvidas pela busca de membros de extensão em vez da resolução de sobrecarga comum:

```csharp
// N1.cs -- .NET 10.0.201, C# 14
namespace N1;

public static class E
{
    extension(System.Text.StringBuilder b)
    {
        public int Cap { get => b.Capacity; set => b.Capacity = value; }
    }
}
```

```csharp
// N2.cs -- .NET 10.0.201, C# 14
namespace N2;

public static class E
{
    extension(System.Text.StringBuilder b)
    {
        public int Cap { get => b.Capacity; set => b.Capacity = value; }
    }
}
```

```csharp
// Use.cs -- .NET 10.0.201, C# 14
using N1;
using N2;

var sb = new System.Text.StringBuilder();
sb.Cap = 64; // CS9339
```

```
error CS9339: The extension resolution is ambiguous between the following members:
'N1.E.extension(System.Text.StringBuilder).Cap' and 'N2.E.extension(System.Text.StringBuilder).Cap'
```

A correção tem o mesmo formato mas você precisa nomear o acessador, já que não existe sintaxe de propriedade que carregue o nome da classe:

```csharp
// .NET 10.0.201, C# 14 -- disambiguated, prints 64
N1.E.set_Cap(sb, 64);
System.Console.WriteLine(N1.E.get_Cap(sb));
```

Os métodos acessadores `get_` e `set_` são exatamente ao que o bloco é reduzido, então chamá-los não é uma gambiarra, é chamar o membro real. É feio o bastante para você tratar como um desbloqueio temporário enquanto remove uma das duplicatas. Se você ainda está decidindo como moldar essas declarações, as regras para [declarar propriedades de extensão no C# 14](/pt-br/2026/06/how-to-declare-extension-properties-in-csharp-14/) cobrem por que propriedades automáticas são rejeitadas e o que os acessadores podem fazer.

## Um tipo de receptor mais específico desempata?

Sim, e é por isso que só alguns dos seus pontos de chamada quebram. A resolução de sobrecarga continua preferindo a melhor conversão a partir do receptor, e essa comparação acontece entre as duas sintaxes. Um bloco de extensão sobre `string` ganha de um método com parâmetro `this` sobre `IEnumerable<char>`:

```csharp
// Old.cs -- .NET 10.0.201, C# 14
namespace Old;

public static class E
{
    public static string Describe(this System.Collections.Generic.IEnumerable<char> s) => "IEnumerable<char>";
}
```

```csharp
// New.cs -- .NET 10.0.201, C# 14
namespace New;

public static class E
{
    extension(string s)
    {
        public string Describe() => "string";
    }
}
```

```csharp
// Use.cs -- .NET 10.0.201, C# 14
using Old;
using New;

System.Console.WriteLine("x".Describe()); // prints: string
```

Um método genérico com parâmetro `this` perde para um bloco de extensão concreto sobre o mesmo receptor, e continua ganhando para qualquer outro tipo de receptor:

```csharp
// .NET 10.0.201, C# 14
// G1.E: public static string Kind<T>(this T value) => "generic this-method";
// G2.E: extension(string s) { public string Kind() => "extension block on string"; }

System.Console.WriteLine("x".Kind()); // extension block on string
System.Console.WriteLine(42.Kind());  // generic this-method
```

Então uma migração que muda um receptor de `IEnumerable<T>` para um tipo concreto vai mover silenciosamente alguns pontos de chamada para a nova implementação sem erro nenhum. Isso é uma mudança de comportamento escondida dentro do que parece uma refatoração de sintaxe, e merece um teste em vez de uma compilação.

## Um método de instância desempata?

Um membro de instância sempre ganha de qualquer membro de extensão, em qualquer uma das sintaxes, sem diagnóstico. Se um tipo ganha um método de instância com assinatura correspondente em uma versão posterior de uma dependência, as duas declarações de extensão ficam inalcançáveis e nada avisa você:

```csharp
// .NET 10.0.201, C# 14
public class Order { public decimal Total() => 10m; }
public static class E1 { public static decimal Total(this Order o) => 20m; }
public static class E2 { extension(Order o) { public decimal Total() => 30m; } }

// new Order().Total() prints 10
```

Esse programa compila sem aviso e imprime `10`. É a imagem espelhada do CS0121: dois membros de extensão ambíguos são barulhentos, dois sombreados são silenciosos. É a mesma classe de risco de atualização que a [mudança disruptiva de resolução de sobrecarga do C# 14 com spans](/pt-br/2026/05/fix-csharp-14-overload-resolution-breaking-change-with-spans/), onde uma nova conversão implícita reassocia silenciosamente chamadas existentes.

## Que ordem de migração evita o erro por completo?

1. Mova as declarações, não as copie. Recorte o método `this` da classe estática e cole o corpo em um bloco `extension` na mesma classe. O CS0111 vai te pegar na hora se você errar esse passo, e é por isso que fazer a migração dentro de uma única classe é mais seguro do que começar uma nova.
2. Migre uma classe estática inteira por vez. Classes migradas pela metade tudo bem; *namespaces* migrados pela metade com uma classe "V2" paralela são de onde vem o CS0121.
3. Nunca crie uma classe de extensão `New` ou `V2` ao lado da antiga. Não há nada para manter compatível, então a classe paralela só te compra uma ambiguidade.
4. Depois de mover, compile a solução com `dotnet build` antes de tocar nos pontos de chamada. Cada ponto de chamada que ainda compila é prova de que a redução coincidiu.
5. Rode os testes, não só o compilador. As regras de especificidade do receptor acima significam que uma migração pode mudar qual implementação roda sem quebrar o build.

Se você está fazendo isso como parte de um salto maior, o [checklist de migração do .NET 8 para o .NET 11](/pt-br/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/) sequencia o aumento de versão da linguagem em relação às atualizações de runtime e pacotes, que é a ordem que evita este erro chegar junto com outros vinte.

## Relacionado

- [Membros de extensão do C# 14: propriedades de extensão, operadores e extensões estáticas](/pt-br/2026/02/csharp-14-extension-members/) para a superfície completa do recurso, incluindo as formas de operador e membro estático que este artigo não cobre.
- [Como declarar propriedades de extensão no C# 14](/pt-br/2026/06/how-to-declare-extension-properties-in-csharp-14/) para as regras de acessadores por trás do truque de desambiguação com `get_` e `set_`.
- [Indexadores de extensão do C# 15 no .NET 11 Preview 6](/pt-br/2026/07/csharp-15-extension-indexers-dotnet-11-preview-6/) para onde a sintaxe de bloco de extensão vai a seguir.
- [Fix: mudança disruptiva de resolução de sobrecarga do C# 14 com Span e ReadOnlySpan](/pt-br/2026/05/fix-csharp-14-overload-resolution-breaking-change-with-spans/) para a outra mudança do C# 14 que reassocia pontos de chamada existentes.
- [Migrar do .NET 8 para o .NET 11: checklist completo](/pt-br/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/) para sequenciar o aumento de versão da linguagem.

## Fontes

- [Resolve errors and warnings related to extension declarations](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/compiler-messages/extension-declarations) no MS Learn, que lista CS9339 e a família CS93xx de diagnósticos de blocos de extensão.
- [Extension methods](https://learn.microsoft.com/en-us/dotnet/csharp/programming-guide/classes-and-structs/extension-methods) no MS Learn, para as duas sintaxes de declaração e o guia de desambiguação.
- [C# 14: exploring extension members](https://devblogs.microsoft.com/dotnet/csharp-exploring-extension-members/) no .NET Blog, que documenta a redução para métodos estáticos com prefixo `get_` e confirma o objetivo de design de que converter um método de extensão para a nova sintaxe não quebra seus consumidores.
- [Extensions discussion](https://github.com/dotnet/csharplang/discussions/8696) no dotnet/csharplang, a thread de design do recurso.
