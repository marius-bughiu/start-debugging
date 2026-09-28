---
title: "Correção: Entry do .NET MAUI com Keyboard.Numeric mostra um teclado numérico pequeno e depois o teclado completo no iPadOS 26"
description: "No iPadOS 26, o MAUI mapeia Keyboard.Numeric para UIKeyboardType.DecimalPad, que agora abre como um mini teclado numérico flutuante. Adicione um mapper que troca o iPad para NumbersAndPunctuation e filtre a entrada você mesmo."
pubDate: 2026-09-28
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-10"
  - "maui"
  - "ios"
  - "csharp"
lang: "pt-br"
translationOf: "2026/09/fix-maui-numeric-entry-small-numpad-then-full-keyboard-on-ipados-26"
translatedBy: "claude"
translationDate: 2026-09-28
---

Se um `Entry` com `Keyboard="Numeric"` no .NET MAUI 10 abre um pequeno teclado numérico flutuante na primeira vez que você toca nele em um iPad, e depois o teclado de largura total na página de números na vez seguinte (às vezes sem ponto decimal, sem sinal de menos, ou com teclas que digitam o dígito errado), não é o MAUI que está trocando de teclado. É o iPadOS 26. O MAUI mapeia `Keyboard.Numeric` para `UIKeyboardType.DecimalPad`, e no iPadOS 26 esse tipo de teclado é apresentado como um teclado numérico compacto e flutuante quando ainda não há nenhum teclado acoplado. A correção que funciona hoje é adicionar ao `EntryHandler.Mapper` uma ação para que as entradas numéricas no iPad recebam `UIKeyboardType.NumbersAndPunctuation`, e então validar o texto você mesmo, porque esse teclado também consegue digitar letras. O iPhone não é afetado e continua com o teclado decimal normal.

## O erro em contexto

Não há exceção. O sintoma é um teclado que muda de formato entre eventos de foco. Em um iPad rodando iPadOS 26.0 ou 26.1 com um `Entry` numérico simples do MAUI:

```text
// .NET 10, Microsoft.Maui.Controls 10.0.x, iPad (10th gen), iPadOS 26.1
1st tap on Entry   -> small floating number pad (digits + decimal key), no Done bar
tap outside        -> keypad dismisses
2nd tap on Entry   -> full-width keyboard, numbers-and-symbols page
type "12.5"        -> field shows unexpected characters on some devices
switch to ABC page and back to 123 -> digits register correctly again
```

Quem pesquisa isso normalmente descreve só uma parte do problema: "Keyboard.Numeric not working on iOS", "no decimal point on iPad numeric keyboard", "numeric keypad floating on iPad", "MAUI Done button missing on iPad" ou "numbers type random characters on iPad". A issue de acompanhamento do MAUI é a [dotnet/maui#32288](https://github.com/dotnet/maui/issues/32288) (iPad 8ª geração, iOS 26.0.1, MAUI 10.0.0-rc.2, marcada como regressão e ainda aberta no backlog). O mesmo comportamento aparece no Flutter como [flutter/flutter#178096](https://github.com/flutter/flutter/issues/178096) e em apps nativos UIKit, o que denuncia que não se trata de um bug do MAUI.

## Por que o iPadOS 26 troca o teclado de um Entry numérico do MAUI

O mapeamento de teclado do MAUI no iOS é curto. Em [`KeyboardExtensions.cs`](https://github.com/dotnet/maui/blob/main/src/Core/src/Platform/iOS/KeyboardExtensions.cs) na `main`, `ApplyKeyboard` faz o seguinte para o caso numérico:

```csharp
// .NET MAUI main (10.0.x and 11 previews), src/Core/src/Platform/iOS/KeyboardExtensions.cs
else if (keyboard == Keyboard.Numeric)
    textInput.SetKeyboardType(UIKeyboardType.DecimalPad);
else if (keyboard == Keyboard.Telephone)
    textInput.SetKeyboardType(UIKeyboardType.PhonePad);
```

Antes do iPadOS 26, `DecimalPad` em um iPad simplesmente abria o teclado completo normal na página de números, porque o iPad nunca teve um teclado numérico dedicado. O iPadOS 26 mudou isso: `decimalPad` e `numberPad` agora apresentam um painel compacto e flutuante só com números. Os desenvolvedores esbarram em três problemas distintos com ele:

1. **O teclado flutuante só aparece quando nenhum teclado está acoplado.** Se o usuário estava digitando em um campo de texto e move o foco para o campo numérico, o teclado acoplado continua visível e muda para a página de números. Se o campo numérico é o first responder, você recebe o teclado flutuante. A issue do Flutter documenta exatamente isso: funciona quando o foco vem de um campo de texto e se comporta mal quando o campo numérico recebe o foco primeiro. É por isso que o teclado parece "trocar" dependendo do que o usuário tocou antes.
2. **O teclado flutuante esconde o `inputAccessoryView`.** O MAUI anexa seu próprio `MauiDoneAccessoryView` a todo `Entry` do iOS em `EntryHandler.CreatePlatformView()`. O [tópico 801458 dos Apple Developer Forums](https://developer.apple.com/forums/thread/801458) relata que o teclado flutuante não mostra a barra acessória, então sua barra Done, e qualquer barra personalizada de Next/Previous, desaparece.
3. **Dispensar e focar de novo produz o teclado completo com entrada incorreta.** O [tópico 808114](https://developer.apple.com/forums/thread/808114) (FB21144039) reproduz o problema no próprio app Contatos da Apple no iPadOS 26.0 até 26.1: toque em um campo numérico, receba o teclado pequeno, dispense-o, toque de novo, receba o teclado completo na página de números, e as teclas registram os caracteres errados até você trocar para a página de letras e voltar.

Nada disso está sob controle do MAUI, e não existe API do UIKit para desativar o teclado flutuante. O que você pode controlar é qual `UIKeyboardType` o campo de texto solicita.

## Reprodução mínima

```xml
<!-- .NET 10, Microsoft.Maui.Controls 10.0.x, run on an iPad with iPadOS 26.0 or 26.1 -->
<ContentPage xmlns="http://schemas.microsoft.com/dotnet/2021/maui"
             xmlns:x="http://schemas.microsoft.com/winfx/2009/xaml"
             x:Class="KeyboardRepro.MainPage">
    <VerticalStackLayout Padding="24" Spacing="16">
        <Entry Placeholder="Amount" Keyboard="Numeric" />
        <Entry Placeholder="Notes" />
    </VerticalStackLayout>
</ContentPage>
```

Inicie o app e toque em "Amount" primeiro: teclado numérico flutuante. Toque fora, toque em "Amount" de novo: teclado completo. Agora toque em "Notes" primeiro e depois em "Amount": teclado acoplado na página de números, sem teclado flutuante. Mesmo código, três teclados diferentes, decididos inteiramente pelo histórico de foco.

## Correção 1: mapear entradas numéricas para NumbersAndPunctuation no iPad

Esta é a solução alternativa a que o fórum da Apple chegou, traduzida para um mapeamento de handler do MAUI. `NumbersAndPunctuation` sempre fica acoplado, mantém a view acessória visível, tem separador decimal e sinal de menos, e se comporta da mesma forma no iPad há muitas versões do iOS.

Adicione isto ao `MauiProgram.cs`:

```csharp
// .NET 10, Microsoft.Maui.Controls 10.0.x, iOS/iPadOS 26
using Microsoft.Maui.Handlers;
#if IOS
using UIKit;
#endif

public static class MauiProgram
{
    public static MauiApp CreateMauiApp()
    {
        var builder = MauiApp.CreateBuilder();
        builder.UseMauiApp<App>();

#if IOS
        // Runs after MAUI's own "Keyboard" mapping, so it overrides DecimalPad.
        EntryHandler.Mapper.AppendToMapping(nameof(IEntry.Keyboard), (handler, entry) =>
        {
            if (entry.Keyboard != Keyboard.Numeric)
                return;

            if (UIDevice.CurrentDevice.UserInterfaceIdiom != UIUserInterfaceIdiom.Pad)
                return;

            if (!OperatingSystem.IsIOSVersionAtLeast(26))
                return;

            handler.PlatformView.KeyboardType = UIKeyboardType.NumbersAndPunctuation;
            handler.PlatformView.ReloadInputViews();
        });
#endif

        return builder.Build();
    }
}
```

Três detalhes importam aqui:

- **Use `AppendToMapping` com a chave `"Keyboard"`.** `AppendToMapping` encadeia sua ação depois do mapeamento existente para essa chave, então o MAUI primeiro executa `UpdateKeyboard` (que define `DecimalPad`, as flags de predição e correção ortográfica e depois chama `ReloadInputViews`), e sua ação em seguida sobrescreve o tipo de teclado. Se você usar `ModifyMapping` ou `PrependToMapping`, o mapeamento do MAUI roda por último e coloca o `DecimalPad` de volta. Qualquer mudança posterior em `Entry.Keyboard` executa a cadeia de novo, então um teclado definido por um binding ou um trigger também continua corrigido.
- **Chame `ReloadInputViews()` você mesmo.** Se a propriedade mudar enquanto o campo já está com foco, o UIKit não troca o teclado até que o campo de texto seja instruído a recarregar suas input views.
- **Proteja com `#if IOS`, não com `#if IOS || MACCATALYST`.** O Mac Catalyst usa teclado físico e não tem o problema do teclado numérico flutuante. O símbolo `IOS` não é definido para o target `net10.0-maccatalyst`, então esse código fica fora do build para Mac.

`OperatingSystem.IsIOSVersionAtLeast(26)` retorna `true` no iPadOS porque o iPadOS se identifica como iOS. A verificação de versão mantém os iPads que ainda estão no iPadOS 18 no caminho antigo e correto do `DecimalPad`. Eu deliberadamente não adicionei um limite superior: a Apple não documentou nenhuma mudança de comportamento, então teste novamente a cada nova versão do iPadOS antes de remover o mapeamento, em vez de chutar uma versão em que o problema desaparece.

## Correção 2: validar o texto, porque NumbersAndPunctuation não é só numérico

`NumbersAndPunctuation` é a página de números do teclado completo. O usuário pode tocar em "ABC" e digitar letras, e pode digitar vários separadores decimais. O `DecimalPad` nunca permitia isso, então código que fazia `decimal.Parse(entry.Text)` sem proteção vai começar a lançar `FormatException`.

Um pequeno behavior que rejeita tudo que não pode virar número resolve:

```csharp
// .NET 10, Microsoft.Maui.Controls 10.0.x
using System.Globalization;

public sealed class DecimalInputBehavior : Behavior<Entry>
{
    protected override void OnAttachedTo(Entry entry)
    {
        entry.TextChanged += OnTextChanged;
        base.OnAttachedTo(entry);
    }

    protected override void OnDetachingFrom(Entry entry)
    {
        entry.TextChanged -= OnTextChanged;
        base.OnDetachingFrom(entry);
    }

    static void OnTextChanged(object? sender, TextChangedEventArgs e)
    {
        if (sender is not Entry entry || string.IsNullOrEmpty(e.NewTextValue))
            return;

        // Appending "0" lets partial input like "-", "12." or "," pass while typing.
        var candidate = e.NewTextValue + "0";
        var ok = decimal.TryParse(
            candidate,
            NumberStyles.AllowLeadingSign | NumberStyles.AllowDecimalPoint,
            CultureInfo.CurrentCulture,
            out _);

        if (!ok)
            entry.Text = e.OldTextValue;
    }
}
```

```xml
<!-- .NET 10, Microsoft.Maui.Controls 10.0.x -->
<Entry Placeholder="Amount" Keyboard="Numeric" ReturnType="Done">
    <Entry.Behaviors>
        <local:DecimalInputBehavior />
    </Entry.Behaviors>
</Entry>
```

Dois motivos para fazer isso na camada compartilhada em vez de interceptar `UITextField.ShouldChangeCharacters` no iOS: o `EntryHandler` do MAUI já é dono desse delegate para aplicar o `MaxLength` (e no iOS 26 usa a variante mais nova com múltiplos intervalos), então substituí-lo quebra o `MaxLength` silenciosamente. E o behavior também protege Android e Windows, onde um teclado físico pode digitar qualquer coisa em um campo numérico.

Fazer o parse com `CultureInfo.CurrentCulture` importa. Em um iPad em alemão, a página de números mostra uma vírgula, e `"12,5"` precisa ser interpretado. Se o seu backend espera entrada invariante, converta uma vez quando ler o valor, não enquanto o usuário digita.

## Correção 3: restaurar a tecla Done no iPad

Com `DecimalPad` no iPhone, o `MauiDoneAccessoryView` do MAUI oferece um botão Done, porque o teclado decimal do iPhone não tem tecla de retorno. `NumbersAndPunctuation` tem tecla de retorno, então defina `ReturnType="Done"` (como no XAML acima) e trate o `Completed`:

```csharp
// .NET 10, Microsoft.Maui.Controls 10.0.x
AmountEntry.Completed += (_, _) =>
{
    AmountEntry.Unfocus();
    // Commit the value, move focus to the next field, etc.
};
```

No iPhone nada muda: o mapeamento da Correção 1 nunca roda lá, o teclado decimal permanece e a barra acessória Done continua funcionando.

## Ativando por Entry em vez de globalmente

Um mapeamento global altera todo `Entry` numérico do app, incluindo os que estão dentro de controles de terceiros. Se você só quer isso em alguns campos, crie uma subclasse de `Entry` e verifique o tipo no mapeamento:

```csharp
// .NET 10, Microsoft.Maui.Controls 10.0.x
public class AmountEntry : Entry
{
    public AmountEntry() => Keyboard = Keyboard.Numeric;
}

#if IOS
EntryHandler.Mapper.AppendToMapping(nameof(IEntry.Keyboard), (handler, entry) =>
{
    if (entry is AmountEntry &&
        UIDevice.CurrentDevice.UserInterfaceIdiom == UIUserInterfaceIdiom.Pad &&
        OperatingSystem.IsIOSVersionAtLeast(26))
    {
        handler.PlatformView.KeyboardType = UIKeyboardType.NumbersAndPunctuation;
        handler.PlatformView.ReloadInputViews();
    }
});
#endif
```

O mapper continua global (é um membro estático de `EntryHandler`), mas a verificação de tipo limita o efeito. Esse é o mesmo padrão que o MAUI usa para qualquer ajuste de plataforma que não expõe como propriedade; a documentação de personalização de handlers no [Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/maui/user-interface/handlers/customize) explica em detalhes a ordem do `AppendToMapping`.

## Armadilhas e problemas parecidos

- **`Keyboard.Telephone` é mapeado para `PhonePad`.** Se os seus campos de telefone mostram o mesmo teclado flutuante nos iPads de teste, estenda a condição da Correção 1 para `entry.Keyboard == Keyboard.Numeric || entry.Keyboard == Keyboard.Telephone`. Para números de telefone, `UIKeyboardType.NumbersAndPunctuation` ainda oferece `+`, `(`, `)` e `-`.
- **Um `CustomKeyboard` não é afetado.** `Keyboard.Create(KeyboardFlags...)` nunca define `DecimalPad`, então nunca aciona o teclado flutuante, e também nunca oferece um teclado numérico no iOS. Não recorra a ele como correção.
- **"Sem ponto decimal" no iPhone é outro problema.** No iPhone, `DecimalPad` mostra o separador do formato regional do dispositivo, não o idioma do app. Um app em inglês dos EUA em um dispositivo configurado para uma região que usa vírgula mostra uma vírgula. Esse não é um comportamento do iPadOS 26, e o parse sensível à cultura da Correção 2 é a resposta nesse caso.
- **Teclas digitando os caracteres errados (FB21144039).** Esse bug está no teclado completo depois que o teclado flutuante foi dispensado. Como a Correção 1 nunca mostra o teclado flutuante, a sequência de dispensar e focar de novo que o provoca não acontece. Se um usuário mesmo assim encontrar o problema, trocar para a página de letras e voltar o reinicia.
- **Outras personalizações do handler de `Entry`.** Se você já adiciona ações a `"Keyboard"` em outro lugar (por exemplo, para incluir uma barra de ferramentas personalizada), a ordem das chamadas de `AppendToMapping` é a ordem em que elas rodam. Mantenha todas as sobrescritas de teclado em um único lugar para que fique óbvio quem escreve por último.

## Relacionados

- A mesma abordagem de mapeamento de handler é o que resolve outros problemas de aparência nativa, como o de [mudar a cor do ícone da SearchBar no .NET MAUI](/pt-br/2025/04/how-to-change-searchbars-icon-color-in-net-maui/).
- Para outra surpresa exclusiva do iOS em que a plataforma, e não o MAUI, decide o resultado, veja [como corrigir UIKitThreadAccessException de MediaPicker.PickPhotosAsync no iOS](/pt-br/2026/09/fix-uikitthreadaccessexception-from-mediapicker-pickphotosasync-in-maui-ios/).
- Se você ainda usa custom renderers do Xamarin.Forms para ajustes de teclado, [o guia de migração do Xamarin.Forms para o MAUI 11](/pt-br/2026/05/migrate-from-xamarin-forms-to-maui-11/) mostra como os renderers se traduzem em mappers de handler.
- O equivalente no Android de "o sistema mudou a aparência por baixo do meu app" é [a flag `UseMaterial3` do Material 3 no MAUI 10](/pt-br/2026/05/maui-10-material-3-android-usematerial3-flag/).
- Para a lista mais ampla de mudanças do MAUI 10, comece por [o que há de novo no .NET MAUI 10](/pt-br/2025/04/whats-new-in-net-maui-10/).

## Fontes

- [dotnet/maui#32288: Keyboard Numeric is not working in iOS](https://github.com/dotnet/maui/issues/32288)
- [`KeyboardExtensions.cs` do MAUI no iOS](https://github.com/dotnet/maui/blob/main/src/Core/src/Platform/iOS/KeyboardExtensions.cs) e [`EntryHandler.iOS.cs`](https://github.com/dotnet/maui/blob/main/src/Core/src/Handlers/Entry/EntryHandler.iOS.cs)
- [Apple Developer Forums: iPad, how to prevent the new floating decimalPad](https://developer.apple.com/forums/thread/801458)
- [Apple Developer Forums: Erratic numberPad keyboard behaviour on iPadOS 26 (FB21144039)](https://developer.apple.com/forums/thread/808114)
- [flutter/flutter#178096: Weird numeric keyboard on iPadOS 26/26.1](https://github.com/flutter/flutter/issues/178096)
- [`UIKeyboardType.decimalPad` na Apple Developer Documentation](https://developer.apple.com/documentation/uikit/uikeyboardtype/decimalpad)
- [Personalizar controles do .NET MAUI com handlers](https://learn.microsoft.com/en-us/dotnet/maui/user-interface/handlers/customize)
