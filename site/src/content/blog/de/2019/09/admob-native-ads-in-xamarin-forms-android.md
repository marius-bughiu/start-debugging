---
title: "AdMob Native Ads in Xamarin Forms (Android)"
description: "Schritt-für-Schritt-Anleitung zum Implementieren von AdMob Native Ads in einer Xamarin-Forms-Android-App mit einem Custom Renderer."
pubDate: 2019-09-20
updatedDate: 2023-11-05
tags:
  - "xamarin"
  - "xamarin-forms"
lang: "de"
translationOf: "2019/09/admob-native-ads-in-xamarin-forms-android"
translatedBy: "claude"
translationDate: 2026-05-01
---
Bis vor Kurzem waren NativeAds in einer geschlossenen Beta und nur bestimmten Entwicklern zugänglich, jetzt aber ist das Anzeigenformat für alle verfügbar. So fügen Sie eine solche Anzeige Ihrer Android-Xamarin-Forms-App mit einem Custom Renderer hinzu.

## Schritt 1: Eine View als Platzhalter für die Anzeige erstellen

Sie erfüllt zwei Aufgaben. Einerseits ist sie eine View-Klasse, an die wir die Custom Renderer binden können, andererseits dient sie als Platzhalter, der den Platz reserviert und den Text "AD" anzeigt, damit die UI nicht springt, sobald die Anzeige geladen wird.

```cs
public class NativeAdView : ContentView
{
    public NativeAdView()
    {
        this.HeightRequest = 360;
        this.Margin = new Thickness(8, 8, 8, 0);

        SetPlaceholderContent();
    }

    private void SetPlaceholderContent()
    {
        var placeholderGrid = new Grid();
        var placeHolderText = new Label
        {
            Text = "AD",
            FontSize = 48,
            FontAttributes = FontAttributes.Bold,
            TextColor = Color.White,
            Opacity = 0.3,
            VerticalOptions = new LayoutOptions(LayoutAlignment.Center, true),
            HorizontalOptions = new LayoutOptions(LayoutAlignment.Center, true)
        };

        placeholderGrid.Children.Add(placeHolderText);

        this.Content = placeholderGrid;
    }
}
```

Hinweis: Ich habe diese Höhe von 360 in der View aus Bequemlichkeit fest verdrahtet, weil ich sie tatsächlich in einer ListView verwende, in der alle Elemente dieselbe Höhe haben. Sie können das entfernen und die Höhe in XAML oder beim Hinzufügen des Elements festlegen.

## Schritt 2: Ein Anzeigen-Layout erstellen

Gehen Sie dazu in Ihrem Android-Projekt in Resources > layout und erstellen Sie eine neue Datei mit dem Namen ad\_unified.axml. Sie können das folgende Beispiel als Ausgangs-Layout verwenden und es nach Bedarf an Ihre Anwendung anpassen.

```xml
<com.google.android.gms.ads.formats.UnifiedNativeAdView android:hardwareAccelerated="false"
    xmlns:android="http://schemas.android.com/apk/res/android"
    android:layout_width="match_parent"
    android:layout_height="match_parent">

    <android.support.v7.widget.CardView
        xmlns:app="http://schemas.android.com/apk/res-auto"
        android:layout_width="match_parent"
        android:layout_height="match_parent"
        app:cardPreventCornerOverlap="false"
        app:cardCornerRadius="12dp">

        <LinearLayout
            xmlns:android="http://schemas.android.com/apk/res/android"
            android:layout_width="match_parent"
            android:layout_height="match_parent"
            android:orientation="vertical"
            android:background="#FFFFFF">

            <AbsoluteLayout
                android:layout_width="match_parent"
                android:layout_height="match_parent"
                android:layout_weight="1">

                <com.google.android.gms.ads.formats.MediaView
                    android:id="@+id/ad_media"
                    android:layout_width="match_parent"
                    android:layout_height="match_parent" />

                <TextView
                    android:layout_width="wrap_content"
                    android:layout_height="wrap_content"
                    android:gravity="left"
                    android:text="Ad"
                    android:textColor="#FFFFFF"
                    android:background="#FFCC66"
                    android:textSize="14sp"
                    android:padding="4dp" />
            </AbsoluteLayout>

            <LinearLayout
                android:layout_width="match_parent"
                android:layout_height="wrap_content"
                android:orientation="horizontal"
                android:padding="5dp">

                <LinearLayout
                    android:layout_height="wrap_content"
                    android:layout_width="match_parent"
                    android:layout_weight="1"
                    android:orientation="vertical"
                    android:gravity="fill_horizontal">

                    <LinearLayout
                        android:layout_height="wrap_content"
                        android:layout_width="wrap_content"
                        android:orientation="horizontal">

                        <ImageView
                            android:id="@+id/ad_app_icon"
                            android:layout_width="40dp"
                            android:layout_height="40dp"
                            android:adjustViewBounds="true"
                            android:paddingBottom="5dp"
                            android:paddingEnd="5dp"
                            android:paddingRight="5dp"/>

                        <LinearLayout
                            android:layout_width="match_parent"
                            android:layout_height="wrap_content"
                            android:orientation="vertical">

                            <TextView
                                android:id="@+id/ad_headline"
                                android:layout_width="match_parent"
                                android:layout_height="wrap_content"
                                android:textColor="#0000FF"
                                android:text="Join the dark side!"
                                android:textSize="16sp"
                                android:textStyle="bold" />

                            <LinearLayout
                                android:layout_width="match_parent"
                                android:layout_height="wrap_content">

                                <TextView
                                    android:id="@+id/ad_advertiser"
                                    android:layout_width="wrap_content"
                                    android:layout_height="wrap_content"
                                    android:gravity="bottom"
                                    android:textSize="14sp"
                                    android:text="Google"
                                    android:textColor="#222222"
                                    android:textStyle="bold"/>

                                <RatingBar
                                    android:id="@+id/ad_stars"
                                    style="?android:attr/ratingBarStyleSmall"
                                    android:layout_width="wrap_content"
                                    android:layout_height="wrap_content"
                                    android:isIndicator="true"
                                    android:numStars="5"
                                    android:stepSize="0.5"
                                    android:rating="4" />
                            </LinearLayout>

                        </LinearLayout>
                    </LinearLayout>

                    <TextView
                        android:textColor="#555555"
                        android:id="@+id/ad_body"
                        android:layout_width="match_parent"
                        android:layout_height="wrap_content"
                        android:text="Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nis."
                        android:textSize="12sp" />
                </LinearLayout>

                <LinearLayout
                    android:layout_height="wrap_content"
                    android:layout_width="wrap_content"
                    android:orientation="vertical"
                    android:layout_gravity="center_vertical"
                    android:paddingLeft="5dp">

                    <TextView
                        android:id="@+id/ad_store"
                        android:text="Google Play"
                        android:textColor="#222222"
                        android:layout_width="wrap_content"
                        android:layout_height="wrap_content"
                        android:layout_gravity="center_horizontal"
                        android:textSize="12sp" />

                    <Button
                        android:id="@+id/ad_call_to_action"
                        android:layout_width="wrap_content"
                        android:layout_height="wrap_content"
                        android:gravity="center"
                        android:layout_margin="0dp"
                        android:text="INSTALL"
                        android:textSize="12sp" />

                    <TextView
                        android:id="@+id/ad_price"
                        android:text="$ 3.49"
                        android:textColor="#222222"
                        android:layout_width="wrap_content"
                        android:layout_height="wrap_content"
                        android:layout_gravity="center_horizontal"
                        android:textSize="12sp" />

                </LinearLayout>
            </LinearLayout>
        </LinearLayout>
    </android.support.v7.widget.CardView>
</com.google.android.gms.ads.formats.UnifiedNativeAdView>
```

Passen Sie es nach Belieben an, behalten Sie aber alle Text-, Bild- und Media-Elemente bei. Derzeit gibt das SDK eine Warnung aus, wenn nicht alle Elemente konfiguriert sind, künftig wird das nicht mehr erlaubt sein.

## Schritt 3: Den Custom Renderer hinzufügen

Dieser Custom Renderer initiiert die Anzeigenanforderung und inflatet das obige Layout in das eigentliche Anzeigen-Control.

```cs
using Android.Content;
using Android.Gms.Ads;
using Android.Gms.Ads.Formats;
using Android.Views;
using Android.Widget;
using MyApp1.Droid.Renderers;
using System;
using Xamarin.Forms;
using Xamarin.Forms.Platform.Android;

[assembly: ExportRenderer(typeof(MyApp1.Controls.NativeAdView), typeof(NativeAdViewRenderer))]

namespace MyApp1.Droid.Renderers
{
    public class NativeAdViewRenderer : ViewRenderer
    {
        public NativeAdViewRenderer(Context context) : base(context)
        {

        }

        protected override void OnElementChanged(ElementChangedEventArgs<Xamarin.Forms.View> e)
        {
            base.OnElementChanged(e);

            if (Control == null)
            {
                var adLoader = new AdLoader.Builder(Context, "ca-app-pub-3940256099942544/1044960115");

                var listener = new UnifiedNativeAdLoadedListener();
                listener.OnNativeAdLoaded += (s, ad) =>
                {
                    try
                    {
                        var root = new UnifiedNativeAdView(Context);
                        var inflater = (LayoutInflater)Context.GetSystemService(Context.LayoutInflaterService);
                        var adView = (UnifiedNativeAdView)inflater.Inflate(Resource.Layout.ad_unified, root);

                        populateUnifiedNativeAdView(ad, adView);

                        SetNativeControl(adView);
                    }
                    catch
                    {

                    }
                };

                adLoader.ForUnifiedNativeAd(listener);
                var requestBuilder = new AdRequest.Builder();
                adLoader.Build().LoadAd(requestBuilder.Build());
            }
        }

        private void populateUnifiedNativeAdView(UnifiedNativeAd nativeAd, UnifiedNativeAdView adView)
        {
            adView.MediaView = adView.FindViewById<MediaView>(Resource.Id.ad_media);

            // Set other ad assets.
            adView.HeadlineView = adView.FindViewById<TextView>(Resource.Id.ad_headline);
            adView.BodyView = adView.FindViewById<TextView>(Resource.Id.ad_body);
            adView.CallToActionView = adView.FindViewById<TextView>(Resource.Id.ad_call_to_action);
            adView.IconView = adView.FindViewById<ImageView>(Resource.Id.ad_app_icon);
            adView.PriceView = adView.FindViewById<TextView>(Resource.Id.ad_price);
            adView.StarRatingView = adView.FindViewById<RatingBar>(Resource.Id.ad_stars);
            adView.StoreView = adView.FindViewById<TextView>(Resource.Id.ad_store);
            adView.AdvertiserView = adView.FindViewById<TextView>(Resource.Id.ad_advertiser);

            // The headline and mediaContent are guaranteed to be in every UnifiedNativeAd.
            ((TextView)adView.HeadlineView).Text = nativeAd.Headline;

            // These assets aren't guaranteed to be in every UnifiedNativeAd, so it's important to
            // check before trying to display them.
            if (nativeAd.Body == null)
            {
                adView.BodyView.Visibility = ViewStates.Invisible;
            }
            else
            {
                adView.BodyView.Visibility = ViewStates.Visible;
                ((TextView)adView.BodyView).Text = nativeAd.Body;
            }

            if (nativeAd.CallToAction == null)
            {
                adView.CallToActionView.Visibility = ViewStates.Invisible;
            }
            else
            {
                adView.CallToActionView.Visibility = ViewStates.Visible;
                ((Android.Widget.Button)adView.CallToActionView).Text = nativeAd.CallToAction;
            }

            if (nativeAd.Icon == null)
            {
                adView.IconView.Visibility = ViewStates.Gone;
            }
            else
            {
                ((ImageView)adView.IconView).SetImageDrawable(nativeAd.Icon.Drawable);
                adView.IconView.Visibility = ViewStates.Visible;
            }

            if (string.IsNullOrEmpty(nativeAd.Price))
            {
                adView.PriceView.Visibility = ViewStates.Gone;
            }
            else
            {
                adView.PriceView.Visibility = ViewStates.Visible;
                ((TextView)adView.PriceView).Text = nativeAd.Price;
            }

            if (nativeAd.Store == null)
            {
                adView.StoreView.Visibility = ViewStates.Invisible;
            }
            else
            {
                adView.StoreView.Visibility = ViewStates.Visible;
                ((TextView)adView.StoreView).Text = nativeAd.Store;
            }

            if (nativeAd.StarRating == null)
            {
                adView.StarRatingView.Visibility = ViewStates.Invisible;
            }
            else
            {
                ((RatingBar)adView.StarRatingView).Rating = nativeAd.StarRating.FloatValue();
                adView.StarRatingView.Visibility = ViewStates.Visible;
            }

            if (nativeAd.Advertiser == null)
            {
                adView.AdvertiserView.Visibility = ViewStates.Invisible;
            }
            else
            {
                ((TextView)adView.AdvertiserView).Text = nativeAd.Advertiser;
                adView.AdvertiserView.Visibility = ViewStates.Visible;
            }

            // This method tells the Google Mobile Ads SDK that you have finished populating your
            // native ad view with this native ad.
            adView.SetNativeAd(nativeAd);
        }
    }

    public class UnifiedNativeAdLoadedListener : AdListener, UnifiedNativeAd.IOnUnifiedNativeAdLoadedListener
    {
        public void OnUnifiedNativeAdLoaded(UnifiedNativeAd ad)
        {
            OnNativeAdLoaded?.Invoke(this, ad);
        }

        public EventHandler<UnifiedNativeAd> OnNativeAdLoaded { get; set; }
    }
}
```

Vergessen Sie nicht, die Namespaces anzupassen und die Anzeigen-ID zu aktualisieren. Zum Testen können Sie diese von Google bereitgestellten Beispiel-IDs verwenden:

-   Native Advanced: `ca-app-pub-3940256099942544/2247696110`
-   Native Advanced Video: `ca-app-pub-3940256099942544/1044960115`

## Schritt 4: Anzeige in Ihrer Seite anzeigen

Fügen Sie an einer beliebigen Stelle in Ihrem XAML einfach Folgendes hinzu:

```xml
<controls:NativeAdView HeightRequest="360" />
```

Wenn Sie es zum Beispiel in einer ListView verwenden möchten, können Sie alternativ eine neue AdPlaceholder-Klasse erstellen und sie etwa alle 5 Elemente in Ihre Liste einfügen. Über einen Data Template Selector wählen Sie dann entweder Ihren tatsächlichen Listeneintrag oder die Anzeigen-View, etwa so:

```cs
public class MyDataTemplateSelector : DataTemplateSelector
    {
        private readonly DataTemplate _itemDataTemplate;
        private readonly DataTemplate _adDataTemplate;

        private DataTemplate _selectedDataTemplate;

        public MyDataTemplateSelector()
        {
            _itemDataTemplate= new DataTemplate(typeof(MyItemView));
            _adDataTemplate = new DataTemplate(typeof(NativeAdView));
        }

        protected override DataTemplate OnSelectTemplate(object item, BindableObject container)
        {
            if (item is AdPlaceholder)
            {
                return _adDataTemplate;
            }

            return _itemDataTemplate;
        }
    }
```

Vergessen Sie jetzt nur nicht, den Data Template Selector an Ihre ListView zu hängen.

Das war's. Ich hatte noch keine Gelegenheit, am iOS-Renderer zu arbeiten, und es wird einige Wochen dauern, bis ich dazu komme. Falls jemand von Ihnen das macht, lassen Sie es einfach in den Kommentaren wissen.

Hoffentlich hilft es. Falls Sie Fragen haben, lassen Sie sie in den Kommentaren!
