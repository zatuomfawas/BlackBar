# Privacy policy

**Blackbar does not collect, transmit, store, or have access to any of your
data.** This is not a commitment we ask you to take on faith — it is enforced by
the browser.

## What the extension can do

Blackbar declares `connect-src 'none'` in its Content Security Policy. Chrome
therefore refuses every network request the extension attempts: no fetch, no
XHR, no WebSocket, no image beacon, no analytics. The extension also loads no
remote code, no fonts, and no third-party scripts.

You can confirm this in under a minute:

- Disconnect from the internet. Everything still works.
- Open DevTools → Network on the editor tab and take a screenshot. Nothing appears.
- Read `manifest.json` in the extension folder.
- The status bar performs this test itself each time the editor opens and shows
  you the result.

## What is stored, and where

| Data | Where | How long |
|---|---|---|
| The screenshot you just took | IndexedDB, inside the extension's own storage | Deleted the moment the editor opens it; anything orphaned is swept after 5 minutes |
| Your settings | `chrome.storage.local` on your device | Until you remove the extension |
| Your licence key | `chrome.storage.local` on your device | Until you remove it |
| Exported images | Wherever you choose to save them | Your files, your disk |

Nothing syncs. There is no account to create and no server to hold anything.

## Permissions, and why each exists

- **`activeTab`** — lets Blackbar read and capture the page *only* on the tab
  you invoked it on, only after you press the shortcut or click the icon, and
  only until you navigate away. This is why installing Blackbar does not ask to
  "read and change your data on all websites."
- **`scripting`** — injects the selection overlay and the page scanner into that
  tab at the moment of capture.
- **`storage`** — saves your settings and licence key locally.
- **`unlimitedStorage`** — full-page screenshots can exceed the default quota
  before they reach the editor.

Blackbar requests no host permissions, no history, no cookies, no downloads
permission, and no identity.


## Changes

Any change to this policy will be published in the repository's commit history,
which is public. If a future version of Blackbar ever needs network access for a
feature, it will be an explicit, separately-permissioned opt-in, announced
before release — never a silent update.

## Contact

Open an issue on the public repository.

