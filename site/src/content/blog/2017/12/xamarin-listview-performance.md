---
title: "Xamarin ListView performance & replacing it with Syncfusion SfListView"
description: "While Xamarin keeps adding features and improves the performance of Xamarin Forms with each and every update, what they offer in terms of cross-platform user controls is not always enough. In my case, I’ve got an RSS reader app which aggregates news articles from different sources and displays them in a ListView like this: While…"
pubDate: 2017-12-16
updatedDate: 2023-11-05
tags:
  - "xamarin"
  - "xamarin-forms"
---
While Xamarin keeps adding features and improves the performance of Xamarin Forms with each and every update, what they offer in terms of cross-platform user controls is not always enough. In my case, I’ve got an RSS reader app which aggregates news articles from different sources and displays them in a ListView like this:

While I like how the app looks, it has a big issue – performance. Even on high-end devices the scrolling is sluggish and on low-end devices it keeps on throwing OutOfMemory exceptions due to the images that are being loaded. So, a change was needed. In this article I’ll only cover the first one – the scrolling performance; we’ll have a look at the OutOfMemory exceptions another time.

### The Item template

First thing you need to look at when troubleshooting performance is the ListView ItemTemplate. Any kind of optimization that you can do at this level will have a big impact on the overall performance of your ListView. Look at things like:

-   reducing the number of XAML elements. The fewer elements to render, the better
-   same goes for nesting. Avoid nesting elements and creating deep hierarchies. It will take way too long to render them
-   make sure your ItemSource is an IList and not an IEnumerable collection. IEnumerable doesn’t support random access
-   don’t change the layout based on your BindingContext. Use a DataTemplateSelector instead

You should already see some improvements in scrolling after making these changes. Next on the list is your caching strategy.

### Caching strategy

By default Xamarin uses the RetainElement caching strategy for Android and iOS which means that it will create one instance of your ItemTemplate for each item in your list. Change your ListView’s caching strategy to RecycleElement to reuse containers that are no longer in view instead of creating new elements every time. This will increase performance by removing initialization costs.

```xml
<ListView CachingStrategy="RecycleElement">
    <ListView.ItemTemplate>
        <DataTemplate>
            <ViewCell>
              ...
            </ViewCell>
        </DataTemplate>
    </ListView.ItemTemplate>
</ListView>
```

If by any chance you’re using a DataTemplateSelector, then you should use the RecycleElementAndDataTemplate caching strategy. For more details on caching strategies you can check [Xamarin’s documentation](https://developer.xamarin.com/guides/xamarin-forms/user-interface/listview/performance/) on ListView performance.

### Syncfusion ListView

If you got this far and your performance issues aren’t solved, then it’s time looking at other options. In my case, I gave Syncfusion SfListView a try because they’re known for their control suites and they offer their Xamarin controls for free under the same conditions as Visual Studio Community (more or less). To get started head over to Syncfusion’s website an [claim your free comunity license](https://www.syncfusion.com/products/communitylicense) if you haven’t already.

Next, you need to add the SfListView package to your project. Syncfusion packages are available through their own NuGet repository. To be able to access it you’ll need to add it to you NuGet sources. A complete guide on how to do that can be found [here](https://help.syncfusion.com/xamarin/listview/getting-started). One you’ve done that, a simple search for SfListView in NuGet will result in the desired package. Install the package in your core/cross-platform project and in all your platform projects as well; it will automatically pick up the correct DLLs based on your project’s target.

Now that you’ve got everything installed, it’s time to replace the standart ListView. To do so, add the following namespace in your page/view:

```xml
xmlns:sflv="clr-namespace:Syncfusion.ListView.XForms;assembly=Syncfusion.SfListView.XForms"
```

And then replace the ListView tag with sflv:ListView, the ListView.ItemTemplate with sflv:SfListView.ItemTemplate and remove the ViewCell from your hierarchy – it’s not needed. Additionaly, if you’ve been using the CachingStrategy property, remove that as well – SfListView recycles elements by default. You should end up with something like this:

```xml
<sflv:ListView>
    <sflv:SfListView.ItemTemplate>
        <DataTemplate>
           ...
        </DataTemplate>
    </sflv:SfListView.ItemTemplate>
</sflv:SfListView>
```

That’s it. If you have any questions let me know in the comments section below. Also, if you’ve got any other tips to share that would improve ListView performance, please do.
