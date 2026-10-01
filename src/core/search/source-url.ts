/** Syntactic guard only: DNS isolation must be independently verified before direct fetch. */
export function publicSourceUrl(raw: string): URL | null {
  if (typeof raw !== 'string' || /[\u0000-\u0020\u007f]/.test(raw) || !/^https?:\/\//i.test(raw)) return null;
  try {
    const url = new URL(raw);
    if (url.username || url.password || !['http:', 'https:'].includes(url.protocol)) return null;
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (host.startsWith('[')) {
      // Only global unicast; mapped IPv4, loopback, link-local and multicast never pass.
      const groups = host.slice(1, -1).split(':');
      const first = Number.parseInt(groups[0]!, 16);
      const second = Number.parseInt(groups[1] || '0', 16);
      if (!(first >= 0x2000 && first <= 0x3fff) || first === 0x2002 ||
          (first === 0x2001 && (second <= 0x1ff || second === 0xdb8)) ||
          (first === 0x3fff && second <= 0x0fff)) return null;
    } else if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      // WHATWG URL has already normalized decimal/hex/octal/short IPv4 spelling.
      const [a, b, c] = host.split('.').map(Number) as [number, number, number];
      if (a === 0 || a === 10 || a === 127 || a >= 224 ||
          (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
          (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 ||
            (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
          (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
          (a === 203 && b === 0 && c === 113)) return null;
    } else {
      if (!host.includes('.') || /(^|\.)(localhost|local|internal|intranet|lan|home|test|invalid|example|onion)$/.test(host) ||
          !host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) return null;
      url.hostname = host;
    }
    url.hash = '';
    return url;
  } catch { return null; }
}
