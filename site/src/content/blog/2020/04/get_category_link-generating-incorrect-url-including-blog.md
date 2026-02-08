---
title: "get_category_link generating incorrect url including /blog/"
description: "Fix for WordPress get_category_link generating incorrect URLs that include /blog/ in the path, causing 404 errors on category pages."
pubDate: 2020-04-04
updatedDate: 2023-11-05
tags:
  - "wordpress"
---
I recently ran an SEO audit tool on the blog just to find out that all the category links were leading to 404s. Upon close inspection the URLs appeared to contain a /blog/ in them while the actual working URLs would be without it. See below:  
  
`https://startdebugging.net/blog/category/opinion/` – not working  
`https://startdebugging.net/category/opinion/` – working

Apparently the whole issue was caused by the fact that I was using a custom permalink format for the posts which used /blog/ as a base, and it was being picked up by the category URLs as well.

## How to fix it?

Make sure to specify a “Category base” in your permalink settings (Settings > Permalink), in my case I just set it to “category”.

![Wordpress, Settings > Permalinks > Category base](/wp-content/uploads/2020/04/image-1.png)
