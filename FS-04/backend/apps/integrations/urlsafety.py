"""Keep outgoing webhooks pointed at the public internet.

Without this, a workspace admin could register http://localhost:8000/…, http://db:5432, a cloud metadata
address (169.254.169.254) or any other internal service, and the Celery worker would POST to it from
inside our network, then show the response in the delivery log (server-side request forgery, SSRF).

Two checks:
- when a webhook is saved: http(s) only, no credentials in the URL, and no host that is obviously
  internal (an IP literal in a private range, `localhost`, or a single-label name like `db` or `redis`);
- right before each delivery: the host name is resolved and every address it resolves to must be public.

Set WEBHOOK_ALLOW_PRIVATE_URLS=true only to test against a receiver on your own machine.
"""
import ipaddress
import socket
from urllib.parse import urlsplit

from django.conf import settings


class UnsafeURL(ValueError):
    """The URL points somewhere a webhook must not be sent."""


class HostLookupFailed(UnsafeURL):
    """The host couldn't be resolved right now; unlike a private address, this may fix itself."""


def resolve(host):
    """Every IP address `host` resolves to (tests replace this so they don't need DNS)."""
    return {info[4][0] for info in socket.getaddrinfo(host, None, proto=socket.IPPROTO_TCP)}


def _is_public(address):
    ip = ipaddress.ip_address(address)
    if ip.version == 6 and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    return ip.is_global and not ip.is_multicast


def check_url(url, resolve_dns=False):
    """Raise UnsafeURL unless `url` is an http(s) URL on the public internet."""
    if settings.WEBHOOK_ALLOW_PRIVATE_URLS:
        return
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https"):
        raise UnsafeURL("Webhook URLs must start with http:// or https://.")
    if parts.username or parts.password:
        raise UnsafeURL("Put credentials in a header on your side, not in the webhook URL.")
    host = (parts.hostname or "").rstrip(".").lower()
    if not host:
        raise UnsafeURL("The webhook URL has no host name.")
    try:
        literal = ipaddress.ip_address(host)
    except ValueError:
        literal = None
    if literal is not None:
        addresses = {host}
    elif host == "localhost" or host.endswith(".localhost") or "." not in host:
        raise UnsafeURL("Webhooks can't be sent to internal host names.")
    elif resolve_dns:
        try:
            addresses = resolve(host)
        except OSError as exc:
            raise HostLookupFailed(f"Couldn't resolve {host}.") from exc
    else:
        return
    if not all(_is_public(a) for a in addresses):
        raise UnsafeURL("Webhooks can't be sent to private, loopback or link-local addresses.")
