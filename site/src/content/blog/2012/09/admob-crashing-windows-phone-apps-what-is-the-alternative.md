---
title: "AdMob crashing Windows Phone apps. What is the alternative?"
description: "Not long ago I’ve published my first app using the devcenter developer account and not the global publisher – and just a couple of days later (or should I say weeks) I started noticing crash reports for my app. Downloaded the stack trace data in hope that I could find out where the issue was…"
pubDate: 2012-09-16
updatedDate: 2023-11-05
tags:
  - "windows-phone"
---
Not long ago I’ve published my first app using the devcenter developer account and not the global publisher – and just a couple of days later (or should I say weeks) I started noticing crash reports for my app.  Downloaded the stack trace data in hope that I could find out where the issue was but no luck – it gave me almost no info about the cause. All I know is that it has something to do with the browser.

So here is my stack trace:

```plaintext
Frame    Image             Function                                                   Offset
0        coredll.dll       xxx_RaiseException                                         19
1        mscoree3_7.dll                                                               436172
2        mscoree3_7.dll                                                               383681
3        mscoree3_7.dll                                                               540620
4                          TransitionStub                                             0
5                          Microsoft.Phone.Controls.NativeMethods.ValidateHResult     236
6                          Microsoft.Phone.Controls.WebBrowserInterop.InvokeScript    128
7                          Microsoft.Phone.Controls.WebBrowser.InvokeScript           84
8                          .__c__DisplayClass36._RunScripts_b__34                     228
9        mscoree3_7.dll                                                               428848
10       mscoree3_7.dll                                                               222523
11       mscoree3_7.dll                                                               221143
12                         System.Reflection.RuntimeMethodInfo.InternalInvoke         112
13                         System.Reflection.RuntimeMethodInfo.InternalInvoke         1556
14                         System.Reflection.MethodBase.Invoke                        104
15                         System.Delegate.DynamicInvokeOne                           564
16                         System.MulticastDelegate.DynamicInvokeImpl                 84
17                         System.Windows.Threading.DispatcherOperation.Invoke        80
18                         System.Windows.Threading.Dispatcher.Dispatch               404
19                         System.Windows.Threading.Dispatcher.OnInvoke               56
```

So my next question was: which part of my app uses the web browser? Answer: none. Except for the advertising part that is. And that’s where AdMob comes in play. A few searches later I found out that I’m not the only one with this problem – there’s lots of developers out there with similar stack traces and all using AdMob for displaying ads.

Even the AdMob Google group is full of this kind of issues / crashes – and yet they do nothing to solve them. There are some workarounds around this – like marking the unhandled exception as handled and preventing the app from crashing – but that will also render the advertisements unclickable which is not desirable.

So I started looking at alternatives – and after a while I ended up with InnerActive. Most of the developers seem to recommend this one as an alternative to Microsoft’s Pub Center and AdMob – and from what I’ve seen they have some nice partnerships with well knows publishers like HalfBrick or ZeptoLab. And I will give them a try.

I’ve already looked at their documentation a bit and at their supported types of ads – and they seem to be all right (in any case – a lot better than AdMob). I will integrate their ads into one of my apps and let you know how it goes.
