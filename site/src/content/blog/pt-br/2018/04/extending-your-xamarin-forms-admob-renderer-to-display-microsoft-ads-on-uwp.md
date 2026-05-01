---
title: "Estendendo seu renderer de AdMob do Xamarin Forms para exibir Microsoft Ads no UWP"
description: "Aprenda a estender seu renderer de AdMob do Xamarin Forms para exibir Microsoft Ads no UWP usando o Microsoft Advertising SDK."
pubDate: 2018-04-08
updatedDate: 2023-11-05
tags:
  - "uwp"
  - "xamarin"
  - "xamarin-forms"
lang: "pt-br"
translationOf: "2018/04/extending-your-xamarin-forms-admob-renderer-to-display-microsoft-ads-on-uwp"
translatedBy: "claude"
translationDate: 2026-05-01
---
Até agora estávamos [exibindo anúncios apenas no Android e iOS via AdMob e nosso renderer de AdMob](/pt-br/2015/09/how-to-add-admob-to-your-xamarin-forms-app/). O Google encerrou totalmente o suporte ao Windows Phone e nunca se preocupou com o UWP, então o AdMob não é uma opção neste cenário específico.

Por sorte, a Microsoft também atua no mercado de publicidade e agora integrou tudo de forma muito boa no developer dashboard e no Visual Studio, tornando bem fácil exibir anúncios no seu app. Vamos partir do código existente do AdMob do artigo linkado acima e estendê-lo para usar o Microsoft Advertising SDK e exibir anúncios no UWP.

Para começar, vá até seu Windows developer dashboard, selecione seu app -- Monetize -- In-app ads e crie uma nova unidade banner.

Em seguida, adicione o pacote NuGet Microsoft.Advertising.XAML ao seu projeto UWP.

Depois clique com o botão direito em References -- Add references e vá em Universal Windows -- Extensions e marque "Microsoft Advertising SDK for XAML"; em seguida clique em OK. **Observação:** pode ser necessário reiniciar o Visual Studio depois desses dois passos para garantir que ele reconheça suas mudanças (por exemplo, se ele não registrar os namespaces para o próximo trecho de código).

Acabamos com a configuração do projeto, agora é hora do renderer. Vamos passo a passo, mas se você só quer o código, ele está completo no fim do post.

Primeiro passo: criar o AdControl. Para isso, precisamos do application ID e do AdUnitId do dev center (preencha-os no código abaixo). Também adicionei alguns IDs de teste fornecidos pela Microsoft na documentação para podermos testar a implementação.

```cs

var ad = new Microsoft.Advertising.WinRT.UI.AdControl
{
#if !DEBUG
    ApplicationId = "",
    AdUnitId = "",
#endif

#if DEBUG
    ApplicationId = "3f83fe91-d6be-434d-a0ae-7351c5a997f1",
    AdUnitId = "test"
#endif
};
```

Em seguida, precisamos determinar a largura disponível para tirar o máximo da nossa tela. Existem 4 tamanhos de banners horizontais disponíveis pela Microsoft, com 300, 320, 640 e 728 pixels de largura. Precisamos decidir qual é adequado para o nosso cenário.

Isso depende de três coisas:

-   A largura disponível da aplicação (não confunda isso com largura da tela, já que no desktop o app não está necessariamente em tela cheia)
-   Se o seu app Xamarin Forms usa um MasterDetail (e tem um menu lateral)
-   A família de dispositivo (queremos saber se é desktop ou não)

Determinar a largura da janela é fácil. Agora, se o seu app usa um MasterDetail como root, em desktops esse menu lateral é exibido sempre (ou seja, não fica oculto), então ocupa espaço da largura disponível do app. No Xamarin Forms, a largura da sidebar é 320px, então vamos subtrair isso da nossa largura disponível. Adicionaremos duas propriedades constantes no nosso renderer para gerenciar essa configuração.

```cs
private const bool _hasSideMenu = true;
private const int _sideBarWidth = 320;
```
```cs
var availableWidth = Window.Current.Bounds.Width;
if (_hasSideMenu)
{
var isDesktop = AnalyticsInfo.VersionInfo.DeviceFamily == "Windows.Desktop";
if (isDesktop)
{
availableWidth = Window.Current.Bounds.Width - _sideBarWidth;
}
}
```

Em seguida escolhemos a largura e altura do anúncio com base na largura disponível e definimos o height request do nosso elemento Xamarin Forms para garantir espaço para exibi-lo na página.

```cs
if (availableWidth >= 728)
{
    ad.Width = 728;
    ad.Height = 90;
}
else if (availableWidth >= 640)
{
    ad.Width = 640;
    ad.Height = 100;
}
else if (availableWidth >= 320)
{
    ad.Width = 320;
    ad.Height = 50;
}
else if (availableWidth >= 300)
{
    ad.Width = 300;
    ad.Height = 50;
}

e.NewElement.HeightRequest = ad.Height;

SetNativeControl(ad);
```

E é só isso. Como prometido, abaixo está o código completo.

```cs
using GazetaSporturilor.Controls;
using GazetaSporturilor.UWP.Renderers;
using Microsoft.Advertising.WinRT.UI;
using Windows.System.Profile;
using Windows.UI.Xaml;
using Xamarin.Forms.Platform.UWP;

[assembly: ExportRenderer(typeof(AdMobView), typeof(AdMobRenderer))]

namespace GazetaSporturilor.UWP.Renderers
{
    public class AdMobRenderer : ViewRenderer<AdMobView, AdControl>
    {
        private const bool _hasSideMenu = true;
        private const int _sideBarWidth = 320;

        public AdMobRenderer()
        {

        }

        protected override void OnElementChanged(ElementChangedEventArgs<AdMobView> e)
        {
            base.OnElementChanged(e);

            if (e.NewElement == null)
            {
                return;
            }

            if (Control == null)
            {
                var ad = new Microsoft.Advertising.WinRT.UI.AdControl
                {
#if !DEBUG
                    ApplicationId = "",
                    AdUnitId = "",
#endif

#if DEBUG
                    ApplicationId = "3f83fe91-d6be-434d-a0ae-7351c5a997f1",
                    AdUnitId = "test"
#endif
                };

                var availableWidth = Window.Current.Bounds.Width;
                if (_hasSideMenu)
                {
                    var isDesktop = AnalyticsInfo.VersionInfo.DeviceFamily == "Windows.Desktop";
                    if (isDesktop)
                    {
                        availableWidth = Window.Current.Bounds.Width - _sideBarWidth;
                    }
                }

                if (availableWidth >= 728)
                {
                    ad.Width = 728;
                    ad.Height = 90;
                }
                else if (availableWidth >= 640)
                {
                    ad.Width = 640;
                    ad.Height = 100;
                }
                else if (availableWidth >= 320)
                {
                    ad.Width = 320;
                    ad.Height = 50;
                }
                else if (availableWidth >= 300)
                {
                    ad.Width = 300;
                    ad.Height = 50;
                }

                e.NewElement.HeightRequest = ad.Height;

                SetNativeControl(ad);
            }
        }
    }
}
```
