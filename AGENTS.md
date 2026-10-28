# proxy 
A proxy server on a pi, and other machines in the tailscale network connect to it. 
Server holds the api keys and sets them in the outgoing http request. 

Keys are bound to their specific api on the proxy server side. 
Consumers import the proxy client and call typed methods for specific apis.
Example: proxy_client.generate_image(prompt, params), no need to pass any api key
This means the server must implement the api specific plumbing. 
Plain http request/response, no streaming.

# Design 
## Config 
use json-store from effect-lib 
serverPort for the service, tailscalePort for tailscale serve 

## Auth 
No client auth: being on the tailnet is the auth. 
Service listens on localhost only, exposed to the tailnet via tailscale serve. 

## On server 
Api keys stored in the key ring, using credentials from effect-lib 
proxy auth login, logout, status, to manage api keys 
proxy server serve, for foreground 
proxy service install, etc. use systemd service from effect-lib
proxy tailscale install, status, url, uninstall, to wire the service behind tailscale serve, from effect-lib tailscale 

## On client 
import the effect client in typescript, and call typed methods. 
store the server host in json-store 

# Testing 
Do e2e testing here by spawning service here without tailscale. 
- do proxy server serve on a local port
- add a dummy api key to it 
- spawn a fake api server that the proxy server will call  
- make the proxy client connect to the proxy server locally 
- make the client send a request 
- assert that the fake api returns ok from the proxy server 
