---
title: "Migre um app .NET MAUI para Android para o nível de API 36"
description: "O Google Play passou a exigir o nível de API alvo 36 desde 2026-08-31, com prorrogações até 2026-11-01. Este é o caminho completo no .NET MAUI de net9.0-android até a API 36: a mudança de target framework, o uses-sdk fixo que silenciosamente te prende no nível antigo, o edge-to-edge sem opção de exclusão, o gesto de voltar preditivo e as regras de telas grandes."
pubDate: 2026-09-04
updatedDate: 2026-09-04
template: migration
tags:
  - "migration"
  - "maui"
  - "android"
  - "google-play"
  - "dotnet-10"
  - "dotnet-11"
lang: "pt-br"
translationOf: "2026/09/migrate-a-dotnet-maui-android-app-to-target-android-api-level-36"
translatedBy: "claude"
translationDate: 2026-09-04
---

A mudança de build é uma linha. As mudanças de comportamento são a migração. O Google Play começou a exigir o nível de API alvo 36 para apps novos e atualizações em 2026-08-31, com uma prorrogação por app disponível no Play Console até 2026-11-01, então se sua atualização foi rejeitada esta semana, é por isso. Em um app .NET MAUI o nível de API alvo não é uma configuração do manifesto que você edita: ele deriva da versão da plataforma Android no seu `TargetFramework`, e o .NET 9 vai no máximo até a API 35. Ou seja, isto é uma atualização do SDK do .NET para o .NET 10 (ou .NET 11), não um ajuste de manifesto. Reserve um dia para um app pequeno e um sprint para qualquer um com orientação travada, botão de voltar personalizado ou insets ajustados na mão. Este guia mira o .NET 10 com .NET MAUI 10.0.100 (lançado em 2026-08-20) como destino, e aponta onde o .NET 11 difere.

## Por que o Play verifica justamente o nível alvo

- **`targetSdkVersion` é o portão, não `compileSdk` nem `minSdk`.** O Play lê `android:targetSdkVersion` do manifesto mesclado dentro do seu AAB. Compilar contra a plataforma da API 36 sozinho não basta.
- **Instalações existentes não são removidas, usuários novos é que ficam de fora.** Segundo a [política de nível de API alvo do Play Console](https://support.google.com/googleplay/android-developer/answer/11926878), apps abaixo do piso continuam nos aparelhos que já os têm, mas deixam de estar disponíveis para novos usuários em versões do Android mais recentes que o alvo do app. Seu funil de instalação degrada em silêncio em vez de quebrar de forma visível.
- **O piso de cada ano é o lançamento do ano anterior.** A API 36 é o Android 16. O requisito de 2027 será a API 37 (Android 17), que o .NET for Android já entrega como estável, então o trabalho que você faz aqui é trabalho que você faz uma vez por ano para sempre.

## O que quebra

| Área | Mudança com alvo API 36 | Severidade |
| --- | --- | --- |
| Edge-to-edge | `windowOptOutEdgeToEdgeEnforcement` está obsoleto e é ignorado em aparelhos com Android 16 | alta |
| Áreas seguras do .NET MAUI | `ContentPage.SafeAreaEdges` passa a valer `None` por padrão a partir do .NET 10, então as páginas vão de borda a borda | alta |
| Voltar preditivo | As animações de volta à tela inicial e entre atividades ficam ativas por padrão; `OnBackPressed` não é chamado | alta |
| Telas grandes | `android:screenOrientation`, `resizableActivity`, `minAspectRatio` e `maxAspectRatio` são ignorados a partir de `sw600dp` | alta (tablets, dobráveis) |
| SDK do .NET | A API 36 exige `net10.0-android` ou posterior; a workload do .NET 9 para na API 35 | alta |
| API mínima | O .NET 11 sobe o piso da API 21 para a API 24 | média (só .NET 11) |
| Renderização de texto | `android:elegantTextHeight` está obsoleto e é ignorado | baixa |
| Agendamento | `ScheduledExecutorService.scheduleAtFixedRate` repõe no máximo uma execução perdida | baixa |
| Sensores de saúde | `BODY_SENSORS` substituído por permissões granulares `android.permissions.health` | baixa (a menos que você leia frequência cardíaca) |

As duas primeiras linhas se somam. Atualizar para o .NET 10 para conseguir a API 36 também muda o padrão de áreas seguras do próprio .NET MAUI no mesmo commit, então um app que estava bem no .NET 9 com alvo 35 pode sair do processo com a barra de título embaixo da barra de status por dois motivos independentes.

## Checklist de pré-voo

- SDK do .NET 10 instalado, com a workload `maui-android` restaurada: `dotnet workload install maui-android`.
- A plataforma do SDK do Android para a API 36 realmente presente na máquina de build e no CI. A ausência dela produz [XA5207](https://learn.microsoft.com/en-us/dotnet/android/messages/xa5207), não um aviso.
- Um aparelho físico ou uma imagem de emulador rodando Android 16. As mudanças de comportamento aqui dependem tanto da versão do sistema quanto do seu alvo, então um emulador com Android 14 vai esconder todas elas.
- Capturas de tela da sua interface atual em um celular e em um tablet, antes de mexer em qualquer coisa. Você vai precisar delas para julgar as regressões de insets.
- A situação do tamanho de página de 16 KB já resolvida, já que é um requisito do Play separado com seu próprio modo de falha. Veja [por que o Google Play rejeita um app Flutter ou MAUI por causa do tamanho de página de 16 KB](/pt-br/2026/08/fix-google-play-rejects-flutter-or-maui-app-for-16-kb-page-size/).

## Passos da migração

1. **Descubra qual é o seu alvo hoje, de verdade.** Não leia o csproj, leia o manifesto mesclado que o build produz:

   ```bash
   dotnet build -f net9.0-android -c Release
   grep -o 'targetSdkVersion="[0-9.]*"' obj/Release/net9.0-android/AndroidManifest.xml
   ```

   **Verificação:** você obtém um único número. Se ele for menor que a versão da plataforma Android no seu `TargetFramework`, alguma coisa está fixando o valor, e o passo 3 é o que mais importa no seu caso.

2. **Mova o target framework para o .NET 10.** A versão da plataforma Android no TFM é o que vira `targetSdkVersion`, então esta única edição é a migração de fato:

   ```xml
   <!-- .csproj, .NET 10, .NET MAUI 10.0.100 -->
   <PropertyGroup>
     <TargetFrameworks>net10.0-android;net10.0-ios;net10.0-maccatalyst</TargetFrameworks>
     <SupportedOSPlatformVersion Condition="$([MSBuild]::GetTargetPlatformIdentifier('$(TargetFramework)')) == 'android'">24.0</SupportedOSPlatformVersion>
   </PropertyGroup>
   ```

   `net10.0-android` puro resolve para a API 36, que é [o padrão documentado do .NET 10](https://learn.microsoft.com/en-us/dotnet/maui/whats-new/dotnet-10). Fixe explicitamente como `net10.0-android36.0` se preferir que o build falhe em vez de derivar quando você depois for para o .NET 11, porque o .NET for Android promoveu a API 37 a estável no .NET 11 Preview 5 e agora projetos .NET 11 miram `net11.0-android37` por padrão. `$(SupportedOSPlatformVersion)` é outro eixo: ele vira `minSdkVersion` e não tem nada a ver com o requisito do Play.

   **Verificação:** recompile e repita o `grep` do passo 1 contra `obj/Release/net10.0-android/AndroidManifest.xml`. Ele precisa imprimir `targetSdkVersion="36"`.

3. **Apague qualquer `uses-sdk` fixo do seu manifesto.** Este é o motivo mais comum de o passo 2 parecer não fazer nada. O .NET for Android só escreve `targetSdkVersion` quando o manifesto de template ainda não tem um, e um valor explícito ganha sem discussão ([`ManifestDocument.cs`](https://github.com/dotnet/android/blob/main/src/Xamarin.Android.Build.Tasks/Utilities/ManifestDocument.cs)):

   ```xml
   <!-- Platforms/Android/AndroidManifest.xml: delete the uses-sdk line entirely -->
   <manifest xmlns:android="http://schemas.android.com/apk/res/android">
     <uses-sdk android:minSdkVersion="21" android:targetSdkVersion="34" />
     <application android:allowBackup="true" android:icon="@mipmap/appicon" android:supportsRtl="true" />
   </manifest>
   ```

   A própria [orientação para XA5207](https://learn.microsoft.com/en-us/dotnet/android/messages/xa5207) da Microsoft mandava adicionar exatamente este elemento para segurar um nível alvo durante uma atualização de SDK, então muitos projetos da era Xamarin.Forms ainda carregam isso. O template atual do .NET MAUI não traz nenhum elemento `uses-sdk`, que é o estado que você quer.

   **Verificação:** `grep -c uses-sdk Platforms/Android/AndroidManifest.xml` retorna `0`, e o manifesto mesclado continua mostrando `targetSdkVersion="36"`.

4. **Decida sua estratégia de edge-to-edge, porque você não tem mais voto.** Com alvo 36 o atributo `windowOptOutEdgeToEdgeEnforcement` está [obsoleto e desabilitado](https://developer.android.com/about/versions/16/behavior-changes-16) em aparelhos com Android 16. Se você o tinha em `Platforms/Android/Resources/values/styles.xml`, apague. Depois escolha um valor de `SafeAreaEdges` por página em vez de aceitar o padrão do .NET 10, que é `None`:

   ```xml
   <!-- .NET MAUI 10.0.100: ContentPage defaults to SafeAreaEdges="None" -->
   <ContentPage SafeAreaEdges="Container">
       <Grid SafeAreaEdges="Container" RowDefinitions="Auto,*">
           <Label Text="Not under the status bar" />
       </Grid>
   </ContentPage>
   ```

   `Container` reproduz o comportamento do .NET 9 de ficar longe das barras de sistema e dos recortes de tela. `All` também evita o teclado, que é o que você quer se dependia do platform-specific `WindowSoftInputModeAdjust.Resize` do Android. `None` é a opção imersiva, e é uma escolha deliberada, não um padrão que você deva herdar por acidente.

   **Verificação:** em um aparelho com Android 16, a barra de status e a barra de navegação por gestos não sobrepõem nenhum controle clicável nas suas três telas principais, nos temas claro e escuro.

5. **Conserte o tratamento personalizado de voltar antes que o voltar preditivo o engula.** Com alvo 36 as animações de voltar preditivo ficam ativas por padrão, `onBackPressed()` não é chamado e `KeyEvent.KEYCODE_BACK` não é despachado. Qualquer sobrescrita de activity como esta para de rodar:

   ```csharp
   // Broken at targetSdkVersion 36 on Android 16
   public override void OnBackPressed()
   {
       if (_hasUnsavedChanges) { ShowConfirmDialog(); return; }
       base.OnBackPressed();
   }
   ```

   Trate na própria superfície de navegação do .NET MAUI, que continua funcionando em todas as plataformas:

   ```csharp
   // .NET MAUI 10.0.100, cross-platform
   protected override bool OnBackButtonPressed()
   {
       if (!_hasUnsavedChanges)
           return base.OnBackButtonPressed();

       Dispatcher.Dispatch(async () => await DisplayAlertAsync("Discard changes?", "...", "OK"));
       return true; // handled
   }
   ```

   A saída de emergência do Android é `android:enableOnBackInvokedCallback="false"` em `<application>` ou em uma `<activity>` específica, e é um paliativo, não uma correção.

   **Verificação:** deslize a partir da borda da tela e segure. Você deve ver a animação de prévia, e ao soltar deve acontecer o que seu handler pretende.

6. **Audite orientação travada e proporções fixas.** Em telas de `sw600dp` para cima, o alvo 36 faz o Android ignorar `android:screenOrientation`, `android:resizableActivity`, `android:minAspectRatio` e `android:maxAspectRatio`, além de `SetRequestedOrientation` em tempo de execução. No .NET MAUI isso normalmente significa um atributo em `MainActivity`:

   ```csharp
   // Ignored on sw600dp+ displays at targetSdkVersion 36
   [Activity(ScreenOrientation = ScreenOrientation.Portrait, /* ... */)]
   public class MainActivity : MauiAppCompatActivity { }
   ```

   A exclusão temporária é uma propriedade do manifesto, e o Google já disse que ela para de valer no nível de API 37:

   ```xml
   <application>
     <property android:name="android.window.PROPERTY_COMPAT_ALLOW_RESTRICTED_RESIZABILITY"
               android:value="true" />
   </application>
   ```

   **Verificação:** rode em um emulador de tablet ou dobrável e gire. Se o layout ficar inutilizável na horizontal, conserte o layout, porque a exclusão te compra um ano.

7. **Atualize o CI para que ele não compile contra uma plataforma que não tem.** A falta da API 36 em um agente aparece como XA5207, e a correção é um target, não um download em portal:

   ```bash
   dotnet build -t:InstallAndroidDependencies -f net10.0-android \
     -p:AndroidSdkDirectory="$ANDROID_HOME" \
     -p:AcceptAndroidSDKLicenses=true
   ```

   O argumento `-f` é obrigatório; sem ele o MSBuild reporta `MSB4057: The target "InstallAndroidDependencies" does not exist in the project`.

   **Verificação:** um build limpo de CI a partir de um cache vazio do SDK produz um AAB assinado sem XA5207.

## Checklist de verificação

- `obj/Release/net10.0-android/AndroidManifest.xml` contém `targetSdkVersion="36"` e o `minSdkVersion` que você pretendia.
- O relatório de pré-lançamento do Play Console em uma faixa interna não mostra aviso de nível de API alvo.
- Todas as telas checadas em um celular com Android 16 quanto a sobreposição de insets, em cima e embaixo, e também com o teclado aberto.
- Gesto de voltar, botão de voltar e qualquer diálogo de confirmação de saída se comportam como antes.
- Execução em tablet ou dobrável nas duas orientações, se você distribui para telas grandes.
- Taxa livre de falhas e taxa de ANR estáveis depois de uma semana em faixa interna, antes de promover.

## Plano de rollback

Reverter o `TargetFramework` para `net9.0-android` restaura o nível alvo antigo e o comportamento antigo de áreas seguras do .NET MAUI, e é uma reversão limpa desde que você não tenha adotado também APIs do .NET 10. O que você não consegue reverter é o lado do Play: depois de publicar um AAB com alvo 36, você não pode publicar um nível alvo menor na mesma faixa, porque o Play aplica o piso em cada upload. Trate a faixa interna como sua janela de rollback e a promoção para produção como caminho sem volta.

## Detalhes que custam tempo de verdade

- **O manifesto escreve só a versão maior.** `net11.0-android36.1` produz `android:targetSdkVersion="36"`, porque o gerador do manifesto pega o componente maior do nível de API. Se você esperava ver `36.1` no manifesto mesclado e foi procurar um bug, não existe.
- **O .NET 9 não te leva até lá.** A workload Android do .NET 9 entregou bindings da API 35 e parou ali, então `net9.0-android36.0` não é um TFM válido. Não há como cumprir o requisito do Play sem mover o SDK.
- **O voltar preditivo teve um bug real no .NET MAUI.** O `MauiAppCompatActivity` registrava um callback de voltar de forma incondicional, o que suprimia a animação de volta à tela inicial do Android mesmo em uma página raiz onde o .NET MAUI não tinha nada a consumir. Foi corrigido com a troca para um `OnBackPressedCallback` do AndroidX cujo estado `Enabled` acompanha se a navegação pode de fato voltar ([dotnet/maui#35223](https://github.com/dotnet/maui/pull/35223)), e saiu no .NET MAUI 10.0.90. O `BlazorWebView` tinha o mesmo bug e sua própria correção na mesma versão. Se sua animação de voltar engasga no Android 16, confira sua versão do .NET MAUI antes de depurar seu próprio código.
- **`ScrollView` ignora `SafeAreaEdges` para desviar do teclado.** `SoftInput` não tem efeito ali, porque o `ScrollView` gerencia os próprios insets de conteúdo. Envolva-o em um `Grid` e defina `SafeAreaEdges` no contêiner.
- **Os ícones da barra de status somem sobre o seu novo fundo de borda a borda.** O .NET 11 Preview 7 adicionou `Window.StatusBarTheme` para controlar o contraste dos ícones independentemente do tema do app, no Android 6.0 e posteriores. No .NET 10 você mesmo configura `WindowInsetsControllerCompat.AppearanceLightStatusBars`.
- **A prorrogação do Play é por app e tem prazo.** A prorrogação até 2026-11-01 é solicitada pela notificação do Play Console no app afetado, não é concedida automaticamente, e não move o prazo da API 37 do ano que vem.

## Relacionado

- [Migre um app .NET MAUI para Android de Mono para CoreCLR no .NET 11](/pt-br/2026/09/migrate-a-dotnet-maui-android-app-from-mono-to-coreclr-in-dotnet-11/) cobre a outra metade de uma mudança para o .NET 11, incluindo o piso da API 24.
- [Por que o Google Play rejeita um app Flutter ou MAUI por causa do tamanho de página de 16 KB](/pt-br/2026/08/fix-google-play-rejects-flutter-or-maui-app-for-16-kb-page-size/) é o outro requisito do Play que bloqueia uploads.
- [Como corrigir "Doesn't support required ABI" ao instalar um app .NET MAUI para Android](/pt-br/2026/08/fix-doesnt-support-required-abi-when-installing-a-dotnet-maui-android-app/) é a falha de instalação que aparece logo depois de mudar os identificadores de runtime.
- [Como corrigir a interface do Flutter sobrepondo a barra de navegação do Android depois de mirar o SDK 35](/pt-br/2026/08/fix-flutter-ui-overlaps-the-android-navigation-bar-after-targeting-sdk-35/) é a mesma imposição de edge-to-edge vista pelo lado do Flutter.
- [Migrar do Xamarin.Forms para o .NET MAUI 11](/pt-br/2026/05/migrate-from-xamarin-forms-to-maui-11/) caso o `uses-sdk` fixo do passo 3 tenha sido o menor dos seus problemas.

## Fontes

- [Requisitos de nível de API alvo para apps do Google Play](https://support.google.com/googleplay/android-developer/answer/11926878), Ajuda do Play Console.
- [Mudanças de comportamento: apps que miram o Android 16 ou superior](https://developer.android.com/about/versions/16/behavior-changes-16), Android Developers.
- [Novidades do .NET MAUI no .NET 10](https://learn.microsoft.com/en-us/dotnet/maui/whats-new/dotnet-10) e [no .NET 11](https://learn.microsoft.com/en-us/dotnet/maui/whats-new/dotnet-11), Microsoft Learn.
- [Layout com áreas seguras](https://learn.microsoft.com/en-us/dotnet/maui/user-interface/safe-area), Microsoft Learn, incluindo a mudança disruptiva de `ContentPage` no .NET 10.
- [Erro XA5207 do .NET for Android](https://learn.microsoft.com/en-us/dotnet/android/messages/xa5207) e [targets de build](https://learn.microsoft.com/en-us/dotnet/android/building-apps/build-targets), Microsoft Learn.
- [Notas de versão do .NET for Android 11 Preview 5](https://github.com/dotnet/android/releases/tag/36.99.0-preview.5.308), que estabilizam a API 37 e fazem o .NET 11 mirar `net11.0-android37` por padrão.
- [dotnet/maui#35223](https://github.com/dotnet/maui/pull/35223), a correção do registro do voltar preditivo.
