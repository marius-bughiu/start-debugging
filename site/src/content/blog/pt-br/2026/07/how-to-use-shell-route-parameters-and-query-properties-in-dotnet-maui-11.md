---
title: "Como usar parâmetros de rota do Shell e query properties para navegação no .NET MAUI 11"
description: "Guia completo para passar dados pela navegação do Shell no .NET MAUI 11: registrar rotas globais, parâmetros de consulta do tipo string, QueryPropertyAttribute versus IQueryAttributable, a assimetria de decodificação de URL entre os dois, ShellNavigationQueryParameters de uso único versus a sobrecarga com IDictionary que retém memória, passar dados de volta com ..?key=value, e por que QueryPropertyAttribute não é seguro para trimming."
pubDate: 2026-07-28
template: how-to
tags:
  - "maui"
  - "dotnet-maui"
  - "dotnet-11"
  - "csharp"
  - "shell"
  - "navigation"
  - "how-to"
lang: "pt-br"
translationOf: "2026/07/how-to-use-shell-route-parameters-and-query-properties-in-dotnet-maui-11"
translatedBy: "claude"
translationDate: 2026-07-28
---

Para passar dados a uma página durante a navegação do Shell no .NET MAUI 11, registre a página de destino como rota global com `Routing.RegisterRoute("details", typeof(DetailPage))`, navegue com `await Shell.Current.GoToAsync($"details?id={id}")` e receba o valor decorando a classe receptora com `[QueryProperty(nameof(Id), "id")]` ou implementando `IQueryAttributable.ApplyQueryAttributes`. Prefira `IQueryAttributable`: `QueryPropertyAttribute` não é seguro para trimming e quebra sob trimming completo ou Native AOT. Para qualquer coisa que não seja uma string, use a sobrecarga `GoToAsync(string, ShellNavigationQueryParameters)` em vez da de `IDictionary<string, object>`, porque a versão com dicionário mantém seu objeto vivo por todo o ciclo de vida da página.

Este artigo mira o .NET MAUI 11 (Preview 6 no momento da escrita, GA em novembro de 2026) com C# 14. A API de navegação do Shell está estável desde o .NET MAUI 8, então tudo exceto as notas específicas do .NET 11 no final vale igualmente para .NET MAUI 8, 9 e 10.

## Como o Shell transforma uma URI em uma página

A navegação do Shell é baseada em URIs. Uma URI de navegação completa tem três partes, no formato `//route/page?queryParameters`:

- A **rota** é um caminho dentro da hierarquia visual do Shell, formado pelas propriedades `Route` que você define em `FlyoutItem`, `TabBar`, `Tab` e `ShellContent`.
- A **página** é algo que não vive na hierarquia visual e é empilhada em uma pilha de navegação sob demanda. Páginas de detalhe quase sempre são assim.
- Os **parâmetros de consulta** são a cauda `?key=value&key2=value2`.

Essa divisão importa mais do que parece, porque os dois tipos de destino seguem regras opostas:

| | Declarado em `AppShell.xaml` | Registrado com `Routing.RegisterRoute` |
| --- | --- | --- |
| Alcançado por | rota absoluta, `//animals/monkeys` | rota relativa, `monkeydetails` |
| Cria uma pilha de navegação | não | sim |
| Funciona com a outra forma | apenas absoluta | apenas relativa |

Rotas absolutas não funcionam com páginas registradas via `Routing.RegisterRoute`, e rotas relativas não funcionam com páginas declaradas dentro da sua subclasse de `Shell`. Inverter isso é a causa mais comum de um `ArgumentException` numa chamada a `GoToAsync` que parece correta.

## Conecte uma rota de detalhe em cinco passos

1. **Dê rotas explícitas aos itens do seu Shell.** Todo item da hierarquia recebe uma rota, você definindo ou não, mas rotas geradas não têm garantia de consistência entre sessões do aplicativo, então nunca dependa delas:

   ```xml
   <!-- AppShell.xaml, .NET MAUI 11 -->
   <Shell xmlns="http://schemas.microsoft.com/dotnet/2021/maui"
          x:Class="OrdersApp.AppShell">
       <TabBar>
           <ShellContent Title="Orders"
                         Route="orders"
                         ContentTemplate="{DataTemplate local:OrdersPage}" />
           <ShellContent Title="Settings"
                         Route="settings"
                         ContentTemplate="{DataTemplate local:SettingsPage}" />
       </TabBar>
   </Shell>
   ```

2. **Registre a página de detalhe como rota global** no construtor da subclasse de `Shell`, ou em qualquer outro lugar que execute antes de a rota ser invocada pela primeira vez:

   ```csharp
   // AppShell.xaml.cs, .NET MAUI 11
   public partial class AppShell : Shell
   {
       public AppShell()
       {
           InitializeComponent();
           Routing.RegisterRoute("orderdetails", typeof(OrderDetailPage));
       }
   }
   ```

   Registrar a mesma string de rota para dois tipos diferentes lança um `ArgumentException`, e o mesmo vale para uma rota duplicada detectada na hierarquia visual na inicialização.

3. **Registre a página e seu view model no container de injeção de dependência** para que o Shell consiga construí-los com suas dependências:

   ```csharp
   // MauiProgram.cs, .NET MAUI 11
   builder.Services.AddTransient<OrderDetailPage>();
   builder.Services.AddTransient<OrderDetailViewModel>();
   ```

4. **Defina o `BindingContext` no construtor da página**, não em `OnAppearing`. O Shell aplica os query attributes à página *e* ao seu `BindingContext` imediatamente depois de construir a página, bem antes de `OnAppearing` rodar. Um view model anexado depois nunca vê os parâmetros:

   ```csharp
   public partial class OrderDetailPage : ContentPage
   {
       public OrderDetailPage(OrderDetailViewModel vm)
       {
           InitializeComponent();
           BindingContext = vm;   // must happen here
       }
   }
   ```

5. **Navegue, e sempre use `await` na chamada.** Navegação sem esperar é uma condição de corrida: o código após a chamada pode rodar antes de a navegação terminar, o que aparece como parâmetros de consulta faltando, um `Shell.Current.CurrentPage` desatualizado, ou uma navegação que silenciosamente não faz nada.

   ```csharp
   // Correct
   await Shell.Current.GoToAsync($"orderdetails?id={order.Id}");

   // Wrong: race condition
   Shell.Current.GoToAsync($"orderdetails?id={order.Id}");
   ```

## Receber parâmetros do tipo string: duas APIs, uma diferença importante

Ambos os mecanismos de recepção funcionam tanto na classe da página quanto na classe usada como seu `BindingContext`.

`QueryPropertyAttribute` mapeia um id de parâmetro de consulta para uma propriedade. O primeiro argumento é o nome da propriedade, o segundo é o id do parâmetro na URI:

```csharp
// .NET MAUI 11, C# 14
[QueryProperty(nameof(OrderId), "id")]
[QueryProperty(nameof(CustomerName), "customer")]
public partial class OrderDetailPage : ContentPage
{
    public string OrderId { set => LoadOrder(value); }
    public string CustomerName { set => Title = value; }
}
```

`IQueryAttributable` entrega tudo em um único dicionário, que é o que você quer assim que dois parâmetros precisam ser validados juntos:

```csharp
// .NET MAUI 11, C# 14
public partial class OrderDetailViewModel : ObservableObject, IQueryAttributable
{
    [ObservableProperty]
    private Order? _order;

    public void ApplyQueryAttributes(IDictionary<string, object> query)
    {
        if (!query.TryGetValue("id", out var raw) || !int.TryParse(raw?.ToString(), out var id))
            return;

        var customer = HttpUtility.UrlDecode(query["customer"].ToString());
        Order = _repository.Load(id, customer);
    }
}
```

Repare na chamada a `HttpUtility.UrlDecode`, porque aqui está a assimetria que custa uma tarde: **valores de parâmetros de consulta do tipo string recebidos via `QueryPropertyAttribute` são decodificados de URL automaticamente, e os recebidos via `IQueryAttributable` não são.** Trocar uma classe do atributo para a interface sem adicionar a decodificação transforma `Acme%20Corp` em um literal `Acme%20Corp` na sua interface.

A regra correspondente do lado emissor é que você precisa codificar qualquer coisa que possa conter `&`, `?`, `#`, `=` ou um espaço:

```csharp
// .NET MAUI 11, C# 14
var url = $"orderdetails?id={order.Id}&customer={Uri.EscapeDataString(order.CustomerName)}";
await Shell.Current.GoToAsync(url);
```

Sem `Uri.EscapeDataString`, um cliente chamado "Smith & Sons" trunca o parâmetro no e comercial e cria silenciosamente um parâmetro fantasma `Sons`.

## Passar objetos, e a sobrecarga que vaza

Parâmetros do tipo string servem bem para identificadores. Para algo mais rico existem duas sobrecargas, e elas se comportam de forma bem diferente.

A sobrecarga com `IDictionary<string, object>` passa dados de **uso múltiplo**:

```csharp
// .NET MAUI 11, C# 14
var parameters = new Dictionary<string, object> { ["Order"] = order };
await Shell.Current.GoToAsync("orderdetails", parameters);
```

Dados passados assim ficam retidos em memória por todo o ciclo de vida da página e não são liberados até a página sair da pilha de navegação. Eles também são reentregues no caminho de volta: se `Page1` passa `MyData` para `Page2`, e `Page2` empilha `Page3`, desempilhar `Page3` faz `Page2` receber `MyData` de novo. Essa reentrega é ocasionalmente o que você quer e normalmente o que você não esperava. Se não quiser, chame `Clear()` no dicionário depois que a página receptora tiver lido o valor.

A sobrecarga com `ShellNavigationQueryParameters` passa dados de **uso único** que o Shell limpa para você depois que a navegação termina:

```csharp
// .NET MAUI 11, C# 14
var parameters = new ShellNavigationQueryParameters { ["Order"] = order };
await Shell.Current.GoToAsync("orderdetails", parameters);
```

`ShellNavigationQueryParameters` implementa `IDictionary<string, object>`, então o lado receptor é idêntico. Use essa por padrão. Recorra ao dicionário simples só quando quiser ativamente que o valor seja reentregue na navegação de volta.

Você pode combinar os dois em uma única chamada: uma URI com parâmetros de consulta do tipo string mais um dicionário de objetos. O `ApplyQueryAttributes` receptor recebe um único dicionário mesclado com os dois conjuntos de chaves.

## Enviar dados de volta

A navegação de volta é `..`, e parâmetros de consulta podem ser anexados a ela. Esta é a forma limpa de retornar um resultado de uma página seletora sem um barramento de mensagens ou um singleton compartilhado:

```csharp
// On the picker page, .NET MAUI 11
await Shell.Current.GoToAsync($"..?selectedId={selected.Id}");
```

A página anterior recebe `selectedId` pelo mecanismo que ela usa, exatamente como se tivesse sido navegada para frente. Objetos também funcionam:

```csharp
var result = new ShellNavigationQueryParameters { ["Selection"] = selected };
await Shell.Current.GoToAsync("..", result);
```

`..` se compõe: `"../../route"` desempilha duas vezes e depois navega para `route`. Isso só funciona se desempilhar realmente deixar você em um ponto da hierarquia a partir do qual `route` seja alcançável.

## Rotas contextuais

Rotas globais podem ser registradas em um caminho em vez de um nome solto, o que faz a mesma rota relativa resolver para páginas diferentes dependendo de onde você está:

```csharp
// AppShell.xaml.cs, .NET MAUI 11
Routing.RegisterRoute("orders/details", typeof(OrderDetailPage));
Routing.RegisterRoute("invoices/details", typeof(InvoiceDetailPage));
```

Agora `await Shell.Current.GoToAsync("details?id=42")` abre `OrderDetailPage` a partir da seção de pedidos e `InvoiceDetailPage` a partir da de faturas. É um jeito elegante de manter um `ItemsViewModel` compartilhado livre de ramificações específicas do destino.

## Armadilhas que vale conhecer antes de publicar

**`QueryPropertyAttribute` não é seguro para trimming.** Desde o .NET MAUI 9 a documentação traz um aviso explícito: o atributo depende de reflexão para encontrar a propriedade e não deve ser usado com trimming completo nem com Native AOT. Implemente `IQueryAttributable` em qualquer tipo que aceite parâmetros de consulta. Se seu aplicativo caminha para uma publicação com trimming ou AOT, trate isso como o fator decisivo entre as duas APIs, não como preferência estilística. Meu artigo sobre [o que é de fato código seguro para trimming](/pt-br/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/) mostra como fazer o analisador avisar sobre o resto antes da hora de publicar.

**`//page` e `///page` são inválidas.** Atualmente rotas globais não podem ser a única página da pilha de navegação, então roteamento absoluto para uma rota global lança exceção. Rotas absolutas são só para a hierarquia visual.

**Navegar para uma rota inexistente lança `ArgumentException`.** Não há no-op silencioso nem rota de fallback, então um erro de digitação numa string de rota é uma falha, não uma página em branco. Mantenha os nomes de rota em uma `static class Routes` com campos `const string` e use-os tanto no registro quanto na navegação.

**`Tab.Stack` é somente leitura.** Você não pode adicionar, remover ou reordenar páginas mutando-a. Para reiniciar a pilha, navegue para uma rota absoluta (`//orders`); para voltar, use `..`.

**Setters de propriedade disparam na ordem dos atributos, não na ordem da URI.** Com vários atributos `[QueryProperty]`, não escreva um setter que assuma que outro parâmetro já chegou. Se dois valores precisam ser validados juntos, esse é exatamente o caso para o qual `IQueryAttributable` existe.

**Navegação adiada bloqueia `GoToAsync`.** Se você usa `args.GetDeferral()` dentro de uma sobrescrita de `OnNavigating`, `GoToAsync` lança `InvalidOperationException` enquanto o adiamento estiver pendente. Note que .NET MAUI 10 e 11 renomearam as APIs de diálogo, então o exemplo canônico de adiamento agora usa `DisplayActionSheetAsync` em vez de `DisplayActionSheet`.

## O que mudou para o Shell no .NET MAUI 11

O contrato de navegação em si não muda no .NET 11, e isso é proposital: a versão é focada em qualidade. Três coisas ao redor merecem nota.

A partir do .NET 11 Preview 6, **aplicativos Shell no Android usam por padrão a arquitetura de Shell baseada em handlers** ([PR #34758](https://github.com/dotnet/maui/pull/34758)). O caminho legado do `ShellRenderer` continua disponível se você registrá-lo explicitamente. Se você tem renderers de Shell customizados no Android, essa é a mudança a testar primeiro contra regressão.

A partir do Preview 5, `BackButtonBehavior` ganhou a propriedade **`AccessibilityLabel`** ([PR #35011](https://github.com/dotnet/maui/pull/35011)). Ela é independente de `TextOverride`, então o rótulo visível pode ficar curto enquanto o rótulo falado continua descritivo. Defina-a sempre que definir `IconOverride`, porque um leitor de tela não tem nada útil a anunciar para um ícone sozinho:

```xml
<!-- .NET MAUI 11 -->
<Shell.BackButtonBehavior>
    <BackButtonBehavior IconOverride="back.png"
                        AccessibilityLabel="Back to order list" />
</Shell.BackButtonBehavior>
```

E o runtime por baixo de tudo isso mudou: CoreCLR agora é o padrão em todas as plataformas do .NET MAUI, o que cobri em [MAUI mobile virando CoreCLR only no Preview 6](/pt-br/2026/07/maui-coreclr-only-runtime-in-dotnet-11-preview-6/). Isso não altera a semântica de navegação, mas altera o perfil de trimming e de inicialização do aplicativo pelo qual você está navegando, o que nos devolve à recomendação de `IQueryAttributable` acima.

## Relacionados

- [Migrar do Xamarin.Forms 5.0 para o .NET MAUI 11: o checklist completo](/pt-br/2026/05/migrate-from-xamarin-forms-to-maui-11/), que cobre a fiação do `AppShell` necessária antes de qualquer coisa aqui se aplicar.
- [Migrar um ListView de alto desempenho do Xamarin.Forms para o CollectionView do MAUI](/pt-br/2026/05/how-to-migrate-a-xamarin-forms-listview-to-maui-collectionview/), pelo handler de mudança de seleção que normalmente dispara uma navegação de detalhe.
- [Como registrar e resolver serviços com chave na injeção de dependência do .NET 11](/pt-br/2026/06/how-to-register-and-resolve-keyed-services-in-dotnet-11-dependency-injection/), útil quando duas rotas precisam de implementações diferentes da mesma interface de repositório.
- [O que é Native AOT e quanto ele custa?](/pt-br/2026/06/what-is-native-aot-and-what-does-it-cost-you/), pelo modo de publicação que torna `QueryPropertyAttribute` inviável.
- [Como dar suporte correto ao modo escuro em um aplicativo .NET MAUI](/pt-br/2026/05/how-to-support-dark-mode-correctly-in-a-maui-app/), porque o cromo do Shell é a primeira coisa que fica errada quando a tematização está pela metade.

## Fontes

- [.NET MAUI Shell navigation](https://learn.microsoft.com/en-us/dotnet/maui/fundamentals/shell/navigation), Microsoft Learn, moniker .NET MAUI 11.
- [ShellNavigationQueryParameters class](https://learn.microsoft.com/en-us/dotnet/api/microsoft.maui.controls.shellnavigationqueryparameters), referência de API do .NET MAUI.
- [IQueryAttributable interface](https://learn.microsoft.com/en-us/dotnet/api/microsoft.maui.controls.iqueryattributable), referência de API do .NET MAUI.
- [What's new in .NET MAUI for .NET 11](https://learn.microsoft.com/en-us/dotnet/maui/whats-new/dotnet-11), Microsoft Learn.
- [Handler de Shell no Android por padrão, dotnet/maui PR #34758](https://github.com/dotnet/maui/pull/34758).
- [Rótulo de acessibilidade do botão voltar, dotnet/maui PR #35011](https://github.com/dotnet/maui/pull/35011).
