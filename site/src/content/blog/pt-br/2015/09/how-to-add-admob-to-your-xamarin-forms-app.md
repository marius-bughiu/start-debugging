---
title: "How To: adicionar AdMob ao seu app Xamarin Forms"
description: "Guia passo a passo para integrar anúncios AdMob no seu app Xamarin Forms em Android e iOS usando custom view renderers."
pubDate: 2015-09-27
updatedDate: 2023-11-18
tags:
  - "xamarin"
  - "xamarin-forms"
lang: "pt-br"
translationOf: "2015/09/how-to-add-admob-to-your-xamarin-forms-app"
translatedBy: "claude"
translationDate: 2026-05-01
---
Uma das primeiras coisas que se pensa ao desenvolver para uma nova plataforma / com uma nova tecnologia é a monetização; e no meu caso a pergunta é: quão fácil é integrar o AdMob? Para o Xamarin Forms a resposta seria: "depende" -- depende da sorte e da complexidade do que você quer alcançar. Vou detalhando ao longo do artigo.

A primeira coisa é adicionar os componentes necessários aos seus projetos. Para este walkthrough vou usar Visual Studio, mas deve ser bem parecido com Xamarin Studio. Aqui, os caminhos se separam por plataforma:

-   para Android -- adicione o pacote NuGet Xamarin.GooglePlayServices.Ads.Lite
-   para iOS -- adicione o pacote NuGet Xamarin.Google.iOS.MobileAds
-   para Windows Phone -- baixe o SDK aqui e adicione como referência (plataforma sem suporte)

A essa altura, o seu projeto Android deve ter parado de compilar e estar mostrando um erro COMPILETODALVIK : UNEXPECTED TOP-LEVEL. Para resolver, vá nas propriedades do projeto Droid, selecione a aba Android Options e em Advanced altere o valor de Java Max Heap Size para 1G. Seu projeto deve compilar agora sem erros.

Em seguida, dentro do seu projeto compartilhado / PCL adicione um novo Content View chamado AdMobView. Remova o código gerado no construtor e ele deve ficar assim:

```cs
public class AdMobView : ContentView
{
    public AdMobView() { }
}
```

Adicione essa nova view à sua página. No XAML pode ser assim:

```xml
<controls:AdMobView />
```

Garanta que NADA atrapalhe o controle. Por nada, quero dizer: controles sobrepostos, padding da página, margins/spacing, etc. Se alguma coisa estiver sobrepondo o controle de anúncio, os anúncios não vão aparecer e você não vai receber erro, então cuidado.

Em seguida, é hora dos custom view renderers; e novamente, vamos por plataforma:

**Android**

Adicione uma nova classe chamada AdMobRenderer com o código abaixo. Mantenha o atributo ExportRenderer acima do namespace, senão a mágica não acontece.

```cs
[assembly: ExportRenderer(typeof(AdMobView), typeof(AdMobRenderer))]

namespace AdExample.Droid.Renderers
{
    public class AdMobRenderer : ViewRenderer
    {
        public AdMobRenderer(Context context) : base(context)
        {

        }

        private int GetSmartBannerDpHeight()
        {
            var dpHeight = Resources.DisplayMetrics.HeightPixels / Resources.DisplayMetrics.Density;

            if (dpHeight <= 400) return 32;
            if (dpHeight <= 720) return 50;
            return 90;
        }

        protected override void OnElementChanged(ElementChangedEventArgs<View> e)
        {
            base.OnElementChanged(e);

            if (Control == null)
            {
                var ad = new AdView(Context)
                {
                    AdSize = AdSize.SmartBanner,
                    AdUnitId = "ca-app-pub-xxxxxxxxxxxxxxxx/xxxxxxxxxx"
                };

                var requestbuilder = new AdRequest.Builder();

                ad.LoadAd(requestbuilder.Build());
                e.NewElement.HeightRequest = GetSmartBannerDpHeight();

                SetNativeControl(ad);
            }
        }
    }
}
```

Em seguida, é preciso modificar seu AndroidManifest.xml para adicionar a AdActivity e as permissões necessárias para exibir anúncios: ACCESS\_NETWORK\_STATE, INTERNET; como no exemplo abaixo.

```xml
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
	<uses-sdk android:minSdkVersion="15" />
	<application>
    <activity android:name="com.google.android.gms.ads.AdActivity" android:configChanges="keyboard|keyboardHidden|orientation|screenLayout|uiMode|screenSize|smallestScreenSize" android:theme="@android:style/Theme.Translucent" />
  </application>
  <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
  <uses-permission android:name="android.permission.INTERNET" />
</manifest>
```

É isso. Seu build Android agora deve exibir anúncios dentro do content view AdMobView.

**iOS**

Comece adicionando uma linha no AppDelegate.cs para inicializar o SDK com seu application ID. Cuidado, não confunda com o ad unit ID. Adicione logo antes da chamada a LoadApplication.

```cs
MobileAds.Configure("ca-app-pub-xxxxxxxxxxxxxxxx~xxxxxxxxxx");
```

Depois, como antes, adicione uma nova classe AdMobRenderer e copie e cole o código abaixo, substituindo o AdmobID pelo ID da sua unidade banner.

```cs
[assembly: ExportRenderer(typeof(AdMobView), typeof(AdMobRenderer))]

namespace GazetaSporturilor.iOS.Renderers
{
    public class AdMobRenderer : ViewRenderer
    {
        BannerView adView;
        bool viewOnScreen;

        protected override void OnElementChanged(ElementChangedEventArgs<Xamarin.Forms.View> e)
        {
            base.OnElementChanged(e);

            if (e.NewElement == null)
                return;

            if (e.OldElement == null)
            {
                adView = new BannerView(AdSizeCons.SmartBannerPortrait)
                {
                    AdUnitID = "ca-app-pub-xxxxxxxxxxxxxxxx/xxxxxxxxxx",
                    RootViewController = GetRootViewController()
                };

                adView.AdReceived += (sender, args) =>
                {
                    if (!viewOnScreen) this.AddSubview(adView);
                    viewOnScreen = true;
                };

                var request = Request.GetDefaultRequest();

                e.NewElement.HeightRequest = GetSmartBannerDpHeight();
                adView.LoadRequest(request);

                base.SetNativeControl(adView);
            }
        }

        private UIViewController GetRootViewController()
        {
            foreach (UIWindow window in UIApplication.SharedApplication.Windows)
            {
                if (window.RootViewController != null)
                {
                    return window.RootViewController;
                }
            }

            return null;
        }

        private int GetSmartBannerDpHeight()
        {
            var dpHeight = (double)UIScreen.MainScreen.Bounds.Height;

            if (dpHeight <= 400) return 32;
            if (dpHeight <= 720) return 50;
            return 90;
        }
    }
}
```

Pronto. Agora você tem anúncios em ambas as plataformas. Comentários ou sugestões, deixe na seção de comentários abaixo.

**Atualização 30 dez 2017**

Neste artigo vimos como exibir anúncios Banner e fixamos o tamanho da view em 320 x 50 dp. Se você quer implementar smart banners, dê uma olhada neste post de continuação: [Tamanho de AdMob Smart Banner no Xamarin Forms](/pt-br/2017/12/admob-smart-banner-sizing-xamarin-forms/)

**Atualização 21 jan 2018**

Finalmente criei coragem para tentar compilar um dos meus apps para iOS, então atualizei este artigo para funcionar com a versão mais recente do AdMob para Xamarin. Também incluí o código de smart sizing mencionado na atualização de 30 dez. Obrigado a todos que estão ajudando na seção de comentários com a implementação para iOS.

### Leia em seguida

-   [How to: adicionar AdMob ao seu app MAUI](/pt-br/2023/11/how-to-add-admob-to-your-maui-app/)
