# Semantic Researcher Overleaf Remote Pack

This extension lets Semantic Researcher Overleaf complete browser-based login from a VS Code Remote window.

When the main extension runs on a remote extension host, it cannot control your local desktop browser directly. The Remote Pack runs in the local VS Code UI extension host, opens Chrome, Edge, or Chromium on your desktop, waits for you to sign in to Overleaf, and returns the session cookies to the main extension.

## Usage

Install this Remote Pack in your local desktop VS Code, and install Semantic Researcher Overleaf in the remote window. Then choose **Login in Browser** from the main extension.

In a normal local VS Code window, this extension is not required.

## Settings

- `semantic-researcher-overleaf-remote-pack.browserPath`: Optional path to a local Chrome, Edge, or Chromium executable when auto-detection does not find one.
