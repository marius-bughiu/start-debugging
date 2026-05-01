---
title: "Windows Phone 7: デバイスから現在の GPS 位置を取得する"
description: "GeoCoordinateWatcher と PositionChanged イベントを使って、Windows Phone 7 デバイスから現在の GPS 位置を取得する方法を解説します。"
pubDate: 2012-01-15
updatedDate: 2023-11-04
tags:
  - "windows-phone"
lang: "ja"
translationOf: "2012/01/windows-phone-7-getting-the-current-gps-location-from-the-device"
translatedBy: "claude"
translationDate: 2026-05-01
---
Windows Phone デバイスで現在の GPS 位置を取得するのは、それほど難しくありません。まず、プロジェクトに **System.Device** への参照を追加し、ジオロケーションを取得したいクラスで using を書きます。

```cs
using System.Device.Location;
```

次に、**GeoCoordinateWatcher** 型のオブジェクトを宣言します。アクセスしやすいよう、メソッド内のローカル変数ではなく、クラスメンバーとして宣言します。

```cs
GeoCoordinateWatcher geoWatcher = null;
```

続いてやることは、GeoCoordinateWatcher のインスタンス生成、position changed イベントのイベントハンドラー作成、データの読み取り開始です。インスタンスを作成するために、クラスのコンストラクターに次のコードを書きます。

```cs
geoWatcher = new GeoCoordinateWatcher();
```

これで、先ほど宣言した変数に GeoCoordinateWatcher オブジェクトが作られます。位置情報に一定の精度が必要な場合、コンストラクターには希望する精度をパラメーターに取るオーバーロードがあります。

```cs
 geoWatcher = new GeoCoordinateWatcher(GeoPositionAccuracy.High);
```

次に **PositionChanged** イベントのイベントハンドラーを作成します。**geoWatcher.PositionChanged +=** と入力して TAB を 2 回押せば、自動的にイベントハンドラーが作られます。ハンドラーを作成したら、**geoWatcher.Start()** を呼び出して座標の取得を開始するだけです。コードはこんな感じになります。

```cs
GeoCoordinateWatcher geoWatcher = null; 

public MainPage() 
{ 
    InitializeComponent(); 
    geoWatcher = new GeoCoordinateWatcher(GeoPositionAccuracy.High); 
    geoWatcher.PositionChanged += new EventHandler<GeoPositionChangedEventArgs<GeoCoordinate>>(geoWatcher_PositionChanged);
    geoWatcher.Start(); 
} 

void geoWatcher_PositionChanged(object sender, GeoPositionChangedEventArgs<GeoCoordinate> e) 
{ 
    throw new NotImplementedException(); 
}
```

次は現在地の座標の取得です。これも簡単です。ハンドラー内で **e.Position.Location** にアクセスすれば **GeoCoordinate** オブジェクトとして取得できますし、個別の値として欲しい場合は **e.Position.Location.Latitude**、**e.Position.Location.Longitude**、**e.Position.Location.Altitude** を 3 つの double 変数に保存できます。例:

```cs
void geoWatcher_PositionChanged(object sender, GeoPositionChangedEventArgs<GeoCoordinate> e)
{ 
    GeoCoordinate currentLocation = e.Position.Location; 
    double currentAltitude = e.Position.Location.Altitude; 
    double currentLongitude = e.Position.Location.Longitude; 
    double currentLatitude = e.Position.Location.Latitude; 
}
```

以上です。最初の値が取れた後にオブジェクトを解放し、現在地の取得を停止したい場合は、イベントハンドラーに次の数行を追加します。あるいは、メソッドにまとめておいて好きなときに呼び出してもよいでしょう。

```cs
geoWatcher.Stop(); 
geoWatcher.Dispose(); 
geoWatcher = null;
```

書いたコードをテストするために、データを表示するための textbox を 3 つアプリに追加します。同じようにしてみてください。とにかく、これで完了です。質問があればコメントを残してください。できるだけ早く返信します。

プロジェクトは [こちら](https://www.dropbox.com/s/rt1k190mor3c2g0/LocationSample.zip?dl=0) から入手できます。
