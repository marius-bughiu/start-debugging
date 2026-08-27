---
title: "Como renderizar um cabeçalho cujo nível (h1-h6) é escolhido em tempo de execução em um componente Blazor"
description: "Razor não tem sintaxe para um nome de tag variável, e DynamicComponent só renderiza tipos de componente. Sobrescreva BuildRenderTree e chame builder.OpenElement(0, $\"h{level}\"). Cobre o repasse de atributos, por que o nome da tag precisa ser limitado antes de chegar ao DOM, por que mudar o nível arranca o elemento do DOM mesmo com @key, e uma variante com nivelamento automático construída sobre um valor em cascata."
pubDate: 2026-08-27
template: how-to
tags:
  - "dotnet"
  - "csharp"
  - "aspnetcore"
  - "how-to"
lang: "pt-br"
translationOf: "2026/08/how-to-render-a-heading-with-a-runtime-chosen-level-in-blazor"
translatedBy: "claude"
translationDate: 2026-08-27
---

O Razor não oferece nenhuma forma de escrever `<h@Level>`, e o `<DynamicComponent>` não ajuda porque seu parâmetro `Type` precisa implementar `IComponent`. A resposta é descer até o `RenderTreeBuilder` e construir o elemento você mesmo: sobrescreva `BuildRenderTree` e chame `builder.OpenElement(0, $"h{level}")` com um nível que você já tenha limitado ao intervalo 1-6. Tudo o que segue foi verificado contra o .NET 10 (SDK 10.0.201, `Microsoft.AspNetCore.App` 10.0.5); as APIs não mudaram nas versões prévias do .NET 11.

## Por que as duas abordagens óbvias não funcionam

O primeiro instinto é `<DynamicComponent Type="...">`. Ele não se aplica aqui. A documentação o descreve como uma forma de "renderizar componentes por tipo", e o runtime impõe isso. Passar um nome de elemento, ou qualquer tipo que não seja um componente, lança uma exceção antes de qualquer coisa ser renderizada:

```text
System.ArgumentException: The component type must implement Microsoft.AspNetCore.Components.IComponent.
```

Não existe equivalente para elementos HTML. O `DynamicComponent` serve para escolher entre `RocketLab.razor` e `SpaceX.razor`, não entre `h2` e `h3`.

O segundo instinto é dividir a tag em dois valores `MarkupString`:

```csharp
// .NET 10. Renders correctly in static SSR and breaks interactively.
builder.AddContent(0, (MarkupString)$"<h{Level}>");
builder.AddContent(1, ChildContent);
builder.AddContent(2, (MarkupString)$"</h{Level}>");
```

Essa é a armadilha que vale a pena entender, porque parece funcionar. Renderizado através do `HtmlRenderer` para renderização estática no servidor, a saída sai exatamente certa:

```html
<h3>Release notes</h3>
```

Isso acontece apenas porque o SSR estático concatena os frames em uma string. Inspecionar a árvore de renderização mostra o que de fato foi produzido: três frames irmãos independentes, não um elemento com um filho.

```text
PrependFrame @sibling 0 frame=[Markup "<h3>"]
PrependFrame @sibling 1 frame=[Text "Release notes"]
PrependFrame @sibling 2 frame=[Markup "</h3>"]
```

No Blazor Server ou WebAssembly, o cliente percorre esses frames e chama `insertMarkup` uma vez por frame de marcação, e [`insertMarkup` analisa o conteúdo de cada frame isoladamente](https://github.com/dotnet/aspnetcore/blob/main/src/Components/Web.JS/src/Rendering/BrowserRenderer.ts) antes de inserir os nós resultantes. O analisador do navegador transforma a string solta `<h3>` em um elemento vazio `<h3></h3>` e a string solta `</h3>` em nada. Seu texto acaba como irmão *depois* de um cabeçalho vazio. O componente passa em um teste rápido de SSR estático e produz marcação quebrada e inacessível assim que o modo de renderização vira interativo.

Um `@switch` sobre seis ramos fixos funciona. Só que são seis cópias de cada atributo, cada classe CSS e do conteúdo filho, e tudo isso precisa ficar sincronizado para sempre. Para um componente isso é tolerável; para um design system com cabeçalhos, rótulos e títulos de seção, não é.

## Passos: construir um componente Heading que escolhe a própria tag

1. Crie um arquivo `.cs` comum, não um arquivo `.razor`. Um componente Razor já gera um método `BuildRenderTree`, então declarar o seu em um bloco `@code` produz `CS0111: Type 'Heading' already defines a member called 'BuildRenderTree' with the same parameter types`.
2. Derive de `ComponentBase` e adicione um parâmetro `int Level`, um parâmetro `RenderFragment? ChildContent` e um dicionário `AdditionalAttributes` marcado com `[Parameter(CaptureUnmatchedValues = true)]` para que quem usar ainda possa passar `class`, `id` e atributos `data-`.
3. Sobrescreva `BuildRenderTree` e limite o nível com `Math.Clamp(Level, 1, 6)` antes de interpolá-lo no nome da tag. Limitar é um controle de segurança, não uma conveniência.
4. Chame `builder.OpenElement(0, $"h{level}")`, depois `builder.AddMultipleAttributes(1, AdditionalAttributes)`, depois `builder.AddContent(2, ChildContent)` e por fim `builder.CloseElement()`.
5. Deixe cada número de sequência como um literal inteiro. Não use uma variável contadora, nem mesmo uma que pareça inofensiva.

## O componente completo

```csharp
// Heading.cs -- .NET 10, C# 14
using Microsoft.AspNetCore.Components;
using Microsoft.AspNetCore.Components.Rendering;

public class Heading : ComponentBase
{
    [Parameter] public int Level { get; set; } = 2;
    [Parameter] public RenderFragment? ChildContent { get; set; }

    [Parameter(CaptureUnmatchedValues = true)]
    public IReadOnlyDictionary<string, object>? AdditionalAttributes { get; set; }

    protected override void BuildRenderTree(RenderTreeBuilder builder)
    {
        var level = Math.Clamp(Level, 1, 6);

        builder.OpenElement(0, $"h{level}");
        builder.AddMultipleAttributes(1, AdditionalAttributes);
        builder.AddContent(2, ChildContent);
        builder.CloseElement();
    }
}
```

Ele é consumido exatamente como qualquer outro componente:

```razor
@* .NET 10 *@
<Heading Level="SectionDepth" class="title" id="release-notes">
    Release notes
</Heading>
```

Renderizado através do `HtmlRenderer`, os resultados são os que você escreveria à mão:

```text
Level= 1 -> <h1 class="title" id="s1">Release notes</h1>
Level= 3 -> <h3 class="title" id="s1">Release notes</h3>
Level= 6 -> <h6 class="title" id="s1">Release notes</h6>
Level= 9 -> <h6 class="title" id="s1">Release notes</h6>
Level=-4 -> <h1 class="title" id="s1">Release notes</h1>
```

Repare que `AddMultipleAttributes` vem antes de `AddContent`. Todos os frames de atributo de um elemento precisam ser adicionados antes de qualquer conteúdo filho; intercalá-los lança uma exceção em tempo de renderização.

## Mantendo tudo em um arquivo .razor

Se você preferir não sair do Razor, dá para ficar, desde que não sobrescreva `BuildRenderTree`. Exponha a lógica do builder como uma propriedade `RenderFragment` e renderize-a como o corpo inteiro do componente:

```razor
@* Heading.razor -- .NET 10 *@
@Rendered

@code {
    [Parameter] public int Level { get; set; } = 2;
    [Parameter] public RenderFragment? ChildContent { get; set; }

    [Parameter(CaptureUnmatchedValues = true)]
    public IReadOnlyDictionary<string, object>? AdditionalAttributes { get; set; }

    private RenderFragment Rendered => builder =>
    {
        builder.OpenElement(0, $"h{Math.Clamp(Level, 1, 6)}");
        builder.AddMultipleAttributes(1, AdditionalAttributes);
        builder.AddContent(2, ChildContent);
        builder.CloseElement();
    };
}
```

Isso compila sem problemas e emite `<h4 class="title">Release notes</h4>` sem nós de espaço em branco soltos em volta, porque a expressão `@Rendered` é a única marcação do componente. O `BuildRenderTree` gerado apenas chama o seu fragmento. Escolha o tipo de arquivo que seu time procura com mais frequência; a árvore de renderização é idêntica.

## O nome da tag chega ao DOM literalmente

O limite do passo 3 é a parte que as pessoas pulam, e é a parte que importa. `OpenElement` não valida nem escapa seu argumento `elementName`. A string que você passar é escrita na saída como nome de tag. Aqui está um componente com um parâmetro `string Level` sem validação, renderizado com três entradas diferentes:

```text
Level="2"                          -> <h2>hi</h2>
Level="2 onload=alert(1)"          -> <h2 onload=alert(1)>hi</h2 onload=alert(1)>
Level="2><script>alert(1)</script" -> <h2><script>alert(1)</script>hi</h2><script>alert(1)</script>
```

Isso é uma tag de script na sua página vinda de um parâmetro de componente. A codificação automática do Blazor protege texto e *valores* de atributo; ela não protege o nome da tag, porque nunca se espera que o nome da tag seja dado do usuário. A própria orientação da Microsoft sobre `RenderTreeBuilder` diz isso: um componente malformado "pode resultar em comportamento indefinido", incluindo "segurança comprometida".

Então nunca deixe um valor não confiável, ou meramente não validado, chegar ao `OpenElement`. Aceite um `int` em vez de uma `string`, limite-o e, se sua API realmente precisar de uma string, valide-a contra uma lista de permissões dos seis nomes de cabeçalho em vez de interpolá-la.

## Mudar o nível destrói e reconstrói o elemento

O algoritmo de diferenças do Blazor combina frames por número de sequência e tipo de frame. Dois frames de elemento com o mesmo número de sequência mas nomes de tag *diferentes* não são o mesmo elemento, então o antigo é removido e um novo é inserido. Capturar o lote de renderização quando `Level` vai de 2 para 3 mostra exatamente isso:

```text
after Level 2 -> 3:
  RemoveFrame @sibling 0 frame=[Element h3]
  PrependFrame @sibling 0 frame=[Element h3]
```

Compare com mudar apenas o atributo `class`, que é corrigido no lugar:

```text
after class change only:
  SetAttribute @sibling 0 frame=[Attribute class=subtitle]
```

A consequência prática é que um cabeçalho que muda de nível perde seu nó do DOM. O foco dentro dele é descartado, qualquer `ElementReference` que você tenha capturado fica obsoleta, transições CSS reiniciam e um script de terceiros que estava ligado àquele nó agora está ligado a um órfão. Adicionar `@key` não salva. Chaves permitem que a diferenciação combine elementos em reordenações; elas não fazem dois nomes de tag diferentes virarem o mesmo elemento. Uma versão com chave produz exatamente o mesmo script de edição:

```text
keyed, Level 2 -> 3:
  RemoveFrame @sibling 0 frame=[Element h3]
  PrependFrame @sibling 0 frame=[Element h3]
```

Isso raramente é um problema, porque o nível de um cabeçalho costuma ser fixo durante toda a vida da seção. Vira um problema quando o nível deriva de algo que muda com frequência, como um sumário recolhível que renumera conforme o usuário expande nós. Se você cair nisso, mantenha o nível estável e mude o estilo em vez disso.

## Números de sequência ficam fixos, inclusive entre ramos

Essa é a regra mais fácil de quebrar assim que você adiciona um segundo caminho de código. É tentador escrever `var seq = 0;` e usar `seq++` em todo lugar, especialmente em um componente com `if`/`else`. Não faça isso. A documentação da Microsoft é explícita: "o desempenho do aplicativo sofre se os números de sequência forem gerados dinamicamente", porque um contador apaga a informação que o algoritmo de diferenças usa para reconhecer em qual ramo você estava. O resultado são scripts de edição mais longos e, em estruturas aninhadas, uma diferenciação recursiva bem mais profunda.

O padrão correto é o que o próprio compilador Razor emite: números literais que aumentam na ordem do *código-fonte*, com cada ramo dono do seu próprio intervalo.

```csharp
// AutoHeading.cs -- .NET 10, C# 14
protected override void BuildRenderTree(RenderTreeBuilder builder)
{
    var level = Ambient?.Value ?? 1;

    if (level <= 6)
    {
        builder.OpenElement(0, $"h{level}");
        builder.AddMultipleAttributes(1, AdditionalAttributes);
        builder.AddContent(2, ChildContent);
        builder.CloseElement();
    }
    else
    {
        builder.OpenElement(3, "div");
        builder.AddAttribute(4, "role", "heading");
        builder.AddAttribute(5, "aria-level", level);
        builder.AddMultipleAttributes(6, AdditionalAttributes);
        builder.AddContent(7, ChildContent);
        builder.CloseElement();
    }
}
```

Se um componente crescer além de uma tela de chamadas ao builder, envolva as partes em `OpenRegion`/`CloseRegion`. Cada região ganha seu próprio espaço de números de sequência, então você pode reiniciar do zero dentro dela sem confundir a diferenciação.

## Nivelamento automático com um valor em cascata

A versão acima já sugere o formato mais útil desse componente. Em vez de obrigar cada chamador a passar o número certo, deixe o cabeçalho ler sua profundidade do contexto. Um pequeno valor em cascata carrega o nível ambiente, e qualquer componente que abra uma seção aninhada repassa o próximo em cascata:

```csharp
// HeadingLevel.cs -- .NET 10, C# 14
public sealed class HeadingLevel
{
    public int Value { get; init; } = 1;
    public HeadingLevel Next() => new() { Value = Value + 1 };
}
```

```razor
@* Section.razor -- .NET 10 *@
<CascadingValue Value="_child" IsFixed="true">
    <section>@ChildContent</section>
</CascadingValue>

@code {
    [CascadingParameter] public HeadingLevel? Ambient { get; set; }
    [Parameter] public RenderFragment? ChildContent { get; set; }

    private HeadingLevel _child = default!;

    protected override void OnParametersSet()
        => _child = (Ambient ?? new HeadingLevel()).Next();
}
```

O `AutoHeading` então não recebe nenhum parâmetro `Level`. Um componente de card colocado três seções abaixo renderiza um `h4` sem saber nada sobre onde foi usado, que é justamente a propriedade que torna componentes reutilizáveis componíveis. Defina `IsFixed="true"` no `CascadingValue` quando o nível não puder mudar depois que a seção renderizar; isso permite ao Blazor pular a inscrição de cada descendente nas notificações de mudança.

## O que fazer além do h6

O HTML para no `h6`, mas um sumário profundamente aninhado não. Em vez de limitar em silêncio e produzir três elementos `h6` irmãos que a tecnologia assistiva lê como pares, recorra ao equivalente em ARIA. `role="heading"` mais `aria-level` expressa qualquer profundidade:

```text
ambient=2 -> <h2 class="title">Release notes</h2>
ambient=6 -> <h6 class="title">Release notes</h6>
ambient=7 -> <div role="heading" aria-level="7" class="title">Release notes</div>
```

Elementos nativos continuam sendo a melhor escolha onde existem, então use as tags reais `h1`-`h6` para os níveis 1 a 6 e reserve o fallback de ARIA para o caso de estouro. Na prática, precisar do nível 7 costuma ser sinal de que a estrutura da página deveria ser achatada, então vale registrar um aviso em desenvolvimento quando o fallback for acionado.

Uma última nota sobre os próprios tipos da árvore de renderização: a documentação marca tudo sob `Microsoft.AspNetCore.Components.RenderTree` como interno instável do framework. `RenderTreeBuilder` e `ComponentBase.BuildRenderTree` são API pública, suportada e segura de usar. Ler `RenderBatch` e `RenderTreeEdit`, como fiz acima para capturar a saída de diferenças, é adequado para diagnóstico mas não é algo para colocar em produção.

## Relacionados

- A resolução de tags do compilador Razor é o que torna um nome de tag variável impossível já de início, e também está por trás do erro em [Elemento de marcação com nome inesperado no Blazor](/pt-br/2026/05/fix-rz10012-found-markup-element-with-unexpected-name-blazor/).
- Código de componente que acessa o DOM precisa respeitar o limite do modo de renderização, como visto em [Chamadas de interoperabilidade JavaScript não podem ser emitidas neste momento](/pt-br/2026/07/fix-javascript-interop-calls-cannot-be-issued-at-this-time-blazor-prerendering/).
- O mesmo instinto de evitar JS para algo que o framework faz nativamente vale para [baixar um arquivo de um componente Blazor sem interoperabilidade JavaScript](/pt-br/2026/08/how-to-download-a-file-from-a-blazor-component-without-javascript-interop/).
- Se a reconstrução de um cabeçalho está perdendo estado que importa para você, [persistir estado através do limite de renderização estática para interativa](/pt-br/2026/06/how-to-persist-state-across-the-blazor-static-to-interactive-render-boundary-in-dotnet-11/) cobre o mecanismo.
- O modo de renderização que você escolher decide se o bug de `MarkupString` acima é sequer alcançável; veja [Blazor Server vs WebAssembly vs United](/pt-br/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/).

## Fontes

- [Cenários avançados do Blazor no ASP.NET Core (construção da árvore de renderização)](https://learn.microsoft.com/en-us/aspnet/core/blazor/advanced-scenarios?view=aspnetcore-10.0), incluindo a orientação sobre números de sequência e o aviso de segurança sobre componentes malformados.
- [Componentes Razor renderizados dinamicamente no ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/dynamiccomponent?view=aspnetcore-10.0) para o contrato do `DynamicComponent`.
- [Referência da API `RenderTreeBuilder.OpenElement`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.components.rendering.rendertreebuilder.openelement).
- [`BrowserRenderer.ts` em dotnet/aspnetcore](https://github.com/dotnet/aspnetcore/blob/main/src/Components/Web.JS/src/Rendering/BrowserRenderer.ts) para ver como os frames de marcação são analisados e inseridos no cliente.
