import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const npm = JSON.parse(readFileSync('package-lock.json', 'utf8')).packages;
const cargo = new Map(
  readFileSync('src-tauri/Cargo.lock', 'utf8')
    .split('[[package]]')
    .flatMap(block => {
      const name = block.match(/^name = "([^"]+)"$/m)?.[1];
      const version = block.match(/^version = "([^"]+)"$/m)?.[1];
      return name && version ? [[name, version]] : [];
    })
);
const minor = version => version?.split('.').slice(0, 2).join('.');
const packages = Object.keys(npm[''].dependencies).filter(
  name => name === '@tauri-apps/api' || name.startsWith('@tauri-apps/plugin-')
);

describe('paired native and JavaScript Tauri dependencies', () => {
  // Cargo tests alone miss this mismatch: the native CLI rejects packaging before
  // compilation when a JS plugin has a different major/minor than its Rust crate.
  it.each(packages)('%s has a compatible Rust major/minor in the committed lock', name => {
    const crate = name === '@tauri-apps/api' ? 'tauri' : name.replace('@tauri-apps/', 'tauri-');
    const jsVersion = npm[`node_modules/${name}`]?.version;
    expect(jsVersion, `${name} is missing from npm lock`).toBeTruthy();
    expect(cargo.get(crate), `${crate} is missing from Cargo.lock`).toBeTruthy();
    expect(minor(cargo.get(crate)), `${name} ${jsVersion} vs ${crate} ${cargo.get(crate)}`).toBe(minor(jsVersion));
  });
});
