---
title: "Hierarquias de classes fechadas no C# 15: a palavra-chave closed no .NET 11 Preview 5"
description: "O C# 15 adiciona o modificador closed no .NET 11 Preview 5, dando as hierarquias de classes exaustividade em tempo de compilacao nas expressoes switch. Veja como funciona e o unico detalhe a observar."
pubDate: 2026-06-21
tags:
  - "csharp"
  - "dotnet"
  - "csharp-15"
  - "dotnet-11"
lang: "pt-br"
translationOf: "2026/06/csharp-15-closed-class-hierarchies-dotnet-11-preview-5"
translatedBy: "claude"
translationDate: 2026-06-21
---

O [.NET 11 Preview 5](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-5/) chegou em 9 de junho de 2026, e dentro do trabalho de linguagem do C# 15 se esconde um recurso que corrige discretamente uma das lacunas mais antigas do sistema de tipos: nao havia como dizer ao compilador "esta classe base tem exatamente estes subtipos". Agora ha. O novo modificador `closed` declara uma hierarquia de classes fechada, e as expressoes switch sobre ela ganham verificacao completa de exaustividade em tempo de compilacao.

Esta e a peca complementar das [unioes de tipos](/pt-br/2026/04/csharp-15-union-types-dotnet-11-preview-2/). As unioes compoem tipos nao relacionados; as hierarquias fechadas travam uma arvore de heranca que voce ja possui. Juntas, elas dao ao C# uma historia de exaustividade completa.

## O que o closed realmente faz

Marque uma classe base como `closed` e o compilador so permite subtipos diretos que vivam no mesmo assembly. Como o conjunto de subtipos agora e conhecido e finito, o compilador pode verificar se um `switch` trata cada caso alcancavel.

```csharp
public closed record class GateState;
public record class Closed : GateState;
public record class Open(float Percent) : GateState;

static string Describe(GateState state) => state switch
{
    Closed => "closed",
    Open(var percent) => $"{percent}% open"
};
```

Sem ramo `default`, sem padrao de descarte, sem `throw new InvalidOperationException("unreachable")`. O compilador ja sabe que `Closed` e `Open` sao as unicas opcoes. Adicione um terceiro subtipo mais tarde e cada switch nao exaustivo acende com um aviso, que e exatamente a rede de seguranca para refatoracoes que os padroes de classe selada mais visitante nunca lhe deram.

## As regras que mordem

Vale a pena memorizar algumas restricoes:

- Uma classe `closed` e **implicitamente abstrata**. Voce nao pode instanciar a base diretamente e nao pode combinar `closed` com `sealed`, `static` ou um modificador `abstract` explicito.
- Os subtipos diretos devem ser declarados no **mesmo assembly**. A heranca entre assemblies e bloqueada, e e isso que torna o conjunto fechado conhecivel.
- Aplica-se a classes e `record class`, mas **nao a structs**.

## O unico detalhe a observar no Preview 5

Aqui esta a parte que vai te derrubar. O compilador emite um marcador `System.Runtime.CompilerServices.ClosedAttribute`, mas o runtime no Preview 5 ainda nao inclui esse atributo. Ate que inclua, todo projeto que usa `closed` precisa declarar o atributo por conta propria:

```csharp
namespace System.Runtime.CompilerServices;

[AttributeUsage(AttributeTargets.Class, AllowMultiple = false, Inherited = false)]
public sealed class ClosedAttribute : Attribute { }
```

Coloque isso em qualquer arquivo do projeto e o recurso compila. Espere que ele desapareca em uma preview posterior, assim que a BCL trouxer o tipo. Esse e o imposto habitual das previews, entao nao incorpore o paliativo em uma biblioteca compartilhada que voce planeja publicar.

Hierarquias fechadas, enums fechados e unioes de tipos estao todos atras de `<LangVersion>preview</LangVersion>` no C# 15 hoje, a caminho da disponibilidade geral com o .NET 11 em novembro de 2026. Se voce ja escreveu um switch com um default inalcancavel so para satisfazer o compilador, este e o recurso que finalmente o apaga. Todos os detalhes estao nas [notas de versao do C# do Preview 5](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview5/csharp.md).
