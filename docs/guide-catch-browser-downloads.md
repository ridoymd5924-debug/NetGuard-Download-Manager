# Tutorial: catch downloads from your browser

[← Back to docs index](README.md)

Set up the extension once, and every download link you click in Firefox, Chrome, Edge, Brave, Opera or Vivaldi goes to NetGuard.

## Before you start

On Windows, NetGuard must be installed with the setup, with **Set up browser integration (Chrome, Edge, Brave, Firefox)** ticked. It is ticked by default. If you're not sure, run the setup again. A portable copy can't do this. On Linux and macOS, start NetGuard once: it sets browser integration up itself.

NetGuard's **Add NetGuard Download Manager to your browser** window, which opens at each start until a browser's extension has reached NetGuard, shows the steps below: **Show me how** opens this tutorial.

Once it is set up, a download link goes like this:

<!-- steps -->


## In Chrome, Edge, Brave, Opera or Vivaldi

NetGuard carries its own extension: the setup puts it in NetGuard's folder, and you add it to the browser once. (NetGuard is not in the Chrome Web Store yet, and NetGuard does not accept the extension listed there by the project it was forked from.)

1. Open your browser's extensions page: type `chrome://extensions`, `edge://extensions` or `brave://extensions` in the address bar.
2. Turn on **Developer mode**.
3. Click **Load unpacked**.
4. Choose the `extension\chromium` folder inside NetGuard's folder. If you installed NetGuard for yourself, that is `%LOCALAPPDATA%\Programs\NetGuard Download Manager\extension\chromium`; you can paste that path into the folder box. If you installed it for everyone, it is `C:\Program Files\NetGuard Download Manager\extension\chromium`.
5. **NetGuard Download Manager** appears. Make sure it is turned on.
6. Go to a web page and click a download link, for example a ZIP or an EXE: NetGuard opens **Download File Info**. Click **Start Download**.

You don't need to start NetGuard first: if it isn't running, it starts by itself. Every release also has the extension as its own download, `...-extension-chromium.zip` (unzip it first, then choose the unzipped folder in step 4).

## In Firefox

Firefox only keeps add-ons signed by Mozilla, and NetGuard has no listing there yet. The add-on, `extension\mdm-firefox.xpi` in NetGuard's folder (or the `...-extension-firefox.xpi` download of a release), can be added for the current Firefox session, or kept in Firefox Developer Edition, Nightly or ESR with `xpinstall.signatures.required` set to `false` in `about:config`:

1. Type `about:debugging#/runtime/this-firefox` in the address bar.
2. Click **Load Temporary Add-on...** and choose the `.xpi` file.
3. Go to a web page and click a download link: NetGuard opens **Download File Info**.

A temporary add-on is removed when Firefox closes. Firefox 140 or later is needed.

## Choose what NetGuard takes

- **Which file types:** **Options → File types → Automatically start downloading the following file types**. Add or remove types, separated by spaces.
- **Sites to leave alone:** **Options → File types → Don't start downloading automatically from the following sites**. Add the site's name, for example `downloads.example.com` or `*.example.com`.
- **One browser only:** **Options → General → Capture downloads from the following browsers**. Untick the ones NetGuard should leave alone.


Everything NetGuard doesn't take stays with the browser.

## Download a link the browser would open

Links to a PDF or a video file, which the browser would open itself, go to NetGuard too when their type is listed. To leave one to the browser, hold **Alt** while clicking it (Firefox opens it; Chrome and Edge download it themselves). Any other link: right-click it and choose **Download with NetGuard Download Manager**, which takes any type.

## Next steps

- [Browser integration in detail (Firefox, private windows, what is sent) →](browser-integration.md)
- [If the browser doesn't hand downloads over →](troubleshooting.md#the-browser-doesnt-send-downloads-to-mdm)
- [Download overnight →](guide-download-overnight.md)
