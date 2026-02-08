---
title: "Xamarin Forms – Using OnPlatform"
description: "Learn how to use OnPlatform in Xamarin Forms to set platform-specific property values in both XAML and C#."
pubDate: 2019-07-27
updatedDate: 2023-11-05
tags:
  - "xamarin"
  - "xamarin-forms"
---
While developing Xamarin Forms applications you will often find yourself in a situation where you need to set different values for a certain property depending on the operating system.

OnPlatform allows you to do just that and can be used both from C# code and XAML. Let’s look at a few examples. For this article, we’ll be working with a new master-detail project.

## Using OnPlatform with XAML

In the about page there’s a Learn More button, let's make its color platform dependent: green for Android, orange for iOS and purple for UWP.

```xml
<Button Margin="0,10,0,0" Text="Learn more" 
    BackgroundColor="{OnPlatform Android=Green, iOS=Orange, UWP=Purple}"
    Command="{Binding OpenWebCommand}"
    TextColor="White" />
```

And let’s look at the result:

![](/wp-content/uploads/2019/07/xamarin-forms-on-platform.png)

Alternatively, you could also use the following syntax which is more convenient when dealing with fancier data types.

```xml
<Button Margin="0,10,0,0" Text="Learn more" 
        Command="{Binding OpenWebCommand}"
        TextColor="White">
    <Button.BackgroundColor>
        <OnPlatform x:TypeArguments="Color">
            <On Platform="Android" Value="Green"/>
            <On Platform="iOS" Value="Orange"/>
            <On Platform="UWP" Value="Purple"/>
        </OnPlatform>
    </Button.BackgroundColor>
</Button>
```

## Using OnPlatform with C# (deprecated)

Same requirements as above, but this time from C# instead of XAML. First we’ll give our button a x:Name=”LearnMoreButton” and then in the code behind we’ll write the following:

```cs
Device.OnPlatform(
    Android: () => this.LearnMoreButton.BackgroundColor = Color.Green, 
    iOS: () => this.LearnMoreButton.BackgroundColor = Color.Orange, 
    WinPhone: () => this.LearnMoreButton.BackgroundColor = Color.Purple,
    Default: () => this.LearnMoreButton.BackgroundColor = Color.Black);
```

Same result as before. WinPhone maps to UWP and you also get to specify a default value for the rest of the platforms. This method is deprecated as of XF 2.3.4, and it’s recommended you write your own switch case on Device.RuntimePlatform instead.

## Using Device.RuntimePlatform instead

The code above can be translated to:

```cs
switch (Device.RuntimePlatform)
{
    case Device.Android:
        LearnMoreButtonSwitch.BackgroundColor = Color.Green;
        break;
    case Device.iOS:
        LearnMoreButtonSwitch.BackgroundColor = Color.Orange;
        break;
    case Device.UWP:
        LearnMoreButtonSwitch.BackgroundColor = Color.Purple;
        break;
     default:
         LearnMoreButtonSwitch.BackgroundColor = Color.Black;
         break;
}
```

The supported platform values currently are: iOS, Android, UWP, macOS, GTK, Tizen and WPF.

As usual, you can find the sample project source code on [GitHub](https://github.com/StartDebugging/xamarin-forms-on-platform).
