# VPS Browser for Hermes Desktop

A globe button in the top right of Hermes Desktop that opens the VPS browser next to the chat, on the right.

Hermes browses on its own screen on the backend server (Hermes Bot Screen). This plugin shows that screen live. Press **Take over** to use the mouse and keyboard yourself, then **Hand back** so Hermes can continue. Logins you make there stay in Hermes's browser.

## Install

Open this link on the computer that runs Hermes Desktop:

`hermes://plugin/install?repo=supporteraphina/hermes-vps-browser/vps-browser&force=1`

Then turn it on in Capabilities → Plugins if it is off.

## Backend setup

On the backend (Linux):

```
hermes computer-use screen install
hermes config set browser.headed true
hermes config set bot_desktop.auto_start true
```

## Build

`npm install && npm run build` writes `vps-browser/plugin.js`.
