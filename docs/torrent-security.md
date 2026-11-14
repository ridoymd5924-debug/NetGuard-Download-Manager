# Torrents and your security

[← Back to docs index](README.md)

A torrent comes from other people's computers, not from one website. That changes what you can trust and what others can see. This page says plainly what NetGuard does and what it doesn't. The switches it mentions are in **Tasks → Torrent settings...**.

## What other people can see

- **Your IP address.** Everyone sharing the same torrent sees it, as do its trackers and the DHT (the network peers use to find each other). That's how BitTorrent works, and no setting in NetGuard changes it. To hide your address, use a VPN on your whole computer.
- **What you download, on your local network.** NetGuard tells other computers on your network which torrents it has, so they can share faster. On public Wi-Fi, turn off **Find peers on the local network**.
- **That you use NetGuard.** Peers see the name "MisterDownloadManager" and its major version, not the exact build.

NetGuard's torrents don't use **encryption** (sometimes called "protocol encryption"). That kind of encryption only hides the traffic from simple filters. It never hides who you are, so NetGuard doesn't claim to offer it. Some peers that require it won't connect.

## What reaches your computer

NetGuard starts its torrent engine the first time a torrent needs it. With **Stop the torrent engine when no torrent is running** on (the default), it stops again a minute after no torrent is running or sharing. While it runs, other peers can connect to NetGuard, and NetGuard asks your router to forward its port (UPnP). Windows may ask whether to allow NetGuard through the firewall: allow it on private networks only.

This is the only part of NetGuard that waits for connections from outside. Downloads, NetGuard's DNS choice (Options → Connection → DNS), its updates and its helpers only connect out, so they never need a firewall exception; the browser extension and the automation API reach NetGuard on this computer only (127.0.0.1).

In Torrent settings you can turn off **Accept incoming connections** and **Map the port on the router (UPnP)**, or the DHT. Downloads still work, sometimes more slowly. A fixed **Port** keeps firewall and router rules working. These changes apply the next time the engine starts, so when no torrent is running.

The torrent engine is written in Rust, which rules out many memory bugs, and NetGuard checks every piece against the torrent's fingerprint, so a peer can't slip in altered data. NetGuard keeps the engine up to date with the fixes its authors publish.

## Trackers

A torrent names the trackers NetGuard asks for peers. NetGuard doesn't contact a tracker on your own computer or your local network (`127.0.0.1`, `192.168.…`, `localhost` and the like), so a torrent can't make NetGuard send requests into the network it sits in. **Add trackers...** follows the same rule: it refuses such an address and tells you why, rather than keeping one that would never be asked.

A `.torrent` file fetched from a web address goes through the same checks as one opened from disk, and NetGuard reads at most 10 MB of it.

## Blocking addresses

**Block the addresses in this list** takes the address of a public IP blocklist, in the P2P (PeerGuardian) or eMule `.dat` format, plain or gzipped. NetGuard downloads it with its own downloader (your Proxy / Socks settings apply), checks it, and fetches it again every 7 days. Peers in it are refused. A list NetGuard can't read is left out, and the last good one stays. The engine reads the list when it starts.

## Files from a torrent

- NetGuard refuses a torrent with file names your system can't write safely, says which name, and writes nothing.
- NetGuard never writes into a file that's already there without asking.
- Files from torrents are marked as **downloaded from the internet**, like a browser's downloads. Windows SmartScreen checks a program before it first runs, and Office opens documents in Protected View. On a Mac, Gatekeeper checks apps.
- A torrent can contain anything, and anyone can make one. Only open programs from people you trust, and scan them if in doubt.

## Proxies

NetGuard's Proxy / Socks settings are for web and FTP downloads. Torrents can use a SOCKS5 one too: set a `socks5://` proxy in **Options → Proxy / Socks** and turn on **Use the proxy** in Torrent settings. The proxy covers connections to peers and web trackers only, so with it NetGuard turns off the DHT, local peer discovery, incoming connections and UDP trackers; it opens no UDP socket toward the network at all. If the proxy is gone from Proxy / Socks while that switch is on, torrents don't start rather than go around it.

To route *everything* through another network, use a VPN for the whole computer.

## A network adapter

**Options → Proxy / Socks → Network adapter** holds NetGuard's connections to one adapter, usually a VPN's ([Options](options.md#proxy--socks)). The torrent engine binds every socket to it: peers (TCP, and through a SOCKS proxy), HTTP and UDP trackers, the DHT and the listening port. On Linux and macOS it binds the adapter itself. On Windows it binds the adapter's address (its IPv4 one when it has one), and Windows sends a packet only through the adapter that has its source address. UPnP and local peer discovery are turned off then, because they talk to the local network rather than through the adapter.

It works as a kill switch. When the adapter disconnects, running torrents stop with "… is not connected; it goes on when it is back", and they start again through the adapter when it is. Until NetGuard notices (within a second), the engine's sockets are still bound to an address that is gone, so nothing can leave another way. A torrent added while the adapter isn't connected doesn't start, and says why. Tracker names are still looked up by the system's DNS.

## Reporting a problem

Found a security issue? Please report it privately on GitHub (**Security → Report a vulnerability**, see [SECURITY.md](../../../blob/main/SECURITY.md)) rather than in a public issue.

## Next steps

- [Torrents →](torrents.md)
- [Back to the docs index →](README.md)
