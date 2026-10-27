# proxy

A typed proxy that keeps API keys off the machines that run agents. The server holds the keys and adds them to outgoing requests; clients on the Tailscale network call typed methods such as `generateImage(prompt)` and never see a key. A simpler alternative to a generic, TLS-intercepting proxy like Infisical's Agent Vault.

## Demo

[![proxy demo](https://img.youtube.com/vi/KlHPnUZ1wxQ/maxresdefault.jpg)](https://youtu.be/KlHPnUZ1wxQ)

## Requirements

- [Bun](https://bun.sh)
- [Tailscale](https://tailscale.com) on the server and on every client
- Linux with systemd on the server (for example a Raspberry Pi)

## Installation

```sh
git clone https://github.com/laroccacharly/proxy
cd proxy
bun install
```
