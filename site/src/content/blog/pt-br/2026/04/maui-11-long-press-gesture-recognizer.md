---
title: ".NET MAUI 11 traz um LongPressGestureRecognizer embutido"
description: ".NET MAUI 11 Preview 3 adiciona LongPressGestureRecognizer como gesto de primeira classe, com duration, threshold de movimento, eventos de state, e binding de command, substituindo o behavior comum do Community Toolkit."
pubDate: 2026-04-16
tags:
  - "dotnet-maui"
  - "dotnet-11"
  - "xaml"
  - "mobile"
lang: "pt-br"
translationOf: "2026/04/maui-11-long-press-gesture-recognizer"
translatedBy: "claude"
translationDate: 2026-04-24
---

Até agora, detectar um long press no .NET MAUI significava apelar pra um behavior de terceiros, o [TouchBehavior do Community Toolkit](https://learn.microsoft.com/en-us/dotnet/communitytoolkit/maui/behaviors/touch-behavior), ou escrever platform handlers por OS. [.NET MAUI 11 Preview 3](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-3/) promove o padrão a uma API de primeira classe com `LongPressGestureRecognizer`, aterrissando via [dotnet/maui #33432](https://github.com/dotnet/maui/pull/33432).

## O que você ganha out of the box

O novo recognizer fica ao lado de `TapGestureRecognizer`, `PanGestureRecognizer`, e o resto da família. Expõe quatro coisas que importam pra UIs reais:

- `MinimumPressDuration` em milissegundos, padrão seguindo a convenção da plataforma (cerca de 500ms no Android, 400ms no iOS).
- Um `MovementThreshold` em unidades device-independent que cancela o gesto se o usuário arrastar além, então um scroll nunca dispara um long press.
- Um evento `StateChanged` reportando `Started`, `Running`, `Completed`, e `Canceled`, útil pra haptic feedback ou estados visuais de pressed.
- `Command` e `CommandParameter` pra bindings MVVM, e um evento `LongPressed` pra code-behind simples.

Como pendura em `GestureRecognizers`, qualquer `View` que já aceita gestos pega sem mudanças de handler.

## Substituindo TouchBehavior em XAML

Um menu de contexto numa imagem de avatar é o caso canônico. No .NET MAUI 10 isso tipicamente exigia um TouchBehavior com um `LongPressCommand`. No .NET MAUI 11 colapsa pra:

```xaml
<Image Source="avatar.png"
       HeightRequest="64"
       WidthRequest="64">
    <Image.GestureRecognizers>
        <LongPressGestureRecognizer
            MinimumPressDuration="650"
            MovementThreshold="10"
            Command="{Binding ShowContextMenuCommand}"
            CommandParameter="{Binding .}" />
    </Image.GestureRecognizers>
</Image>
```

O recognizer despacha na UI thread e passa o parâmetro bindado direto, então o view model fica platform-agnostic.

## Reagindo ao state pra feedback de press

O evento `StateChanged` é o que faz isso parecer nativo. A maioria dos long presses de plataforma anima uma escala ou atenua o target durante o hold, e cancela limpo se o dedo desviar. Com a nova API essa lógica vive num só lugar:

```csharp
var longPress = new LongPressGestureRecognizer
{
    MinimumPressDuration = 500
};

longPress.StateChanged += async (s, e) =>
{
    switch (e.State)
    {
        case GestureRecognizerState.Started:
            await card.ScaleTo(0.97, 80);
            break;
        case GestureRecognizerState.Completed:
            await HapticFeedback.Default.PerformAsync(HapticFeedbackType.LongPress);
            await card.ScaleTo(1.0, 80);
            ShowMenu();
            break;
        case GestureRecognizerState.Canceled:
            await card.ScaleTo(1.0, 80);
            break;
    }
};

card.GestureRecognizers.Add(longPress);
```

Esse único evento substitui três platform handlers e um Behavior ligado no `MauiProgram`.

## Por que isso importa pra autores de libraries

Libraries de controle que antes enviavam seu próprio plumbing de long-press agora podem se apoiar num contrato compartilhado. Um recognizer de `Microsoft.Maui.Controls` significa que bindings, input transparency, e propagação de `IsEnabled` já funcionam do jeito que o resto do framework funciona, então consumidores param de bater em inconsistências como o gesto disparando durante um scroll de `CollectionView` ou não respeitando `InputTransparent="True"` num parent.

Se você ainda está no TouchBehavior do Community Toolkit, a migração geralmente é uma troca de uma linha e um rename de property. Veja as [release notes completas do MAUI no Preview 3](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview3/dotnetmaui.md) pras mudanças circundantes de gestos e XAML.
