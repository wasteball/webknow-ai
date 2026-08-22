import { readdir, readFile } from 'node:fs/promises';

const output = new URL('../.output/chrome-mv3/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', output), 'utf8'));
const expectedPermissions = ['activeTab', 'scripting', 'sidePanel', 'storage'];
const permissions = [...(manifest.permissions ?? [])].sort();
const requiredHosts = manifest.host_permissions ?? [];
const failures = [];

if (JSON.stringify(permissions) !== JSON.stringify(expectedPermissions)) {
  failures.push(`permissions=${JSON.stringify(permissions)}`);
}
if (requiredHosts.length) failures.push(`required hosts=${JSON.stringify(requiredHosts)}`);
if (!manifest.optional_host_permissions?.includes('https://*/*')) {
  failures.push('missing optional HTTPS host permission');
}

async function textFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
    if (entry.isDirectory()) files.push(...(await textFiles(url)));
    else if (/\.(?:html|js|json|css|map|txt)$/i.test(entry.name)) files.push(url);
  }
  return files;
}

const forbidden = ['127.0.0.1:4173', '<all_urls>', 'storage.sync', 'product-backend'];
for (const file of await textFiles(output)) {
  const content = await readFile(file, 'utf8');
  for (const value of forbidden) {
    if (content.includes(value)) failures.push(`${file.pathname}: contains ${value}`);
  }
}
if (failures.length) throw new Error(`Production build audit failed: ${failures.join('; ')}`);
console.log('Production build has expected permissions and no test or backend origins.');
