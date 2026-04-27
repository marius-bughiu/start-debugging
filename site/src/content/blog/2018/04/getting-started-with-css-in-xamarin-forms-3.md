---
title: "Getting started with CSS in Xamarin Forms 3"
description: "Learn how to use Cascading StyleSheets (CSS) in Xamarin Forms 3, including inline CDATA styles and embedded CSS files."
pubDate: 2018-04-18
updatedDate: 2023-11-05
tags:
  - "xamarin"
  - "xamarin-forms"
---
There’s a couple of new things coming with this new version of Xamarin Forms, and one of them is Cascading StyleSheets (CSS). Yup, that’s right, CSS in XAML. Not sure yet how useful it will be and how adopted it will become – as quite a few features are still missing but I’m guessing it will be a welcome addition to anyone wanting to transition from web development.

So, to jump right into it – there’s two ways of adding CSS to your application:

-   first is by dropping your styles right into your elements resources and wrapping it into a CDATA tag
-   And the second one involves actual .css files added as embedded resources into your project

And once you have the CSS included, you use it by either specifying **StyleClass** or the shorthand **class** property on your XAML element.

To exemplify we’ll do some changes to a new Xamarin Forms project that uses the master detail template. So go ahead – File > New project and upgrade it to Xamarin Forms 3.

First off, the CDATA way. Let’s say we want to make the elements of our list orange. Go to the ItemsPage and inside the XAML, above the `<ContentPage.ToolbarItems>` tag, drop this:

```xml
<ContentPage.Resources>
    <StyleSheet>
        <![CDATA[

            .my-list-item {
                padding: 20;
                background-color: orange;
                color: white;
            }

        ]]>
    </StyleSheet>
</ContentPage.Resources>
```

Now, we need to use this new .my-list-item class. Find your ListView’s ItemTemplate and notice the StackLayout inside it – that’s our target. Remove that padding and apply our class like so:

```xml
<StackLayout Padding="10" class="my-list-item">
```

And that’s it.

Now let’s have a look at the second approach, the one using embedded CSS files. First, create a new folder in your app called Styles and create a new file inside it called about.css (we’re going to style the about page for this part). After you create the file, make sure you right click > Properties and set the **Build action** to **Embedded resource**; otherwise it won’t work.

Now in our view – AboutPage.xaml – add the following right above <ContentPage.BindingContext> element. This will reference our CSS file in our page. The fact that the path starts with a “/” means it starts from the root. You can also specify relative paths by omitting the first slash.

```xml
<ContentPage.Resources>
   <StyleSheet Source="/Styles/about.css" />
</ContentPage.Resources>
```

As for our CSS – let’s make some small changes to the app title and the learn more button, like so:

```css
.app-name {
    font-size: 48;
    color: orange;
}

.learn-more {
    border-color: orange;
    border-width: 1;
}
```

Careful as the font-size and border-width are simple (double) values; don’t specify “px” as that will not work and lead to an error. I’m guessing the values provided are in DIP (device independent pixels). Same goes for other properties like thickness, margin, padding, etc.

Now, everything’s nice and pretty, but keep in mind that there are some limitations:

-   Not all selectors are supported in this version. The \[attribute\] selectors, the @media and the @supports selectors or the : and :: selectors. They don’t work yet. Also, from my tryouts, targeting an element with two classes like .class1.class2 doesn’t work either.
-   Not all properties are supported, and most importantly, not all supported properties work on all elements. For example: the text-align property is only supported for Entry, EntryCell, Label and SearchBar, so you can’t left-align the text of a Button. Or if you take the border-width property – this one will only work with buttons.
-   Inheritance is not supported

For a complete list of what’s supported and what not you can check out [the pull request made for this feature on GitHub](https://github.com/xamarin/Xamarin.Forms/pull/1207). Additionally, just in case something goes wrong/doesn’t work, the original sample repository is no longer available on GitHub, but the snippets above are enough to get you started.
