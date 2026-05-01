---
title: "Como adicionar o AdMob ao seu app MAUI"
description: "Aprenda a exibir anúncios em banner do AdMob no seu app .NET MAUI tanto no Android quanto no iOS, com configuração passo a passo e implementações de handlers específicas por plataforma."
pubDate: 2023-11-17
tags:
  - "maui"
  - "dotnet"
  - "dotnet-8"
lang: "pt-br"
translationOf: "2023/11/how-to-add-admob-to-your-maui-app"
translatedBy: "claude"
translationDate: 2026-05-01
---
Uma das primeiras coisas em que as pessoas pensam ao desenvolver para uma nova plataforma ou usar uma nova tecnologia é monetização; e, no meu caso, a pergunta é: o quanto é fácil integrar o AdMob? Para o .NET MAUI a resposta seria 'depende', depende da sorte e da complexidade do que você quer alcançar; mas vou detalhar isso ao longo do caminho.

Neste artigo vamos ver como exibir um anúncio em banner usando o AdMob tanto no Android quanto no iOS.

A primeira coisa que precisamos fazer é adicionar os pacotes do AdMob específicos por plataforma:

-   para Android, adicione o pacote NuGet `Xamarin.GooglePlayServices.Ads.Lite`
-   para iOS, adicione o pacote NuGet `Xamarin.Google.iOS.MobileAds`

Depois que os pacotes estiverem instalados, você pode acabar encontrando alguns erros de bindings, do tipo:

```plaintext
Type androidx.collection.LongSparseArrayKt$keyIterator$1 is defined multiple times.
```

Isso ocorre por conflitos entre as bibliotecas de bindings referenciadas pelo MAUI e as referenciadas pelos pacotes do Xamarin que acabamos de instalar. Podemos corrigir isso forçando uma certa versão de pacote. Nesse caso, queremos instalar:

-   para Android: `Xamarin.AndroidX.Collection.Ktx` versão `1.3.0.1`
-   para iOS: `Xamarin.Build.Download` versão `0.11.4`

Com esses pacotes instalados, seu projeto deve compilar e rodar sem problemas em ambas as plataformas. Agora vamos ao código. Começamos definindo nossa view de anúncio:

```cs
public class BannerAd : ContentView
{
    public static readonly BindableProperty AdUnitIdProperty =
        BindableProperty.Create("AdUnitId", typeof(string), typeof(BannerAd), null);

    public string AdUnitId
    {
        get { return (string)GetValue(AdUnitIdProperty); }
        set { SetValue(AdUnitIdProperty, value); }
    }
}
```

Em seguida, criamos um handler vazio para a view (mais adiante forneceremos implementações específicas por plataforma para isso):

```cs
internal partial class BannerAdHandler { }
```

E registramos o handler no `MauiProgram.cs`, logo após `.UseMauiApp()`:

```cs
builder
    .UseMauiApp<App>()
    .ConfigureMauiHandlers(handlers =>
        {
            handlers.AddHandler(typeof(BannerAd), typeof(BannerAdHandler));
        });
```

Com tudo configurado, é hora de trabalhar nos handlers específicos por plataforma. Eles vão para as pastas `Platforms/Android` e `Platforms/iOS`, respectivamente.

Para Android, o handler fica assim:

```cs
internal partial class BannerAdHandler : ViewHandler<BannerAd, AdView>
{
    public static IPropertyMapper<BannerAd, BannerAdHandler> PropertyMapper = 
      new PropertyMapper<BannerAd, BannerAdHandler>(ViewMapper);


    public BannerAdHandler() : base(PropertyMapper) { }

    protected override void DisconnectHandler(AdView platformView)
    {
        platformView.Dispose();
        base.DisconnectHandler(platformView);
    }

    protected override AdView CreatePlatformView()
    {
        var adView = new AdView(Context)
        {
            AdSize = GetAdSize(),
            AdUnitId = VirtualView.AdUnitId
        };

        VirtualView.HeightRequest = 90;

        var request = new AdRequest.Builder().Build();
        adView.LoadAd(request);

        return adView;
    }
}
```

E para iOS:

```cs
internal partial class BannerAdHandler : ViewHandler<BannerAd, BannerView>
{
    public static IPropertyMapper<BannerAd, BannerAdHandler> PropertyMapper = 
      new PropertyMapper<BannerAd, BannerAdHandler>(ViewMapper);

    public BannerAdHandler() : base(PropertyMapper) { }

    protected override void DisconnectHandler(BannerView platformView)
    {
        platformView.Dispose();
        base.DisconnectHandler(platformView);
    }

    protected override BannerView CreatePlatformView()
    {
        var adSize = AdSizeCons.GetCurrentOrientationAnchoredAdaptiveBannerAdSize((float)UIScreen.MainScreen.Bounds.Width);
        var adView = new BannerView(adSize)
        {
            AdUnitId = VirtualView.AdUnitId,
            RootViewController = GetRootViewController()
        };
        
        VirtualView.HeightRequest = 90;

        var request = Request.GetDefaultRequest();
        adView.LoadRequest(request);

        return adView;
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
}
```

Com os handlers específicos por plataforma implementados, podemos usar a view `BannerAd` na nossa página. Vá até `MainPage.xaml` e simplesmente adicione o `BannerAd` dentro do seu layout:

```xml
<admob:BannerAd AdUnitId="ca-app-pub-3940256099942544/6300978111" />
```

E é isso! Se você rodar o app, agora deverá ver um anúncio de teste sendo exibido em ambas as plataformas.

### Leia em seguida

-   [GitHub: implementação do plugin AdMob e exemplo totalmente funcional para .NET MAUI](https://github.com/marius-bughiu/Plugin.AdMob)
