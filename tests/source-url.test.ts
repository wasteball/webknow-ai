import { expect, it } from 'vitest';
import { publicSourceUrl } from '../src/core/search/source-url';

it.each([
  'http://localhost/', 'http://localhost./', 'http://a.localhost/', 'http://printer/',
  'http://127.1/', 'http://2130706433/', 'http://0x7f000001/', 'http://0177.0.0.1/',
  'http://10.0.0.1/', 'http://172.31.0.1/', 'http://192.168.1.1/', 'http://169.254.169.254/',
  'http://100.64.0.1/', 'http://0.0.0.0/', 'http://192.0.2.1/', 'http://198.18.0.1/',
  'http://198.51.100.1/', 'http://203.0.113.1/', 'http://224.0.0.1/', 'http://255.255.255.255/',
  'http://[::1]/', 'http://[::]/', 'http://[fc00::1]/', 'http://[fe80::1]/',
  'http://[::ffff:127.0.0.1]/', 'http://[2001:db8::1]/', 'http://[2002:7f00:1::]/',
  'https://user:pass@example.com/', 'https://a.local/', 'https://a.internal/',
  'file:///etc/passwd', 'data:text/plain,hi', 'javascript:alert(1)', '//example.com',
  'https://example.com/\nsecret',
])('rejects non-public or ambiguous target %s', (raw) => expect(publicSourceUrl(raw)).toBeNull());

it.each(['https://example.com/a?q=x', 'http://8.8.8.8/', 'https://[2606:4700:4700::1111]/'])('accepts public-shaped HTTP targets %s', (raw) => {
  expect(publicSourceUrl(raw)?.href).toBe(new URL(raw).href);
});

it('canonicalizes hostname spelling without treating DNS as proven public', () => {
  expect(publicSourceUrl('https://EXAMPLE.com.:8443/a#part')?.origin).toBe('https://example.com:8443');
});
