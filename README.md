# proxy

A typed proxy that keeps API keys off the machines that run agents. A Cloudflare Worker holds the keys and adds them to outgoing requests; clients, each with a scoped API key of their own, call typed methods such as `notify(message)` or `generateImage(prompt)` and never see an upstream key. A simpler alternative to a generic, TLS-intercepting proxy like Infisical's Agent Vault.

## Demo

[![proxy demo](https://img.youtube.com/vi/KlHPnUZ1wxQ/maxresdefault.jpg)](https://youtu.be/KlHPnUZ1wxQ)

## Requirements

- [Bun](https://bun.sh)
- A [Cloudflare](https://cloudflare.com) account

## Installation

```sh
git clone https://github.com/laroccacharly/proxy
cd proxy
bun install
```
