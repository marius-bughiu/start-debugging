---
title: ".NET MAUI 10 SR6 finaliza Material 3 no Android atrás de uma única flag UseMaterial3"
description: "MAUI 10 SR6 (10.0.60) estende o tema Material 3 para Button, Entry, SearchBar, DatePicker, Slider, ProgressBar, ImageButton, Switch e Shell no Android. Ative com uma propriedade MSBuild. Sem renderers customizados, sem editar styles.xml."
pubDate: 2026-05-27
tags:
  - "dotnet"
  - "maui"
  - "android"
  - "material-3"
  - "dotnet-10"
lang: "pt-br"
translationOf: "2026/05/maui-10-material-3-android-usematerial3-flag"
translatedBy: "claude"
translationDate: 2026-05-27
---

A Microsoft entregou o [último grande bloco de suporte ao Material 3 para .NET MAUI no Android](https://devblogs.microsoft.com/dotnet/dotnet-maui-material-3/) na versão .NET MAUI 10 SR6 (10.0.60), anunciada em 26 de maio de 2026. A parte interessante não é que Material 3 chegou. É que a ativação é exatamente uma propriedade MSBuild e que o time manteve a customização de handlers totalmente fora da equação.

Se você acompanhou a história mobile do .NET 11, o próprio MAUI também está [trocando o runtime padrão para CoreCLR no Android e iOS no .NET 11 Preview 4](/pt-br/2026/05/maui-coreclr-default-android-ios-dotnet-11-preview-4/). Material 3, porém, é um recurso do .NET MAUI 10 e é entregue hoje pela cadência de service release suportada.

## Como o lançamento foi fatiado

Material 3 não chegou de uma vez só. O recurso foi distribuído em três service releases do .NET MAUI 10:

- **SR3 (10.0.30)**: estilos base de Material 3 para um punhado de controles.
- **SR4 (10.0.40)**: `CheckBox` ganhou o novo tema.
- **SR6 (10.0.60)**: o grande lote. `Button`, `Entry`, `SearchBar`, `DatePicker`, `Slider`, `ProgressBar`, `ImageButton`, `Switch` e tema completo de `Shell`.

O conjunto suportado completo no SR6 cobre `Entry`, `Editor`, `SearchBar`, `RadioButton`, `ProgressBar`, `Slider`, `Picker`, `TimePicker`, `DatePicker`, `CheckBox`, `Switch`, `ImageButton`, `Button`, `Label`, `ActivityIndicator`, `Image` e `Shell`.

## A ativação é uma única propriedade

Toda a ativação é uma única propriedade no seu `.csproj`:

```xml
<PropertyGroup>
  <UseMaterial3>true</UseMaterial3>
</PropertyGroup>
```

É essa toda a superfície. Recompile, implante em um dispositivo ou emulador Android, e os controles suportados começam a aplicar o estilo Material 3 automaticamente. Sem customização de handlers, sem renderers customizados, sem mexer em `Resources/values/styles.xml`, sem alterações em `MainActivity`.

Se quiser limitar a flag só ao Android, use a condição padrão de MSBuild:

```xml
<PropertyGroup Condition="$(TargetFramework.Contains('-android'))">
  <UseMaterial3>true</UseMaterial3>
</PropertyGroup>
```

## Estilos explícitos continuam vencendo

O time manteve a regra de precedência do jeito que você gostaria. Qualquer coisa definida explicitamente em XAML ou C# sobrescreve os padrões do Material 3:

```xml
<Button Text="Save"
        BackgroundColor="#0F62FE"
        TextColor="White" />
```

Esse botão mantém o azul IBM. Material 3 só preenche onde você ainda não pintou. Handlers e renderers customizados ficam intocados, o que importa se você já tem um design system sobrescrevendo controles específicos; ativar a flag não vai silenciosamente reestilizar coisas que você customizou de propósito.

## Por que isso importa

O gap visual do Android é uma das reclamações mais antigas sobre MAUI. Controles padrão pareciam datados, corrigir isso exigia descer ao XML de tema do Android, e qualquer workaround por controle tendia a se desviar do que o Google entregava no próximo release do Material. Uma única flag MSBuild que acompanha Material 3 ao longo dos SR é uma redução significativa da superfície de manutenção para qualquer time que ainda não tenha um design system fechado.

O movimento pragmático em um app MAUI 10 existente: subir para 10.0.60, definir `UseMaterial3` como `true`, rodar o app em um emulador Android e percorrer cada tela. Qualquer lugar onde você estilizou manualmente para compensar os padrões antigos agora é candidato a ser apagado.
